import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile('apps/desktop/public/studio.css', 'utf8');
const html = await readFile('apps/desktop/public/studio.html', 'utf8');
const start = css.indexOf('/* ---- C22 revamp'), end = css.indexOf('/* ---- End C22 revamp ---- */');
const block = css.slice(start, end);
const reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');
const diagnosticWarningExceptions = [
  '.arcane-app .studio-diagnostics{--warning:#f0b85a;--warning-line:#6e5524}',
  '@media (prefers-color-scheme:light){\n  :root:not([data-theme=dark]) .arcane-app .studio-diagnostics{--warning:#8a5a00;--warning-line:#d9b36a}\n}',
  ':root[data-theme=light] .arcane-app .studio-diagnostics{--warning:#8a5a00;--warning-line:#d9b36a}',
];

test('the C22 block is owned, static and sits before the final reduced-motion reset', () => {
  assert.ok(start > 0 && end > start && reset > end, 'owned block before the reset');
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /transition|animation|@keyframes|will-change|@container|@layer|scroll-timeline/);
  assert.equal((block.match(/\{/g) ?? []).length, (block.match(/\}/g) ?? []).length, 'balanced braces');
});

test('type stays on the 12px floor in px and uses one scale', () => {
  for (const [, size] of block.matchAll(/font-size:([^;}]+)/g)) {
    assert.ok(size !== undefined, 'font-size capture is required');
    if (size.startsWith('var(')) continue;
    assert.match(size, /^\d+px$/, size);
    assert.ok(parseInt(size, 10) >= 12, size);
  }
  for (const token of ['--s-1:8px', '--t-meta:12px', '--r-1:10px', '--r-2:14px', '--r-3:18px', '--row-h:36px']) assert.ok(block.includes(token), token);
});

test('no protected control is dropped and the live-status contract is untouched', () => {
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const id of ['#codex-model', '#codex-effort', '#codex-select', '#sidebar-toggle', '#codex-submit']) {
    assert.doesNotMatch(clean, new RegExp(id + '[^{,]*\\{[^}]*display:none'), id);
  }
  assert.doesNotMatch(clean, /(^|[},])\s*\.chat-topline p\s*\{/, 'no bare .chat-topline p rule');
  assert.doesNotMatch(clean, /font-size:max\(12px,1em\)/, 'native floor stays the original');
});

test('the decorative grain ring is gone, anchors and palette stay', () => {
  assert.match(block, /body\.arcane-app\{background:var\(--vignette\),var\(--canvas\);/);
  assert.match(css, /--accent:#ff3340/);
  assert.match(block, /--playtest-on|Playtest "on" green/);
  // Permit only these exact diagnostic component rules; unrelated surfaces keep the palette lock.
  const lockedPalette = diagnosticWarningExceptions.reduce((remaining, rule) => {
    assert.equal(remaining.split(rule).length, 2, 'one exact diagnostic warning exception: ' + rule);
    return remaining.replace(rule, '');
  }, block);
  assert.doesNotMatch(lockedPalette, /#f28936|#f0b85a|#6e5524|#8a5a00|#d9b36a|240,184,90|127,212,154/i, 'no orange, amber or green tints outside the exact diagnostic exception');
  assert.match(block, /\.codex-message\.codex::before\{/, 'red diamond kept');
});

test('one official logo with one shared gradient', () => {
  const marks = [...html.matchAll(/<svg class="arcane-logo"[^>]*>[\s\S]*?<\/svg>/g)].map(m => m[0]);
  assert.ok(marks.length >= 4);
  assert.equal(new Set(marks).size, 1, 'every mark is identical');
  assert.match(marks[0]!, /M32 4 4 57h13L32 28l15 29h13L32 4Z/); assert.match(marks[0]!, /m27 40 19 13-6-13H27Z/);
  assert.match(html, /<linearGradient id="arcane-logo-fill"/);
  assert.match(block, /\.arcane-logo path\{fill:url\(#arcane-logo-fill\) var\(--logo-b\)\}/);
  assert.match(block, /\.arcane-logo-shard\{display:none\}/);
});

test('eyebrows are removed, layouts and reusable classes exist, scrollbars are hidden but restored in forced colors', () => {
  assert.match(block, /:is\(\.eyebrow,\.setup-step\)\{display:none\}/);
  for (const selector of ['.arcane-bar{', '.arcane-bar__input{', '.arcane-bar__model{', '.arcane-bar__send{', '.queue-strip{', '.queue-row{', '.queue-text{', '.queue-status{', '.queue-menu{', '.queue-editor{', '.sidebar-status-card{', '.pyx-perch{', '.pyx--alert{', '.folder-row{', '.folder-chats{']) assert.ok(block.includes(selector), selector);
  assert.doesNotMatch(block, /queue-row__/, 'the guessed queue class names are gone');
  for (const state of ['paused', 'sending', 'rejected', 'unknown']) assert.ok(block.includes('data-queue-state=' + state), state);
  assert.match(block, /@media \(max-width:520px\)\{/);
  assert.match(css.slice(0, start), /@media\(max-width:1100px\) and \(min-width:761px\)\s*\{/, 'overlay covers the inclusive legacy preview breakpoint');
  assert.match(block, /@media \(max-width:1100px\)\{[\s\S]*?\.artifact-panel\{position:absolute/);
  assert.match(block, /@media \(prefers-reduced-transparency:reduce\)/);
  assert.match(block, /\.arcane-app,\.arcane-app \*:not\(\.composer-model-popover,\.composer-model-popover \*\)\{scrollbar-width:none!important\}/);
  assert.match(block, /@media \(forced-colors:active\)\{\s*\.arcane-app,\.arcane-app \*:not\(\.composer-model-popover,\.composer-model-popover \*\)\{scrollbar-width:auto!important\}/);
});

test('static delivery excludes the pending motion block and preserves the viewer flex child', () => {
  assert.doesNotMatch(css, /\/\* ---- C22 motion|c22-in-|c22-loop-/);
  assert.match(css, /\.asset-viewer\{[^}]*flex:none/);
});

test('the sidebar status card ships hidden with blank data (no fake values)', () => {
  const card = html.match(/<section id="sidebar-status-card"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(card, /\shidden>/);
  assert.match(card, /<span id="sidebar-studio-status"[^>]*><\/span>/);
  assert.match(card, /<meter id="sidebar-actions-meter"[^>]*value="0"/);
});

test('the open model and effort popovers retain their existing geometry, font, focus and scroller design', () => {
  assert.doesNotMatch(block, /\.composer-model-popover\{[^}]*max-height|\.composer-model-popover \.picker-model-options|:is\(\.model-group-heading,/);
  assert.ok(block.includes(':not(.composer-model-popover *):focus-visible'), 'shared focus override excludes picker contents');
  assert.ok(block.includes('*:not(.composer-model-popover,.composer-model-popover *){scrollbar-width:none!important}'), 'picker keeps its existing scrollbars');
});

test('unused usage and context hooks are not presented as measured or shared data', () => {
  assert.doesNotMatch(html, /class="(?:message-usage|reply-usage|folder-row__context|folder-summary)(?:[" ])/);
  const account = html.match(/<p id="sidebar-account"[^>]*>/)?.[0] ?? '';
  assert.match(account, /\shidden>/);
  assert.match(html, /<span id="sidebar-account-name"[^>]*><\/span>/);
  assert.match(html, /<span id="sidebar-account-plan"[^>]*><\/span>/);
});

test('static diagnostic icon and border selectors leave the existing warning rules authoritative', () => {
  const rules = [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selectors, declarations]) => selectors!.split(',').map(selector => ({ selector: selector.trim(), declarations: declarations! })));
  const warningOverrides = rules.filter(rule => rule.selector.includes('.studio-diagnostics[data-severity=warning]') &&
    /(?:^|;)\s*(?:color|border-color)\s*:/.test(rule.declarations));
  assert.deepEqual(warningOverrides, [], 'static styling must not override severity-specific warning icon/border rules');
  assert.ok(rules.some(rule => rule.selector === '.arcane-app .studio-diagnostics-badge .icon' && rule.declarations === 'color:var(--text)'), 'generic icon styling remains');
  const original = css.slice(0, start);
  assert.ok(original.includes('.arcane-app .studio-diagnostics[data-severity=warning] .studio-diagnostics-badge{border-color:var(--warning-line)}'));
  assert.ok(original.includes('.arcane-app .studio-diagnostics[data-severity=warning] .studio-diagnostics-badge .icon{color:var(--warning)}'));
});

test('diagnostic warning tokens retain dark, preferred-light and explicit-light component colors only', () => {
  for (const rule of diagnosticWarningExceptions) assert.ok(block.includes(rule), rule);
  const componentRules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector, declarations]) => selector!.includes('.studio-diagnostics') && /--warning(?:-line)?:/.test(declarations!));
  assert.equal(componentRules.length, 3, 'only default, preferred-light and explicit-light component exceptions');
  for (const [, , declarations] of componentRules) {
    assert.match(declarations!, /^--warning:#[a-f0-9]{6};--warning-line:#[a-f0-9]{6}$/);
  }
  assert.ok(diagnosticWarningExceptions[1]!.includes(':root:not([data-theme=dark])'), 'preferred light never overrides explicit dark');
  assert.ok(diagnosticWarningExceptions[2]!.startsWith(':root[data-theme=light]'), 'explicit light works regardless of system preference');
});
