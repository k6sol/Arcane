/**
 * Arcane learns from feedback on its own results (local only; no model weights change).
 *
 * In chat: a "Was this right?" thumbs up / down row under each finished reply and on generated-model cards, with an optional
 * short reason; the next message is also read as feedback ("no not good", "trees look the same", "perfect"), as are an undo
 * of the build, asking for the same thing again and a model review decision (document event
 * `arcane-learning-signal`). Each signal goes to the daemon's human-only /v1/preferences/signal with the turn's Arcane tool
 * calls; the daemon classifies it locally and updates per-option preference weights. When a preference changes, a small
 * "Learning" note says what Arcane will do differently.
 *
 * In Settings > Project memory > What Arcane has learned: every learned preference with its evidence, Prefer / Avoid /
 * Remove, Forget all and an on/off switch. Reads happen only when that page is shown or after a learning update.
 *
 * Nothing here uses browser storage; turn context lives in memory for this window only. Text is set with textContent.
 */
export const LEARNED_SECTION_ID = 'settings-memory';
export const LEARNED_SIGNAL_EVENT = 'arcane-learning-signal';
const REASON_CHARS = 160, TOOL_INPUT_CHARS = 16_384, TOOLS = 48;
/** Output-producing Arcane tools whose inputs describe what was built (others carry no learnable parameters). */
const OUTPUT_TOOLS = new Set(['scene_build', 'environment_apply', 'assets_procedural', 'skills_get', 'terrain_generate', 'scene_create', 'scene_update', 'script_update']);
const UNDO_TOOLS = new Set(['receipt_restore', 'scene_delete']);
const TURN_TTL_MS = 6 * 3600 * 1000;
const JOBS = 128, JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ChatFeedbackTool { name: string; status?: string; input?: string; result?: string; article?: HTMLElement | null }
export interface ChatFeedbackHooks {
  /** A user message is about to be sent in tab `key` (its echo article is `anchor`). */
  userMessage(event: { key: string; text: string; box: HTMLElement | null; anchor: HTMLElement | null }): void;
  /** A reply finished in tab `key`; `tools` are the turn's tool calls in order. */
  turnFinished(event: { key: string; ok: boolean; tools: readonly ChatFeedbackTool[]; box: HTMLElement | null }): void;
}
export interface LearnedView {
  id: string; param: string; value: string; label: string; stance: 'like' | 'dislike' | 'unsure'; evidence: number; pinned: 'like' | 'dislike' | null; mean: number;
}
export interface LearnedSnapshot { enabled: boolean; project: LearnedView[]; global: LearnedView[]; context: string; warnings: string[] }
export interface LearnedOptions { token: () => string; fetch?: typeof fetch; now?: () => number }
export interface LearnedController { hooks: ChatFeedbackHooks; reload(): Promise<void>; stop(): void; resume(): void }

const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const short = (name: string) => name.replace(/^mcp__[A-Za-z0-9_-]+__/, '');
function readView(value: unknown): LearnedView | null {
  const row = rec(value); if (!row) return null;
  const { id, param, label, stance, evidence, pinned, mean } = row, item = row.value;
  if (typeof id !== 'string' || id.length > 96 || typeof param !== 'string' || typeof item !== 'string' || typeof label !== 'string' || label.length > 160 ||
      (stance !== 'like' && stance !== 'dislike' && stance !== 'unsure') || typeof evidence !== 'number' || !Number.isFinite(evidence) || typeof mean !== 'number' ||
      (pinned !== null && pinned !== 'like' && pinned !== 'dislike')) return null;
  return { id, param, value: item, label, stance, evidence: Math.max(0, Math.round(evidence)), pinned: pinned as LearnedView['pinned'], mean };
}
/** Strict reader for the daemon snapshot; null when it is not understood. */
export function readLearnedSnapshot(value: unknown): LearnedSnapshot | null {
  const row = rec(value); if (!row || typeof row.enabled !== 'boolean' || !Array.isArray(row.project) || !Array.isArray(row.global) || typeof row.context !== 'string' || !Array.isArray(row.warnings)) return null;
  const list = (items: unknown[]) => items.slice(0, 200).map(readView).filter((item): item is LearnedView => !!item);
  return { enabled: row.enabled, project: list(row.project), global: list(row.global), context: row.context.slice(0, 600),
    warnings: row.warnings.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 300)).slice(0, 4) };
}
/** The tool calls a signal carries: Arcane output tools only, bounded. Exported for tests. */
export function feedbackTools(tools: readonly ChatFeedbackTool[]): { name: string; input: string }[] {
  return tools.filter(tool => OUTPUT_TOOLS.has(short(tool.name)) && tool.status === 'finished' && typeof tool.input === 'string' && tool.input.length <= TOOL_INPUT_CHARS)
    .slice(-TOOLS).map(tool => ({ name: short(tool.name), input: tool.input! }));
}
function jobIdOf(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const value = rec(JSON.parse(text)), nested = rec(value?.job)?.jobId;
    if (value?.jobId !== undefined && nested !== undefined && value.jobId !== nested) return null;
    const id = value?.jobId ?? nested;
    return typeof id === 'string' && JOB_ID.test(id) ? id : null;
  } catch { return null; }
}

const SVG = 'http://www.w3.org/2000/svg';
const THUMB = 'M7 10v10H4V10h3Zm2 10h7.6a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 17.8 10H14V6.5A2.5 2.5 0 0 0 11.5 4L9 10v10Z';
function thumbIcon(doc: Document, down: boolean): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.classList.add('feedback-icon');
  if (down) svg.setAttribute('transform', 'rotate(180)');
  const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', THUMB); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path); return svg;
}

export function startLearnedPreferences(doc: Document, options: LearnedOptions): LearnedController {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  let stopped = false, busy = false, snapshot: LearnedSnapshot | null = null, forgetArmed = false, lifecycle = 0;
  const cleanups: (() => void)[] = [];
  /** Per chat tab: the last turn that built something, and the last request text (re-ask detection). Memory only. */
  const turns = new Map<string, { tools: { name: string; input: string }[]; at: number }>();
  const prompts = new Map<string, string>();
  // A job is immutable: conflicting call inputs fence its feedback instead of replacing it with another subject.
  const jobs = new Map<string, { tool: { name: string; input: string } | null; at: number }>();
  function jobTools(jobId: string | null): { name: string; input: string }[] {
    const at = now();
    for (const [id, row] of jobs) if (at < row.at || at - row.at > TURN_TTL_MS) jobs.delete(id);
    const row = jobId ? jobs.get(jobId) : null;
    return row?.tool ? [row.tool] : [];
  }
  function rememberJobs(tools: readonly ChatFeedbackTool[]): void {
    jobTools(null);
    for (const call of tools) {
      if (short(call.name) !== 'assets_procedural' || call.status !== 'finished') continue;
      const [tool] = feedbackTools([call]), id = jobIdOf(call.result);
      if (!tool || !id) continue;
      let result: Record<string, unknown> | null = null;
      try { result = rec(JSON.parse(call.result!)); } catch { continue; }
      const job = rec(result?.job) ?? result;
      if (!result || result.error || result.isError === true || !job || !['queued', 'running', 'succeeded'].includes(String(job.state))) continue;
      const previous = jobs.get(id);
      jobs.set(id, { tool: previous && (previous.tool === null || previous.tool.input !== tool.input) ? null : tool, at: previous?.at ?? now() });
      while (jobs.size > JOBS) jobs.delete(jobs.keys().next().value!);
    }
  }

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; value: unknown; message: string }> {
    const token = options.token();
    if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, value: null, message: 'Learning needs the local desktop session.' };
    try {
      const response = await doFetch(path, { method, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const value: unknown = await response.json().catch(() => null);
      const message = typeof rec(value)?.message === 'string' ? String(rec(value)!.message).slice(0, 300) : '';
      return { ok: response.ok, value, message: response.ok ? '' : message || 'Learning is unavailable right now.' };
    } catch { return { ok: false, value: null, message: 'Learning is unavailable right now.' }; }
  }

  // ---- chat: signals and the Learning note ----
  function note(host: HTMLElement | null, after: HTMLElement | null, text: string): void {
    if (!host || stopped || !text) return;
    const line = make('p', 'learning-note');
    line.setAttribute('role', 'status');
    line.append(make('span', 'learning-note-badge', 'Learning'), make('span', 'learning-note-text', text));
    if (after && after.parentNode === host) after.after(line); else host.append(line);
  }
  async function signal(body: Record<string, unknown>): Promise<string | null> {
    if (stopped || snapshot?.enabled === false) return null;
    const { ok, value } = await call('POST', '/v1/preferences/signal', body);
    const reply = rec(value);
    if (!ok || !reply || reply.enabled !== true) return null;
    if (reply.learned === true && settingsShown()) void reload();
    else if (reply.learned === true) snapshot = null;
    return typeof reply.message === 'string' && reply.learned === true ? reply.message.slice(0, 300) : null;
  }
  function feedbackRow(className: string, label: string, tools: { name: string; input: string }[] | (() => { name: string; input: string }[]), compact = false): HTMLElement {
    const row = make('div', className); row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
    if (!compact) row.append(make('span', 'feedback-prompt', 'Was this right?'));
    const up = make('button', 'feedback-button'), down = make('button', 'feedback-button');
    for (const [button, vote, name] of [[up, 'up', 'Good result'], [down, 'down', 'Not right']] as const) {
      button.type = 'button'; button.dataset.vote = vote; button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', name); button.title = name;
      button.append(thumbIcon(doc, vote === 'down'));
    }
    const form = make('form', 'feedback-reason'); form.hidden = true;
    const input = make('input', 'feedback-reason-input'); input.type = 'text'; input.maxLength = REASON_CHARS; input.autocomplete = 'off';
    input.placeholder = 'What should change? e.g. too plain, trees look the same'; input.setAttribute('aria-label', 'What should change (optional)');
    const send = make('button', 'feedback-send', 'Send'); send.type = 'submit';
    const skip = make('button', 'feedback-skip', 'Skip'); skip.type = 'button';
    form.append(input, send, skip);
    const status = make('p', 'feedback-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    row.append(up, down, form, status);
    let sent: 'positive' | 'negative' | null = null, sending = false;
    const press = (vote: 'positive' | 'negative' | null) => { up.setAttribute('aria-pressed', String(vote === 'positive')); down.setAttribute('aria-pressed', String(vote === 'negative')); };
    async function submit(polarity: 'positive' | 'negative', reason: string): Promise<void> {
      if (sending || stopped) return;
      const scoped = typeof tools === 'function' ? tools() : tools;
      if (!scoped.length) { form.hidden = true; press(null); status.textContent = 'Refresh this model preview before rating it.'; return; }
      sending = true; form.hidden = true; press(polarity);
      status.textContent = 'Thanks — learning from this…';
      const message = await signal({ source: 'explicit', polarity, ...(reason ? { reason: reason.slice(0, REASON_CHARS) } : {}), tools: scoped });
      sending = false; sent = polarity;
      status.textContent = message ?? (snapshot?.enabled === false ? 'Thanks. Learning is off in Settings, so nothing was saved.' : polarity === 'positive' ? 'Thanks — noted.' : 'Thanks — noted. Tell me what to change and I\'ll fix it.');
      status.dataset.learned = String(!!message);
    }
    up.addEventListener('click', () => { if (sent !== 'positive') void submit('positive', ''); });
    down.addEventListener('click', () => { if (sent === 'negative' || sending) return; press('negative'); form.hidden = false; status.textContent = ''; input.focus(); });
    form.addEventListener('submit', event => { event.preventDefault(); void submit('negative', input.value.trim()); });
    skip.addEventListener('click', () => void submit('negative', ''));
    return row;
  }
  const hooks: ChatFeedbackHooks = {
    userMessage({ key, text, box, anchor }) {
      if (stopped || typeof text !== 'string') return;
      const previous = prompts.get(key); prompts.set(key, text.slice(0, 2000));
      const last = turns.get(key);
      if (!last || now() - last.at > TURN_TTL_MS || !last.tools.length) return;
      void signal({ source: 'message', text: text.slice(0, 2000), ...(previous ? { previous } : {}), tools: last.tools }).then(message => { if (message) note(box, anchor, message); });
    },
    turnFinished({ key, ok, tools, box }) {
      if (stopped || !ok) return;
      const outputs = feedbackTools(tools), last = turns.get(key);
      if (last && now() - last.at <= TURN_TTL_MS && tools.some(tool => UNDO_TOOLS.has(short(tool.name)) && tool.status !== 'failed'))
        void signal({ source: 'undo', tools: last.tools }).then(message => { if (message) note(box, null, message); });
      if (outputs.length) turns.set(key, { tools: outputs, at: now() });
      rememberJobs(tools);
      if (!box) return;
      // Generated-model cards: a compact rating scoped to the procedural call that made the previewed job.
      for (const tool of tools) {
        if (short(tool.name) !== 'assets_preview' || tool.status !== 'finished' || !tool.article?.isConnected || tool.article.querySelector('.model-feedback')) continue;
        const job = jobIdOf(tool.input), scoped = job && jobIdOf(tool.result) === job ? jobTools(job) : [];
        if (scoped.length) tool.article.append(feedbackRow('model-feedback', 'Rate this model', () => jobIdOf(tool.input) === job && jobIdOf(tool.result) === job ? jobTools(job) : [], true));
      }
      if (!outputs.length) return;
      // Under the reply's own text (aligned with it, like the usage line); otherwise at the end of the transcript.
      const replies = box.querySelectorAll<HTMLElement>('.codex-message[data-role=assistant]'), lastReply = replies[replies.length - 1];
      const users = box.querySelectorAll<HTMLElement>('.codex-message[data-role=user]'), lastUser = users[users.length - 1];
      const after = lastReply && (!lastUser || lastUser.compareDocumentPosition(lastReply) & 4) ? lastReply : null;
      (after ?? box).append(feedbackRow('turn-feedback', 'Rate this result', outputs));
    },
  };
  const onSignal = (event: Event) => {
    const detail = rec((event as CustomEvent).detail);
    if (!detail || detail.source !== 'review' || typeof detail.positive !== 'boolean' || typeof detail.jobId !== 'string' || !JOB_ID.test(detail.jobId)) return;
    const tools = jobTools(detail.jobId);
    if (tools.length) void signal({ source: 'review', polarity: detail.positive ? 'positive' : 'negative', tools });
  };

  // ---- Settings: What Arcane has learned ----
  function settingsShown(): boolean {
    const section = el(LEARNED_SECTION_ID); if (!section || section.hidden) return false;
    const drawer = section.closest('dialog'); return !drawer || (drawer as HTMLDialogElement).open;
  }
  const say = (text: string, kind: 'info' | 'error' | 'ready' = 'info') => { const status = el('learned-status'); if (status) { status.textContent = text; status.dataset.kind = kind; } };
  function render(): void {
    const list = el('learned-list'), toggle = el<HTMLInputElement>('learned-enabled'), forget = el<HTMLButtonElement>('learned-forget');
    if (toggle) { toggle.disabled = busy || stopped || !snapshot; toggle.checked = snapshot?.enabled ?? true; }
    if (forget) { forget.disabled = busy || stopped || !snapshot; forget.textContent = forgetArmed ? 'Click again to forget everything' : 'Forget all'; forget.dataset.armed = String(forgetArmed); }
    if (!list) return;
    if (!snapshot) { list.replaceChildren(); return; }
    const rows: HTMLElement[] = [];
    const shown = new Set<string>();
    const add = (view: LearnedView, layer: 'project' | 'global') => {
      if (shown.has(view.id)) return; shown.add(view.id);
      const li = make('li', 'learned-item'); li.dataset.stance = view.stance; li.dataset.id = view.id;
      const badge = make('span', 'learned-stance', view.stance === 'like' ? 'Prefers' : view.stance === 'dislike' ? 'Avoids' : 'Unsure');
      const label = make('span', 'learned-label', view.label);
      const meta = make('span', 'learned-meta', (view.evidence === 1 ? '1 signal' : view.evidence + ' signals') + ' · ' + (layer === 'project' ? 'this project' : 'all projects') + (view.pinned ? ' · set by you' : ''));
      const actions = make('span', 'learned-actions');
      const button = (text: string, action: 'like' | 'dislike' | 'clear' | 'delete', pressed?: boolean) => {
        const b = make('button', 'settings-text-button learned-action', text); b.type = 'button'; b.disabled = busy || stopped;
        if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
        b.setAttribute('aria-label', text + ': ' + view.label);
        b.addEventListener('click', () => void edit(layer, view.id, action === 'like' && view.pinned === 'like' || action === 'dislike' && view.pinned === 'dislike' ? 'clear' : action));
        return b;
      };
      actions.append(button('Prefer', 'like', view.pinned === 'like'), button('Avoid', 'dislike', view.pinned === 'dislike'), button('Remove', 'delete'));
      li.append(badge, label, meta, actions); rows.push(li);
    };
    for (const view of snapshot.project) add(view, 'project');
    for (const view of snapshot.global) add(view, 'global');
    list.replaceChildren(...rows);
    const empty = el('learned-empty'); if (empty) empty.hidden = rows.length > 0;
  }
  function show(next: LearnedSnapshot): void {
    snapshot = next; forgetArmed = false;
    const count = next.project.length + new Set(next.global.map(view => view.id).filter(id => !next.project.some(view => view.id === id))).size;
    say(next.warnings[0] ?? (!next.enabled ? 'Learning is off. Arcane keeps what it learned but does not use it or learn more.'
      : count ? 'Arcane uses these in every chat and fills them in when a build leaves a setting open. Your explicit requests always win.'
      : 'Nothing learned yet. Rate a result with the thumbs, or just tell Arcane what you think of it.'), next.warnings.length ? 'error' : 'info');
    render();
  }
  async function reload(): Promise<void> {
    if (stopped || busy) return;
    const generation = lifecycle; busy = true; render();
    const { ok, value, message } = await call('GET', '/v1/preferences');
    if (generation !== lifecycle) return;
    busy = false;
    const read = ok ? readLearnedSnapshot(value) : null;
    if (read) show(read); else { say(message || 'What Arcane has learned could not be read.', 'error'); render(); }
  }
  async function mutate(path: string, body: unknown, done: string): Promise<void> {
    if (stopped || busy) return;
    const generation = lifecycle; busy = true; render();
    const { ok, value, message } = await call('POST', path, body);
    if (generation !== lifecycle) return;
    busy = false;
    const read = ok ? readLearnedSnapshot(value) : null;
    if (read) { show(read); say(done, 'ready'); } else { say(message || 'That change was not saved.', 'error'); render(); }
  }
  const edit = (layer: 'project' | 'global', id: string, action: 'like' | 'dislike' | 'clear' | 'delete') =>
    mutate('/v1/preferences/edit', { layer, id, action }, action === 'delete' ? 'Removed. Arcane will stop using it.' : action === 'clear' ? 'Back to learning from your feedback.' : 'Saved. Arcane will follow this until you change it.');
  function bind(): void {
    if (cleanups.length) return;
    const on = (target: EventTarget | null, type: string, handler: (event: Event) => void) => {
      if (!target) return; target.addEventListener(type, handler); cleanups.push(() => target.removeEventListener(type, handler));
    };
    on(doc, LEARNED_SIGNAL_EVENT, onSignal);
    on(el('learned-enabled'), 'change', event => {
      const enabled = (event.target as HTMLInputElement).checked;
      void mutate('/v1/preferences/enabled', { enabled }, enabled ? 'Learning is on.' : 'Learning is off. Nothing new is learned or used.');
    });
    on(el('learned-forget'), 'click', () => {
      if (!forgetArmed) { forgetArmed = true; render(); return; }
      void mutate('/v1/preferences/forget', { confirm: true }, 'Forgotten. Arcane starts learning from scratch.');
    });
    on(el('learned-forget'), 'blur', () => { if (forgetArmed) { forgetArmed = false; render(); } });
    const section = el(LEARNED_SECTION_ID), Observer = doc.defaultView?.MutationObserver;
    if (section && Observer) {
      let shown = settingsShown();
      const observer = new Observer(() => { const next = settingsShown(); if (next && !shown) void reload(); shown = next; });
      observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
      const drawer = section.closest('dialog'); if (drawer) observer.observe(drawer, { attributes: true, attributeFilter: ['open'] });
      cleanups.push(() => observer.disconnect());
    }
  }
  function stop(): void { stopped = true; lifecycle++; busy = false; for (const cleanup of cleanups.splice(0)) cleanup(); render(); }
  function resume(): void {
    if (!stopped && cleanups.length) return;
    stopped = false; lifecycle++; bind(); render();
    if (settingsShown()) void reload();
  }
  resume();
  return { hooks, reload, stop, resume };
}
