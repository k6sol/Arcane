/// <reference lib="dom" />
/** Live Studio error dock: read-only presentation of the paired plugin's bounded output diagnostics.
 * "Fix" only prefills the active chat composer; nothing is ever sent, queued or retried from here.
 * The reader distinguishes a complete current read from a bounded partial read. Valid captured errors and warnings stay
 * visible when output is truncated, labelled incomplete; only a complete current read can look clear. Superseded or
 * failed reads keep same-session evidence labelled stale. Every read proof covers the exact generation and session. */

export const WORKSPACE_PREFILL_EVENT = 'workspace:prefill';
export const STUDIO_DIAGNOSTICS_ROUTE = '/v1/studio/diagnostics';
export const STUDIO_DIAGNOSTICS_CLEAR_ROUTE = '/v1/studio/diagnostics/clear';
const COMPOSER_LIMIT = 131072;
const DISPLAY = Object.freeze({ groups: 16, entries: 100, message: 2048, source: 512, stack: 2048, place: 200, session: 256, id: 64 });
const RESPONSE_LIMIT = 2 * 1024 * 1024, REQUEST_TIMEOUT_MS = 8000;
const SESSION_TOKEN = /^[a-f0-9]{64}$/;

export interface StudioDiagnosticItem {
  id: string; kind: 'error' | 'warning'; message: string; source: string | null; line: number | null;
  stack: string | null; count: number; firstAt: string; lastAt: string;
}
export interface StudioDiagnosticItemView extends StudioDiagnosticItem { sessionId: string; placeName: string; live: boolean }

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
const iso = (value: unknown): string | null => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;

/** Completeness evidence for one receipt, from the same parse that produced its items. A receipt is complete only when all
 * three counts are zero: every group and entry the daemon sent is shown, exactly as sent. */
export interface StudioDiagnosticsReceipt {
  /** Items shown from this receipt, after every bound. */
  readonly entries: number;
  /** Malformed groups and entries the item reader left out. */
  readonly skipped: number;
  /** Fields that were present with an invalid value and are shown as their default (no source, line or stack; 'Studio'; not live). */
  readonly malformed: number;
  /** Groups, entries and text cut at the display bounds. */
  readonly truncated: number;
}

/** The one wire parser. `readStudioDiagnostics` returns its items, tolerant as before; the headless reader also takes its
 * receipt, so a read can be current only when this parse skipped, defaulted and cut nothing. */
function parseStudioDiagnostics(value: unknown): { readonly items: StudioDiagnosticItemView[]; readonly receipt: StudioDiagnosticsReceipt } {
  if (!plain(value) || !Array.isArray(value.diagnostics)) throw new Error('Studio diagnostics are unavailable.');
  const items: StudioDiagnosticItemView[] = [];
  let skipped = 0, malformed = 0, truncated = Math.max(0, value.diagnostics.length - DISPLAY.groups);
  /** Absent or null optional fields are valid; a present value that does not read is shown as the default and counted. */
  const defaulted = (raw: unknown, read: unknown) => { if (read === null && raw !== undefined && raw !== null) malformed++; };
  const cut = (raw: unknown, max: number) => { if (typeof raw === 'string' && raw.length > max) truncated++; };
  for (const group of value.diagnostics.slice(0, DISPLAY.groups)) {
    if (!plain(group) || !Array.isArray(group.entries)) { skipped++; continue; }
    const sessionId = text(group.sessionId, DISPLAY.session); if (!sessionId) { skipped++; continue; }
    const place = text(group.placeName, DISPLAY.place), placeName = place ?? 'Studio';
    defaulted(group.placeName, place); defaulted(group.live, typeof group.live === 'boolean' ? group.live : null);
    cut(group.sessionId, DISPLAY.session); cut(group.placeName, DISPLAY.place);
    truncated += Math.max(0, group.entries.length - DISPLAY.entries);
    for (const entry of group.entries.slice(0, DISPLAY.entries)) {
      if (!plain(entry)) { skipped++; continue; }
      const id = text(entry.id, DISPLAY.id), message = text(entry.message, DISPLAY.message), firstAt = iso(entry.firstAt), lastAt = iso(entry.lastAt);
      if (!id || !message || !firstAt || !lastAt || (entry.kind !== 'error' && entry.kind !== 'warning')) { skipped++; continue; }
      if (!Number.isSafeInteger(entry.count) || (entry.count as number) < 1) { skipped++; continue; }
      const line = Number.isSafeInteger(entry.line) && (entry.line as number) >= 1 ? entry.line as number : null;
      const source = text(entry.source, DISPLAY.source), stack = text(entry.stack, DISPLAY.stack);
      defaulted(entry.source, source); defaulted(entry.line, line); defaulted(entry.stack, stack);
      cut(entry.id, DISPLAY.id); cut(entry.message, DISPLAY.message); cut(entry.source, DISPLAY.source); cut(entry.stack, DISPLAY.stack);
      items.push({ id, kind: entry.kind, message, source, line, stack,
        count: entry.count as number, firstAt, lastAt, sessionId, placeName, live: group.live === true });
    }
  }
  items.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  truncated += Math.max(0, items.length - DISPLAY.entries);
  const shown = items.slice(0, DISPLAY.entries);
  return { items: shown, receipt: Object.freeze({ entries: shown.length, skipped, malformed, truncated }) };
}

/** Strict reader for the daemon receipt; malformed items are skipped, never rendered raw. Newest first. */
export function readStudioDiagnostics(value: unknown): StudioDiagnosticItemView[] {
  return parseStudioDiagnostics(value).items;
}

/** The exact request a person can review and send themselves. */
export function studioFixPrompt(item: Pick<StudioDiagnosticItem, 'kind' | 'message' | 'source' | 'line'>): string {
  const message = item.message.replace(/\s+/g, ' ').trim();
  const where = (item.source ? ' in ' + item.source : '') + (item.line !== null ? ' line ' + item.line : '');
  return 'Fix this Studio ' + item.kind + ': ' + message + where + '. Read the live script first with script_read.';
}

/** Default prefill target: the shared chat composer used by both providers. Never submits the form. */
export function prefillComposer(doc: Document, value: string): boolean {
  const composer = doc.getElementById('codex-composer');
  if (!(composer instanceof doc.defaultView!.HTMLTextAreaElement)) return false;
  const current = composer.value.trim();
  const next = (current ? composer.value.replace(/\s+$/, '') + '\n\n' : '') + value;
  if (next.length > COMPOSER_LIMIT) return false;
  composer.value = next;
  composer.dispatchEvent(new (doc.defaultView!.Event)('input', { bubbles: true }));
  composer.focus();
  composer.setSelectionRange(composer.value.length, composer.value.length);
  return true;
}

/* ---- Reader state (additive). A pure reducer, so every transition can be tested without a DOM or a network. ---- */

export type StudioDiagnosticsReaderState = 'neutral' | 'current' | 'partial' | 'stale' | 'failed';
/** Why the view is not current (the reason of a stale or failed state). 'superseded': a newer read, stop or clear replaced
 * the proven read; 'incomplete': the receipt held more than the dock can show; 'malformed': it was not read in full. */
export type StudioDiagnosticsFault = 'http' | 'network' | 'malformed' | 'incomplete' | 'offline' | 'skipped' | 'superseded' | 'no-session' | 'session-mismatch';
/** Faults a read reports itself ('skipped' and 'superseded' come only from the skip, begin and supersede events). */
export type StudioDiagnosticsReadFault = Exclude<StudioDiagnosticsFault, 'skipped' | 'superseded'>;
/** Why the reader is neutral: never read, cleared by a person, or a new session epoch that has not been read yet. */
export type StudioDiagnosticsNeutralReason = 'initial' | 'cleared' | 'session-changed';
/** Proof of a captured read: exact request generation/session, parse time, displayed entry count and completeness. */
export interface StudioDiagnosticsProof { readonly generation: number; readonly session: number; readonly at: string; readonly entries: number; readonly complete: boolean }
export interface StudioDiagnosticsSnapshot {
  readonly state: StudioDiagnosticsReaderState;
  /** The neutral or fault reason; null only while complete and current. */
  readonly reason: StudioDiagnosticsNeutralReason | StudioDiagnosticsFault | null;
  /** The HTTP status when the reason is 'http'. */
  readonly httpStatus: number | null;
  /** Current or partial captured items; the last same-session evidence while stale. Empty while neutral or failed. */
  readonly items: readonly StudioDiagnosticItemView[];
  /** Latest issued generation (each read, skip, clear and stop takes one). Only an answer for exactly this one lands. */
  readonly generation: number;
  /** Epoch of the authorised-session observation this view belongs to; 0 before the first. Any change of the observed bearer,
   * including losing it, is a new epoch, and nothing read in another epoch is ever kept or shown. Never the bearer itself. */
  readonly session: number;
  /** True while the read of `generation` is in flight. */
  readonly pending: boolean;
  /** Exact proof and completeness behind the displayed items: kept while stale, null while neutral or failed. */
  readonly proof: StudioDiagnosticsProof | null;
}
/** Every event that takes a generation carries the session epoch observed with it. */
export type StudioDiagnosticsEvent =
  | { readonly type: 'begin'; readonly generation: number; readonly session: number }
  | { readonly type: 'settle'; readonly generation: number; readonly session: number; readonly items: readonly StudioDiagnosticItemView[]; readonly receipt: StudioDiagnosticsReceipt; readonly at: string }
  | { readonly type: 'fault'; readonly generation: number; readonly session: number; readonly fault: StudioDiagnosticsReadFault; readonly httpStatus?: number }
  | { readonly type: 'skip'; readonly generation: number; readonly session: number }
  | { readonly type: 'supersede'; readonly generation: number; readonly session: number }
  | { readonly type: 'cleared'; readonly generation: number; readonly session: number };

const NO_ITEMS: readonly StudioDiagnosticItemView[] = Object.freeze([]);
export const STUDIO_DIAGNOSTICS_INITIAL: StudioDiagnosticsSnapshot = Object.freeze({
  state: 'neutral', reason: 'initial', httpStatus: null, items: NO_ITEMS, generation: 0, session: 0, pending: false, proof: null });

const patch = (from: StudioDiagnosticsSnapshot, change: Partial<StudioDiagnosticsSnapshot>): StudioDiagnosticsSnapshot => Object.freeze({ ...from, ...change });
const answers = (from: StudioDiagnosticsSnapshot, event: { generation: number; session: number }) =>
  from.pending && event.generation === from.generation && event.session === from.session;
/** A different session epoch starts neutral again: output read under another (or no) authorised session is never shown. */
const enter = (from: StudioDiagnosticsSnapshot, session: number): StudioDiagnosticsSnapshot =>
  from.session !== 0 && session !== from.session ? patch(STUDIO_DIAGNOSTICS_INITIAL, { reason: 'session-changed', generation: from.generation, session }) : from;
/** A newer generation ends the current read: its output is kept, labelled stale, until a read of the newer one lands. */
const advance = (from: StudioDiagnosticsSnapshot, generation: number, session: number, pending: boolean): StudioDiagnosticsSnapshot => {
  const next = enter(from, session);
  return next.state === 'current' || next.state === 'partial'
    ? patch(next, { state: 'stale', reason: 'superseded', httpStatus: null, generation, session, pending })
    : patch(next, { generation, session, pending });
};
/** Prior captured output is kept and marked stale; without it the read simply failed. Neither has a current severity. */
const failure = (from: StudioDiagnosticsSnapshot, fault: StudioDiagnosticsReadFault, httpStatus: number | null): StudioDiagnosticsSnapshot => from.proof
  ? patch(from, { state: 'stale', reason: fault, httpStatus, pending: false })
  : patch(from, { state: 'failed', reason: fault, httpStatus, items: NO_ITEMS, pending: false });
const counted = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : -1;
/** A receipt proves a current read only when nothing was skipped, defaulted or cut and it covers exactly the items given. */
function receiptFault(items: readonly StudioDiagnosticItemView[], receipt: StudioDiagnosticsReceipt | undefined): 'malformed' | 'incomplete' | null {
  if (!plain(receipt)) return 'malformed';
  const truncated = counted(receipt.truncated);
  if (counted(receipt.skipped) !== 0 || counted(receipt.malformed) !== 0 || truncated < 0 || counted(receipt.entries) !== items.length) return 'malformed';
  return truncated === 0 ? null : 'incomplete';
}

/** Pure transition. Anything that does not answer the exact pending generation and session returns `from` unchanged. */
export function reduceStudioDiagnostics(from: StudioDiagnosticsSnapshot, event: StudioDiagnosticsEvent): StudioDiagnosticsSnapshot {
  switch (event.type) {
    case 'begin':
      return event.generation > from.generation ? advance(from, event.generation, event.session, true) : from;
    case 'settle': {
      if (!answers(from, event)) return from;
      const fault = receiptFault(event.items, event.receipt);
      if (fault === 'malformed') return failure(from, fault, null);
      // Valid bounded output is fresh evidence, even when it is incomplete. Never substitute an older clean list for it.
      const complete = fault === null;
      return patch(from, { state: complete ? 'current' : 'partial', reason: complete ? null : 'incomplete', httpStatus: null,
        items: Object.freeze(event.items.slice()), pending: false,
        proof: Object.freeze({ generation: event.generation, session: event.session, at: event.at, entries: event.items.length, complete }) });
    }
    case 'fault':
      if (!answers(from, event)) return from;
      return failure(from, event.fault, event.fault === 'http' && Number.isSafeInteger(event.httpStatus) ? event.httpStatus as number : null);
    case 'skip': {
      if (!(event.generation > from.generation)) return from;
      const next = advance(from, event.generation, event.session, false);
      return next.proof ? patch(next, { state: 'stale', reason: 'skipped', httpStatus: null }) : next;
    }
    case 'supersede':
      return event.generation > from.generation ? advance(from, event.generation, event.session, false) : from;
    case 'cleared':
      if (from.pending || event.generation !== from.generation || event.session !== from.session) return from;
      // A person cleared the output: nothing is displayed, and nothing claims a clean read until the next one lands.
      return patch(STUDIO_DIAGNOSTICS_INITIAL, { reason: 'cleared', generation: from.generation, session: from.session });
    default:
      return from;
  }
}

export type StudioDiagnosticsSeverity = 'clear' | 'warnings' | 'errors';
/** A complete current read can prove clear. An exact partial read can only prove captured errors or warnings, never their
 * absence. Superseded, pending and wrong-session evidence has no current severity. */
export function studioDiagnosticsSeverity(snapshot: StudioDiagnosticsSnapshot): StudioDiagnosticsSeverity | null {
  const proof = snapshot.proof;
  if ((snapshot.state !== 'current' && snapshot.state !== 'partial') || snapshot.pending || !proof || proof.generation !== snapshot.generation
    || proof.session !== snapshot.session || proof.entries !== snapshot.items.length
    || (snapshot.state === 'current' ? proof.complete !== true || snapshot.reason !== null : proof.complete !== false || snapshot.reason !== 'incomplete')) return null;
  const errors = snapshot.items.filter(item => item.kind === 'error').length;
  return errors ? 'errors' : snapshot.items.length ? 'warnings' : snapshot.state === 'current' ? 'clear' : null;
}

export type StudioDiagnosticsTone = StudioDiagnosticsSeverity | 'neutral';
/** Exactly one tone class is present; partial reads may show observed severity, but can never show clear. */
export const STUDIO_DIAGNOSTICS_TONES: readonly StudioDiagnosticsTone[] = Object.freeze(['clear', 'warnings', 'errors', 'neutral']);
export interface StudioDiagnosticsPresentation {
  readonly tone: StudioDiagnosticsTone;
  readonly className: string;
  /** Partial reads show observed warning/error only. 'none' requires a complete current read. */
  readonly severity: 'none' | 'warning' | 'error' | 'unknown';
  readonly label: string;
  readonly count: string;
  readonly ariaLabel: string;
  readonly title: string;
  readonly status: string;
}
const CLEAN_STATUS = 'No Studio errors or warnings.';
const clockTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const summarize = (items: readonly StudioDiagnosticItemView[]) => {
  const errors = items.filter(item => item.kind === 'error').length, warnings = items.length - errors;
  return (errors ? errors + (errors === 1 ? ' error' : ' errors') : '') + (errors && warnings ? ', ' : '') + (warnings ? warnings + (warnings === 1 ? ' warning' : ' warnings') : '');
};
function faultText(reason: StudioDiagnosticsSnapshot['reason'], httpStatus: number | null): string {
  switch (reason) {
    case 'http': return 'the read failed' + (httpStatus !== null ? ' (HTTP ' + httpStatus + ')' : '');
    case 'network': return 'Arcane could not be reached';
    case 'malformed': return 'the reply was unreadable';
    case 'incomplete': return 'the reply was too large to show in full';
    case 'offline': return 'the read ran while offline';
    case 'skipped': return 'the read was skipped (no active Studio session)';
    case 'superseded': return 'the read was interrupted';
    case 'no-session': return 'there is no signed-in local session';
    case 'session-mismatch': return 'the local session changed during the read';
    default: return 'the latest read did not complete';
  }
}
/** A read in flight right after a current read (or a stop): the proven output stays on screen but claims nothing. */
const rereading = (snapshot: StudioDiagnosticsSnapshot): boolean =>
  snapshot.pending && snapshot.proof !== null && (snapshot.state === 'current' || snapshot.reason === 'superseded');

/** Labels, classes and text for a snapshot. Pure; the dock renders exactly this. */
export function studioDiagnosticsPresentation(snapshot: StudioDiagnosticsSnapshot, formatTime: (iso: string) => string = clockTime): StudioDiagnosticsPresentation {
  const items = snapshot.items, summary = summarize(items), severity = studioDiagnosticsSeverity(snapshot);
  const proof = snapshot.proof;
  if (snapshot.state === 'partial' && !snapshot.pending && proof && proof.generation === snapshot.generation
    && proof.session === snapshot.session && proof.entries === items.length && proof.complete === false && snapshot.reason === 'incomplete') {
    const tone = severity ?? 'neutral', observed = summary ? 'At least ' + summary + ' captured.' : 'No entries captured; the total is unknown.';
    return Object.freeze({ tone, className: 'studio-diagnostics--' + tone,
      severity: severity === 'errors' ? 'error' : severity === 'warnings' ? 'warning' : 'unknown',
      label: 'Studio (incomplete)', count: items.length ? String(items.length) + '+' : '–',
      ariaLabel: 'Studio output is incomplete. ' + observed, title: 'Studio output is incomplete',
      status: 'Incomplete Studio output. ' + observed + ' More output or text was omitted. Read at ' + formatTime(proof.at) + '.' });
  }
  if (severity) {
    return Object.freeze({ tone: severity, className: 'studio-diagnostics--' + severity, severity: severity === 'errors' ? 'error' : severity === 'warnings' ? 'warning' : 'none',
      label: 'Studio', count: severity === 'clear' ? '' : String(items.length), ariaLabel: 'Studio output: ' + (summary || 'no errors or warnings'),
      title: summary ? 'Studio output: ' + summary : 'Studio output', status: items.length ? '' : CLEAN_STATUS });
  }
  const neutral = { tone: 'neutral', className: 'studio-diagnostics--neutral', severity: 'unknown' } as const;
  // Proven output that is not current now: being read again, stale, or a 'current' snapshot whose proof is not exact.
  if (proof && (snapshot.state === 'stale' || snapshot.state === 'current' || snapshot.state === 'partial')) {
    const when = formatTime(proof.at), incomplete = proof.complete === false;
    const count = items.length ? String(items.length) + (incomplete ? '+' : '') : '–';
    const note = incomplete ? ' (incomplete captured output)' : '';
    const last = 'Last read at ' + when + ': ' + (summary || (incomplete ? 'total unknown' : 'nothing reported')) + note + '.';
    if (rereading(snapshot)) {
      // The label and rows hold still while the next read is in flight (no layout shift), but the tone is neutral.
      return Object.freeze({ ...neutral, label: 'Studio', count, ariaLabel: 'Studio output: checking. ' + last,
        title: 'Studio output: checking', status: 'Checking Studio output. Showing the output read at ' + when + note + '.' });
    }
    // A retry after a fault reads exactly like the settled stale view, so a failing poll does not flicker.
    const fault = faultText(snapshot.reason, snapshot.httpStatus);
    return Object.freeze({ ...neutral, label: 'Studio (stale)', count, ariaLabel: 'Studio output is stale (' + fault + '). ' + last,
      title: 'Studio output is stale: ' + fault, status: 'Stale: ' + fault + '. Showing the output read at ' + when + note + '.' });
  }
  if (snapshot.state === 'failed') {
    const fault = faultText(snapshot.reason, snapshot.httpStatus);
    return Object.freeze({ ...neutral, label: 'Studio (unread)', count: '–', ariaLabel: 'Studio output could not be read (' + fault + ').',
      title: 'Studio output could not be read', status: 'Studio output could not be read: ' + fault + '.' });
  }
  const [ariaLabel, status]: readonly [string, string] = snapshot.reason === 'cleared' ? ['Studio output: cleared, not read since', 'Cleared.']
    : snapshot.reason === 'session-changed' ? ['Studio output: not read for this session yet', 'Studio output has not been read for this session yet.']
    : ['Studio output: not read yet', 'Studio output has not been read yet.'];
  return Object.freeze({ ...neutral, label: 'Studio', count: '–', ariaLabel, title: 'Studio output', status });
}

export interface StudioDiagnosticsOptions {
  token: () => string;
  transport?: typeof fetch;
  /** Brings the conversation into view before the composer is prefilled. */
  showConversation?: () => void;
  intervalMs?: number;
  /** Polls only while this is true (for example, once a Studio session exists); a skipped poll sends no request. */
  active?: () => boolean;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  formatTime?: (iso: string) => string;
  /** Offline probe; a read that starts or finishes while this is false is never current. Default: navigator.onLine. */
  online?: () => boolean;
  /** Clock for the read proof. Default: Date.now. */
  now?: () => number;
  /** Also keep the badge after a clean read without an active Studio session. Active sessions keep their pill visible. */
  showWhenClear?: boolean;
}

export interface StudioDiagnosticsDock {
  stop(): void; resume(): void; refresh(): Promise<void>; items(): readonly StudioDiagnosticItemView[];
  /** The reader state behind the dock (additive). */
  state(): StudioDiagnosticsSnapshot;
  /** Final teardown (additive): stops the poll and every listener; late answers and resume() are ignored afterwards. */
  dispose(): void;
}

export type StudioDiagnosticsReaderOptions = Pick<StudioDiagnosticsOptions, 'token' | 'transport' | 'intervalMs' | 'active' | 'schedule' | 'online' | 'now'>;
export interface StudioDiagnosticsReader {
  snapshot(): StudioDiagnosticsSnapshot;
  subscribe(listener: (snapshot: StudioDiagnosticsSnapshot) => void): () => void;
  /** One read now (does not consult `active`). Never rejects; resolves once the read settles or is superseded. */
  read(): Promise<void>;
  /** Clears the daemon's Studio output, then shows a neutral 'cleared' view. Only a trusted (human) event is accepted. */
  clear(trigger: { readonly isTrusted: boolean } | null | undefined): Promise<boolean>;
  start(): void;
  stop(): void;
  /** Restarts after stop(); false when it was not stopped or is disposed. */
  resume(): boolean;
  dispose(): void;
}

class ReadError extends Error {
  constructor(readonly fault: 'http' | 'network' | 'malformed', readonly status: number | null = null) { super('Studio diagnostics read failed: ' + fault); }
}
/** Runs one step of a read and turns any throw or rejection (including a synchronous one) into a typed fault. */
const guard = async <T>(work: () => T, fault: 'network' | 'malformed'): Promise<Awaited<T>> => {
  try { return await work(); } catch { throw new ReadError(fault); }
};

/** Headless reader: polling, auth epochs, generations and teardown. The dock below is one view of it. */
export function createStudioDiagnosticsReader(options: StudioDiagnosticsReaderOptions): StudioDiagnosticsReader {
  const transport = options.transport ?? ((input, init) => fetch(input, init));
  const schedule = options.schedule ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); });
  const interval = options.intervalMs ?? 4000;
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(snapshot: StudioDiagnosticsSnapshot) => void>();
  /** Requests in flight with their deadline timers, so stop() and dispose() can end both. */
  const inFlight = new Map<AbortController, () => void>();
  const abortAll = () => { for (const [controller, cancelDeadline] of inFlight) { cancelDeadline(); controller.abort(); } inFlight.clear(); };
  /** `observed` is the bearer of the current epoch (null: none). It stays in this closure: never emitted, logged or rendered. */
  let snapshot = STUDIO_DIAGNOSTICS_INITIAL, generation = 0, session = 0, observed: string | null = null;
  let started = false, stopped = false, disposed = false, clearing = false, lap = 0, cancelTimer: (() => void) | null = null;

  const emit = (event: StudioDiagnosticsEvent) => {
    if (disposed) return;
    const next = reduceStudioDiagnostics(snapshot, event);
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of Array.from(listeners)) { try { listener(next); } catch { /* A broken view never stops the reader. */ } }
  };
  const bearer = (): string => { try { const value = options.token(); return typeof value === 'string' ? value : ''; } catch { return ''; } };
  /** Observes the authorised local session. Any change, including losing it or getting it back, opens a new epoch
   * (`session` + 1), and the reducer then drops everything read in the old one. Returns the bearer, or null for none. */
  const observe = (): string | null => {
    const raw = bearer(), token = SESSION_TOKEN.test(raw) ? raw : null;
    if (session === 0 || token !== observed) { observed = token; session++; }
    return token;
  };
  const isOnline = (): boolean => { try { return online() !== false; } catch { return false; } };
  const stamp = (): string => { try { const at = now(); if (Number.isFinite(at)) return new Date(at).toISOString(); } catch { /* Fall back below. */ } return new Date().toISOString(); };
  const request = async (path: string, token: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    inFlight.set(controller, () => clearTimeout(deadline));
    try {
      const response = await guard(() => transport(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }), 'network');
      if (!response.ok) throw new ReadError('http', response.status);
      const raw = await guard(() => response.text(), 'network');
      if (raw.length > RESPONSE_LIMIT) throw new ReadError('malformed');
      return await guard(() => JSON.parse(raw) as unknown, 'malformed');
    } finally { clearTimeout(deadline); inFlight.delete(controller); }
  };
  const read = async (): Promise<void> => {
    if (disposed || stopped || clearing) return;
    const mine = ++generation, token = observe(), own = session;
    emit({ type: 'begin', generation: mine, session: own });
    // Reads require the authorised local session: without one no request is sent and nothing can become current.
    if (token === null) { emit({ type: 'fault', generation: mine, session: own, fault: 'no-session' }); return; }
    if (!isOnline()) { emit({ type: 'fault', generation: mine, session: own, fault: 'offline' }); return; }
    let outcome: StudioDiagnosticsEvent;
    try {
      const value = await request(STUDIO_DIAGNOSTICS_ROUTE, token);
      // One parse gives items and completeness evidence; valid truncated output remains explicitly partial.
      const { items, receipt } = await guard(() => parseStudioDiagnostics(value), 'malformed');
      outcome = { type: 'settle', generation: mine, session: own, items, receipt, at: stamp() };
    } catch (error) {
      const fault = error instanceof ReadError ? error : new ReadError('network');
      outcome = fault.status === null ? { type: 'fault', generation: mine, session: own, fault: fault.fault }
        : { type: 'fault', generation: mine, session: own, fault: fault.fault, httpStatus: fault.status };
    }
    // An answer for an older generation, or for a stopped or disposed reader, never lands: the newer one owns the view.
    if (disposed || mine !== generation) return;
    // Proof of session: the observation must be unchanged when the answer arrives. A change (another bearer, or none) is a
    // new epoch: this answer is dropped, and so is everything shown from the old one.
    const current = observe();
    if (session !== own) {
      const next = ++generation;
      emit({ type: 'begin', generation: next, session });
      emit({ type: 'fault', generation: next, session, fault: current === null ? 'no-session' : 'session-mismatch' });
      return;
    }
    if (!isOnline()) { emit({ type: 'fault', generation: mine, session: own, fault: 'offline' }); return; }
    emit(outcome);
  };
  // A skipped poll sends nothing, but still observes the session, so a lost or changed one drops the old output at once.
  const skip = () => { if (disposed || stopped || clearing) return; observe(); emit({ type: 'skip', generation: ++generation, session }); };
  const loop = (own: number): void => {
    cancelTimer = null;
    if (disposed || stopped || own !== lap) return;
    let wanted = true; try { wanted = options.active?.() ?? true; } catch { wanted = false; }
    let pass = Promise.resolve();
    if (wanted) pass = read(); else skip();
    void pass.finally(() => { if (!disposed && !stopped && own === lap && !cancelTimer) cancelTimer = schedule(() => loop(own), interval); });
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read,
    async clear(trigger) {
      // Human-initiated only: the dock passes its own trusted click; nothing in the reader ever clears on its own.
      if (disposed || stopped || clearing || trigger?.isTrusted !== true) return false;
      // Only the epoch that produced the view can clear it. A changed observation resets the view and clears nothing.
      const shown = session, token = observe();
      if (session !== shown) { emit({ type: 'supersede', generation: ++generation, session }); return false; }
      if (token === null) return false;
      const mine = ++generation;
      clearing = true;
      emit({ type: 'supersede', generation: mine, session: shown });
      try {
        await request(STUDIO_DIAGNOSTICS_CLEAR_ROUTE, token, {});
        if (disposed || mine !== generation) return false;
        observe();
        if (session !== shown) { emit({ type: 'supersede', generation: ++generation, session }); return false; }
        emit({ type: 'cleared', generation: mine, session: shown });
        return true;
      } catch { return false; } finally { clearing = false; }
    },
    start() { if (disposed || started) return; started = true; if (!stopped) loop(++lap); },
    stop() {
      if (disposed || stopped) return;
      stopped = true; lap++; cancelTimer?.(); cancelTimer = null;
      abortAll();
      emit({ type: 'supersede', generation: ++generation, session });
    },
    resume() {
      if (disposed || !stopped) return false;
      stopped = false;
      if (started) loop(++lap);
      return true;
    },
    dispose() {
      if (disposed) return;
      cancelTimer?.(); cancelTimer = null; listeners.clear();
      abortAll();
      // Final, and silent (the listeners are gone): what was shown is no longer claimed current, and nothing lands after this.
      snapshot = reduceStudioDiagnostics(snapshot, { type: 'supersede', generation: ++generation, session });
      disposed = true; stopped = true; lap++;
    },
  };
}

const SVG = 'http://www.w3.org/2000/svg';
/** The pill's glyph: a terminal window, for Studio's output. */
function outputIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.75'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const frame = doc.createElementNS(SVG, 'rect');
  for (const [name, value] of [['x', '3.5'], ['y', '4.5'], ['width', '17'], ['height', '15'], ['rx', '2.5']] as const) frame.setAttribute(name, value);
  svg.append(frame);
  for (const d of ['m7.5 9.5 3 2.5-3 2.5', 'M12.5 15h4']) { const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
/** Which state the pill shows. Green, yellow and red come only from a current read; anything else is neutral. */
/** How fresh the dock's list is: never read, the latest read (current), an older list kept after a failed or skipped read
 * (stale), or no list because the latest read failed (failed). */
export type StudioDiagnosticsRead = 'none' | 'current' | 'stale' | 'failed';
export function studioDiagnosticsTone(read: StudioDiagnosticsRead, items: readonly Pick<StudioDiagnosticItem, 'kind'>[]): StudioDiagnosticsTone {
  if (read !== 'current') return 'neutral';
  return items.some(item => item.kind === 'error') ? 'errors' : items.length ? 'warnings' : 'clear';
}

export function startStudioDiagnostics(doc: Document, options: StudioDiagnosticsOptions): StudioDiagnosticsDock {
  const mount = doc.getElementById('studio-diagnostics');
  if (!mount) return { stop() {}, resume() {}, async refresh() {}, items: () => NO_ITEMS, state: () => STUDIO_DIAGNOSTICS_INITIAL, dispose() {} };
  const reader = createStudioDiagnosticsReader({ ...options, online: options.online ?? (() => doc.defaultView?.navigator.onLine !== false) });
  const formatTime = options.formatTime ?? clockTime;
  const ui = new AbortController(), signal = ui.signal;
  let notice = '', clearing = false, disposed = false, listed: readonly StudioDiagnosticItemView[] | null = null;

  // Prefill is a public DOM contract so either chat can be targeted without importing it.
  const onPrefill = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (disposed || !plain(detail) || typeof detail.text !== 'string' || !detail.text) return;
    options.showConversation?.();
    if (!prefillComposer(doc, detail.text)) { notice = 'The message box could not take this request.'; render(); }
  };

  const toggle = doc.createElement('button');
  toggle.type = 'button'; toggle.id = 'studio-diagnostics-toggle'; toggle.className = 'studio-diagnostics-badge';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'studio-diagnostics-panel');
  const count = doc.createElement('span'); count.className = 'studio-diagnostics-count';
  const label = doc.createElement('span'); label.className = 'studio-diagnostics-label'; label.textContent = 'Studio';
  toggle.append(outputIcon(doc), label, count);
  const panel = doc.createElement('section');
  panel.id = 'studio-diagnostics-panel'; panel.className = 'studio-diagnostics-panel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'studio-diagnostics-title');
  const header = doc.createElement('div'); header.className = 'studio-diagnostics-header';
  const title = doc.createElement('h2'); title.id = 'studio-diagnostics-title'; title.textContent = 'Studio output';
  const clear = doc.createElement('button'); clear.type = 'button'; clear.className = 'secondary studio-diagnostics-clear'; clear.textContent = 'Clear';
  header.append(title, clear);
  const status = doc.createElement('p'); status.className = 'studio-diagnostics-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = doc.createElement('ul'); list.className = 'studio-diagnostics-list';
  panel.append(header, status, list);
  mount.replaceChildren(toggle, panel);

  const studioActive = () => { try { return options.active?.() ?? true; } catch { return false; } };
  const open = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (value: boolean) => { toggle.setAttribute('aria-expanded', String(value)); panel.hidden = !value; };
  const renderRow = (item: StudioDiagnosticItemView) => {
    const row = doc.createElement('li'); row.className = 'studio-diagnostic'; row.dataset.kind = item.kind; row.dataset.id = item.id;
    const kind = doc.createElement('span'); kind.className = 'studio-diagnostic-kind'; kind.textContent = item.kind === 'error' ? 'Error' : 'Warning';
    const message = doc.createElement('p'); message.className = 'studio-diagnostic-message'; message.textContent = item.message;
    const meta = doc.createElement('p'); meta.className = 'studio-diagnostic-meta';
    const parts = [item.source ?? 'Studio output', ...(item.line !== null ? ['line ' + item.line] : []), ...(item.count > 1 ? ['×' + item.count] : []), formatTime(item.lastAt)];
    meta.textContent = parts.join(' · ');
    if (item.stack) meta.title = item.stack;
    const place = doc.createElement('p'); place.className = 'studio-diagnostic-place'; place.textContent = item.placeName + (item.live ? '' : ' (disconnected)');
    const fix = doc.createElement('button'); fix.type = 'button'; fix.className = 'studio-diagnostic-fix'; fix.textContent = 'Fix';
    fix.setAttribute('aria-label', 'Fix: ' + item.message.slice(0, 120));
    fix.addEventListener('click', () => {
      // Prefill only: the request lands in the message box for a person to review and send. Nothing is sent from here.
      doc.dispatchEvent(new (doc.defaultView!.CustomEvent)(WORKSPACE_PREFILL_EVENT, { detail: { text: studioFixPrompt(item) } }));
      setOpen(false); render();
    }, { signal });
    const body = doc.createElement('div'); body.className = 'studio-diagnostic-body'; body.append(kind, message, meta, place);
    row.append(body, fix); return row;
  };
  const render = () => {
    if (disposed) return;
    const observed = reader.snapshot();
    const active = studioActive();
    // A current receipt alone does not prove a live Studio session. Preserve the existing active-session presentation gate.
    const snapshot = !active && (observed.state === 'current' || observed.state === 'partial')
      ? patch(observed, { state: 'stale', reason: 'skipped' }) : observed;
    const items = snapshot.items, view = studioDiagnosticsPresentation(snapshot, formatTime);
    // The daemon holds more output than the dock can show: keep the badge so a person can see why, and Clear it.
    const overflow = snapshot.reason === 'incomplete' || snapshot.proof?.complete === false;
    // The opt-in clear pill holds its place (neutral, never green) while its next read is in flight: no topbar shift per poll.
    const pinned = options.showWhenClear === true && (view.tone === 'clear' || rereading(snapshot));
    mount.hidden = items.length === 0 && !open() && !overflow && !pinned && !active;
    // Observed partial errors/warnings retain severity; only complete current output may claim no errors.
    mount.dataset.reader = snapshot.state;
    mount.dataset.severity = view.severity;
    for (const tone of STUDIO_DIAGNOSTICS_TONES) mount.classList.toggle('studio-diagnostics--' + tone, tone === view.tone);
    label.textContent = view.label;
    count.textContent = view.count;
    toggle.setAttribute('aria-label', view.ariaLabel);
    toggle.title = view.title;
    clear.disabled = clearing || (items.length === 0 && !overflow);
    // Rows are rebuilt only when the displayed items change, so a poll does not steal focus from a Fix button.
    if (items !== listed) { listed = items; list.replaceChildren(...items.map(renderRow)); }
    // While a read or clear is in flight the live region is busy, so assistive technology announces only where it settles.
    status.setAttribute('aria-busy', String(snapshot.pending || clearing));
    const line = notice || (clearing ? 'Clearing Studio output.' : view.status);
    if (status.textContent !== line) status.textContent = line;
  };
  toggle.addEventListener('click', () => { setOpen(!open()); render(); }, { signal });
  clear.addEventListener('click', event => {
    // Human-initiated only: a scripted click (isTrusted false) never clears, and nothing else calls the clear route.
    if (!event.isTrusted || clearing || disposed) return;
    clearing = true; notice = ''; render();
    void reader.clear(event).then(done => {
      clearing = false;
      if (disposed) return;
      if (!done) notice = 'Studio output could not be cleared.';
      render();
    });
  }, { signal });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { setOpen(false); render(); toggle.focus(); } }, { signal });
  doc.addEventListener(WORKSPACE_PREFILL_EVENT, onPrefill);
  const unsubscribe = reader.subscribe(() => { notice = ''; render(); });
  render(); reader.start();
  return {
    stop() { if (disposed) return; reader.stop(); doc.removeEventListener(WORKSPACE_PREFILL_EVENT, onPrefill); },
    resume() { if (disposed || !reader.resume()) return; doc.addEventListener(WORKSPACE_PREFILL_EVENT, onPrefill); },
    refresh: () => reader.read(),
    items: () => reader.snapshot().items,
    state: () => reader.snapshot(),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe(); reader.dispose(); ui.abort();
      doc.removeEventListener(WORKSPACE_PREFILL_EVENT, onPrefill);
    },
  };
}
