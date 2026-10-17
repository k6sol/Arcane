/// <reference lib="dom" />
// Arcane-styled in-app dialogs and the per-project Permissions settings.
//
// Dialogs: the desktop host (apps/desktop/electron/in-app-dialog.cjs) sends one bounded question at a time; this module
// renders it as a focused modal (role=dialog, aria-modal, focus trap, the rest of the page inert), Esc answers the cancel
// button, Enter the default button, and the answer goes back with the request id. The host validates the id and button
// index again and treats a timeout, navigation or close as cancel. Text is set with textContent only.
//
// Permissions: two persisted per-project switches read and saved through the host (project-permissions.cjs). Without the
// desktop bridge (browser preview) the card says so and nothing is automatic.

export interface ArcaneDialogRequest {
  id: string; type: 'none' | 'info' | 'question' | 'warning' | 'error'; title: string; message: string; detail: string;
  buttons: string[]; defaultId: number; cancelId: number;
}
export interface PermissionSettings { claudeTools: boolean; codexAutoApprove: boolean }
interface DialogBridge {
  attach(listener: (request: ArcaneDialogRequest) => void): Promise<unknown>;
  reply(answer: { id: string; response: number }): Promise<unknown>;
}
interface PermissionBridge {
  read(): Promise<{ available: boolean; settings: PermissionSettings }>;
  save(patch: Partial<PermissionSettings>): Promise<{ saved: true; settings: PermissionSettings }>;
}
export interface AutoApprovalSource {
  setAutoApprove(enabled: boolean): void;
  autoApprovals(): readonly { at: number; summary: string }[];
  subscribeAutoApprovals(listener: () => void): () => void;
}
export interface ArcaneDialogOptions { desktop?: unknown; codex?: AutoApprovalSource | null }

const TYPES = ['none', 'info', 'question', 'warning', 'error'];
const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Exact request shape (the preload already copied it); anything else is ignored. */
export function readDialogRequest(value: unknown): ArcaneDialogRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length <= max;
  if (typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.id) || !TYPES.includes(v.type as string) || !text(v.title, 120) || !text(v.message, 600) ||
      !text(v.detail, 4000) || !Array.isArray(v.buttons) || v.buttons.length < 1 || v.buttons.length > 4 || !v.buttons.every(b => text(b, 48) && (b as string).length > 0)) return null;
  const index = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < (v.buttons as unknown[]).length;
  if (!index(v.defaultId) || !index(v.cancelId)) return null;
  return { id: v.id, type: v.type as ArcaneDialogRequest['type'], title: v.title as string, message: v.message as string, detail: v.detail as string,
    buttons: [...v.buttons as string[]], defaultId: v.defaultId as number, cancelId: v.cancelId as number };
}

/**
 * Render one modal and resolve with the chosen button index. The page behind it is inert until it closes; focus returns
 * to where it was. Exposed for the in-app renderer and for tests.
 */
export function showArcaneDialog(doc: Document, request: ArcaneDialogRequest): { result: Promise<number>; close(response?: number): void } {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
  };
  const previous = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const layer = make('div', undefined, 'arcane-modal-layer'); layer.dataset.arcaneDialog = request.id;
  const box = make('section', undefined, 'arcane-modal'); box.dataset.type = request.type;
  box.setAttribute('role', request.type === 'warning' || request.type === 'error' ? 'alertdialog' : 'dialog');
  box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
  const titleId = 'arcane-modal-title-' + request.id, bodyId = 'arcane-modal-body-' + request.id;
  box.setAttribute('aria-labelledby', titleId); box.setAttribute('aria-describedby', bodyId);
  const head = make('header', undefined, 'arcane-modal-head');
  const mark = make('span', undefined, 'arcane-modal-mark'); mark.setAttribute('aria-hidden', 'true');
  const title = make('h2', request.title, 'arcane-modal-title'); title.id = titleId;
  head.append(mark, title);
  const body = make('div', undefined, 'arcane-modal-body'); body.id = bodyId;
  if (request.message) body.append(make('p', request.message, 'arcane-modal-message'));
  for (const paragraph of request.detail.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)) body.append(make('p', paragraph, 'arcane-modal-detail'));
  const actions = make('div', undefined, 'arcane-modal-actions');
  // The last button that is not the cancel button is the primary (red) action; the others stay quiet.
  let primary = -1;
  for (let i = request.buttons.length - 1; i >= 0; i--) if (i !== request.cancelId) { primary = i; break; }
  const buttons = request.buttons.map((label, index) => {
    const button = make('button', label, index === primary ? 'arcane-modal-button arcane-modal-primary' : 'arcane-modal-button');
    button.type = 'button'; button.dataset.response = String(index);
    if (index === request.defaultId) button.dataset.default = 'true';
    button.addEventListener('click', () => close(index));
    return button;
  });
  actions.append(...buttons);
  box.append(head, body, actions); layer.append(box);
  // Everything else on the page is inert while the question is open (background clicks and focus never reach it).
  const inerted: HTMLElement[] = [];
  for (const child of Array.from(doc.body.children)) if (child instanceof HTMLElement && !child.inert && child !== layer) { child.inert = true; inerted.push(child); }
  doc.body.append(layer);
  let settle: (value: number) => void = () => {};
  const result = new Promise<number>(resolve => { settle = resolve; });
  let done = false;
  function close(response = request.cancelId) {
    if (done) return; done = true;
    doc.removeEventListener('keydown', onKey, true);
    layer.remove();
    for (const node of inerted) node.inert = false;
    if (previous && previous.isConnected) { try { previous.focus({ preventScroll: true }); } catch { /* focus is best effort */ } }
    settle(response);
  }
  function onKey(event: KeyboardEvent) {
    if (done) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(request.cancelId); return; }
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement && box.contains(event.target))) { event.preventDefault(); event.stopPropagation(); close(request.defaultId); return; }
    if (event.key === 'Tab') {
      const focusable = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) { event.preventDefault(); box.focus(); return; }
      const first = focusable[0]!, last = focusable[focusable.length - 1]!, active = doc.activeElement;
      if (event.shiftKey && (active === first || !box.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !box.contains(active))) { event.preventDefault(); first.focus(); }
    }
  }
  doc.addEventListener('keydown', onKey, true);
  (buttons[request.defaultId] ?? box).focus({ preventScroll: true });
  return { result, close };
}

function dialogBridge(desktop: unknown): DialogBridge | null {
  const d = (desktop as { dialogs?: Partial<DialogBridge> } | null | undefined)?.dialogs;
  return d && typeof d.attach === 'function' && typeof d.reply === 'function' ? d as DialogBridge : null;
}
function permissionBridge(desktop: unknown): PermissionBridge | null {
  const p = (desktop as { projectPermissions?: Partial<PermissionBridge> } | null | undefined)?.projectPermissions;
  return p && typeof p.read === 'function' && typeof p.save === 'function' ? p as PermissionBridge : null;
}

/** Mount the in-app dialog listener and the Permissions card. Returns a stop handle (pagehide). */
export function startArcaneDialogs(doc: Document, options: ArcaneDialogOptions = {}): { stop(): void; resume(): void } {
  let stopped = false, open: { close(response?: number): void } | null = null;
  const queue: ArcaneDialogRequest[] = [];
  const dialogs = dialogBridge(options.desktop);
  function next() {
    if (stopped || open || !queue.length || !dialogs) return;
    const request = queue.shift()!;
    const shown = showArcaneDialog(doc, request); open = shown;
    void shown.result.then(response => {
      open = null;
      void dialogs.reply({ id: request.id, response }).catch(() => { /* the host times out to cancel */ });
      next();
    });
  }
  if (dialogs) void dialogs.attach(value => {
    const request = readDialogRequest(value);
    if (!request || stopped || queue.length >= 16) return;
    queue.push(request); next();
  }).catch(() => { /* the host keeps using native dialogs */ });

  // ---------------------------------------------------------------- permissions card
  const permissions = permissionBridge(options.desktop);
  const el = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const claude = el<HTMLInputElement>('permissions-claude-tools'), codex = el<HTMLInputElement>('permissions-codex-auto');
  const state = el('permissions-state'), notice = el('permissions-notice'), log = el<HTMLOListElement>('permissions-log');
  let settings: PermissionSettings | null = null, saving = false;
  const say = (text: string) => { if (notice) notice.textContent = text; };
  function render() {
    const available = !!permissions && !!settings;
    for (const box of [claude, codex]) if (box) box.disabled = !available || saving;
    if (claude) claude.checked = settings?.claudeTools ?? false;
    if (codex) codex.checked = settings?.codexAutoApprove ?? false;
    if (state) {
      state.textContent = !permissions ? 'Desktop only' : !settings ? 'Checking' : settings.claudeTools && settings.codexAutoApprove ? 'Auto-approve on' : settings.claudeTools || settings.codexAutoApprove ? 'Partly automatic' : 'Ask first';
      state.className = 'status-text ' + (settings && (settings.claudeTools || settings.codexAutoApprove) ? 'good' : 'neutral');
    }
    if (log) {
      const entries = options.codex?.autoApprovals() ?? [];
      log.replaceChildren(...entries.slice(-8).reverse().map(entry => {
        const item = doc.createElement('li');
        const time = doc.createElement('time'); time.dateTime = new Date(entry.at).toISOString(); time.textContent = new Date(entry.at).toLocaleTimeString();
        item.append(time, doc.createTextNode(' ' + entry.summary)); return item;
      }));
      if (!entries.length) { const item = doc.createElement('li'); item.textContent = 'Nothing has been auto-approved in this session.'; log.append(item); }
    }
  }
  function apply(next: PermissionSettings) { settings = next; options.codex?.setAutoApprove(next.codexAutoApprove); render(); }
  async function load() {
    if (!permissions) { options.codex?.setAutoApprove(false); say('Saved permissions are available in the Arcane desktop app.'); render(); return; }
    try { const value = await permissions.read(); if (stopped) return; if (value.available) apply(value.settings); else { say('Open a project to change its permissions.'); render(); } }
    catch { if (!stopped) { say('Permissions could not be read. Arcane will ask before acting.'); options.codex?.setAutoApprove(false); render(); } }
  }
  async function save(patch: Partial<PermissionSettings>, message: string) {
    if (!permissions || saving) return;
    saving = true; render();
    try { const value = await permissions.save(patch); if (!stopped) { apply(value.settings); say(message); } }
    catch { if (!stopped) say('The permission could not be saved. Nothing changed.'); }
    finally { saving = false; if (!stopped) render(); }
  }
  const onClaude = (event: Event) => { if (!event.isTrusted || !claude) return; const on = claude.checked;
    void save({ claudeTools: on }, on ? 'Claude chat now uses Arcane tools in this project without asking.' : 'Claude chat will ask before using Arcane tools. The current tool credential was revoked.'); };
  const onCodex = (event: Event) => { if (!event.isTrusted || !codex) return; const on = codex.checked;
    void save({ codexAutoApprove: on }, on ? 'In-project edits and commands are now approved automatically.' : 'Every edit and command now waits for your review.'); };
  claude?.addEventListener('change', onClaude); codex?.addEventListener('change', onCodex);
  // The log listener lives for the page lifetime, like the other settings panels.
  options.codex?.subscribeAutoApprovals(() => { if (!stopped) render(); });
  void load();
  return {
    stop() { stopped = true; open?.close(); open = null; queue.length = 0; },
    resume() { if (!stopped) return; stopped = false; void load(); },
  };
}
