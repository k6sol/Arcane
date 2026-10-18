/// <reference lib="dom" />
/** Live Studio error dock: read-only presentation of the paired plugin's bounded output diagnostics.
 * "Fix" only prefills the active chat composer; nothing is ever sent, queued or retried from here. */

export const WORKSPACE_PREFILL_EVENT = 'workspace:prefill';
export const STUDIO_DIAGNOSTICS_ROUTE = '/v1/studio/diagnostics';
export const STUDIO_DIAGNOSTICS_CLEAR_ROUTE = '/v1/studio/diagnostics/clear';
const COMPOSER_LIMIT = 131072;
const DISPLAY = Object.freeze({ groups: 16, entries: 100, message: 2048, source: 512, stack: 2048, place: 200 });

export interface StudioDiagnosticItem {
  id: string; kind: 'error' | 'warning'; message: string; source: string | null; line: number | null;
  stack: string | null; count: number; firstAt: string; lastAt: string;
}
export interface StudioDiagnosticItemView extends StudioDiagnosticItem { sessionId: string; placeName: string; live: boolean }

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
const iso = (value: unknown): string | null => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;

/** Strict reader for the daemon receipt; malformed items are skipped, never rendered raw. Newest first. */
export function readStudioDiagnostics(value: unknown): StudioDiagnosticItemView[] {
  if (!plain(value) || !Array.isArray(value.diagnostics)) throw new Error('Studio diagnostics are unavailable.');
  const items: StudioDiagnosticItemView[] = [];
  for (const group of value.diagnostics.slice(0, DISPLAY.groups)) {
    if (!plain(group) || !Array.isArray(group.entries)) continue;
    const sessionId = text(group.sessionId, 256); if (!sessionId) continue;
    const placeName = text(group.placeName, DISPLAY.place) ?? 'Studio';
    for (const entry of group.entries.slice(0, DISPLAY.entries)) {
      if (!plain(entry)) continue;
      const id = text(entry.id, 64), message = text(entry.message, DISPLAY.message), firstAt = iso(entry.firstAt), lastAt = iso(entry.lastAt);
      if (!id || !message || !firstAt || !lastAt || (entry.kind !== 'error' && entry.kind !== 'warning')) continue;
      if (!Number.isSafeInteger(entry.count) || (entry.count as number) < 1) continue;
      const line = Number.isSafeInteger(entry.line) && (entry.line as number) >= 1 ? entry.line as number : null;
      items.push({ id, kind: entry.kind, message, source: text(entry.source, DISPLAY.source), line, stack: text(entry.stack, DISPLAY.stack),
        count: entry.count as number, firstAt, lastAt, sessionId, placeName, live: group.live === true });
    }
  }
  return items.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)).slice(0, DISPLAY.entries);
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
}

export interface StudioDiagnosticsDock { stop(): void; resume(): void; refresh(): Promise<void>; items(): readonly StudioDiagnosticItemView[] }

const SVG = 'http://www.w3.org/2000/svg';
function alertIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3 2 20h20Z', 'M12 10v4', 'M12 17h.01']) { const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

export function startStudioDiagnostics(doc: Document, options: StudioDiagnosticsOptions): StudioDiagnosticsDock {
  const mount = doc.getElementById('studio-diagnostics');
  let items: StudioDiagnosticItemView[] = [];
  if (!mount) return { stop() {}, resume() {}, async refresh() {}, items: () => items };
  const transport = options.transport ?? ((input, init) => fetch(input, init));
  const schedule = options.schedule ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); });
  const interval = options.intervalMs ?? 4000;
  const formatTime = options.formatTime ?? (value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

  // Prefill is a public DOM contract so either chat can be targeted without importing it.
  const onPrefill = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!plain(detail) || typeof detail.text !== 'string' || !detail.text) return;
    options.showConversation?.();
    if (!prefillComposer(doc, detail.text)) status.textContent = 'The message box could not take this request.';
  };

  const toggle = doc.createElement('button');
  toggle.type = 'button'; toggle.id = 'studio-diagnostics-toggle'; toggle.className = 'studio-diagnostics-badge';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'studio-diagnostics-panel');
  const count = doc.createElement('span'); count.className = 'studio-diagnostics-count';
  const label = doc.createElement('span'); label.className = 'studio-diagnostics-label'; label.textContent = 'Studio';
  toggle.append(alertIcon(doc), label, count);
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

  let stopped = false, cancelTimer: (() => void) | null = null, generation = 0;
  const inFlight = new Set<AbortController>();
  const open = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (value: boolean) => { toggle.setAttribute('aria-expanded', String(value)); panel.hidden = !value; };
  const render = () => {
    const errors = items.filter(item => item.kind === 'error').length, warnings = items.length - errors;
    mount.hidden = items.length === 0 && !open();
    mount.dataset.severity = errors ? 'error' : warnings ? 'warning' : 'none';
    count.textContent = String(items.length);
    const summary = (errors ? errors + (errors === 1 ? ' error' : ' errors') : '') + (errors && warnings ? ', ' : '') + (warnings ? warnings + (warnings === 1 ? ' warning' : ' warnings') : '');
    toggle.setAttribute('aria-label', 'Studio output: ' + (summary || 'no errors'));
    toggle.title = summary ? 'Studio output: ' + summary : 'Studio output';
    clear.disabled = items.length === 0;
    const rows = items.map(item => {
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
        doc.dispatchEvent(new (doc.defaultView!.CustomEvent)(WORKSPACE_PREFILL_EVENT, { detail: { text: studioFixPrompt(item) } }));
        setOpen(false); render();
      });
      const body = doc.createElement('div'); body.className = 'studio-diagnostic-body'; body.append(kind, message, meta, place);
      row.append(body, fix); return row;
    });
    list.replaceChildren(...rows);
    if (!items.length) status.textContent = 'No Studio errors or warnings.';
    else if (status.textContent === 'No Studio errors or warnings.') status.textContent = '';
  };
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const token = options.token();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('No local session.');
    const controller = new AbortController(); inFlight.add(controller);
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await transport(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Studio diagnostics request failed (HTTP ' + response.status + ').');
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new Error('Studio diagnostics response is too large.');
      return JSON.parse(raw) as unknown;
    } finally { clearTimeout(deadline); inFlight.delete(controller); }
  };
  const refresh = async () => {
    const mine = ++generation;
    try {
      const next = readStudioDiagnostics(await request(STUDIO_DIAGNOSTICS_ROUTE));
      if (mine !== generation || stopped) return;
      items = next; render();
    } catch { /* Keep the last view; the dock never interrupts the conversation. */ }
  };
  const loop = () => {
    cancelTimer = null; if (stopped) return;
    let wanted = true; try { wanted = options.active?.() ?? true; } catch { wanted = false; }
    void (wanted ? refresh() : Promise.resolve()).finally(() => { if (!stopped && !cancelTimer) cancelTimer = schedule(loop, interval); });
  };
  toggle.addEventListener('click', () => { setOpen(!open()); render(); });
  clear.addEventListener('click', async () => {
    clear.disabled = true; const mine = ++generation;
    try {
      await request(STUDIO_DIAGNOSTICS_CLEAR_ROUTE, {});
      if (mine === generation) { items = []; status.textContent = 'Cleared.'; render(); }
    } catch { status.textContent = 'Studio output could not be cleared.'; clear.disabled = items.length === 0; }
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { setOpen(false); render(); toggle.focus(); } });
  doc.addEventListener(WORKSPACE_PREFILL_EVENT, onPrefill);
  render(); loop();
  return {
    stop() { stopped = true; cancelTimer?.(); cancelTimer = null; for (const controller of inFlight) controller.abort(); doc.removeEventListener(WORKSPACE_PREFILL_EVENT, onPrefill); },
    resume() { if (!stopped) return; stopped = false; doc.addEventListener(WORKSPACE_PREFILL_EVENT, onPrefill); loop(); },
    refresh,
    items: () => items,
  };
}
