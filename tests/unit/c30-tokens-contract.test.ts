import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// C30 design tokens: the canvas foundations (fonts, palette warmth, glass, atmosphere, radii, spacing and type) live in
// one owned block, "/* C30 tokens */" ... "/* end C30 tokens */", ahead of every other C30 block inside the C22 block.
const css = await readFile('apps/desktop/public/studio.css', 'utf8');
const start = css.indexOf('/* C30 tokens */'), end = css.indexOf('/* end C30 tokens */');
const block = css.slice(start, end);
const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
const rootRule = clean.match(/(?:^|\n):root\{([\s\S]*?)\n\}/)?.[1] ?? '';
const token = (name: string) => rootRule.match(new RegExp('(?:^|[;\\s])' + name.replace(/[-]/g, '\\-') + ':([^;]+);'))?.[1]?.replace(/\s+/g, ' ').trim();

test('the token block is owned, static and the first C30 block inside the C22 block', () => {
  const c22 = css.indexOf('/* ---- C22 revamp'), c22End = css.indexOf('/* ---- End C22 revamp ---- */');
  assert.ok(c22 > 0 && start > c22 && end > start && c22End > end, 'inside the C22 block, before its end marker');
  const firstC30 = css.search(/\/\* C30 (?!tokens \*\/)[a-z]/);
  assert.ok(firstC30 === -1 || firstC30 > end, 'no other C30 block precedes the tokens');
  assert.doesNotMatch(clean, /transition|animation|@keyframes|will-change|@import|--grain/);
  assert.equal((clean.match(/\{/g) ?? []).length, (clean.match(/\}/g) ?? []).length);
});

test('fonts: Plex Sans, Archivo and Plex Mono lead full fallback stacks; faces only as the eight same-origin woff2', () => {
  const faces = [...clean.matchAll(/@font-face\{([^}]*)\}/g)].map(match => match[1]!);
  // The faces land with the woff2 files, daemon routes and fixtures (c30-tokens/font-proposal.md). Until then none is
  // declared, so no page requests a missing file.
  if (!faces.length) assert.doesNotMatch(clean, /url\(/);
  else assert.equal(faces.length, 8);
  for (const face of faces) {
    assert.match(face, /font-display:fallback/);
    assert.match(face, /src:url\(\/fonts\/[a-z0-9-]+\.woff2\) format\("woff2"\)/);
    assert.match(face, /unicode-range:U\+/);
    assert.doesNotMatch(face, /https?:|local\(/, 'no network or installed-font lookups');
  }
  const files = faces.map(face => face.match(/url\(\/fonts\/([^)]+)\)/)![1]).sort();
  if (faces.length) assert.deepEqual(files, [
    'archivo-latin-ext-wght-normal.woff2', 'archivo-latin-wght-normal.woff2',
    'ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2',
    'ibm-plex-mono-latin-ext-400-normal.woff2', 'ibm-plex-mono-latin-ext-500-normal.woff2',
    'ibm-plex-sans-latin-ext-wght-normal.woff2', 'ibm-plex-sans-latin-wght-normal.woff2',
  ]);
  assert.equal(token('--font-ui'), '"IBM Plex Sans","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Arial,sans-serif');
  assert.equal(token('--font-display'), '"Archivo","Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Arial,sans-serif');
  assert.equal(token('--font-mono'), '"IBM Plex Mono",ui-monospace,"Cascadia Code",Consolas,"SFMono-Regular",Menlo,monospace');
});

test('palette: canvas text, ink ladder, warm near-blacks, glass, rims, popover and reds (dark); light keeps its palette', () => {
  const exact: Record<string, string> = {
    '--text': '#f4efef', '--text-secondary': 'rgba(244,239,239,.72)', '--muted': 'rgba(244,239,239,.55)',
    '--panel': '#0f0b0d', '--raised': '#1a1416', '--input': '#0e0a0c', '--sunken': '#0a0708', '--hover': '#1f191b', '--hover-strong': '#2a2326',
    '--glass': 'rgba(18,12,14,.55)', '--glass-strong': 'rgba(14,9,11,.88)', '--glass-solid': '#0e090b', '--pop-bg': '#0e090b',
    '--danger': '#ff6b74', '--focus-ring': '#ffffff', '--playtest-on': '#3fbf7f', '--sidebar-rim': 'rgba(142,15,34,.28)',
    '--c30-text': '#f4efef', '--c30-ink-45': 'rgba(244,239,239,.45)', '--c30-ink-55': 'rgba(244,239,239,.55)', '--c30-ink-72': 'rgba(244,239,239,.72)',
    '--c30-ink-92': 'rgba(244,239,239,.92)', '--c30-glass': 'rgba(18,12,14,.55)', '--c30-blur': 'blur(24px) saturate(140%)',
    '--c30-popover': '#0e090b', '--c30-tooltip': '#0c080a', '--c30-red': '#e5323f', '--c30-rim': 'var(--c30-rim-24)',
    '--c30-rim-24': 'inset 0 0 0 1px rgba(142,15,34,.24)', '--c30-green': '#3fbf7f', '--c30-amber': '#f2c14e',
  };
  for (const [name, value] of Object.entries(exact)) assert.equal(token(name), value, name);
  assert.equal(token('--accent'), undefined, 'the accent stays #ff3340 from the base palette');
  assert.match(css, /--accent:#ff3340/);
  // Light: the dark overrides sit on bare :root; the base light palette (higher specificity) is untouched.
  assert.match(css, /:root\[data-theme=light\]\{\n  --bg:#f5f5f5;[^}]*--text:#080808;/);
  assert.doesNotMatch(clean, /:root:not\(\[data-theme=dark\]\)\{[^}]*--text:/, 'light text stays on the base palette');
  assert.match(clean, /:root\[data-theme=light\]\{[^}]*--c30-text:#080808;/, 'c30 tokens carry light twins');
});

test('atmosphere: exactly the canvas layers, vignette on top, no grain', () => {
  assert.equal(token('--canvas'), 'radial-gradient(1100px 620px at 86% -16%,rgba(200,16,46,.2),rgba(200,16,46,0) 70%), radial-gradient(900px 640px at -12% 118%,rgba(92,7,18,.5),rgba(92,7,18,0) 70%), radial-gradient(900px 600px at 55% 45%,rgba(255,51,64,.035),rgba(255,51,64,0) 70%), linear-gradient(180deg,#0b0b0c,#080808)');
  assert.equal(token('--vignette'), 'radial-gradient(130% 120% at 50% 42%,rgba(0,0,0,0) 58%,rgba(0,0,0,.5) 100%)');
  assert.match(css, /body\.arcane-app\{background:var\(--vignette\),var\(--canvas\);background-color:var\(--bg\)\}/);
});

test('scales: radii 10/14/18, an 8px rhythm and the canvas type sizes on the 12px floor', () => {
  for (const [name, value] of [['--c30-r-1', '10px'], ['--c30-r-2', '14px'], ['--c30-r-3', '18px'], ['--c30-r-pill', '999px'],
    ['--c30-s-0', '4px'], ['--c30-s-1', '8px'], ['--c30-s-2', '16px'], ['--c30-s-3', '24px'], ['--c30-s-4', '32px'],
    ['--c30-t-meta', '12px'], ['--c30-t-body', '13px'], ['--c30-t-ui', '14px'], ['--c30-t-prose', '15px'], ['--c30-t-title', '18px'],
    ['--c30-lh-reading', '1.75'], ['--c30-w-medium', '500'], ['--c30-w-heavy', '800'], ['--c30-track-wordmark', '.16em']] as const) {
    assert.equal(token(name), value, name);
  }
  for (const [, size] of rootRule.matchAll(/--c30-t-[a-z-]+:(\d+)px/g)) assert.ok(Number(size) >= 12, size);
});

test('glass only on the sidebar, composer, popovers and dialogs, prefixed, with opaque and forced-colors fallbacks', () => {
  const blurred = [...clean.matchAll(/([^{}]+)\{[^{}]*-webkit-backdrop-filter:(?!none)[^;}]+;backdrop-filter:(?!none)/g)].map(match => match[1]!.trim());
  assert.deepEqual(blurred, [
    '.arcane-app .workspace-stage .composer',
    '.arcane-app :is(.workspace-search-results,.tool-switcher .workspace-tabs,.studio-diagnostics-panel):not(.composer-model-popover *)',
    '.arcane-app .settings-drawer',
  ]);
  assert.match(clean, /\.arcane-app \.arcane-modal-layer\{-webkit-backdrop-filter:blur\(8px\) saturate\(120%\)\}/);
  assert.match(token('--sidebar-glass') ?? '', /^linear-gradient\(180deg,rgba\(36,20,24,\.62\),rgba\(18,12,14,\.55\) 40%,rgba\(14,9,11,\.6\)\)$/);
  const reduced = clean.slice(clean.indexOf('@media (prefers-reduced-transparency:reduce){'));
  assert.match(reduced, /--c30-blur:none;/);
  for (const name of ['--c30-glass', '--c30-glass-composer', '--glass', '--glass-strong']) assert.match(reduced, new RegExp(name + ':var\\(--(?:c30-)?glass-solid\\)'), name);
  assert.match(reduced, /--sidebar-glass:var\(--sidebar-solid\)/);
  const forced = clean.slice(clean.indexOf('@media (forced-colors:active){'));
  assert.match(forced, /body\.arcane-app\{background:Canvas\}/);
  assert.match(forced, /-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none/);
});
