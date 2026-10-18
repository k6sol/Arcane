/**
 * Keep this mesh (docs/build/MESH_KEEP.md). Procedural meshes placed in Studio live only in that Studio session. This module
 * shows each one in the Blender assets panel (#mesh-keep-panel) and on its chat asset card (.chat-asset-card[data-job-id])
 * with a Keep this mesh button, its status and any error (quota, moderation pending, unknown outcome, failed).
 *
 * The button only forwards the person's click to the desktop host (window.arcaneDesktop.meshKeep), which asks in its own
 * trusted Arcane dialog (account, asset name, upload quota) before anything is uploaded. Nothing here uploads, retries or
 * acts on model output; a model can only suggest the button. Finish keeping (swap only, no upload) and "I checked my
 * inventory" go to the daemon's human-only /v1/mesh-keep routes. All text is rendered as text.
 */

export const MESH_KEEP_PANEL_ID = 'mesh-keep-panel';
const POLL_MS = 5000, BUSY_POLL_MS = 2000;
const DIGEST = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = ['uploading', 'kept', 'uploaded', 'finishing', 'partial', 'failed', 'unknown'] as const;

export interface MeshKeepReceiptView { attemptId: string; state: typeof STATES[number]; message: string; acknowledged: boolean; assetIds: number[] }
export interface MeshKeepCandidateView {
  digest: string; sessionId: string; placeName: string; name: string; jobId: string | null; meshCount: number | null;
  live: boolean; capable: boolean; action: 'keep' | 'finish' | 'none'; receipt: MeshKeepReceiptView | null;
}
export interface MeshKeepView { available: boolean; consentChannel: boolean; candidates: MeshKeepCandidateView[] }
export interface MeshKeepBridge { version: 1; keep(request: { digest: string; sessionId: string }): Promise<{ state: string; message: string }> }
export interface MeshKeepOptions {
  token: () => string;
  desktop: { meshKeep?: MeshKeepBridge } | null;
  /** Test seam; defaults to the page's fetch. */
  fetch?: typeof fetch;
}
export interface MeshKeepController { reload(): Promise<void>; stop(): void; resume(): void }

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

function readReceipt(value: unknown): MeshKeepReceiptView | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (!text(r.attemptId, 36) || !UUID.test(r.attemptId) || !(STATES as readonly unknown[]).includes(r.state) || !text(r.message, 1000) || typeof r.acknowledged !== 'boolean' || !Array.isArray(r.assets)) return undefined;
  const assetIds: number[] = [];
  for (const asset of r.assets.slice(0, 16)) {
    const id = asset && typeof asset === 'object' ? (asset as Record<string, unknown>).assetId : undefined;
    if (Number.isSafeInteger(id) && (id as number) > 0) assetIds.push(id as number);
  }
  return { attemptId: r.attemptId, state: r.state as MeshKeepReceiptView['state'], message: r.message, acknowledged: r.acknowledged, assetIds };
}

/** Strict reader for GET /v1/mesh-keep/state; anything unexpected yields null. */
export function readMeshKeepView(value: unknown): MeshKeepView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.available !== 'boolean' || typeof v.consentChannel !== 'boolean' || !Array.isArray(v.candidates) || v.candidates.length > 64) return null;
  const candidates: MeshKeepCandidateView[] = [];
  for (const raw of v.candidates) {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>, receipt = readReceipt(c.receipt);
    if (!text(c.digest, 64) || !DIGEST.test(c.digest) || !text(c.sessionId, 128) || !ID.test(c.sessionId) || !text(c.placeName, 256) || !text(c.name, 120)
      || !(c.jobId === null || text(c.jobId, 128)) || !(c.meshCount === null || Number.isSafeInteger(c.meshCount)) || typeof c.live !== 'boolean' || typeof c.capable !== 'boolean'
      || !['keep', 'finish', 'none'].includes(c.action as string) || receipt === undefined) return null;
    candidates.push({ digest: c.digest, sessionId: c.sessionId, placeName: c.placeName, name: c.name, jobId: c.jobId as string | null, meshCount: c.meshCount as number | null,
      live: c.live, capable: c.capable, action: c.action as MeshKeepCandidateView['action'], receipt });
  }
  return { available: v.available, consentChannel: v.consentChannel, candidates };
}

/** The one status line for a placed mesh, in plain words. */
export function meshKeepStatus(candidate: MeshKeepCandidateView, view: Pick<MeshKeepView, 'consentChannel'>): string {
  if (candidate.receipt) return candidate.receipt.message;
  if (!candidate.live) return 'Session only. Open this place in Studio (Edit mode) to keep it.';
  if (!candidate.capable) return 'Session only. This Studio connection cannot upload meshes; update Studio and the Arcane plugin.';
  if (!view.consentChannel) return 'Session only. Keeping it needs the Arcane desktop app.';
  return 'Session only: it disappears on reconnect, Play or reopening. Keep it to save it to your Roblox account.';
}

export function startMeshKeep(doc: Document, options: MeshKeepOptions): MeshKeepController {
  const transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let view: MeshKeepView | null = null, stopped = false, timer: ReturnType<typeof setTimeout> | null = null, inflight: Promise<void> | null = null;
  const notes = new Map<string, string>(); // per-candidate result of the last click (cancelled, refused...)
  const busy = new Set<string>();
  const key = (c: MeshKeepCandidateView) => c.digest + ':' + c.sessionId;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (value !== undefined) element.textContent = value; if (className) element.className = className; return element;
  };

  async function call(path: string, input?: Record<string, unknown>): Promise<unknown> {
    const response = await transport(path, { method: input ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + options.token(), ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    let payload: unknown = null; try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error(payload && typeof payload === 'object' && text((payload as { message?: unknown }).message, 400) ? (payload as { message: string }).message : 'Keep this mesh is unavailable.');
    return payload;
  }

  async function keep(candidate: MeshKeepCandidateView): Promise<void> {
    const id = key(candidate); if (busy.has(id)) return;
    const bridge = options.desktop?.meshKeep;
    if (!bridge || typeof bridge.keep !== 'function') { notes.set(id, 'Keeping a mesh needs the Arcane desktop app, which asks you to confirm every upload.'); render(); return; }
    busy.add(id); notes.set(id, 'Waiting for your confirmation…'); render();
    try {
      const out = await bridge.keep({ digest: candidate.digest, sessionId: candidate.sessionId });
      notes.set(id, out.state === 'started' ? '' : text(out.message, 400) && out.message ? out.message : 'Not uploaded.');
    } catch { notes.set(id, 'Could not confirm the keep result. Review the mesh card before trying again.'); }
    finally { busy.delete(id); }
    await reload();
  }
  async function post(candidate: MeshKeepCandidateView, path: string): Promise<void> {
    const id = key(candidate), receipt = candidate.receipt; if (!receipt || busy.has(id)) return;
    busy.add(id); render();
    try { await call(path, { attemptId: receipt.attemptId }); notes.delete(id); }
    catch (error) { notes.set(id, error instanceof Error ? error.message : 'Keep this mesh is unavailable.'); }
    finally { busy.delete(id); }
    await reload();
  }

  function controls(candidate: MeshKeepCandidateView, compact: boolean): HTMLElement {
    const id = key(candidate), box = make('div', undefined, compact ? 'mesh-keep-inline' : 'mesh-keep-item');
    box.setAttribute('data-mesh-keep', id);
    if (!compact) {
      const title = make('strong', candidate.name, 'mesh-keep-name');
      const meta = make('span', candidate.placeName + (candidate.meshCount ? ' · ' + candidate.meshCount + (candidate.meshCount === 1 ? ' mesh' : ' meshes') : ''), 'hint mesh-keep-meta');
      box.append(title, meta);
    }
    const state = candidate.receipt?.state ?? 'session';
    box.setAttribute('data-state', state);
    const status = make('p', notes.get(id) || meshKeepStatus(candidate, view ?? { consentChannel: false }), 'hint mesh-keep-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const row = make('div', undefined, 'button-row mesh-keep-actions');
    const button = (label: string, run: () => Promise<void>, primary = false) => {
      const b = make('button', label, primary ? 'mesh-keep-button' : 'secondary mesh-keep-button'); b.type = 'button'; b.disabled = busy.has(id);
      b.addEventListener('click', event => { if (event.isTrusted && !event.defaultPrevented && !stopped) void run(); });
      row.append(b);
    };
    if (candidate.action === 'keep' && view?.consentChannel) button('Keep this mesh', () => keep(candidate), true);
    if (candidate.action === 'finish') button('Finish keeping', () => post(candidate, '/v1/mesh-keep/finish'));
    if (candidate.receipt && (candidate.receipt.state === 'unknown' || candidate.receipt.state === 'partial') && !candidate.receipt.acknowledged)
      button('I checked my inventory', () => post(candidate, '/v1/mesh-keep/acknowledge'));
    box.append(status); if (row.childElementCount) box.append(row);
    return box;
  }

  function renderPanel(): void {
    const host = doc.getElementById(MESH_KEEP_PANEL_ID); if (!host) return;
    const list = host.querySelector<HTMLElement>('[data-mesh-keep-list]'), empty = host.querySelector<HTMLElement>('[data-mesh-keep-empty]');
    if (!list) return;
    const candidates = view?.candidates ?? [];
    list.replaceChildren(...candidates.map(c => { const item = make('li'); item.append(controls(c, false)); return item; }));
    if (empty) empty.hidden = candidates.length > 0;
    host.setAttribute('aria-busy', 'false');
  }
  function renderCards(): void {
    // Mutation delivery happens after this stack, so a synchronous rendering flag cannot suppress our own edits.
    observer?.disconnect();
    try {
      for (const old of Array.from(doc.querySelectorAll('.chat-asset-card > .mesh-keep-inline'))) old.remove();
      for (const candidate of view?.candidates ?? []) {
        if (!candidate.jobId) continue;
        for (const card of Array.from(doc.querySelectorAll<HTMLElement>('.chat-asset-card[data-job-id]'))) {
          if (card.getAttribute('data-job-id') === candidate.jobId) card.append(controls(candidate, true));
        }
      }
    } finally { if (!stopped) observe(); }
  }
  let rendering = false;
  function render(): void { if (stopped) return; rendering = true; try { renderPanel(); renderCards(); } finally { rendering = false; } }

  async function reload(): Promise<void> {
    if (stopped) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try { view = readMeshKeepView(await call('/v1/mesh-keep/state')); }
      catch { view = null; }
      render();
    })().finally(() => { inflight = null; schedule(); });
    return inflight;
  }
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const active = view?.candidates.some(c => c.receipt && (c.receipt.state === 'uploading' || c.receipt.state === 'finishing')) || busy.size > 0;
    timer = setTimeout(() => { if (!doc.hidden) void reload(); else schedule(); }, active ? BUSY_POLL_MS : POLL_MS);
  }
  // Chat asset cards are re-rendered by the workspace; put the inline controls back whenever that happens.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (!rendering && !stopped) renderCards(); }) : null;
  const observe = () => { const host = doc.getElementById('chat-assets'); if (host && observer) observer.observe(host, { childList: true, subtree: true }); };
  observe(); void reload();
  return {
    reload,
    stop(): void { stopped = true; if (timer) clearTimeout(timer); timer = null; observer?.disconnect(); },
    resume(): void { if (!stopped) return; stopped = false; observe(); void reload(); },
  };
}
