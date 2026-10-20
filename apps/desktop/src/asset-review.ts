/// <reference lib="dom" />
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
const RESPONSE_LIMIT = 32 * 1024;
type Decision = 'approved' | 'rejected';
export interface ViewedAsset { readonly jobId: string; readonly sha256: string; readonly bytes: number }
interface Subject {
  schemaVersion: 1; projectId: string; conversation: { provider: 'codex' | 'claude-code'; threadId: string; sessionId: string | null };
  jobId: string; manifestSha256: string; sourceRequestSha256: string;
  artifacts: { path: 'asset.glb' | 'collision.glb'; sha256: string; bytes: number }[];
}
interface Review {
  reviewId: string; subject: Subject; subjectDigest: string; status: 'pending' | Decision;
  revision: number; preparedAt: string; decidedAt: string | null;
}
export interface ReviewStatus { subject: Subject; subjectDigest: string; review: Review | null; retry: false }
interface Command { reviewId: string; decision: Decision; idempotencyKey: string }
interface Pending extends Command { subjectDigest: string }
type Receipt = { state: 'recorded'; review: Review } | { state: 'not-recorded'; review: Review } | { state: 'stale'; review: null };
const invalid = (): never => { throw new Error('Model review response did not match the viewed model.'); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  if ((proto !== Object.prototype && proto !== null) || own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) { const field = Object.getOwnPropertyDescriptor(value, key); if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return invalid(); result[key] = field.value; }
  return result;
}
function string(value: unknown, expression: RegExp): string { if (typeof value !== 'string' || !expression.test(value)) return invalid(); return value; }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(); return value; }
function timestamp(value: unknown): string { if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return invalid(); return value; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(value: unknown, cryptography: Crypto): Promise<string> {
  return [...new Uint8Array(await cryptography.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function subject(value: unknown, viewed: ViewedAsset): Subject {
  const s = record(value, ['schemaVersion', 'projectId', 'conversation', 'jobId', 'manifestSha256', 'sourceRequestSha256', 'artifacts']);
  const c = record(s.conversation, ['provider', 'threadId', 'sessionId']);
  if (s.schemaVersion !== 1 || s.jobId !== viewed.jobId || !UUID.test(viewed.jobId) || !HASH.test(viewed.sha256) ||
      c.provider !== 'codex' && c.provider !== 'claude-code' || !Array.isArray(s.artifacts) || s.artifacts.length !== 2) return invalid();
  const artifacts: Subject['artifacts'] = s.artifacts.map((value, index) => {
    const a = record(value, ['path', 'sha256', 'bytes']), path = index === 0 ? 'asset.glb' : 'collision.glb';
    if (a.path !== path) return invalid();
    return { path, sha256: string(a.sha256, HASH), bytes: integer(a.bytes, 1, 64 * 1024 * 1024) };
  });
  if (artifacts[0]!.sha256 !== viewed.sha256 || artifacts[0]!.bytes !== viewed.bytes) return invalid();
  return { schemaVersion: 1, projectId: string(s.projectId, HASH), conversation: { provider: c.provider, threadId: string(c.threadId, ID), sessionId: c.sessionId === null ? null : string(c.sessionId, ID) },
    jobId: string(s.jobId, UUID), manifestSha256: string(s.manifestSha256, HASH), sourceRequestSha256: string(s.sourceRequestSha256, HASH), artifacts };
}
function review(value: unknown, expected: Subject, expectedDigest: string): Review {
  const r = record(value, ['reviewId', 'subject', 'subjectDigest', 'status', 'revision', 'preparedAt', 'decidedAt']);
  const viewed = { jobId: expected.jobId, sha256: expected.artifacts[0]!.sha256, bytes: expected.artifacts[0]!.bytes };
  const measured = subject(r.subject, viewed);
  if (r.subjectDigest !== expectedDigest || canonical(measured) !== canonical(expected) || !['pending', 'approved', 'rejected'].includes(String(r.status))) return invalid();
  const revision = integer(r.revision, 0, 4096);
  if (r.status === 'pending' ? revision !== 0 || r.decidedAt !== null : revision < 1 || typeof r.decidedAt !== 'string') return invalid();
  return { reviewId: string(r.reviewId, UUID), subject: measured, subjectDigest: expectedDigest, status: r.status as Review['status'], revision,
    preparedAt: timestamp(r.preparedAt), decidedAt: r.decidedAt === null ? null : timestamp(r.decidedAt) };
}
export async function readAssetReviewStatus(value: unknown, viewed: ViewedAsset, cryptography: Crypto = crypto): Promise<ReviewStatus> {
  const r = record(value, ['subject', 'subjectDigest', 'review', 'retry']), measured = subject(r.subject, viewed);
  const hash = string(r.subjectDigest, HASH);
  if (r.retry !== false || hash !== await digest(measured, cryptography)) return invalid();
  return { subject: measured, subjectDigest: hash, review: r.review === null ? null : review(r.review, measured, hash), retry: false };
}
function receipt(value: unknown, prepared: ReviewStatus, command: Pending): Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const state = (value as Record<string, unknown>).state;
  if (state === 'stale') { const r = record(value, ['state', 'review', 'retry']); if (r.review !== null || r.retry !== false) return invalid(); return { state, review: null }; }
  const r = record(value, state === 'recorded' ? ['state', 'review', 'command', 'retry'] : ['state', 'review', 'retry']);
  if (r.retry !== false || state !== 'recorded' && state !== 'not-recorded') return invalid();
  const measured = review(r.review, prepared.subject, prepared.subjectDigest);
  if (measured.reviewId !== command.reviewId || measured.revision < (prepared.review?.revision ?? 0)) return invalid();
  if (state === 'recorded') {
    const c = record(r.command, ['idempotencyKey', 'decision', 'revision']), revision = integer(c.revision, 1, 4096);
    if (c.idempotencyKey !== command.idempotencyKey || c.decision !== command.decision || revision > measured.revision ||
        revision === measured.revision && measured.status !== command.decision) return invalid();
  }
  return { state, review: measured };
}
export class AssetReviewRequestError extends Error {
  constructor(readonly unknownOutcome: boolean) { super(unknownOutcome ? 'Review decision was not confirmed.' : 'Model review is unavailable.'); }
}
export class AssetReviewApi {
  constructor(private readonly token: string, private readonly tokenOrigin: string, private readonly currentOrigin: () => string,
    private readonly transport: typeof fetch = fetch, private readonly timeoutMs = 10000) {}
  async request(endpoint: 'prepare' | 'status' | 'decide' | 'receipt', body: { jobId: string } | Command | { reviewId: string; idempotencyKey: string }, signal: AbortSignal): Promise<unknown> {
    let payload: Record<string, unknown>;
    try {
      if (!['prepare', 'status', 'decide', 'receipt'].includes(endpoint)) return invalid();
      if (endpoint === 'prepare' || endpoint === 'status') { const r = record(body, ['jobId']); payload = { jobId: string(r.jobId, UUID) }; }
      else {
        const r = record(body, endpoint === 'decide' ? ['reviewId', 'decision', 'idempotencyKey'] : ['reviewId', 'idempotencyKey']);
        payload = { reviewId: string(r.reviewId, UUID), idempotencyKey: string(r.idempotencyKey, UUID) };
        if (endpoint === 'decide') { if (r.decision !== 'approved' && r.decision !== 'rejected') return invalid(); payload.decision = r.decision; }
      }
    } catch { throw new AssetReviewRequestError(false); }
    let origin: URL; try { origin = new URL(this.tokenOrigin); } catch { throw new AssetReviewRequestError(false); }
    if (!HASH.test(this.token) || origin.origin !== this.tokenOrigin || !['http:', 'https:'].includes(origin.protocol) ||
        this.currentOrigin() !== this.tokenOrigin || signal.aborted) throw new AssetReviewRequestError(false);
    const controller = new AbortController(), abort = () => controller.abort();
    let dispatched = false, definitive = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new AssetReviewRequestError(endpoint === 'decide' && dispatched)); });
    const cancel = () => { abort(); rejectAbort(); };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      if (signal.aborted) throw new AssetReviewRequestError(false);
      dispatched = true;
      response = await Promise.race([this.transport('/v1/assets/review/' + endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      }), cancelled]);
      definitive = response.status >= 400 && response.status < 500;
      if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('Content-Type') ?? '') || !response.body) throw new Error();
      const declared = response.headers.get('Content-Length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) throw new Error();
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = []; let total = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), cancelled]); if (part.done) break;
        total += part.value.byteLength; if (total > RESPONSE_LIMIT) throw new Error();
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode()); return JSON.parse(chunks.join('')) as unknown;
    } catch { throw new AssetReviewRequestError(endpoint === 'decide' && dispatched && !definitive); }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
  }
}
interface ReviewOptions { transport?: typeof fetch; tokenOrigin?: string; deadlineMs?: number; cryptography?: Crypto }
interface Session {
  epoch: number; controller: AbortController; active: () => boolean; viewed: ViewedAsset; root: HTMLElement; status: HTMLElement; notice: HTMLElement;
  approve: HTMLButtonElement; reject: HTMLButtonElement; refresh: HTMLButtonElement; prepared: ReviewStatus | null; busy: boolean; fenced: boolean; blocked: boolean;
}
/** Owns only its card. Unknown dispatched commands stay fenced across viewer reloads. */
export class AssetReviewCard {
  private epoch = 0;
  private session: Session | null = null;
  private unlink: (() => void) | null = null;
  private readonly unknown = new Map<string, Pending>();
  private readonly api: AssetReviewApi;
  private readonly cryptography: Crypto;
  constructor(private readonly doc: Document, token: string, options: ReviewOptions = {}) {
    const origin = () => doc.defaultView?.location?.origin ?? '';
    this.api = new AssetReviewApi(token, options.tokenOrigin ?? origin(), origin, options.transport, options.deadlineMs);
    this.cryptography = options.cryptography ?? globalThis.crypto;
  }
  clear(): void {
    this.epoch++; this.unlink?.(); this.unlink = null;
    this.session?.controller.abort(); this.session?.root.remove(); this.session = null;
  }
  async show(host: HTMLElement, viewed: ViewedAsset, signal: AbortSignal, current: () => boolean): Promise<void> {
    this.clear(); if (!current() || signal.aborted) return;
    const epoch = this.epoch, controller = new AbortController();
    const root = this.make('section', undefined, 'viewer-review'); root.setAttribute('aria-label', 'Model review');
    root.setAttribute('data-review-job-id', viewed.jobId);
    const title = this.make('h3', 'Model review', 'viewer-status');
    const status = this.make('strong', 'Checking review…', 'viewer-status'); status.setAttribute('aria-label', 'Model review status');
    const notice = this.make('p', 'Review this model before approving it.', 'viewer-status'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const controls = this.make('div', undefined, 'viewer-animation');
    const approve = this.make('button', 'Approve model'), reject = this.make('button', 'Reject model'), refresh = this.make('button', 'Refresh review');
    for (const button of [approve, reject, refresh]) { button.type = 'button'; button.disabled = true; controls.append(button); }
    root.append(title, status, notice, controls); host.append(root);
    const active = () => this.session?.epoch === epoch && this.epoch === epoch && !controller.signal.aborted && current();
    const s: Session = { epoch, controller, active, viewed: { ...viewed }, root, status, notice, approve, reject, refresh, prepared: null, busy: true, fenced: false, blocked: true };
    this.session = s;
    const abort = () => { if (this.session === s) this.clear(); };
    signal.addEventListener('abort', abort, { once: true }); this.unlink = () => signal.removeEventListener('abort', abort);
    const human = (event: Event): boolean => {
      const click = event as MouseEvent;
      return event.isTrusted && !event.defaultPrevented && click.button === 0 && !click.altKey && !click.ctrlKey && !click.metaKey && !click.shiftKey && active();
    };
    approve.addEventListener('click', event => { if (human(event) && !approve.disabled) void this.decide(s, 'approved'); });
    reject.addEventListener('click', event => { if (human(event) && !reject.disabled) void this.decide(s, 'rejected'); });
    refresh.addEventListener('click', event => { if (human(event) && !refresh.disabled) void this.refresh(s); });
    try {
      const data = await this.api.request('prepare', { jobId: viewed.jobId }, controller.signal);
      const prepared = await readAssetReviewStatus(data, viewed, this.cryptography);
      if (!active()) return;
      this.apply(s, prepared); notice.textContent = s.fenced ? 'Decision not confirmed. Check its recorded status before continuing.' :
        this.unknown.size >= 32 ? 'Resolve an unconfirmed model review before making another decision.' : 'Review this version of the model before approving it.';
    } catch { if (active()) { status.textContent = 'Review unavailable'; notice.textContent = 'The review could not be matched to this model. Refresh its status or reload the model.'; } }
    finally { if (active()) { s.busy = false; this.render(s); } }
  }
  private key(s: Session): string { return s.viewed.jobId + ':' + s.viewed.sha256 + ':' + s.prepared?.subjectDigest; }
  private apply(s: Session, prepared: ReviewStatus): void {
    if (s.prepared && (prepared.subjectDigest !== s.prepared.subjectDigest || prepared.review && s.prepared.review &&
        (prepared.review.reviewId !== s.prepared.review.reviewId || prepared.review.revision < s.prepared.review.revision))) invalid();
    s.prepared = prepared; s.fenced = this.unknown.has(this.key(s)); s.blocked = false;
  }
  private render(s: Session): void {
    if (!s.active()) return;
    const review = s.prepared?.review;
    if (s.blocked && !s.busy) s.status.textContent = 'Review unavailable';
    else if (review) s.status.textContent = review.status.charAt(0).toUpperCase() + review.status.slice(1);
    else if (s.prepared) s.status.textContent = 'Review unavailable';
    s.root.setAttribute('data-review-state', s.fenced ? 'unknown' : s.blocked ? 'unavailable' : review?.status ?? 'unavailable');
    s.approve.disabled = s.busy || s.blocked || s.fenced || review?.status !== 'pending' || this.unknown.size >= 32;
    s.reject.disabled = s.busy || s.blocked || s.fenced || !review || review.status === 'rejected' || this.unknown.size >= 32;
    s.refresh.disabled = s.busy;
    s.refresh.textContent = s.fenced ? 'Check review status' : 'Refresh review';
  }
  private async decide(s: Session, decision: Decision): Promise<void> {
    if (!s.active() || s.busy || s.blocked || s.fenced || !s.prepared?.review || this.unknown.size >= 32) return;
    if (s.prepared.review.status === 'rejected' || s.prepared.review.status === decision) return;
    let key: string; try { key = this.cryptography.randomUUID(); } catch { return; }
    if (!UUID.test(key)) return;
    const command: Pending = { reviewId: s.prepared.review.reviewId, decision, idempotencyKey: key, subjectDigest: s.prepared.subjectDigest };
    const subjectKey = this.key(s); this.unknown.set(subjectKey, command); s.busy = true; s.fenced = true; this.render(s);
    try {
      const value = await this.api.request('decide', { reviewId: command.reviewId, decision, idempotencyKey: key }, s.controller.signal);
      const result = receipt(value, s.prepared, command);
      if (!s.active()) return;
      if (result.state !== 'recorded') return invalid();
      this.unknown.delete(subjectKey); this.apply(s, { ...s.prepared, review: result.review });
      s.notice.textContent = result.review.status === 'approved' ? 'Model approved.' : 'Model rejected.';
      // A recorded review decision is feedback for the local learning loop (learned-preferences.ts).
      try { this.doc.dispatchEvent(new (this.doc.defaultView ?? globalThis).CustomEvent('arcane-learning-signal', { detail: { source: 'review', jobId: result.review.subject.jobId, positive: result.review.status === 'approved' } })); } catch { /* Learning is optional. */ }
    } catch { if (s.active()) s.notice.textContent = 'Decision not confirmed. Check its recorded status before continuing.'; }
    finally { if (s.active()) { s.busy = false; this.render(s); } }
  }
  private async refresh(s: Session): Promise<void> {
    if (!s.active() || s.busy) return;
    s.busy = true; this.render(s);
    try {
      const pending = this.unknown.get(this.key(s));
      if (pending && s.prepared) {
        const value = await this.api.request('receipt', { reviewId: pending.reviewId, idempotencyKey: pending.idempotencyKey }, s.controller.signal);
        const result = receipt(value, s.prepared, pending); if (!s.active()) return;
        if (result.state === 'stale') { s.blocked = true; s.notice.textContent = 'This review changed. Reload the model before continuing.'; return; }
        if (result.state === 'recorded') this.unknown.delete(this.key(s));
        this.apply(s, { ...s.prepared, review: result.review });
        s.notice.textContent = result.state === 'recorded' ? 'Recorded review status confirmed.' : 'No recorded decision found. The unconfirmed decision remains blocked.';
      } else {
        const value = await this.api.request('status', { jobId: s.viewed.jobId }, s.controller.signal);
        const prepared = await readAssetReviewStatus(value, s.viewed, this.cryptography); if (!s.active()) return;
        this.apply(s, prepared); s.notice.textContent = prepared.review ? 'Review status refreshed.' : 'Reload this model to prepare a review.';
      }
    } catch { if (s.active()) { s.blocked = true; s.notice.textContent = 'Review status could not be confirmed. No decision was repeated.'; } }
    finally { if (s.active()) { s.busy = false; this.render(s); } }
  }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;
  }
}
