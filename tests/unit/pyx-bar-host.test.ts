import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Pyx bar host (apps/desktop/electron/pyx-bar-host.cjs) with fake Electron pieces: no window ever reaches the screen.
const require = createRequire(import.meta.url);
const host = require(join(process.cwd(), 'apps/desktop/electron/pyx-bar-host.cjs')) as any;
const { createPyxBar, createPositionStore, pyxPlacement, readPositions, rememberPosition, clampToArea, displayKey, PYX_SIZE, STORE_FILE } = host;

type Rect = { x: number; y: number; width: number; height: number };
const display = (id: number, bounds: Rect, taskbar = 48, primary = false) => ({ id, primary, bounds, workArea: { ...bounds, height: bounds.height - taskbar } });
const LEFT = display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 48, true);
const RIGHT = display(2, { x: 1920, y: 0, width: 2560, height: 1440 }, 40);
const ORIGIN = 'http://127.0.0.1:4100';

class FakeContents extends EventEmitter {
  sent: [string, unknown][] = []; mainFrame = { url: ORIGIN + '/pyx-bar' }; loading = true; zoom = 1;
  send(channel: string, value: unknown) { this.sent.push([channel, value]); }
  setWindowOpenHandler() {} isLoading() { return this.loading; } getZoomFactor() { return this.zoom; } isDestroyed() { return false; }
}
class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = [];
  options: any; bounds: Rect; visible = false; destroyed = false; ignore: [boolean, unknown][] = []; focused = 0; minimized = false; content: Rect | null = null;
  webContents = new FakeContents();
  constructor(options: any = {}) { super(); this.options = options; this.bounds = { x: 0, y: 0, width: options.width ?? 0, height: options.height ?? 0 }; FakeWindow.made.push(this); }
  getBounds() { return { ...this.bounds }; } setBounds(b: Rect) { this.bounds = { ...b }; } getContentBounds() { return { ...(this.content ?? this.bounds) }; }
  show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused++; } isVisible() { return this.visible; } isMinimized() { return this.minimized; } restore() { this.minimized = false; }
  isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; this.emit('closed'); }
  setAlwaysOnTop() {} setIgnoreMouseEvents(on: boolean, o?: unknown) { this.ignore.push([on, o]); }
  loadURL() { return Promise.resolve(); }
}
class FakeIpc {
  handlers = new Map<string, Function>(); listeners = new Map<string, Function>();
  handle(channel: string, fn: Function) { this.handlers.set(channel, fn); }
  on(channel: string, fn: Function) { this.listeners.set(channel, fn); }
}
const timers = () => {
  let nextId = 1; const queue = new Map<number, { at: number; fn: () => void }>(); let now = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; queue.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: number) => { queue.delete(id); },
    advance(ms: number) { now += ms; for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { queue.delete(id); t.fn(); } },
  };
};

function rig(options: { displays?: any[]; main?: Rect; store?: any } = {}) {
  FakeWindow.made = [];
  const main = new FakeWindow({ width: 1440, height: 900 }); main.bounds = options.main ?? { x: 240, y: 90, width: 1440, height: 900 }; main.visible = true;
  main.content = { ...main.bounds, y: main.bounds.y + 32, height: main.bounds.height - 32 };
  const screen = Object.assign(new EventEmitter(), {
    displays: options.displays ?? [LEFT], cursor: { x: 0, y: 0 },
    getAllDisplays() { return this.displays; }, getCursorScreenPoint() { return { ...this.cursor }; },
    getDisplayNearestPoint(p: { x: number; y: number }) { return this.displays.find((d: any) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width) ?? this.displays[0]; },
  });
  const clock = timers(), ipc = new FakeIpc();
  const bar = createPyxBar({ BrowserWindow: FakeWindow, screen, preload: 'pyx-preload.cjs', getMain: () => main, getOrigin: () => ORIGIN, available: () => true, store: options.store ?? null, timers: clock });
  const trusted = (event: any) => event?.sender === main.webContents;
  bar.installIpc(ipc, { trusted });
  const fromMain = { sender: main.webContents, senderFrame: { url: ORIGIN + '/studio' } };
  const barWindow = () => FakeWindow.made.find(w => w !== main) ?? null;
  const fromBar = () => { const w = barWindow()!; return { sender: w.webContents, senderFrame: w.webContents.mainFrame }; };
  const send = (channel: string, ...args: unknown[]) => ipc.listeners.get(channel)!(fromBar(), ...args);
  const invoke = (channel: string, ...args: unknown[]) => ipc.handlers.get(channel)!(fromMain, ...args);
  const barReady = () => { const w = barWindow()!; w.emit('ready-to-show'); w.webContents.loading = false; send('arcane:pyx-ready'); };
  const perch = () => main.webContents.sent.filter(([c]) => c === 'arcane:pyx-visibility').map(([, v]) => v);
  const told = () => barWindow()!.webContents.sent.filter(([c]) => c === 'arcane:pyx-visibility').map(([, v]) => v);
  return { main, screen, clock, ipc, bar, barWindow, send, invoke, barReady, perch, told, fromMain };
}

test('the perch toggles the bar: open, then close with the pop-out, aria-expanded follows', async () => {
  const r = rig();
  assert.deepEqual(await r.invoke('arcane:pyx-toggle'), { opened: true, open: true });
  const w = r.barWindow()!;
  assert.equal(w.visible, false, 'not shown before the bar has painted');
  assert.equal(w.options.show, false); assert.equal(w.options.transparent, true); assert.equal(w.options.frame, false); assert.equal(w.options.webPreferences.sandbox, true);
  assert.deepEqual(r.perch(), [true], 'the perch says expanded at once');
  r.barReady();
  assert.equal(w.visible, true, 'shown after its first paint'); assert.ok(w.focused > 0);
  assert.equal(r.told().at(-1), true, 'the bar is told to pop in');
  // Second perch click closes: the bar is told first, then hides itself once its pop-out has played.
  assert.deepEqual(await r.invoke('arcane:pyx-toggle'), { opened: false, open: false });
  assert.equal(r.told().at(-1), false); assert.deepEqual(r.perch().at(-1), false);
  assert.equal(w.visible, true, 'still on screen while it animates out');
  r.send('arcane:pyx-close');
  assert.equal(w.visible, false, 'hidden when the bar reports the pop-out done');
  // Third click opens it again, at the same place, with the draft kept (same window, no reload).
  w.bounds = { ...w.bounds, x: 500, y: 300 };
  await r.invoke('arcane:pyx-toggle');
  assert.equal(r.barWindow(), w, 'the same document, so the draft survives'); assert.equal(w.visible, true); assert.deepEqual([w.bounds.x, w.bounds.y], [500, 300]);
  assert.equal(await r.invoke('arcane:pyx-is-open'), true);
});

test('close falls back to hiding when the bar does not answer; × and Escape close from the bar', async () => {
  const r = rig();
  await r.invoke('arcane:pyx-toggle'); r.barReady(); const w = r.barWindow()!;
  await r.invoke('arcane:pyx-toggle');
  r.clock.advance(419); assert.equal(w.visible, true);
  r.clock.advance(2); assert.equal(w.visible, false, 'hidden after the fallback');
  assert.deepEqual(w.ignore.at(-1), [true, { forward: true }], 'clicks pass through again while hidden');
  await r.invoke('arcane:pyx-toggle'); assert.equal(w.visible, true);
  const toldBefore = r.told().length;
  r.send('arcane:pyx-close'); // the bar's × or Escape, after its own pop-out
  assert.equal(w.visible, false); assert.equal(r.perch().at(-1), false, 'the perch follows a close from the bar');
  assert.equal(r.told().length, toldBefore, 'no "closed" echo back to the bar, so a quick reopen is never undone by a late close');
  assert.equal(await r.invoke('arcane:pyx-is-open'), false);
  // Reopening while it is still animating out cancels the hide.
  await r.invoke('arcane:pyx-toggle'); await r.invoke('arcane:pyx-toggle'); await r.invoke('arcane:pyx-toggle');
  r.clock.advance(1000); assert.equal(w.visible, true, 'a quick re-open wins over the pending hide');
  // Expand: the main window comes forward and the bar closes.
  r.main.minimized = true; r.send('arcane:pyx-expand');
  assert.equal(r.main.minimized, false); assert.ok(r.main.focused > 0); assert.equal(r.told().at(-1), false);
});

test('drag: the host follows the cursor, keeps the bar on a work area and remembers it per display', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pyx-host-')); const store = createPositionStore(dir);
  try {
    const r = rig({ displays: [LEFT, RIGHT], store });
    await r.invoke('arcane:pyx-toggle'); r.barReady(); const w = r.barWindow()!;
    const start = w.getBounds();
    r.screen.cursor = { x: start.x + 60, y: start.y + 110 };
    r.send('arcane:pyx-drag', 'start');
    assert.deepEqual(w.ignore.at(-1), [false, undefined], 'the bar takes the pointer for the whole move');
    r.send('arcane:pyx-interactive', false); assert.deepEqual(w.ignore.at(-1), [false, undefined], 'pass-through waits until the move ends');
    r.screen.cursor = { x: start.x + 160, y: start.y + 60 }; r.send('arcane:pyx-drag', 'move');
    assert.deepEqual([w.bounds.x, w.bounds.y], [start.x + 100, start.y - 50]);
    assert.deepEqual([w.bounds.width, w.bounds.height], [PYX_SIZE.width, PYX_SIZE.height], 'the size never drifts while moving');
    // Past the bottom edge: clamped inside the work area (above the taskbar).
    r.screen.cursor = { x: start.x + 160, y: 5000 }; r.send('arcane:pyx-drag', 'move');
    assert.equal(w.bounds.y, LEFT.workArea.height - PYX_SIZE.height);
    // Onto the right display, then let go: remembered for that display.
    r.screen.cursor = { x: 2600, y: 700 }; r.send('arcane:pyx-drag', 'move'); r.send('arcane:pyx-drag', 'end');
    const saved = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf8'));
    assert.equal(saved.last, displayKey(RIGHT));
    assert.deepEqual(saved.positions[displayKey(RIGHT)], { dx: w.bounds.x - RIGHT.workArea.x, dy: w.bounds.y - RIGHT.workArea.y });
    // A press that never moved is not saved as a move.
    const before = readFileSync(join(dir, STORE_FILE), 'utf8');
    r.send('arcane:pyx-drag', 'start'); r.send('arcane:pyx-drag', 'cancel');
    assert.equal(readFileSync(join(dir, STORE_FILE), 'utf8'), before);
    // Keyboard nudge: bounded and remembered.
    const x = w.bounds.x; r.send('arcane:pyx-nudge', { dx: 9999, dy: 0 }); assert.equal(w.bounds.x, x + 64, 'a step is at most 64px');
    // A new session opens where the user left it.
    const again = rig({ displays: [LEFT, RIGHT], store });
    await again.invoke('arcane:pyx-toggle'); const w2 = again.barWindow()!;
    assert.deepEqual([w2.bounds.x, w2.bounds.y], [w.bounds.x, w.bounds.y]);
    // That display is gone: back on the main window's display, inside its work area.
    const lone = rig({ displays: [LEFT], store });
    await lone.invoke('arcane:pyx-toggle'); const w3 = lone.barWindow()!;
    assert.ok(w3.bounds.x >= 0 && w3.bounds.x + PYX_SIZE.width <= 1920 && w3.bounds.y + PYX_SIZE.height <= LEFT.workArea.height);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a display change keeps an open bar on a visible work area', async () => {
  const r = rig({ displays: [LEFT, RIGHT] });
  await r.invoke('arcane:pyx-toggle'); r.barReady(); const w = r.barWindow()!;
  w.bounds = { ...w.bounds, x: 3800, y: 1200 };
  r.screen.displays = [LEFT]; r.screen.emit('display-removed');
  assert.ok(w.bounds.x + PYX_SIZE.width <= 1920 && w.bounds.y + PYX_SIZE.height <= LEFT.workArea.height, JSON.stringify(w.bounds));
});

test('first open keeps clear of the main window composer', () => {
  const area = LEFT.workArea, size = PYX_SIZE;
  const solid = (p: { x: number; y: number }) => ({ x: p.x + 16, y: p.y + 16, width: size.width - 32, height: size.height - 72 });
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  // Main window in the top half: bottom centre of the work area is clear.
  const small = { x: 400, y: 40, width: 1100, height: 600 }, smallComposer = { x: 534, y: 470, width: 832, height: 150 };
  const a = pyxPlacement({ displays: [LEFT], main: small, composer: smallComposer });
  assert.equal(a.source, 'bottom-centre'); assert.equal(a.x, Math.round((1920 - size.width) / 2)); assert.equal(a.y, area.height - size.height);
  // Maximised main window: its composer is at the bottom centre, so the bar opens above it on the perch side.
  const max = { x: 0, y: 0, width: 1920, height: 1032 }, composer = { x: 544, y: 840, width: 832, height: 170 };
  const b = pyxPlacement({ displays: [LEFT], main: max, composer });
  assert.equal(b.source, 'above-composer'); assert.equal(overlaps(solid(b), composer), false);
  assert.equal(b.x + 17, composer.x, 'Pyx lines up over the perch');
  // A narrow main window on the left: beside it, level with its composer.
  const narrow = { x: 0, y: 200, width: 900, height: 832 }, narrowComposer = { x: 30, y: 870, width: 840, height: 140 };
  const c = pyxPlacement({ displays: [LEFT], main: narrow, composer: narrowComposer });
  assert.equal(overlaps(solid(c), narrowComposer), false); assert.ok(c.x >= narrow.x + narrow.width - 16, c.source);
  // Every candidate stays inside the work area.
  for (const p of [a, b, c]) assert.ok(p.x >= 0 && p.y >= 0 && p.x + size.width <= area.width && p.y + size.height <= area.height);
  // No displays: nothing to place.
  assert.equal(pyxPlacement({ displays: [] }), null);
  // Without a composer report, the composer is assumed at the bottom centre of the main window and still avoided.
  const guessed = pyxPlacement({ displays: [LEFT], main: max });
  assert.equal(guessed.source, 'above-composer'); assert.ok(guessed.y + size.height - 56 <= max.y + max.height - 190);
});

test('positions file: bounded, tolerant of damage, atomic, most recent display first', () => {
  assert.deepEqual(readPositions(null), { version: 1, last: null, positions: {} });
  assert.deepEqual(readPositions({ version: 2, last: 'x', positions: {} }).positions, {});
  const bad = readPositions({ version: 1, last: '0,0,1920x1080', positions: { '0,0,1920x1080': { dx: 1.5, dy: 2 }, 'not a key': { dx: 1, dy: 1 }, '1920,0,2560x1440': { dx: 10, dy: 20 } } });
  assert.deepEqual(bad, { version: 1, last: null, positions: { '1920,0,2560x1440': { dx: 10, dy: 20 } } });
  let record = readPositions(null);
  for (let i = 0; i < 12; i++) record = rememberPosition(record, `${i * 100},0,100x100`, i, i);
  assert.equal(Object.keys(record.positions).length, 8); assert.equal(record.last, '1100,0,100x100'); assert.equal(Object.keys(record.positions)[0], '1100,0,100x100');
  assert.deepEqual(clampToArea({ x: -50, y: 9999 }, LEFT.workArea), { x: 0, y: LEFT.workArea.height - PYX_SIZE.height });
  const dir = mkdtempSync(join(tmpdir(), 'pyx-store-'));
  try {
    const store = createPositionStore(dir);
    assert.deepEqual(store.read(), readPositions(null), 'missing file');
    writeFileSync(join(dir, STORE_FILE), '{not json'); assert.deepEqual(store.read(), readPositions(null), 'damaged file');
    assert.equal(store.write(record), true); assert.equal(store.read().last, record.last);
    const sub = join(dir, 'as-dir'); mkdirSync(join(sub, STORE_FILE), { recursive: true });
    assert.equal(createPositionStore(sub).write(record), false, 'never writes through something that is not a file');
    assert.equal(createPositionStore(null).write(record), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the bar may move, close or submit; only the workspace may toggle or publish', async () => {
  const r = rig();
  await r.invoke('arcane:pyx-toggle'); r.barReady(); const w = r.barWindow()!;
  const stranger = { sender: new FakeContents(), senderFrame: { url: ORIGIN + '/pyx-bar' } };
  await assert.rejects(async () => r.ipc.handlers.get('arcane:pyx-toggle')!(stranger), /unavailable/);
  const before = w.getBounds();
  r.screen.cursor = { x: 10, y: 10 }; r.ipc.listeners.get('arcane:pyx-drag')!(stranger, 'start');
  r.screen.cursor = { x: 900, y: 10 }; r.ipc.listeners.get('arcane:pyx-drag')!(stranger, 'move');
  r.ipc.listeners.get('arcane:pyx-close')!(stranger);
  assert.deepEqual(w.getBounds(), before); assert.equal(w.visible, true);
  assert.deepEqual(await r.ipc.handlers.get('arcane:pyx-submit')!(stranger, 'hi'), { accepted: false, message: 'Pyx couldn’t send that.' });
  // The layout report from the workspace is bounded.
  r.ipc.listeners.get('arcane:pyx-layout')!(r.fromMain, { x: 1e9, y: 0, width: 10, height: 10 });
  r.ipc.listeners.get('arcane:pyx-layout')!(stranger, { x: 0, y: 0, width: 10, height: 10 });
});

test('submit round trip through the host: the workspace answers, the bar gets the result', async () => {
  const r = rig();
  await r.invoke('arcane:pyx-toggle'); r.barReady(); const w = r.barWindow()!;
  const pending = r.ipc.handlers.get('arcane:pyx-submit')!({ sender: w.webContents, senderFrame: w.webContents.mainFrame }, 'Plant a forest');
  const request = r.main.webContents.sent.find(([c]) => c === 'arcane:pyx-request')?.[1] as { type: string; id: string; text: string };
  assert.equal(request.type, 'submit'); assert.equal(request.text, 'Plant a forest');
  r.ipc.listeners.get('arcane:pyx-answer')!(r.fromMain, { id: request.id, accepted: true });
  assert.deepEqual(await pending, { accepted: true });
  // A publish reaches the bar once; the same snapshot again is not re-sent.
  const publish = r.ipc.listeners.get('arcane:pyx-publish')!;
  const snapshot = { state: { phase: 'idle', provider: 'claude', reply: 'Forest planted.' }, suggestions: [] };
  const count = () => w.webContents.sent.filter(([c]) => c === 'arcane:pyx-state').length;
  const n = count(); publish(r.fromMain, snapshot); publish(r.fromMain, snapshot);
  assert.equal(count(), n + 1);
});

test('bar-local model IPC relays only exact frame requests and original replies without focusing the main window',async()=>{
  const r=rig();await r.invoke('arcane:pyx-toggle');r.barReady();const w=r.barWindow()!,event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
  const view={revision:'453f0fb4-f28b-434a-aee5-605261af915f',selectable:true,message:null,selected:{provider:'codex',model:'fixture',effort:'low'},models:[{provider:'codex',id:'fixture',label:'Fixture',efforts:['low','high']}]};
  const read=r.ipc.handlers.get('arcane:pyx-models')!(event),request=r.main.webContents.sent.at(-1)![1] as {id:string;type:string};assert.equal(request.type,'models-read');
  r.ipc.listeners.get('arcane:pyx-model-answer')!({sender:{}},{id:request.id,result:view});
  r.ipc.listeners.get('arcane:pyx-model-answer')!(r.fromMain,{id:request.id,result:view});assert.deepEqual(await read,view);
  const choice={revision:view.revision,provider:'codex',model:'fixture',effort:'high'},selected=r.ipc.handlers.get('arcane:pyx-select-model')!(event,choice),select=r.main.webContents.sent.at(-1)![1] as {id:string;type:string};
  assert.equal(select.type,'models-select');r.ipc.listeners.get('arcane:pyx-model-answer')!(r.fromMain,{id:select.id,result:{state:'applied'}});assert.deepEqual(await selected,{state:'applied'});
  assert.equal(r.main.focused,0);assert.equal(r.main.webContents.sent.some(([,v])=>(v as {type?:string})?.type==='model-picker'),false);
  const count=r.main.webContents.sent.length;
  for(const bad of [{...choice,token:'forged'},{...choice,revision:'-'.repeat(36)},{...choice,effort:'high\n'}])assert.equal((await r.ipc.handlers.get('arcane:pyx-select-model')!(event,bad)).state,'rejected');
  assert.equal(await r.ipc.handlers.get('arcane:pyx-models')!({sender:w.webContents,senderFrame:{...w.webContents.mainFrame}}),null);assert.equal(r.main.webContents.sent.length,count);
});

test('model picker geometry is a fixed owned size, clamped and restored with the painted bar anchor',async()=>{
  const r=rig();await r.invoke('arcane:pyx-toggle');r.barReady();const w=r.barWindow()!,base=w.getBounds();
  r.send('arcane:pyx-picker-open',true);let expanded=w.getBounds();assert.equal(expanded.width,PYX_SIZE.width);assert.equal(expanded.height,host.PYX_PICKER_HEIGHT);
  assert.equal(expanded.y+expanded.height-PYX_SIZE.height,base.y);assert.equal(r.main.focused,0);
  r.send('arcane:pyx-picker-open',{height:9999});assert.deepEqual(w.getBounds(),expanded);
  r.screen.displays=[display(1,{x:0,y:0,width:1100,height:640},40,true)];r.screen.emit('display-metrics-changed');expanded=w.getBounds();
  assert.ok(expanded.y>=0&&expanded.y+expanded.height<=600);r.send('arcane:pyx-nudge',{dx:16,dy:0});assert.equal(w.getBounds().height,host.PYX_PICKER_HEIGHT);
  r.send('arcane:pyx-picker-open',false);assert.equal(w.getBounds().height,PYX_SIZE.height);assert.ok(w.getBounds().y+w.getBounds().height<=600);
  r.send('arcane:pyx-picker-open',true);r.bar.hide();assert.equal(w.getBounds().height,PYX_SIZE.height);assert.equal(w.visible,false);
});

test('lost selection acknowledgement stays unknown and reset closes model admission without replay',async()=>{
  const r=rig();await r.invoke('arcane:pyx-toggle');r.barReady();const w=r.barWindow()!,event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
  const choice={revision:'453f0fb4-f28b-434a-aee5-605261af915f',provider:'codex',model:'fixture',effort:'high'};
  const pending=r.ipc.handlers.get('arcane:pyx-select-model')!(event,choice),before=r.main.webContents.sent.length;r.clock.advance(6000);
  assert.equal((await pending).state,'unknown');assert.equal(r.main.webContents.sent.length,before);
  const read=r.ipc.handlers.get('arcane:pyx-models')!(event),select=r.ipc.handlers.get('arcane:pyx-select-model')!(event,choice);r.bar.reset();
  assert.equal(await read,null);assert.equal((await select).state,'unknown');assert.equal(r.main.focused,0);
  assert.equal(host.readModelResult({state:'applied',accepted:true}),null);
});
