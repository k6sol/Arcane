/**
 * Settings › Project memory: edits ARCANE.md in the project folder, the notes both chat providers read at the start of a
 * conversation (art style, conventions, naming, script architecture, past decisions). Plain text in a textarea; the saved
 * text is never rendered as HTML. Reads and writes go through the daemon's human-only /v1/project-memory routes.
 *
 * `append(note)` is the seam behind a chat reply's explicit "Save to project memory" button; nothing is saved without a click.
 * The file is read only when the Project memory page is shown (or a note is appended), never at workspace start.
 */

export const PROJECT_MEMORY_SECTION_ID = 'settings-memory';
export const PROJECT_MEMORY_LIMIT_BYTES = 16 * 1024;

export interface ProjectMemoryView { text: string; bytes: number; limit: number; exists: boolean; truncated: boolean }
export interface ProjectMemoryOptions {
  token: () => string;
  /** Test seam; defaults to the page's fetch. */
  fetch?: typeof fetch;
}
export interface ProjectMemoryController {
  /** Appends one suggested note to ARCANE.md (explicit user click only). */
  append(note: string): Promise<{ ok: boolean; message: string }>;
  reload(): Promise<void>;
  stop(): void;
  resume(): void;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** True while a Settings page is on screen: its section is shown inside an open Settings drawer. */
function settingsSectionShown(doc: Document, id: string): boolean {
  const section = doc.getElementById(id);
  if (!section || section.hidden) return false;
  const drawer = section.closest('dialog');
  return !drawer || (drawer as HTMLDialogElement).open;
}

/** Calls `onShown` each time the Settings page becomes visible, so the page reads the daemon only when someone looks at it. */
function watchSettingsSection(doc: Document, id: string, onShown: () => void): () => void {
  const section = doc.getElementById(id), Observer = doc.defaultView?.MutationObserver;
  if (!section || !Observer) return () => {};
  let shown = settingsSectionShown(doc, id);
  const observer = new Observer(() => { const next = settingsSectionShown(doc, id); if (next && !shown) onShown(); shown = next; });
  observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
  const drawer = section.closest('dialog'); if (drawer) observer.observe(drawer, { attributes: true, attributeFilter: ['open'] });
  return () => observer.disconnect();
}

/** Strict reader for the daemon reply; anything unexpected yields null. */
export function readProjectMemoryView(value: unknown): ProjectMemoryView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.text !== 'string' || typeof row.exists !== 'boolean' || typeof row.truncated !== 'boolean' ||
    !Number.isSafeInteger(row.bytes) || row.limit !== PROJECT_MEMORY_LIMIT_BYTES || bytes(row.text) > PROJECT_MEMORY_LIMIT_BYTES) return null;
  return { text: row.text, bytes: row.bytes as number, limit: row.limit, exists: row.exists, truncated: row.truncated };
}

/** "1,024 / 16,384 bytes" for the counter under the textarea. */
export function memoryCount(text: string): string {
  return bytes(text).toLocaleString('en-US') + ' / ' + PROJECT_MEMORY_LIMIT_BYTES.toLocaleString('en-US') + ' bytes';
}

export function startProjectMemory(doc: Document, options: ProjectMemoryOptions): ProjectMemoryController {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const input = el<HTMLTextAreaElement>('project-memory-input'), save = el<HTMLButtonElement>('project-memory-save');
  const count = el('project-memory-count'), status = el('project-memory-status');
  let saved = '', loaded = false, busy = false, stopped = false;
  const cleanups: (() => void)[] = [];
  const headers = (json = false): Record<string, string> => ({ Authorization: 'Bearer ' + options.token(), ...(json ? { 'Content-Type': 'application/json' } : {}) });
  const say = (text: string, kind: 'info' | 'error' | 'ready' = 'info') => { if (status) { status.textContent = text; status.dataset.kind = kind; } };

  function render(): void {
    if (!input || !save) return;
    const text = input.value, over = bytes(text) > PROJECT_MEMORY_LIMIT_BYTES;
    if (count) { count.textContent = memoryCount(text); count.dataset.over = String(over); }
    input.disabled = !loaded || stopped;
    input.setAttribute('aria-invalid', String(over));
    save.disabled = !loaded || busy || stopped || over || text === saved;
  }
  async function request(method: 'GET' | 'PUT' | 'POST', path: string, text?: string): Promise<{ view: ProjectMemoryView | null; message: string }> {
    try {
      const response = await doFetch(path, { method, headers: headers(text !== undefined), cache: 'no-store', credentials: 'same-origin',
        ...(text !== undefined ? { body: JSON.stringify({ text }) } : {}) });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) { const view = readProjectMemoryView(body); return { view, message: view ? '' : 'Project memory returned an unexpected reply.' }; }
      const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message.slice(0, 300) : '';
      return { view: null, message: message || 'Project memory is unavailable right now.' };
    } catch { return { view: null, message: 'Project memory is unavailable right now.' }; }
  }
  function show(view: ProjectMemoryView): void {
    saved = view.text; loaded = true;
    if (input) input.value = view.text;
    say(view.truncated ? 'ARCANE.md is over 16 KB; only the first 16 KB is shown and shared with the AI. Shorten it and save.'
      : view.exists ? 'Saved in ARCANE.md in your project folder.' : 'No project memory yet. Saving creates ARCANE.md in your project folder.', view.truncated ? 'error' : 'info');
    render();
  }
  async function reload(): Promise<void> {
    if (stopped || busy) return;
    // Never overwrite unsaved edits with a background reload.
    if (loaded && input && input.value !== saved) return;
    busy = true; render();
    const { view, message } = await request('GET', '/v1/project-memory');
    busy = false;
    if (stopped) return;
    if (view) show(view); else { say(message, 'error'); render(); }
  }
  async function submit(): Promise<void> {
    if (!input || busy || stopped || !loaded) return;
    const text = input.value;
    if (bytes(text) > PROJECT_MEMORY_LIMIT_BYTES) { say('Project memory is limited to 16 KB. Shorten it before saving.', 'error'); return; }
    busy = true; render(); say('Saving…');
    const { view, message } = await request('PUT', '/v1/project-memory', text);
    busy = false;
    if (view) { saved = view.text; if (input.value === text) input.value = view.text; say('Saved. New chats and the next reply use these notes.', 'ready'); }
    else say(message, 'error');
    render();
  }
  async function append(note: string): Promise<{ ok: boolean; message: string }> {
    if (stopped || typeof note !== 'string' || !note.trim()) return { ok: false, message: 'There is nothing to save.' };
    const { view, message } = await request('POST', '/v1/project-memory/append', note);
    if (!view) return { ok: false, message };
    // Keep the editor in step unless it holds unsaved edits, which are never discarded silently.
    if (input && (!loaded || input.value === saved)) { saved = view.text; loaded = true; input.value = view.text; render(); }
    else say('A note from chat was added to ARCANE.md. Saving your unsaved edits here would replace it.', 'error');
    return { ok: true, message: 'Saved to ARCANE.md.' };
  }
  function bind(): void {
    if (!input || !save || cleanups.length) return;
    const on = (target: EventTarget, type: string, handler: (event: Event) => void) => {
      target.addEventListener(type, handler); cleanups.push(() => target.removeEventListener(type, handler));
    };
    on(input, 'input', () => render());
    on(save, 'click', () => void submit());
    on(input, 'keydown', event => {
      const key = event as KeyboardEvent;
      if ((key.ctrlKey || key.metaKey) && !key.altKey && key.key.toLowerCase() === 's') { event.preventDefault(); void submit(); }
    });
    // Opening the section re-reads the file (edits made outside Arcane show up) unless there are unsaved edits.
    for (const nav of Array.from(doc.querySelectorAll<HTMLElement>('[data-settings-section-target="' + PROJECT_MEMORY_SECTION_ID + '"]'))) on(nav, 'click', () => void reload());
    cleanups.push(watchSettingsSection(doc, PROJECT_MEMORY_SECTION_ID, () => void reload()));
  }
  function stop(): void { stopped = true; for (const cleanup of cleanups.splice(0)) cleanup(); render(); }
  function resume(): void { stopped = false; bind(); render(); if (settingsSectionShown(doc, PROJECT_MEMORY_SECTION_ID)) void reload(); }
  resume();
  return { append, reload, stop, resume };
}
