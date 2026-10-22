'use strict';
// The Pyx pop-out bar window and its IPC relay. The bar never talks to the daemon or a provider: every intent is relayed
// to the workspace renderer, which uses the main composer's own controls (pyx-link.ts). State flows the other way.
// The host also owns where the bar sits: a first open avoids the main window's composer, a drag is remembered per display
// (pyx-bar.v1.json in Arcane's own user directory) and the bar is kept inside a visible work area when displays change.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PYX_PATH = '/pyx-bar';
const PYX_SIZE = Object.freeze({ width: 772, height: 244 }); // pyx-bar.css: 740px bar + 16px margins; bubble row, 60px bar, one suggestion row, shadow room
/** Where the painted bar sits inside the transparent window (pyx-bar.css): x 16..756, bubble from y 16, bar y 80..140, suggestions to ~180. */
const PYX_SOLID = Object.freeze({ left: 16, top: 16, right: 16, bottom: 56 });
const PYX_BAR_BOTTOM = 140; // the 60px bar row ends 140px into the window
const PYX_PET_X = 17; // the pet's left edge inside the window, aligned over the main composer's perch when the bar opens beside it
const ANSWER_MS = 6000, CLOSE_FALLBACK_MS = 420, SHOW_FALLBACK_MS = 2500, NUDGE_MAX = 64, GAP = 12;
const STORE_FILE = 'pyx-bar.v1.json', STORE_MAX_DISPLAYS = 8, STORE_MAX_BYTES = 8192;
const PHASES = ['idle', 'working', 'done', 'error', 'offline'], PROVIDERS = ['claude', 'codex', 'arcane'];

/** A bounded, plain copy of the workspace's snapshot (pyx-bar.ts re-validates everything again). */
function readSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let json; try { json = JSON.stringify(value); } catch { return null; }
  if (json.length > 32768) return null;
  const s = value.state, str = (v, max) => typeof v === 'string' ? v.slice(0, max) : null, int = v => Number.isSafeInteger(v) && v >= 0 && v <= 100000 ? v : null;
  if (!s || typeof s !== 'object' || !PHASES.includes(s.phase)) return null;
  const p = s.progress && typeof s.progress === 'object' ? { title: str(s.progress.title, 200), step: int(s.progress.step), steps: int(s.progress.steps),
    startedAt: typeof s.progress.startedAt === 'number' && Number.isFinite(s.progress.startedAt) ? s.progress.startedAt : null } : null;
  const state = { phase: s.phase, provider: PROVIDERS.includes(s.provider) ? s.provider : null, model: str(s.model, 64), modelTitle: str(s.modelTitle, 96), effort: str(s.effort, 24),
    reply: str(s.reply, 600), progress: p && p.title ? p : null, message: str(s.message, 300), canStop: s.canStop === true };
  const suggestions = Array.isArray(value.suggestions) ? value.suggestions.slice(0, 3).map(x => x && typeof x === 'object' ? { label: str(x.label, 60), text: str(x.text, 4000) } : null)
    .filter(x => x && x.label && x.text) : [];
  return { state, suggestions };
}

// ------------------------------------------------------------------------------------------------ geometry ----
const finite = v => typeof v === 'number' && Number.isFinite(v);
const rectOf = r => r && finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width >= 0 && r.height >= 0
  ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
const intersects = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** A stable name for a display across launches: its bounds (DIP), which change only when the arrangement does. */
const displayKey = display => { const b = rectOf(display?.bounds); return b ? `${b.x},${b.y},${b.width}x${b.height}` : null; };
/** Keeps the whole window inside a work area (the transparent margins included, so the painted bar is always reachable). */
function clampToArea(point, area, size = PYX_SIZE) {
  const a = rectOf(area); if (!a) return { x: Math.round(point.x), y: Math.round(point.y) };
  const x = Math.min(Math.max(Math.round(point.x), a.x), a.x + Math.max(0, a.width - size.width));
  const y = Math.min(Math.max(Math.round(point.y), a.y), a.y + Math.max(0, a.height - size.height));
  return { x, y };
}
/** The painted part of the bar at a window position (what must not cover the composer). */
const solidAt = (p, size = PYX_SIZE) => ({ x: p.x + PYX_SOLID.left, y: p.y + PYX_SOLID.top, width: size.width - PYX_SOLID.left - PYX_SOLID.right, height: size.height - PYX_SOLID.top - PYX_SOLID.bottom });
const displayFor = (displays, p, size = PYX_SIZE) => {
  const cx = p.x + size.width / 2, cy = p.y + size.height / 2;
  let best = null, bestDistance = Infinity;
  for (const d of displays) {
    const b = rectOf(d.bounds); if (!b) continue;
    const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width)), dy = Math.max(b.y - cy, 0, cy - (b.y + b.height)), distance = dx * dx + dy * dy;
    if (distance < bestDistance) { best = d; bestDistance = distance; }
  }
  return best;
};

/** Without a report from the workspace, the composer is assumed to be where Arcane draws it: bottom centre of the window. */
const guessComposer = main => {
  if (!main) return null;
  const width = Math.min(832, Math.max(0, main.width - 48)), height = Math.min(190, main.height);
  return { x: Math.round(main.x + (main.width - width) / 2), y: main.y + main.height - height, width, height };
};
/**
 * Where the bar opens. Order: a position the user dragged it to (the display it was last on, else the main window's
 * display), else a default that keeps the main window's composer clear: bottom centre of the work area, then beside the
 * main window, then just above the composer on the perch side. Every result is clamped into a work area.
 */
function pyxPlacement({ displays, main = null, composer = null, saved = null, size = PYX_SIZE }) {
  const list = (Array.isArray(displays) ? displays : []).filter(d => rectOf(d?.bounds) && rectOf(d?.workArea));
  if (!list.length) return null;
  const byKey = key => list.find(d => displayKey(d) === key) ?? null;
  const mainRect = rectOf(main);
  const home = (mainRect && displayFor(list, mainRect, mainRect)) ?? list.find(d => d.primary) ?? list[0];
  const fromSaved = (key, entry) => {
    const display = byKey(key); if (!display || !entry || !finite(entry.dx) || !finite(entry.dy)) return null;
    const area = rectOf(display.workArea), p = clampToArea({ x: area.x + entry.dx, y: area.y + entry.dy }, area, size);
    return { ...p, display: displayKey(display), source: 'saved' };
  };
  const positions = saved && typeof saved.positions === 'object' && saved.positions ? saved.positions : {};
  if (saved && typeof saved.last === 'string') { const p = fromSaved(saved.last, positions[saved.last]); if (p) return p; }
  { const key = displayKey(home), p = fromSaved(key, positions[key]); if (p) return p; }

  const area = rectOf(home.workArea), clear = rectOf(composer) ?? guessComposer(mainRect);
  const ok = p => !clear || !intersects(solidAt(p, size), { x: clear.x - GAP, y: clear.y - GAP, width: clear.width + 2 * GAP, height: clear.height + 2 * GAP });
  const candidates = [{ x: area.x + (area.width - size.width) / 2, y: area.y + area.height - size.height, source: 'bottom-centre' }];
  if (mainRect) {
    const baseline = (clear ? clear.y + clear.height : mainRect.y + mainRect.height) - PYX_BAR_BOTTOM; // bar row level with the composer's bottom
    candidates.push({ x: mainRect.x + mainRect.width + GAP - PYX_SOLID.left, y: baseline, source: 'beside-main' });
    candidates.push({ x: mainRect.x - size.width - GAP + PYX_SOLID.right, y: baseline, source: 'beside-main' });
  }
  if (clear) candidates.push({ x: clear.x - PYX_PET_X, y: clear.y - GAP - (size.height - PYX_SOLID.bottom), source: 'above-composer' });
  for (const c of candidates) {
    const p = clampToArea(c, area, size);
    // Beside the main window only counts when it really fits there (clamping it back over the window would defeat it).
    if (c.source === 'beside-main' && (Math.abs(p.x - Math.round(c.x)) > 0)) continue;
    if (ok(p)) return { ...p, display: displayKey(home), source: c.source };
  }
  return { ...clampToArea(candidates[0], area, size), display: displayKey(home), source: 'bottom-centre' };
}

// ------------------------------------------------------------------------------------------------ persistence ----
/** Reads a saved-positions record, dropping anything malformed: { version: 1, last, positions: { [displayKey]: { dx, dy } } }. */
function readPositions(value) {
  const empty = { version: 1, last: null, positions: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return empty;
  const positions = {};
  const entries = value.positions && typeof value.positions === 'object' && !Array.isArray(value.positions) ? Object.entries(value.positions) : [];
  for (const [key, entry] of entries.slice(0, STORE_MAX_DISPLAYS)) {
    if (!/^-?\d{1,6},-?\d{1,6},\d{1,6}x\d{1,6}$/.test(key) || !entry || !Number.isSafeInteger(entry.dx) || !Number.isSafeInteger(entry.dy) ||
        Math.abs(entry.dx) > 100000 || Math.abs(entry.dy) > 100000) continue;
    positions[key] = { dx: entry.dx, dy: entry.dy };
  }
  const last = typeof value.last === 'string' && Object.hasOwn(positions, value.last) ? value.last : null;
  return { version: 1, last, positions };
}
/** Remembers one display's position (most recent first, at most eight displays). */
function rememberPosition(record, key, dx, dy) {
  const current = readPositions(record), positions = { [key]: { dx: Math.round(dx), dy: Math.round(dy) } };
  for (const [k, v] of Object.entries(current.positions)) if (k !== key && Object.keys(positions).length < STORE_MAX_DISPLAYS) positions[k] = v;
  return { version: 1, last: key, positions };
}
/** A tiny JSON file in Arcane's user directory. Reads tolerate a missing or damaged file; writes are atomic (temp + rename). */
function createPositionStore(directory) {
  const file = () => { const dir = typeof directory === 'function' ? directory() : directory; return dir ? path.join(dir, STORE_FILE) : null; };
  return {
    read() {
      const target = file(); if (!target) return readPositions(null);
      try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.size > STORE_MAX_BYTES) return readPositions(null); return readPositions(JSON.parse(fs.readFileSync(target, 'utf8'))); }
      catch { return readPositions(null); }
    },
    write(record) {
      const target = file(); if (!target) return false;
      const temp = target + '.' + randomUUID() + '.tmp';
      try {
        if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) return false;
        fs.writeFileSync(temp, JSON.stringify(readPositions(record)) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, target); return true;
      } catch { try { fs.rmSync(temp, { force: true }); } catch { /* nothing to remove */ } return false; }
    },
  };
}

// ------------------------------------------------------------------------------------------------ the window ----
function createPyxBar({ BrowserWindow, screen, preload, partition = 'arcane-workspace', getMain, getOrigin, available, devTools = false, store = null, timers = globalThis }) {
  let bar = null, snapshot = null, disposed = false, open = false, shown = false, ready = false, closeTimer = null, drag = null, saved = null, placed = false, lastPushed = '';
  let layout = null; // the main window's composer, in its viewport's CSS pixels (pyx-link.ts)
  const pending = new Map(), visibilityListeners = new Set();
  const barUrl = () => getOrigin() + PYX_PATH;
  const live = w => !!w && !w.isDestroyed();
  const fromBar = event => {
    try { const c = bar?.webContents, f = event?.senderFrame; return live(bar) && event.sender === c && !!f && f === c.mainFrame && f.url === barUrl(); } catch { return false; }
  };
  const toBar = (channel, value) => { try { if (live(bar)) bar.webContents.send(channel, value); } catch { /* closing */ } };
  const toMain = request => { const main = getMain(); if (!live(main) || !available()) return false; main.webContents.send('arcane:pyx-request', request); return true; };
  const push = (force = false) => {
    const key = JSON.stringify(snapshot); if (!force && key === lastPushed) return; lastPushed = key;
    toBar('arcane:pyx-state', snapshot?.state ?? null); toBar('arcane:pyx-suggestions', snapshot?.suggestions ?? []);
  };
  /** Tells the workspace (perch aria-expanded) and the bar (pop in or out) whether the bar is open. */
  const announce = (toTheBar = true) => {
    const main = getMain(); try { if (live(main)) main.webContents.send('arcane:pyx-visibility', open); } catch { /* closing */ }
    if (toTheBar && (shown || !open)) toBar('arcane:pyx-visibility', open); // the bar hears "open" only once it is on screen, so its pop is seen
    for (const listener of visibilityListeners) { try { listener(open); } catch { /* observers are optional */ } }
  };
  const displays = () => { try { return screen.getAllDisplays(); } catch { return []; } };
  const positions = () => { if (!saved) { try { saved = readPositions(store?.read?.() ?? null); } catch { saved = readPositions(null); } } return saved; };
  const composerOnScreen = main => {
    if (!layout || !live(main)) return null;
    try {
      const content = main.getContentBounds(), zoom = main.webContents.getZoomFactor?.() || 1;
      return rectOf({ x: content.x + layout.x * zoom, y: content.y + layout.y * zoom, width: layout.width * zoom, height: layout.height * zoom });
    } catch { return null; }
  };
  const setPosition = p => { if (live(bar)) bar.setBounds({ x: p.x, y: p.y, width: PYX_SIZE.width, height: PYX_SIZE.height }); };
  const place = () => {
    const main = getMain(), visibleMain = live(main) && main.isVisible?.() !== false && main.isMinimized?.() !== true;
    const p = pyxPlacement({ displays: displays(), main: visibleMain ? main.getBounds() : null, composer: visibleMain ? composerOnScreen(main) : null, saved: positions() });
    if (p) setPosition(p);
    placed = true;
  };
  /** After a display change, the bar is kept inside the work area of the display nearest to it. */
  const reclamp = () => {
    if (!live(bar)) return;
    const b = bar.getBounds(), list = displays(), display = displayFor(list, b);
    if (!display) return;
    const p = clampToArea(b, display.workArea);
    if (p.x !== b.x || p.y !== b.y) setPosition(p);
  };
  const remember = () => {
    if (!live(bar)) return;
    const b = bar.getBounds(), display = displayFor(displays(), b), key = displayKey(display); if (!key) return;
    const area = rectOf(display.workArea);
    saved = rememberPosition(positions(), key, b.x - area.x, b.y - area.y);
    try { store?.write?.(saved); } catch { /* the position is still remembered for this session */ }
  };
  const onDisplays = () => reclamp();
  for (const type of ['display-added', 'display-removed', 'display-metrics-changed']) { try { screen.on?.(type, onDisplays); } catch { /* optional */ } }

  const reveal = w => { if (bar !== w || !open || shown || !live(w)) return; shown = true; w.show(); w.focus(); announce(); };
  function make() {
    const main = getMain(); if (!live(main)) return null;
    const w = new BrowserWindow({
      width: PYX_SIZE.width, height: PYX_SIZE.height, useContentSize: true,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Pyx', autoHideMenuBar: true, thickFrame: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, devTools, partition, backgroundThrottling: true },
    });
    bar = w; placed = false; shown = false; ready = false;
    w.setAlwaysOnTop(true, 'floating'); // above Roblox Studio and other normal windows, below system UI
    w.setIgnoreMouseEvents(true, { forward: true }); // the transparent margin passes clicks through until the pointer is over the bar
    const contents = w.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const type of ['will-navigate', 'will-redirect', 'will-frame-navigate']) contents.on(type, event => event.preventDefault()); // the bar never navigates
    contents.on('will-attach-webview', event => event.preventDefault());
    // Same partition as the workspace: makeWindow's onBeforeRequest (policy.requestAllowed) already confines every request to the origin.
    contents.on('did-finish-load', () => { if (bar === w) { lastPushed = ''; push(true); if (shown) toBar('arcane:pyx-visibility', open); } });
    contents.on('render-process-gone', () => { if (bar === w) { bar = null; shown = false; w.destroy(); if (open) { open = false; announce(); } } });
    w.on('closed', () => { if (bar === w) { bar = null; shown = false; if (open) { open = false; announce(); } } });
    // Shown only once the bar has painted its closed (transparent) state, so the pop starts from nothing, never a flash.
    w.once('ready-to-show', () => { timers.setTimeout(() => reveal(w), SHOW_FALLBACK_MS); });
    void w.loadURL(barUrl()).catch(() => { if (bar === w) { bar = null; w.destroy(); if (open) { open = false; announce(); } } });
    return w;
  }
  const hideNow = () => {
    if (closeTimer) { timers.clearTimeout(closeTimer); closeTimer = null; }
    drag = null;
    if (live(bar) && shown) { bar.hide(); shown = false; }
    try { bar?.setIgnoreMouseEvents?.(true, { forward: true }); } catch { /* destroyed */ }
  };

  const api = {
    /** Open the bar (create it on first use). Shown after its first paint; the bar pops in when told it is open. */
    open() {
      if (disposed || !available()) return { opened: false, open: false };
      if (closeTimer) { timers.clearTimeout(closeTimer); closeTimer = null; }
      const w = live(bar) ? bar : make(); if (!w) return { opened: false, open: false };
      if (!placed) place(); else reclamp();
      open = true;
      if (shown) { w.focus(); announce(); } // already on screen (or mid-close): pop back in
      else if (ready) reveal(w);
      else announce(); // the workspace learns it now; the window appears when the bar reports its first paint
      return { opened: true, open: true };
    },
    /** Close with the bar's pop-out animation; it hides itself when done (or after a short fallback). */
    close() {
      if (!open) return { open: false };
      open = false; drag = null; announce();
      if (!live(bar) || !shown) { hideNow(); return { open: false }; }
      if (closeTimer) timers.clearTimeout(closeTimer);
      closeTimer = timers.setTimeout(() => { closeTimer = null; if (!open) hideNow(); }, CLOSE_FALLBACK_MS);
      return { open: false };
    },
    /** The perch: open when closed, close when open. */
    toggle() { return open ? { opened: false, ...api.close() } : api.open(); },
    isOpen() { return open; },
    onVisibility(listener) { visibilityListeners.add(listener); return () => visibilityListeners.delete(listener); },
    hide() { open = false; hideNow(); announce(); },
    /** Workspace navigated, reloaded, switched project or lost its runtime: the bar goes honestly offline. */
    reset() { snapshot = null; layout = null; for (const [id, p] of pending) { timers.clearTimeout(p.timer); p.resolve({ accepted: false, message: 'Arcane reloaded. Your text is still here.' }); pending.delete(id); } push(true); },
    dispose() {
      disposed = true; api.reset(); open = false; hideNow(); if (live(bar)) bar.destroy(); bar = null;
      for (const type of ['display-added', 'display-removed', 'display-metrics-changed']) { try { screen.removeListener?.(type, onDisplays); } catch { /* optional */ } }
    },
    installIpc(ipcMain, { trusted }) {
      // ---- from the workspace renderer (trusted = main.cjs rendererEvent: exact main frame of the workspace window)
      ipcMain.handle('arcane:pyx-open', (event, ...args) => { if (args.length || !trusted(event)) throw new Error('Pyx is unavailable.'); return api.open(); });
      ipcMain.handle('arcane:pyx-toggle', (event, ...args) => { if (args.length || !trusted(event)) throw new Error('Pyx is unavailable.'); return api.toggle(); });
      ipcMain.handle('arcane:pyx-is-open', (event, ...args) => { if (args.length || !trusted(event)) throw new Error('Pyx is unavailable.'); return open; });
      ipcMain.on('arcane:pyx-publish', (event, value) => { if (!trusted(event)) return; const next = readSnapshot(value); if (!next) return; snapshot = next; push(); });
      ipcMain.on('arcane:pyx-layout', (event, value) => {
        if (!trusted(event)) return;
        const r = rectOf(value); layout = r && r.width <= 20000 && r.height <= 20000 && Math.abs(r.x) <= 20000 && Math.abs(r.y) <= 20000 ? r : null;
      });
      ipcMain.on('arcane:pyx-answer', (event, value) => {
        if (!trusted(event) || !value || typeof value.id !== 'string') return;
        const p = pending.get(value.id); if (!p) return; pending.delete(value.id); timers.clearTimeout(p.timer);
        p.resolve(value.accepted === true ? { accepted: true } : { accepted: false, message: typeof value.message === 'string' ? value.message.slice(0, 300) : 'Arcane didn’t take that.' });
      });
      // ---- from the bar (fromBar: exact main frame of the bar window at origin + /pyx-bar)
      ipcMain.handle('arcane:pyx-snapshot', event => fromBar(event) ? snapshot : null);
      ipcMain.handle('arcane:pyx-submit', (event, text) => {
        if (!fromBar(event) || typeof text !== 'string' || !text.trim() || text.length > 131072) return { accepted: false, message: 'Pyx couldn’t send that.' };
        if (pending.size >= 4) return { accepted: false, message: 'Pyx is still passing on your last message.' };
        const id = randomUUID();
        return new Promise(resolve => {
          const timer = timers.setTimeout(() => { pending.delete(id); resolve({ accepted: false, message: 'Arcane didn’t answer. Your text is still here.' }); }, ANSWER_MS);
          pending.set(id, { resolve, timer });
          if (!toMain({ type: 'submit', id, text })) { timers.clearTimeout(timer); pending.delete(id); resolve({ accepted: false, message: 'Arcane isn’t open. Your text is still here.' }); }
        });
      });
      ipcMain.on('arcane:pyx-ready', event => { if (!fromBar(event)) return; ready = true; reveal(bar); });
      ipcMain.on('arcane:pyx-stop', event => { if (fromBar(event)) toMain({ type: 'stop' }); });
      // The bar has finished its pop-out (× or Escape, or after the host asked it to close): hide now.
      ipcMain.on('arcane:pyx-close', event => { if (!fromBar(event)) return; if (open) { open = false; announce(false); } hideNow(); }); // the bar closed itself: no echo back, so a quick reopen is never undone
      const focusMain = () => { const main = getMain(); if (!live(main)) return; if (main.isMinimized()) main.restore(); main.show(); main.focus(); };
      ipcMain.on('arcane:pyx-expand', event => { if (!fromBar(event)) return; focusMain(); api.close(); });
      ipcMain.on('arcane:pyx-model-picker', event => { if (!fromBar(event)) return; focusMain(); toMain({ type: 'model-picker' }); });
      ipcMain.on('arcane:pyx-interactive', (event, on) => { if (fromBar(event) && !drag) bar.setIgnoreMouseEvents(on !== true, { forward: true }); });
      // Moving: the bar only says start / move / end; the host reads the cursor itself, so a renderer can never place the
      // window anywhere the user's pointer is not. The bar stays inside the work area of the display under the cursor.
      ipcMain.on('arcane:pyx-drag', (event, phase) => {
        if (!fromBar(event) || !open || !shown) return;
        if (phase === 'start') {
          let cursor; try { cursor = screen.getCursorScreenPoint(); } catch { return; }
          const b = bar.getBounds(); drag = { cx: cursor.x, cy: cursor.y, x: b.x, y: b.y, moved: false };
          bar.setIgnoreMouseEvents(false);
        } else if (phase === 'move' && drag) {
          let cursor; try { cursor = screen.getCursorScreenPoint(); } catch { return; }
          const target = { x: drag.x + cursor.x - drag.cx, y: drag.y + cursor.y - drag.cy };
          let display = null; try { display = screen.getDisplayNearestPoint(cursor); } catch { display = displayFor(displays(), target); }
          setPosition(clampToArea(target, display?.workArea)); drag.moved = true;
        } else if (phase === 'end' || phase === 'cancel') {
          const moved = drag?.moved === true; drag = null;
          if (moved) { reclamp(); remember(); }
        }
      });
      // Keyboard moving (arrow keys on Pyx): bounded steps, clamped and remembered the same way.
      ipcMain.on('arcane:pyx-nudge', (event, value) => {
        if (!fromBar(event) || !open || !shown || !value || typeof value !== 'object') return;
        const dx = Number.isSafeInteger(value.dx) ? Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, value.dx)) : 0, dy = Number.isSafeInteger(value.dy) ? Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, value.dy)) : 0;
        if (!dx && !dy) return;
        const b = bar.getBounds(), target = { x: b.x + dx, y: b.y + dy }, display = displayFor(displays(), target);
        setPosition(clampToArea(target, display?.workArea)); remember();
      });
    },
  };
  return api;
}
module.exports = { createPyxBar, createPositionStore, readSnapshot, readPositions, rememberPosition, pyxPlacement, clampToArea, displayKey, PYX_PATH, PYX_SIZE, PYX_SOLID, STORE_FILE };
