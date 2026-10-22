/// <reference lib="dom" />
/**
 * Imported assets in the preview panel: "Choose an asset", the asset picker with "Import from file…", dropping files on
 * the preview, and showing or removing an import. Files are only ever opened by the desktop main process
 * (arcaneDesktop.assetImport: the native picker, or dropped files it checks itself). This module reads the daemon's
 * import store with the workspace bearer and shows imports in the shared viewer, labelled "Imported".
 * With nothing to choose, "Choose an asset" opens the file picker straight away.
 */
import type { ImportedViewerAsset, ImportedEffectView } from './asset-viewer.js';

export interface ImportReply {
  state: 'imported' | 'cancelled' | 'refused' | 'busy' | 'unavailable'; message: string;
  imported: { id: string; name: string; kind: 'model' | 'effect'; duplicate: boolean }[];
  refused: { name: string; message: string }[];
}
export interface AssetImportBridge { version: 1; pick(): Promise<ImportReply>; importFiles(...files: File[]): Promise<ImportReply> }
export interface AssetLibrary {
  viewer: { showImported(asset: ImportedViewerAsset, load: (signal: AbortSignal) => Promise<ArrayBuffer>, current: () => boolean, actions: { remove(): void }): Promise<void>; clear(): void };
  /** Generated models that can be shown now (the same rows the chat's asset cards offer). */
  generated(): { jobId: string; name: string }[];
  /** The chat card's View action for one generated model. */
  view(jobId: string): boolean;
  /** Drop the generated selection so an import can take the viewer. */
  release(): void;
}
export interface AssetImportOptions { token: () => string; desktop: { assetImport?: AssetImportBridge } | null; library: AssetLibrary; transport?: typeof fetch }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MODEL_LIMIT = 64 * 1024 * 1024;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const text = (value: unknown, limit: number): string | null => typeof value === 'string' && value.trim() ? value.replace(UNSAFE, ' ').trim().slice(0, limit) : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;

/** One daemon record -> the viewer's shape, or null. Everything shown comes from the real file the daemon read. */
export function readImportedAsset(value: unknown): ImportedViewerAsset | null {
  const r = fields(value); if (!r) return null;
  const id = r.id, kind = r.kind, name = text(r.name, 80), fileName = text(r.fileName, 160), bytes = count(r.bytes);
  if (typeof id !== 'string' || !UUID.test(id) || (kind !== 'model' && kind !== 'effect') || r.source !== 'imported' || !name || !fileName || !bytes || bytes > MODEL_LIMIT
    || typeof r.sha256 !== 'string' || !HEX64.test(r.sha256) || typeof r.importedAt !== 'string' || !Number.isFinite(Date.parse(r.importedAt)) || !['glb', 'gltf', 'rbxmx'].includes(String(r.format))) return null;
  let model: ImportedViewerAsset['model'] = null, effect: ImportedEffectView | null = null;
  if (kind === 'model') {
    const m = fields(r.model); if (!m) return null;
    const stats = { triangles: count(m.triangles), meshes: count(m.meshes), materials: count(m.materials), textures: count(m.textures), animations: count(m.animations) };
    if (Object.values(stats).some(v => v === null)) return null;
    model = stats as { triangles: number; meshes: number; materials: number; textures: number; animations: number };
  } else {
    const e = fields(r.effect); if (!e || !Array.isArray(e.items) || !e.items.length || e.items.length > 64) return null;
    const items = e.items.map(fields).filter((item): item is Fields => !!item && typeof item.className === 'string' && /^[A-Za-z]{1,32}$/.test(item.className) && !!fields(item.props)).map(item => ({
      className: item.className as string, name: text(item.name, 80) ?? (item.className as string), parent: text(item.parent, 80),
      position: Array.isArray(item.position) && item.position.length === 3 && item.position.every(Number.isFinite) ? item.position as [number, number, number] : [0, 0, 0] as [number, number, number],
      area: Array.isArray(item.area) && item.area.length === 3 && item.area.every(Number.isFinite) ? item.area as [number, number, number] : null,
      props: item.props as Record<string, unknown>,
    }));
    if (items.length !== e.items.length) return null;
    effect = { items, scripts: count(e.scripts) ?? 0, otherClasses: Array.isArray(e.otherClasses) ? e.otherClasses.filter((c): c is string => typeof c === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(c)).slice(0, 16) : [],
      clamped: Array.isArray(e.clamped) ? e.clamped.filter((c): c is string => typeof c === 'string' && /^[A-Za-z]{1,32}\.[A-Za-z0-9]{1,48}$/.test(c)).slice(0, 32) : [], truncated: e.truncated === true };
  }
  return { id, kind, format: r.format as ImportedViewerAsset['format'], name, fileName, bytes, sha256: r.sha256, importedAt: r.importedAt, model, effect };
}
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

export function startAssetImports(doc: Document, options: AssetImportOptions) {
  const transport = options.transport ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const bridge = (): AssetImportBridge | null => {
    const value = options.desktop?.assetImport;
    return value && typeof value.pick === 'function' && typeof value.importFiles === 'function' ? value : null;
  };
  let imports: ImportedViewerAsset[] = [], stopped = false, busy = false, shownId = '', listEpoch = 0;
  const cleanup: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, handler, opts); cleanup.push(() => target.removeEventListener(type, handler, opts));
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (className) element.className = className; if (content !== undefined) element.textContent = content; return element;
  };
  // Icons are cloned from the page's inert <template id="asset-viewer-icons">; absent there, the control keeps its text.
  const icon = (name: string): Node => {
    const template = doc.getElementById('asset-viewer-icons') as HTMLTemplateElement | null;
    const source = template?.content?.querySelector?.('[data-icon="' + name + '"]');
    if (!source) return doc.createTextNode('');
    const svg = source.cloneNode(true) as Element; svg.setAttribute('class', 'import-icon'); svg.removeAttribute('data-icon'); return svg;
  };
  const request = (path: string, init: RequestInit = {}) => transport(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: 'Bearer ' + options.token() },
    cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });

  // ---- Notices: one dismissible card at the foot of the preview stage. ----
  const stage = doc.getElementById('artifact-stage'), trigger = doc.getElementById('preview-settings') as HTMLButtonElement | null;
  const notice = make('div', 'import-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true;
  const noticeBody = make('div', 'import-notice-body'), dismiss = make('button', 'import-notice-close'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Dismiss'); dismiss.append(icon('close'));
  notice.append(noticeBody, dismiss);
  listen(dismiss, 'click', () => { notice.hidden = true; noticeBody.replaceChildren(); });
  function say(title: string, lines: { name: string; message: string }[] = [], tone: 'ok' | 'warn' = 'ok') {
    noticeBody.replaceChildren(make('strong', 'import-notice-title', title));
    if (lines.length) {
      const list = make('ul', 'import-notice-list');
      for (const line of lines.slice(0, 8)) { const item = make('li'); item.append(make('span', 'import-notice-name', line.name), make('span', 'import-notice-message', line.message)); list.append(item); }
      noticeBody.append(list);
    }
    notice.dataset.tone = tone; notice.hidden = false;
  }

  // ---- Drop target: the whole preview panel. ----
  const panel = doc.getElementById('artifact-panel');
  const drop = make('div', 'import-drop'); drop.setAttribute('aria-hidden', 'true'); drop.hidden = true;
  drop.append(icon('upload'), make('strong', 'import-drop-title', 'Drop to import'), make('span', 'import-drop-formats', 'GLB, glTF or Roblox .rbxmx'));
  if (stage) stage.append(drop, notice);
  const hasFiles = (event: Event) => Array.from((event as DragEvent).dataTransfer?.types ?? []).includes('Files');
  let depth = 0;
  if (panel) {
    listen(panel, 'dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); depth++; drop.hidden = false; });
    listen(panel, 'dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); const data = (event as DragEvent).dataTransfer; if (data) data.dropEffect = bridge() ? 'copy' : 'none'; });
    listen(panel, 'dragleave', event => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
    listen(panel, 'drop', event => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; drop.hidden = true;
      const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
      if (files.length) void run(desktop => desktop.importFiles(...files.slice(0, 8)));
    });
  }

  // ---- Import, list, show, remove ----
  async function refresh(): Promise<ImportedViewerAsset[]> {
    const epoch = ++listEpoch;
    try {
      const response = await request('/v1/imports');
      if (!response.ok) throw new Error();
      const payload = fields(await response.json());
      if (epoch !== listEpoch || stopped) return imports;
      const rows = Array.isArray(payload?.imports) ? payload!.imports as unknown[] : [];
      imports = rows.slice(0, 128).map(readImportedAsset).filter((row): row is ImportedViewerAsset => !!row);
    } catch { /* The list stays as it was; the next choice reads it again. */ }
    renderPicker();
    return imports;
  }
  async function run(work: (desktop: AssetImportBridge) => Promise<ImportReply>): Promise<void> {
    const desktop = bridge();
    if (!desktop) { say('Importing needs the Arcane desktop app.', [], 'warn'); return; }
    if (busy) return;
    busy = true; trigger?.setAttribute('aria-busy', 'true'); closePicker(false);
    try {
      const reply = await work(desktop);
      if (stopped || !reply || reply.state === 'cancelled') return;
      if (reply.state === 'busy' || reply.state === 'unavailable') { say(text(reply.message, 200) ?? 'Importing is unavailable right now.', [], 'warn'); return; }
      const refused = (Array.isArray(reply.refused) ? reply.refused : []).map(row => ({ name: text(row?.name, 120) ?? 'File', message: text(row?.message, 300) ?? 'Not imported.' }));
      const added = (Array.isArray(reply.imported) ? reply.imported : []).filter(row => row && typeof row.id === 'string' && UUID.test(row.id));
      await refresh();
      const first = imports.find(item => item.id === added[0]?.id);
      if (first) show(first);
      if (refused.length) say(added.length ? 'Imported ' + added.length + ' of ' + (added.length + refused.length) + ' files' : refused.length === 1 ? 'Couldn’t import this file' : 'Couldn’t import these files', refused, 'warn');
      else if (added.length) { notice.hidden = true; noticeBody.replaceChildren(); }
    } catch { say('Arcane couldn’t import that. Nothing was changed.', [], 'warn'); }
    finally { busy = false; trigger?.removeAttribute('aria-busy'); }
  }
  async function load(asset: ImportedViewerAsset, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await request('/v1/imports/file?id=' + encodeURIComponent(asset.id), { method: 'GET', signal });
    if (!response.ok || response.headers.get('Content-Length') !== String(asset.bytes) || !response.body) { await response.body?.cancel(); throw new Error('Import unavailable.'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > asset.bytes) throw new Error('Import changed.'); chunks.push(value); }
    } finally { reader.releaseLock(); }
    if (total !== asset.bytes) throw new Error('Import incomplete.');
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (digest !== asset.sha256) throw new Error('Import checksum mismatch.');
    return bytes.buffer;
  }
  function openPreview(): void {
    doc.getElementById('preview-model-tab')?.click();
    const toggle = doc.getElementById('workspace-preview-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  }
  function show(asset: ImportedViewerAsset): void {
    options.library.release();
    shownId = asset.id; openPreview(); renderPicker();
    void options.library.viewer.showImported(asset, signal => load(asset, signal), () => !stopped && shownId === asset.id, { remove: () => { void remove(asset); } });
  }
  async function remove(asset: ImportedViewerAsset): Promise<void> {
    try {
      const response = await request('/v1/imports/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: asset.id }) });
      if (!response.ok && response.status !== 404) throw new Error();
      if (shownId === asset.id) { shownId = ''; options.library.viewer.clear(); }
      await refresh();
      say('Removed ' + asset.name + '. The file on your computer is unchanged.');
    } catch { say('Arcane couldn’t remove ' + asset.name + '. Try again.', [], 'warn'); }
  }

  // ---- Picker: generated and imported assets, then "Import from file…". ----
  const picker = make('div', 'import-picker'); picker.id = 'asset-picker'; picker.hidden = true;
  picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'Choose an asset');
  const list = make('div', 'import-picker-list'); list.setAttribute('role', 'list');
  const importButton = make('button', 'import-picker-import'); importButton.type = 'button';
  importButton.append(icon('upload'), make('span', 'import-picker-import-label', 'Import from file…'), make('span', 'import-picker-formats', 'GLB, glTF, .rbxmx'));
  picker.append(list, importButton);
  if (stage) stage.append(picker);
  let returnFocus: HTMLElement | null = null;
  listen(importButton, 'click', () => { void run(desktop => desktop.pick()); });
  function row(label: string, meta: string, kind: 'model' | 'effect', selected: boolean, open: () => void, removeRow?: () => void): HTMLElement {
    const item = make('div', 'import-row'); item.setAttribute('role', 'listitem'); if (selected) item.dataset.selected = 'true';
    const main = make('button', 'import-row-main'); main.type = 'button';
    const names = make('span', 'import-row-names'); names.append(make('span', 'import-row-name', label), make('span', 'import-row-meta', meta));
    main.append(icon(kind === 'effect' ? 'flame' : 'cube'), names);
    if (selected) main.setAttribute('aria-current', 'true');
    main.addEventListener('click', () => { closePicker(false); open(); });
    item.append(main);
    if (removeRow) {
      const bin = make('button', 'import-row-remove'); bin.type = 'button'; bin.setAttribute('aria-label', 'Remove ' + label); bin.title = 'Remove import';
      bin.append(icon('trash')); bin.addEventListener('click', () => { removeRow(); });
      item.append(bin);
    }
    return item;
  }
  function renderPicker(): void {
    const rows: HTMLElement[] = [];
    // Marked selected only while the viewer still shows that file; a chat card's View may have replaced it since.
    const showing = shownId && doc.querySelector('#asset-viewer .vw[data-source="imported"]') ? shownId : '';
    for (const job of options.library.generated().slice(0, 32)) {
      const name = text(job.name, 80) ?? 'Model';
      rows.push(row(name.charAt(0).toUpperCase() + name.slice(1), 'Model · Generated', 'model', false, () => { shownId = ''; options.library.view(job.jobId); }));
    }
    for (const asset of imports) {
      rows.push(row(asset.name, (asset.kind === 'effect' ? 'Effect' : 'Model') + ' · Imported · ' + formatBytes(asset.bytes), asset.kind, asset.id === showing,
        () => show(asset), () => { void remove(asset); }));
    }
    list.replaceChildren(...rows); list.hidden = !rows.length;
    if (trigger) trigger.setAttribute('aria-haspopup', rows.length ? 'dialog' : 'false');
  }
  function place(anchor: HTMLElement): void {
    if (!stage) return;
    const host = stage.getBoundingClientRect(), at = anchor.getBoundingClientRect(), width = Math.min(360, host.width - 24);
    picker.style.width = width + 'px';
    picker.style.left = Math.round(Math.min(Math.max(12, at.left - host.left + at.width / 2 - width / 2), host.width - width - 12)) + 'px';
    picker.style.top = Math.round(Math.min(at.bottom - host.top + 8, Math.max(12, host.height - 320))) + 'px';
  }
  function openPicker(anchor: HTMLElement): void {
    renderPicker(); returnFocus = anchor; place(anchor); picker.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    (picker.querySelector<HTMLElement>('.import-row-main') ?? importButton).focus();
  }
  function closePicker(restore = true): void {
    if (picker.hidden) return;
    picker.hidden = true; returnFocus?.setAttribute('aria-expanded', 'false');
    if (restore) returnFocus?.focus();
  }
  listen(picker, 'keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Escape') { event.preventDefault(); closePicker(); return; }
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const items = [...picker.querySelectorAll<HTMLElement>('.import-row-main'), importButton], index = items.indexOf(doc.activeElement as HTMLElement);
    event.preventDefault(); items[(index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  listen(doc, 'pointerdown', event => { if (!picker.hidden && !(event.target instanceof Node && (picker.contains(event.target) || returnFocus?.contains(event.target)))) closePicker(false); });
  /** "Choose an asset": straight to the file picker when there is nothing to choose, otherwise the picker. The list is read
   * here, on the person's click (never at startup), so it is current and an idle workspace makes no import request. */
  async function choose(anchor: HTMLElement): Promise<void> {
    if (!picker.hidden) { closePicker(); return; }
    await refresh();
    if (stopped) return;
    if (!options.library.generated().length && !imports.length) { void run(desktop => desktop.pick()); return; }
    openPicker(anchor);
  }
  if (trigger) {
    trigger.dataset.assetPicker = 'on'; trigger.setAttribute('aria-controls', picker.id); trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('data-workspace-target');
    listen(trigger, 'click', event => { event.preventDefault(); void choose(trigger); });
  }
  // The viewer's asset chip opens the same picker while something is shown.
  listen(doc, 'arcane:choose-asset', event => { const anchor = (event as CustomEvent<{ anchor?: unknown }>).detail?.anchor; if (anchor instanceof HTMLElement) void choose(anchor); });
  return {
    refresh, choose,
    stop(): void { stopped = true; closePicker(false); for (const remove of cleanup.splice(0)) remove(); drop.remove(); notice.remove(); picker.remove(); if (trigger) delete trigger.dataset.assetPicker; },
  };
}
