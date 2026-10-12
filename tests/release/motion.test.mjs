import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sheets = ['studio', 'lab'].map(name => ({
  name,
  css: readFileSync(new URL('../../apps/desktop/public/' + name + '.css', import.meta.url), 'utf8'),
}));

// Dependency-free scanner: respect strings, brackets and functional values. In
// particular, commas inside :where() / cubic-bezier() are not list separators.
function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function rulesOf(css, context = []) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let cursor = 0;
  while (cursor < clean.length) {
    while (/\s/.test(clean[cursor] ?? '') && cursor < clean.length) cursor++;
    if (cursor === clean.length) break;
    let open = cursor, quote = '';
    for (; open < clean.length; open++) {
      const char = clean[open];
      if (quote) {
        if (char === '\\') open++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') break;
    }
    assert.ok(open < clean.length, 'CSS rule must have a block');
    const selector = clean.slice(cursor, open).trim();
    let end = open + 1, depth = 1;
    quote = '';
    for (; end < clean.length && depth > 0; end++) {
      const char = clean[end];
      if (quote) {
        if (char === '\\') end++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    assert.equal(depth, 0, 'CSS blocks must balance: ' + selector);
    const body = clean.slice(open + 1, end - 1);
    if (selector.startsWith('@')) {
      assert.match(selector, /^@(?:media|supports|keyframes)\b/, 'Recognize every grouping rule');
      rules.push(...rulesOf(body, [...context, selector]));
    } else {
      const declarations = splitTopLevel(body, ';').map(value => {
        const colon = value.indexOf(':');
        assert.ok(colon > 0, 'CSS declaration must have a property: ' + value);
        return { property: value.slice(0, colon).trim(), value: value.slice(colon + 1).trim() };
      });
      rules.push({ selector, declarations, context });
    }
    cursor = end;
  }
  return rules;
}

const normalize = value => value.replace(/\s/g, '').toLowerCase();
const optedIn = rule => rule.context.some(value => normalize(value) === '@media(prefers-reduced-motion:no-preference)');
const reduced = rule => rule.context.some(value => normalize(value) === '@media(prefers-reduced-motion:reduce)');
const frames = rule => rule.context.some(value => value.startsWith('@keyframes'));
const enabledMotion = declaration => /^(?:transition|animation)(?:-|$)/.test(declaration.property)
  && !/^(?:none|0(?:ms|s)?)(?:\s*!important)?$/.test(declaration.value);

function resolve(value, rules) {
  const tokens = new Map(rules.filter(rule => rule.selector === ':root')
    .flatMap(rule => rule.declarations.map(declaration => [declaration.property, declaration.value])));
  return value.replace(/var\((--[\w-]+)\)/g, (_, key) => {
    assert.ok(tokens.has(key), 'Motion token must resolve: ' + key);
    return tokens.get(key);
  });
}

test('contract scanner respects functional commas and nested preference/pointer blocks', () => {
  const sample = rulesOf('@media (prefers-reduced-motion: no-preference) { @media (hover: hover) { :where(a, button) { transition: transform 120ms cubic-bezier(.2,.7,.2,1), opacity 180ms ease; } } }');
  assert.equal(sample.length, 1);
  assert.equal(sample[0].context.length, 2);
  assert.deepEqual(splitTopLevel(sample[0].declarations[0].value, ','), ['transform 120ms cubic-bezier(.2,.7,.2,1)', 'opacity 180ms ease']);
  assert.throws(() => rulesOf('.broken { opacity: 1;'), /balance/);
});

for (const { name, css } of sheets) {
  const rules = rulesOf(css);
  test(name + ': reduced motion disables transitions, animations and scrolling on elements and pseudo-elements', () => {
    const reset = rules.find(rule => reduced(rule)
      && normalize(rule.selector) === '*,*::before,*::after');
    assert.ok(reset, 'An explicit universal reduced-motion reset is required');
    for (const [property, value] of [['animation', 'none!important'], ['transition', 'none!important'], ['scroll-behavior', 'auto!important']]) {
      assert.ok(reset.declarations.some(declaration => declaration.property === property && normalize(declaration.value) === value), property);
    }
    assert.equal(rules.at(-1), reset, 'The preference reset must be last in the cascade');
    for (const rule of rules) for (const declaration of rule.declarations) {
      if (declaration.property === 'scroll-behavior') assert.match(declaration.value, /^auto(?:\s*!important)?$/);
      if (enabledMotion(declaration)) assert.ok(optedIn(rule) && !reduced(rule), rule.selector + ': motion requires no-preference');
    }
  });

  test(name + ': transitions are explicit, short and exclude layout, filters and continuous effects', () => {
    const relevant = new Set([
      ':where(button:enabled, a, summary)', ':where(input, select, textarea)',
      '.workspace-search', '.workspace-stage .composer', '.app-sidebar', '.group-chevron',
      '.artifact-stage .asset-previews figure[role="button"]',
      ':where(button:enabled, .sidebar nav a, .install-help > summary)',
      'select', '.provider-card', '.selection-panel',
    ].map(normalize));
    const reveals = new Set([
      '.workspace-welcome', '.workspace-search-results', '.setup-panel',
      '.artifact-stage .asset-previews figure[role="button"]',
    ].map(normalize));
    let transitions = 0;
    for (const rule of rules) for (const declaration of rule.declarations) {
      assert.notEqual(declaration.property, 'will-change', 'Do not permanently promote canvas/surface layers');
      assert.notEqual(declaration.property, 'transition-property', 'Use reviewable explicit shorthands');
      if (!enabledMotion(declaration)) continue;
      assert.ok(['transition', 'animation'].includes(declaration.property), 'No detached timing/delay overrides');
      const value = resolve(declaration.value, rules);
      assert.doesNotMatch(value, /\binfinite\b/);
      for (const item of splitTopLevel(value, ',')) {
        const times = [...item.matchAll(/(?<![\w.])(\d*\.?\d+)(ms|s)\b/g)]
          .map(match => Number(match[1]) * (match[2] === 's' ? 1000 : 1));
        assert.equal(times.length, 1, 'One duration and no hidden delay: ' + item);
        assert.ok(times[0] > 0 && times[0] <= 200, 'Motion must finish within 200 ms: ' + item);
        if (declaration.property === 'transition') {
          transitions++;
          for (const selector of splitTopLevel(rule.selector, ',')) assert.ok(relevant.has(normalize(selector)), 'Transition must belong to an approved real control/surface: ' + selector);
          assert.match(item, /^(?:transform|opacity|background-color|border-color|color)\s/, 'No all, geometry, shadow, background-image or filter transitions');
        } else {
          for (const selector of splitTopLevel(rule.selector, ',')) assert.ok(reveals.has(normalize(selector)), 'Only stable, approved surfaces reveal: ' + selector);
          assert.match(item, /^arcane-reveal\s/);
          assert.match(item, /\s1$/, 'Reveal must have one iteration and no backwards fill');
          assert.doesNotMatch(rule.selector, /notice|error|approval|dialog|codex-message|status|unknown|canvas/, 'Critical/streaming content stays immediate');
        }
      }
    }
    assert.ok(transitions > 0, 'A motion contract must cover actual interactions');
    for (const rule of rules.filter(frames)) {
      assert.ok(optedIn(rule), 'Keyframes must also be gated');
      for (const { property, value } of rule.declarations) {
        assert.ok(['transform', 'opacity'].includes(property), 'Reveal animates only compositor properties');
        if (property === 'opacity') assert.ok(Number(value) >= .9 && Number(value) <= 1, 'Reveals never conceal content');
      }
    }
    assert.doesNotMatch(css, /@(?:import|scroll-timeline)|animation-timeline|view-timeline/);
  });

  test(name + ': moving hover effects require a precise hover-capable pointer', () => {
    for (const rule of rules.filter(rule => rule.selector.includes(':hover'))) {
      if (!rule.declarations.some(declaration => declaration.property === 'transform')) continue;
      assert.ok(optedIn(rule));
      if (!rule.selector.includes('.asset-previews')) assert.ok(rule.selector.includes(':not(:active)'), 'Hover lift yields to the press state');
      assert.ok(rule.context.some(value => normalize(value).includes('(hover:hover)') && normalize(value).includes('(pointer:fine)')), rule.selector);
    }
  });
}

test('studio: dynamic verified preview figures have keyboard, hover, press and selected states without canvas animation', () => {
  const css = sheets.find(sheet => sheet.name === 'studio').css;
  const rules = rulesOf(css);
  for (const state of [':focus-visible', ':hover', ':active', '[aria-pressed="true"]']) {
    assert.ok(rules.some(rule => rule.selector.includes('.asset-previews figure') && rule.selector.includes(state)), state);
  }
  for (const rule of rules.filter(rule => rule.selector.includes('canvas'))) {
    assert.equal(rule.declarations.some(declaration => /^(?:animation|transition|transform|filter|will-change)/.test(declaration.property)), false, 'Canvas backing stores and geometry must remain untouched');
  }
  assert.ok(rules.some(rule => rule.selector === '.workspace-tools .notice.error' && rule.declarations.some(declaration => declaration.property === 'color' && declaration.value === 'var(--danger)')));
  assert.ok(rules.some(rule => rule.selector === '[hidden]' && rule.declarations.some(declaration => declaration.property === 'display' && declaration.value === 'none!important')));
});

test('studio: laptop/mobile CSS does not discard tabs, model selection, navigation or preview controls', () => {
  const rules = rulesOf(sheets.find(sheet => sheet.name === 'studio').css);
  const control = /\.workspace-tab\b|\.project-tab\b|\.add-tab\b|\.artifact-toolbar \.icon-button\b|#sidebar-toggle\b|#codex-select\b|^\.app-sidebar$/;
  for (const rule of rules.filter(rule => control.test(rule.selector))) {
    for (const declaration of rule.declarations) {
      assert.ok(!(declaration.property === 'display' && declaration.value.startsWith('none')), 'Real controls cannot be dropped: ' + rule.selector);
    }
  }
  assert.ok(rules.some(rule => rule.selector === '.workspace-tabs' && rule.declarations.some(declaration => declaration.property === 'overflow-x' && declaration.value === 'auto')), 'Tabs must remain scrollable');
  assert.ok(rules.some(rule => rule.selector === '.workspace-search-results' && rule.declarations.some(declaration => declaration.property === 'max-width' && declaration.value.includes('100vw'))), 'Search results fit narrow viewports');
});

test('both surfaces retain visible keyboard focus and scrollbar affordances in forced colors', () => {
  for (const { name, css } of sheets) {
    const rules = rulesOf(css);
    assert.ok(rules.some(rule => rule.selector.includes(':focus-visible') && rule.declarations.some(declaration => declaration.property === 'outline' && declaration.value.includes('2px'))), name);
    assert.ok(rules.some(rule => rule.selector === '::-webkit-scrollbar-thumb:hover'), name);
    assert.ok(rules.some(rule => rule.context.some(value => normalize(value) === '@media(forced-colors:active)') && rule.declarations.some(declaration => declaration.property === 'scrollbar-color' && declaration.value === 'auto')), name);
  }
});
