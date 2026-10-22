import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PYX_DONE_HOLD_MS, PYX_FRAME_MS, PYX_PALETTE, pyxScale, pyxSpriteGrid, pyxSpritePixels, type PyxSpriteMood } from '../../apps/desktop/src/pyx-sprite.js';
import {
  PYX_DRAG_THRESHOLD, PYX_INPUT_MAX, PYX_NUDGE_STEP, PYX_OFFLINE_STATE, PYX_PROVIDER_MARKS, createFakePyxBridge, pyxBubbleText, pyxDragStarted, pyxEffortLevel, pyxElapsed, pyxFill,
  pyxModelLabel, pyxMood, pyxNudge, readPyxState, readPyxSuggestions, type PyxBarState,
} from '../../apps/desktop/src/pyx-bar.js';
import { pyxShortModel, pyxStarterSuggestions, pyxSummary } from '../../apps/desktop/src/pyx-link.js';
import { providerLogo } from '../../apps/desktop/src/codex-chat.js';
import { STARTER_PROMPTS } from '../../apps/desktop/src/starter-prompts.js';

// sha256 of JSON.stringify(pixel runs) produced by the Claude Design ShardPet component itself (size 48), per mood and frame.
const CANVAS_FINGERPRINTS: Record<string, string> = {
  idle1: '0f4427e16e173d84d3d9f93dc99e16919a2fc04a5488d25c8338b2af7afcc1a3', idle2: '3d837afdc587d8d46cb5e771ebefa312ff4820756154db4904aa2b44f19654ac',
  listening1: 'a972c8cbd19b0956153dd274da7c89c64ea0456d5a99ae6c3a8dc793d1782f7b', listening2: 'a972c8cbd19b0956153dd274da7c89c64ea0456d5a99ae6c3a8dc793d1782f7b',
  working1: '0b81eaad6d2f4b20334f54cf8b084c32b0f11cf7a70c5ee036cdb34a6c24f6a0', working2: '0de4c6f15d8262c2295df48a9c5c1b170a24f99bd756b1bd3323becf5b7918e3',
  done1: '09afbcdcebb60f82695436083b10f0650ad7ed69441dff7288e88ddabb6e7e14', done2: '09afbcdcebb60f82695436083b10f0650ad7ed69441dff7288e88ddabb6e7e14',
};
const MOODS: PyxSpriteMood[] = ['idle', 'listening', 'working', 'done'];
const state = (patch: Partial<PyxBarState> = {}): PyxBarState => ({ ...PYX_OFFLINE_STATE, phase: 'idle', ...patch });

test('Pyx sprite is the ShardPet pixel data exactly, for every mood and frame', () => {
  for (const mood of MOODS) for (const frame of [1, 2] as const) {
    const runs = pyxSpritePixels(mood, frame);
    assert.equal(createHash('sha256').update(JSON.stringify(runs)).digest('hex'), CANVAS_FINGERPRINTS[mood + frame], mood + frame);
    for (const run of runs) {
      assert.ok(Number.isInteger(run.x) && Number.isInteger(run.y) && Number.isInteger(run.w) && run.w >= 1, 'integer runs');
      assert.ok(run.x >= 0 && run.x + run.w <= 24 && run.y >= 0 && run.y < 24, 'inside the 24×24 grid');
      assert.ok(Object.values(PYX_PALETTE).includes(run.fill), 'palette only: ' + run.fill);
    }
  }
  assert.deepEqual(Object.values(PYX_PALETTE), ['#14040A', '#8E0F22', '#E5323F', '#FF6B78', '#FFFFFF'], 'outline, dark red, red, light red, white');
  assert.notDeepEqual(pyxSpriteGrid('idle', 1), pyxSpriteGrid('idle', 2), 'idle has two frames');
  assert.notDeepEqual(pyxSpriteGrid('working', 1), pyxSpriteGrid('working', 2), 'working has two frames');
  assert.deepEqual(PYX_FRAME_MS, { idle: 600, listening: null, working: 180, done: null }, 'character sheet timings');
  assert.equal(PYX_DONE_HOLD_MS, 1200);
  assert.equal(pyxScale(48), 2); assert.equal(pyxScale(50), 2); assert.equal(pyxScale(20), 1); assert.equal(pyxScale(96), 4); assert.equal(pyxScale(Number.NaN), 1);
});

test('host state is bounded and typed; malformed input is dropped, never shown', () => {
  assert.equal(readPyxState(null).phase, 'offline');
  assert.equal(readPyxState({ phase: 'hacked' }).phase, 'offline');
  const s = readPyxState({ phase: 'working', provider: 'claude', model: 'Opus 5.5', modelTitle: 'Claude Opus 5.5', effort: 'high', reply: 'x'.repeat(2000), canStop: true,
    progress: { title: '  Placing oak and pine across the valley ', step: 5, steps: 8, startedAt: 1000 }, message: '<b>not html</b>' });
  assert.equal(s.provider, 'claude'); assert.equal(s.model, 'Opus 5.5'); assert.equal(s.reply?.length, 600); assert.equal(s.canStop, true);
  assert.deepEqual(s.progress, { title: 'Placing oak and pine across the valley', step: 5, steps: 8, startedAt: 1000 });
  assert.equal(readPyxState({ phase: 'working', progress: { title: 'x', step: 9, steps: 8 } }).progress?.steps, null, 'impossible counts are not shown');
  assert.equal(readPyxState({ phase: 'working', progress: { title: 'x', step: 1 } }).progress?.step, null, 'a step without a total is not shown');
  assert.equal(readPyxState({ phase: 'idle', provider: 'gemini', canStop: 'yes' }).provider, null);
  assert.equal(readPyxState({ phase: 'idle', canStop: 'yes' }).canStop, false);
  assert.equal(readPyxState({ phase: 'idle', reply: 'a\u0000b' }).reply, 'ab', 'control characters stripped');
});

test('suggestions: at most three, deduplicated, strings or {label,text}', () => {
  assert.deepEqual(readPyxSuggestions('nope'), []);
  assert.deepEqual(readPyxSuggestions(['Add a waterfall by the caves', 'Playtest the spawn', 'Playtest the spawn', '', 7, 'Make it golden hour', 'Fourth']),
    [{ label: 'Add a waterfall by the caves', text: 'Add a waterfall by the caves' }, { label: 'Playtest the spawn', text: 'Playtest the spawn' }, { label: 'Make it golden hour', text: 'Make it golden hour' }]);
  assert.deepEqual(readPyxSuggestions([{ label: 'Forest', text: 'Build a forest\nwith caves' }]), [{ label: 'Forest', text: 'Build a forest\nwith caves' }]);
  assert.equal(readPyxSuggestions([{ label: 'x'.repeat(200), text: 'y' }])[0]?.label.length, 60);
});

test('a suggestion only fills the box: empty or an earlier suggestion is replaced, a draft is kept and extended', () => {
  assert.equal(pyxFill('', 'Playtest the spawn'), 'Playtest the spawn');
  assert.equal(pyxFill('   ', 'Playtest the spawn'), 'Playtest the spawn');
  assert.equal(pyxFill('Add a waterfall by the caves', 'Playtest the spawn', ['Add a waterfall by the caves', 'Playtest the spawn']), 'Playtest the spawn');
  assert.equal(pyxFill('Make the cave darker', 'Playtest the spawn', ['Playtest the spawn']), 'Make the cave darker Playtest the spawn');
  assert.equal(pyxFill('a', 'b'.repeat(PYX_INPUT_MAX)).length, PYX_INPUT_MAX);
});

test('mood priority matches the perch: typing > alert > working > done (held 1.2 s) > idle', () => {
  assert.equal(pyxMood({ phase: 'working', typing: true, doneUntil: 0, now: 0 }), 'listening');
  assert.equal(pyxMood({ phase: 'error', typing: false, doneUntil: 0, now: 0 }), 'alert');
  assert.equal(pyxMood({ phase: 'offline', typing: false, doneUntil: 0, now: 0 }), 'alert');
  assert.equal(pyxMood({ phase: 'working', typing: false, doneUntil: 5000, now: 0 }), 'working');
  assert.equal(pyxMood({ phase: 'idle', typing: false, doneUntil: 1200, now: 1199 }), 'done');
  assert.equal(pyxMood({ phase: 'idle', typing: false, doneUntil: 1200, now: 1200 }), 'idle');
});

test('the bubble reports and asks what next; it never invents a reply', () => {
  assert.equal(pyxBubbleText(state({ reply: 'Forest’s planted.' })), 'Forest’s planted. What next?');
  assert.equal(pyxBubbleText(state({ reply: 'Want me to light the caves?' })), 'Want me to light the caves?');
  assert.equal(pyxBubbleText(state({ reply: null })), null);
  assert.equal(pyxBubbleText(state({ phase: 'working', reply: 'Old reply.' })), null, 'no stale report while working');
  assert.equal(pyxBubbleText(state({ phase: 'offline' })), 'Pyx can’t reach Arcane right now.');
  assert.equal(pyxBubbleText(state({ phase: 'error', message: 'Claude stopped: usage limit reached.' })), 'Claude stopped: usage limit reached.');
});

test('model chip: pips like the main composer, an honest label and the real provider marks', () => {
  assert.deepEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'x-high', 'turbo', null].map(pyxEffortLevel), [1, 1, 2, 3, 3, 3, 3, 0, 0]);
  assert.equal(pyxModelLabel(state({ provider: 'claude', model: 'Opus 5.5', effort: 'high' })), 'Model: Claude Opus 5.5, reasoning high. Change model');
  assert.equal(pyxModelLabel(state({ provider: 'codex', model: 'gpt-5.5', modelTitle: 'GPT-5.5', effort: 'medium' })), 'Model: GPT-5.5, reasoning medium. Change model');
  assert.equal(pyxModelLabel(state({ provider: 'claude', model: 'Opus 5.5', effort: 'turbo' })), 'Model: Claude Opus 5.5. Change model');
  assert.equal(pyxModelLabel(state()), 'Choose a model');
  // A minimal SVG document double: the bar's marks must be the main composer's marks, byte for byte.
  const make = (tag: string) => { const attrs: Record<string, string> = {}, children: unknown[] = []; return { tag, attrs, children, setAttribute: (k: string, v: string) => { attrs[k] = v; }, append: (...c: unknown[]) => children.push(...c) }; };
  const doc = { createElementNS: (_ns: string, tag: string) => make(tag) } as unknown as Document;
  for (const provider of ['claude', 'codex', 'arcane'] as const) {
    const svg = providerLogo(doc, provider) as unknown as { children: { attrs: Record<string, string> }[] };
    assert.equal(svg.children[0]?.attrs.d, PYX_PROVIDER_MARKS[provider], provider);
  }
});

test('elapsed time and reply summaries are short and literal', () => {
  assert.deepEqual([0, 12_400, 72_000, 3_840_000].map(pyxElapsed), ['0s', '12s', '1m 12s', '1h 4m']);
  assert.equal(pyxSummary('Forest’s planted. I placed 42 trees and two caves.'), 'Forest’s planted.');
  assert.equal(pyxSummary('**Done** — `Workspace.Forest` is ready'), 'Done — Workspace.Forest is ready');
  assert.equal(pyxSummary('```lua\nprint(1)\n```'), null);
  const long = pyxSummary('word '.repeat(80), 40)!; assert.ok(long.length <= 40 && long.endsWith('…'), long);
  assert.equal(pyxShortModel('Claude Opus 5.5'), 'Opus 5.5'); assert.equal(pyxShortModel('Choose model'), null); assert.equal(pyxShortModel('gpt-5.5'), 'gpt-5.5');
  const starters = pyxStarterSuggestions();
  assert.equal(starters.length, 3); assert.equal(starters[0]?.label, STARTER_PROMPTS[0]?.title); assert.equal(starters[0]?.text, STARTER_PROMPTS[0]?.prompt);
});

test('fake bridge records intents and never sends on its own', async () => {
  const bridge = createFakePyxBridge({ phase: 'idle', provider: 'claude' });
  const seen: unknown[] = []; const off = bridge.onState(v => seen.push(v));
  bridge.pushState({ phase: 'working' }); off(); bridge.pushState({ phase: 'idle' });
  assert.equal(seen.length, 2, 'unsubscribe stops updates');
  assert.equal(bridge.calls.length, 0);
  assert.deepEqual(await bridge.submit('Plant a forest'), { accepted: true });
  bridge.nextSubmit = new Error('down'); await assert.rejects(bridge.submit('x'));
  assert.deepEqual(bridge.calls.map(c => c.method), ['submit', 'submit']);
  assert.equal(bridge.onVisibility, undefined, 'a plain fake has no window to open or close');
  const windowed = createFakePyxBridge({ phase: 'idle' }, { window: true }), opens: boolean[] = [];
  windowed.pushVisibility(true); windowed.onVisibility?.(open => opens.push(open)); windowed.pushVisibility(false);
  windowed.drag?.('start'); windowed.drag?.('move'); windowed.drag?.('end'); windowed.nudge?.(16, 0); windowed.ready?.();
  assert.deepEqual(opens, [true, false], 'the latest word is replayed to a late subscriber');
  assert.deepEqual(windowed.calls.map(c => [c.method, ...c.args]), [['drag', 'start'], ['drag', 'move'], ['drag', 'end'], ['nudge', 16, 0], ['ready']]);
});

test('moving: a press on Pyx is a click until it travels past the threshold; arrow keys step the bar', () => {
  assert.equal(PYX_DRAG_THRESHOLD, 4);
  assert.equal(pyxDragStarted(100, 100, 102, 102), false, 'a wobble is still a click');
  assert.equal(pyxDragStarted(100, 100, 104, 100), true);
  assert.equal(pyxDragStarted(100, 100, 97, 97), true);
  assert.deepEqual(pyxNudge('ArrowLeft', false), { dx: -PYX_NUDGE_STEP, dy: 0 });
  assert.deepEqual(pyxNudge('ArrowDown', true), { dx: 0, dy: PYX_NUDGE_STEP * 4 });
  assert.deepEqual(pyxNudge('ArrowUp', false), { dx: 0, dy: -16 });
  assert.equal(pyxNudge('Enter', false), null); assert.equal(pyxNudge('a', true), null);
});

test('pyx-bar.html: CSP-clean (no inline style or script), labelled input, live region, module entry', () => {
  const html = readFileSync('apps/desktop/public/pyx-bar.html', 'utf8');
  assert.doesNotMatch(html, /\sstyle=/, 'no inline style attributes (style-src self)');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts (script-src self)');
  assert.doesNotMatch(html, /https?:\/\//, 'no remote resources');
  assert.match(html, /<script type="module" src="\/pyx-bar\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/pyx-bar\.css">/);
  assert.match(html, /<label for="pyx-input"[^>]*>Tell Pyx what to build<\/label>/);
  assert.match(html, /<input id="pyx-input" class="pyx-input" type="text"/, 'one line, as the canvas: long text scrolls inside the box');
  assert.match(html, /<button id="pyx-close" class="pyx-close" type="button" aria-label="Close Pyx">/, 'a labelled close button');
  assert.match(html, /<main id="pyx" class="pyx" data-autostart="true" data-open="false"/, 'first paint is the closed state, so the window never flashes');
  assert.match(html, /id="pyx-announce"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(html, /<kbd|Esc stops|Press Enter|eyebrow/i, 'no keyboard-hint text and no eyebrow labels');
});

test('pyx-bar.css: motion only with no-preference, a final reduced-motion reset, hidden scrollbars, crisp sprite, palette only', () => {
  const css = readFileSync('apps/desktop/public/pyx-bar.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const motionBlock = /@media \(prefers-reduced-motion: no-preference\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(motionBlock.length > 0, 'a no-preference block');
  const outside = css.replace(motionBlock, '');
  assert.doesNotMatch(outside.replace(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*$/, ''), /(?:^|[;{])\s*(?:animation|transition)\s*:/m, 'no motion outside the opt-in block');
  assert.match(css.trim(), /@media \(prefers-reduced-motion: reduce\)\{\s*\*,\*::before,\*::after\{animation:none!important;transition:none!important;scroll-behavior:auto!important\}\s*\}$/, 'reset is last');
  assert.doesNotMatch(css, /\binfinite\b/, 'loops are script-driven and gated');
  assert.match(css, /\*::-webkit-scrollbar\{display:none/); assert.match(css, /scrollbar-width:none/);
  assert.match(css, /\.pyx-sprite\{[^}]*image-rendering:pixelated[^}]*shape-rendering:crispEdges/);
  assert.match(css, /:focus-visible\{outline:2px solid #fff/);
  const allowed = new Set(['#fff', '#14040a', '#f4efef', '#eadfe1', '#9c9093', '#757575', '#e5323f', '#ff5a66', '#ff9aa6', '#c8102e', '#ff3340', '#0e0c0e', '#33272b', '#1f1a1d', '#2a2326', '#2a1114', '#5a1e26', '#f0434f']);
  for (const hex of css.toLowerCase().match(/#[0-9a-f]{3,8}\b/g) ?? []) assert.ok(allowed.has(hex), 'palette: ' + hex);
  for (const [, r, g, b] of css.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) assert.ok(r === g && g === b || Number(r) > 200 && Number(g) < 120, 'rgba neutral or red: ' + r + ',' + g + ',' + b);
  const sizes = [...css.matchAll(/font-size:(\d+)px/g)].map(m => Number(m[1])); assert.ok(sizes.every(size => size >= 12), 'type floor 12px');
  // The pop: open settles with an overshoot, close is quicker and plain; both only with motion.
  assert.match(css, /\.pyx\[data-open=false\]\{opacity:0;transform:[^}]*scale\(\.9\)[^}]*pointer-events:none\}/);
  assert.match(motionBlock, /\.pyx\[data-open=true\]\{transition:[^}]*var\(--pyx-e-pop\)/);
  assert.match(motionBlock, /\.pyx\[data-open=false\]\{transition:[^}]*var\(--pyx-e-exit\)/);
  // No clipping: a one-line input whose line box clears any face's ascent and descent; chips shorten instead of hiding.
  const input = /\.pyx-input\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(input, /height:40px/); assert.match(input, /line-height:24px/); assert.match(input, /min-width:0/);
  assert.doesNotMatch(input, /overflow:hidden|white-space:pre/);
  assert.match(css, /\.pyx-suggestions\{[^}]*flex-wrap:nowrap/); assert.match(css, /\.pyx-suggestion\{[^}]*min-width:0/);
  assert.match(css, /\.pyx-model\{[^}]*flex:0 1 auto;min-width:0/);
  // The app's own face, from the same origin (no remote font).
  assert.match(css, /@font-face\{font-family:"IBM Plex Sans";[^}]*src:url\(\/fonts\/ibm-plex-sans-latin-wght-normal\.woff2\)/);
  assert.doesNotMatch(css, /-webkit-app-region/, 'moving is the host following the pointer, not a native drag region that would swallow clicks');
});
