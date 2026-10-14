/// <reference lib="dom" />

export interface PlaytestPanelOptions {
  root: HTMLElement;
  token: () => string;
  isSignedIn: () => boolean;
  transport?: typeof fetch;
}
export interface PlaytestPanelController { stop(): void; refresh(): Promise<void> }

const RESPONSE_BYTES = 128 * 1024;
const POLL_MS = 2_000, AUTH_CHECK_MS = 250, TIMEOUT_MS = 15_000, VISIBLE_JOBS = 3;
const ACTIONS = ['start', 'observe-state-and-console', 'stop-owned-play'] as const;
type Row = Record<string, unknown>;
type DisplayValue = string | number | boolean | DisplayValue[] | { [key: string]: DisplayValue };
interface Job {
  id: string; targetName: string; state: 'needs_approval' | 'running' | 'complete' | 'cancelled';
  displayDigest: string; display: Readonly<Row>; scope: string; durationMs: number;
  consentExpiresAt: number; evidence: 'native' | 'fixture';
  review: { phase: string; outcome: string | null; code: string | null; cleanup: string; requiresHumanReview: boolean };
}
function invalid(): never { throw new Error('Invalid playtest response'); }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
function keys(value: Row, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|[\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function displayCopy(value: unknown): Readonly<Row> {
  let nodes = 0;
  const copy = (value: unknown, depth: number): DisplayValue => {
    if (++nodes > 512 || depth > 6) invalid();
    if (typeof value === 'string') return text(value, 4096);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return integer(value);
    if (Array.isArray(value)) {
      if (!value.length || value.length > 16) invalid();
      return Object.freeze(value.map(item => copy(item, depth + 1))) as unknown as DisplayValue[];
    }
    const source = object(value), result: { [key: string]: DisplayValue } = {};
    const entries = Object.entries(source);
    if (!entries.length || entries.length > 32) invalid();
    for (const [key, child] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      // Attested private-target metadata is text, never an object coerced into a name.
      if (key === 'trustedPrivateTarget') {
        if (typeof child === 'string') text(child);
        else for (const field of Object.values(object(child))) text(field);
      }
      result[key] = copy(child, depth + 1);
    }
    return Object.freeze(result);
  };
  return object(copy(value, 0));
}
function readJob(value: unknown): Job {
  const source = object(value), id = text(source.id, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
  text(source.actor); // Deliberately neither retained nor displayed.
  const targetName = text(source.targetName), displayDigest = text(source.displayDigest, 64);
  if (!/^[a-f0-9]{64}$/.test(displayDigest) || source.nativeAcceptance !== false ||
      !['native', 'fixture'].includes(source.evidence as string) ||
      !['needs_approval', 'running', 'complete', 'cancelled'].includes(source.state as string)) invalid();
  const display = displayCopy(source.display), proposal = object(display.proposal), binding = object(proposal.binding);
  keys(display, ['proposal', 'cleanupGraceMs', 'requestTimeoutMs', 'proofMaxAgeMs', 'consentExpiresAt', 'guarantee', 'actions', 'raceDisclosure'], ['trustedPrivateTarget']);
  keys(proposal, ['binding', 'durationMs', 'observationIntervalMs', 'failOnRuntimeError'], ['trustedPrivateTarget']);
  keys(binding, ['pairedSessionId', 'nativeStudioId', 'placeId'], ['clientLifetimeId', 'pluginArtifactHash', 'scopeRevision']);
  text(binding.pairedSessionId); text(binding.nativeStudioId);
  for (const key of ['clientLifetimeId', 'pluginArtifactHash', 'scopeRevision']) if (binding[key] !== undefined) text(binding[key]);
  if (binding.placeId !== 0 || typeof proposal.failOnRuntimeError !== 'boolean') invalid();
  const durationMs = integer(proposal.durationMs, 1, 86_400_000);
  integer(proposal.observationIntervalMs, 1, 86_400_000);
  for (const key of ['cleanupGraceMs', 'requestTimeoutMs', 'proofMaxAgeMs']) integer(display[key], 1, 86_400_000);
  const consentExpiresAt = integer(display.consentExpiresAt, 1);
  if (display.guarantee !== 'observed-non-atomic' || !Array.isArray(display.actions) ||
      display.actions.length !== ACTIONS.length || display.actions.some((action, index) => action !== ACTIONS[index])) invalid();
  text(display.raceDisclosure, 4096);
  const review = object(source.review);
  if (review.requiresHumanReview !== undefined && typeof review.requiresHumanReview !== 'boolean') invalid();
  integer(review.observations);
  return {
    id, targetName, state: source.state as Job['state'], displayDigest, display,
    scope: JSON.stringify(display), durationMs, consentExpiresAt, evidence: source.evidence as Job['evidence'],
    review: {
      phase: text(review.phase, 64), outcome: review.outcome === null ? null : text(review.outcome, 64),
      code: review.code === null ? null : text(review.code, 64), cleanup: text(review.cleanup, 64),
      requiresHumanReview: review.requiresHumanReview === true,
    },
  };
}
function readJobs(value: unknown): Job[] {
  const jobs = object(value).jobs;
  if (!Array.isArray(jobs) || jobs.length > 128) invalid();
  const result = jobs.map(readJob);
  if (new Set(result.map(job => job.id)).size !== result.length) invalid();
  return result;
}

/** Count bytes while reading, before decoding or parsing even an error body. */
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const cancel = async () => { try { await response.body?.cancel(); } catch { /* Already closed. */ } };
  const length = response.headers.get('content-length');
  if (response.redirected || (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES)) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    await cancel(); invalid();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    if (signal.aborted) invalid();
    while (true) {
      const part = await reader.read();
      if (signal.aborted) invalid();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_BYTES) { await reader.cancel(); invalid(); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  if (response.status !== 200) invalid();
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
}
function active(job: Job): boolean { return job.state === 'needs_approval' || job.state === 'running'; }
function sameScope(left: Job, right: Job): boolean {
  return left.id === right.id && left.displayDigest === right.displayDigest && left.scope === right.scope &&
    left.targetName === right.targetName && left.evidence === right.evidence;
}
function status(job: Job): { label: string; danger: boolean } {
  if (job.review.cleanup === 'unknown' || job.review.requiresHumanReview) return { label: 'Needs review', danger: true };
  if (job.state === 'needs_approval') return { label: '', danger: false };
  if (job.state === 'running') return { label: 'Testing…', danger: false };
  const clean = job.review.cleanup === 'complete' || (job.state === 'cancelled' && job.review.cleanup === 'not_started');
  if (!clean || (job.state === 'complete' && (job.review.phase !== 'done' ||
      !['succeeded', 'failed'].includes(job.review.outcome ?? '') || (job.review.outcome === 'succeeded' && job.review.code !== 'OK')))) {
    return { label: 'Needs review', danger: true };
  }
  return { label: job.state === 'cancelled' ? 'Test cancelled' : 'Test finished', danger: job.review.outcome === 'failed' };
}

/** Conversation-sized human consent UI. Mounting, styles and routes belong to the parent. */
export function startPlaytestPanel(options: PlaytestPanelOptions): PlaytestPanelController {
  const { root } = options, doc = root.ownerDocument, view = doc.defaultView;
  const transport = options.transport ?? globalThis.fetch;
  let stopped = false, pageHidden = false, epoch = 0, sessionToken: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, nextPoll = 0, stale = false;
  let jobs: Job[] = [];
  let request: { controller: AbortController; epoch: number; promise: Promise<void> } | null = null;
  // Negative deduplication only: an ambiguous command is never sent again for this scope.
  const attempted = new Set<string>();
  interface JobView { job: Job; signature: string; element: HTMLElement; heading: HTMLElement; details: HTMLDetailsElement; controls: HTMLButtonElement[]; remove(): void }
  const rendered = new Map<string, JobView>();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  };
  const notice = node('p', '', 'playtest-notice');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const refreshButton = node('button', 'Refresh status', 'playtest-refresh'); refreshButton.type = 'button';
  const feedback = node('div', undefined, 'playtest-feedback'); feedback.append(notice, refreshButton); feedback.hidden = true;
  root.hidden = true; root.replaceChildren();
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Playtests'); root.setAttribute('aria-busy', 'false');

  function clearRows(): void {
    for (const row of rendered.values()) row.remove();
    rendered.clear(); jobs = []; root.replaceChildren(); root.hidden = true;
    root.setAttribute('aria-busy', 'false'); notice.textContent = ''; feedback.hidden = true; stale = false;
  }
  function invalidate(): void {
    epoch++; request?.controller.abort(); request = null; sessionToken = null; clearRows();
  }
  function context(): string | null {
    if (stopped || pageHidden || doc.visibilityState !== 'visible') return null;
    try {
      if (!options.isSignedIn()) return null;
      const token = options.token();
      return typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token) ? token : null;
    } catch { return null; }
  }
  function syncContext(): string | null {
    const token = context();
    if (token !== sessionToken) { invalidate(); sessionToken = token; nextPoll = 0; }
    return token;
  }
  function current(operation: NonNullable<typeof request>, token: string): boolean {
    return syncContext() === token && request === operation && epoch === operation.epoch && !operation.controller.signal.aborted;
  }
  const attemptKey = (job: Job, action: string) => action + ':' + job.id + ':' + job.displayDigest;
  function busy(): void {
    root.setAttribute('aria-busy', String(request !== null)); refreshButton.disabled = request !== null;
    for (const row of rendered.values()) for (const button of row.controls) {
      const action = button.getAttribute('data-playtest-action')!;
      button.disabled = request !== null || stale || attempted.has(attemptKey(row.job, action)) ||
        (action === 'approve' && (row.job.consentExpiresAt <= Date.now() || row.job.review.requiresHumanReview || row.job.review.cleanup === 'unknown'));
    }
  }
  function message(content: string): void { notice.textContent = content; feedback.hidden = !content; }
  function detailsFor(job: Job): HTMLDetailsElement {
    const details = node('details', undefined, 'playtest-details');
    const summary = node('summary', 'Permission details'); summary.setAttribute('data-playtest-action', 'details');
    details.append(summary, node('p', 'Allow this test to start play, observe state and console, then stop only the play it owns.'));
    const fields = node('dl');
    function field(key: string, value: string): void { fields.append(node('dt', key), node('dd', value)); }
    function walk(value: unknown, path: string): void {
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, path + '[' + index + ']'));
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, path ? path + '.' + key : key);
      else field(path, typeof value === 'string' ? value : String(value));
    }
    walk(job.display, 'display'); field('displayDigest', job.displayDigest);
    details.append(fields); return details;
  }
  function makeRow(job: Job, signature: string): JobView {
    const element = node('article', undefined, 'playtest-row'), heading = node('h3', 'Playtest · ' + job.targetName, 'playtest-title');
    heading.tabIndex = -1;
    element.append(heading, node('p', (job.durationMs / 1000) + ' s · Local, unpublished place', 'playtest-subtitle'));
    const state = status(job);
    if (state.label) {
      const label = node('p', state.label, state.danger ? 'playtest-status danger' : 'playtest-status');
      label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite'); element.append(label);
    }
    if (job.evidence === 'fixture' || !active(job)) element.append(node('p',
      job.evidence === 'fixture' ? 'Fixture evidence · Native acceptance unverified' : 'Native evidence · Native acceptance unverified', 'playtest-evidence'));
    const controls: HTMLButtonElement[] = [], listeners: (() => void)[] = [];
    function button(label: string, action: 'approve' | 'cancel'): void {
      const button = node('button', label); button.type = 'button'; button.setAttribute('data-playtest-action', action);
      button.setAttribute('aria-label', label + ' · ' + job.targetName);
      const click = (event: Event) => {
        if (event.isTrusted !== true || button.disabled || !root.contains(button) || rendered.get(job.id)?.element !== element) return;
        event.preventDefault(); void mutate(job, action);
      };
      button.addEventListener('click', click); listeners.push(() => button.removeEventListener('click', click));
      controls.push(button); element.append(button);
    }
    if (job.state === 'needs_approval') button('Run test', 'approve');
    if (active(job)) button(job.state === 'running' ? 'Stop' : 'Cancel', 'cancel');
    const details = detailsFor(job); element.append(details);
    return { job, signature, element, heading, details, controls, remove() { listeners.forEach(remove => remove()); } };
  }
  function render(): void {
    const selected = [...jobs].reverse().filter(job => active(job) || rendered.has(job.id)).slice(0, VISIBLE_JOBS);
    const focused = doc.activeElement as HTMLElement | null;
    const focusedRow = [...rendered.values()].find(row => focused && row.element.contains(focused));
    const focusedAction = focused?.getAttribute('data-playtest-action');
    let changed = root.children.length !== selected.length + 1;
    const next = new Map<string, JobView>();
    for (const job of selected) {
      const signature = JSON.stringify([job.id, job.targetName, job.state, job.scope, job.displayDigest, job.evidence, status(job)]);
      const previous = rendered.get(job.id);
      let row = previous;
      if (!row || row.signature !== signature) {
        row = makeRow(job, signature); row.details.open = previous?.details.open ?? false;
        previous?.remove(); changed = true;
      }
      row.job = job; next.set(job.id, row);
    }
    for (const [id, row] of rendered) if (!next.has(id)) { row.remove(); changed = true; }
    const order = [...next.keys()];
    if (order.some((id, index) => [...rendered.keys()][index] !== id)) changed = true;
    rendered.clear(); for (const [id, row] of next) rendered.set(id, row);
    if (changed) {
      root.replaceChildren(feedback, ...[...rendered.values()].map(row => row.element));
      if (focusedRow && focused) {
        const replacement = rendered.get(focusedRow.job.id);
        if (root.contains(focused)) focused.focus();
        else if (replacement) {
          const target = replacement.controls.find(button => button.getAttribute('data-playtest-action') === focusedAction);
          (target ?? replacement.heading).focus();
        }
      }
    }
    root.hidden = selected.length === 0; busy();
  }

  function run(token: string, method: 'GET' | 'POST', path: string, body: Row | undefined,
    accept: (value: unknown) => void, failure: () => void, after?: () => void): Promise<void> {
    const controller = new AbortController();
    const operation = { controller, epoch, promise: Promise.resolve() };
    request = operation; nextPoll = Date.now() + POLL_MS; busy();
    operation.promise = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let removeAbort = () => {};
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error('Playtest request aborted'));
          controller.signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => controller.signal.removeEventListener('abort', abort);
        });
        deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        // A relative same-origin fetch lets the browser supply Origin. No asserted human identity.
        const response = await Promise.race([transport(path, {
          method, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(async response => {
          if (controller.signal.aborted) { try { await response.body?.cancel(); } catch { /* Closed. */ } invalid(); }
          return readResponse(response, controller.signal);
        }), aborted]);
        if (current(operation, token)) accept(response);
      } catch {
        // A deadline is reportable; an invalidated generation has no UI authority.
        if (syncContext() === token && request === operation && epoch === operation.epoch) failure();
      } finally {
        if (deadline !== undefined) clearTimeout(deadline); removeAbort();
        if (request === operation && epoch === operation.epoch) {
          request = null; busy(); after?.();
        }
      }
    })();
    return operation.promise;
  }
  function refresh(): Promise<void> {
    const token = syncContext();
    if (!token) return Promise.resolve();
    if (request) return request.promise;
    return run(token, 'GET', '/v1/playtests', undefined, value => {
      jobs = readJobs(value); stale = false; render();
    }, () => { stale = true; message('Couldn’t refresh test status. Refresh status to check again.'); busy(); });
  }
  function mutate(captured: Job, action: 'approve' | 'cancel'): Promise<void> {
    const token = syncContext(), latest = jobs.find(job => job.id === captured.id);
    if (!token || request || stale || !latest || !sameScope(captured, latest) || latest.state !== captured.state ||
        !active(latest) || (action === 'approve' && (latest.state !== 'needs_approval' || latest.consentExpiresAt <= Date.now() ||
          latest.review.requiresHumanReview || latest.review.cleanup === 'unknown')) ||
        attempted.has(attemptKey(captured, action))) return Promise.resolve();
    attempted.add(attemptKey(captured, action)); message('');
    return run(token, 'POST', '/v1/playtests/' + action,
      action === 'approve' ? { id: captured.id, displayDigest: captured.displayDigest } : { id: captured.id }, value => {
        const returned = readJob(object(value).job);
        if (!sameScope(returned, captured) || returned.state === 'needs_approval' ||
            (action === 'approve' && returned.state === 'cancelled') || (action === 'cancel' && returned.state === 'running')) invalid();
        jobs = jobs.map(job => job.id === returned.id ? returned : job); stale = false; render();
      }, () => { stale = true; message('Couldn’t confirm the request. Refresh status; this request won’t be sent again.'); busy(); },
      () => { void refresh(); });
  }
  const refreshClick = (event: Event) => { if (event.isTrusted === true && !refreshButton.disabled && root.contains(refreshButton)) void refresh(); };
  refreshButton.addEventListener('click', refreshClick);
  function schedule(): void {
    if (stopped || pageHidden || doc.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      timer = undefined;
      if (syncContext() && !request && Date.now() >= nextPoll) void refresh();
      busy(); schedule();
    }, AUTH_CHECK_MS);
  }
  function visibility(): void {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    syncContext();
    if (context()) void refresh();
    schedule();
  }
  const hide = () => { pageHidden = true; visibility(); };
  const show = () => { pageHidden = false; visibility(); };
  doc.addEventListener('visibilitychange', visibility);
  view?.addEventListener('pagehide', hide); view?.addEventListener('pageshow', show);
  void refresh(); schedule();
  return {
    refresh,
    stop() {
      if (stopped) return;
      stopped = true; if (timer !== undefined) clearTimeout(timer); timer = undefined;
      doc.removeEventListener('visibilitychange', visibility);
      view?.removeEventListener('pagehide', hide); view?.removeEventListener('pageshow', show);
      refreshButton.removeEventListener('click', refreshClick); invalidate(); attempted.clear();
    },
  };
}
