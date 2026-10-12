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
const hasSelector = (rule, selector) => splitTopLevel(rule.selector, ',').some(value => normalize(value) === normalize(selector));
const hasDeclaration = (rule, property, value) => rule.declarations.some(declaration => declaration.property === property && normalize(declaration.value) === normalize(value));
const forced = rule => rule.context.some(value => normalize(value) === '@media(forced-colors:active)');
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
  const figure = '.artifact-stage .asset-previews figure';
  for (const [state, property] of [
    ['[role="button"]:focus-visible', 'outline'], ['[role="button"]:active', 'background'],
    ['[aria-pressed="true"]', 'border-color'],
  ]) {
    const rule = rules.find(rule => !forced(rule) && hasSelector(rule, figure + state));
    assert.ok(rule && rule.declarations.some(declaration => declaration.property === property), state + ' needs visible feedback');
    assert.equal(rule.context.length, 0, 'Keyboard, press and selection feedback must also work with reduced motion');
    if (property === 'outline') assert.ok(hasDeclaration(rule, property, '2px solid var(--focus-ring)'));
  }
  const hover = rules.find(rule => hasSelector(rule, figure + '[role="button"]:hover:not(:active)'));
  assert.ok(hover && hasDeclaration(hover, 'border-color', 'var(--accent)'), 'Hover must yield to press feedback');
  assert.ok(hover.context.some(value => normalize(value).includes('(hover:hover)') && normalize(value).includes('(pointer:fine)')));
  for (const rule of rules.filter(rule => rule.selector.includes('canvas'))) {
    assert.equal(rule.declarations.some(declaration => /^(?:animation|transition|transform|filter|will-change)/.test(declaration.property)), false, 'Canvas backing stores and geometry must remain untouched');
  }
  assert.ok(rules.some(rule => hasSelector(rule, '.notice.error') && hasDeclaration(rule, 'color', 'var(--danger)')), 'Native error notices retain their danger color');
  assert.ok(rules.some(rule => hasSelector(rule, '[hidden]') && hasDeclaration(rule, 'display', 'none!important')));
});

test('studio: laptop/mobile CSS does not discard tabs, model selection, navigation or preview controls', () => {
  const rules = rulesOf(sheets.find(sheet => sheet.name === 'studio').css);
  const controls = [
    '.workspace-tab', '.artifact-toolbar .icon-button', '#sidebar-toggle', '#codex-model', '#codex-effort',
    '#codex-select', '.composer-models', '.app-sidebar', '.nav-link', '.new-chat',
    '.sidebar-links .nav-link', '.sidebar-secondary .nav-link',
  ];
  for (const rule of rules.filter(rule => controls.some(selector => hasSelector(rule, selector)))) {
    for (const declaration of rule.declarations) {
      assert.ok(!(declaration.property === 'display' && declaration.value.startsWith('none')), 'Real controls cannot be dropped: ' + rule.selector);
    }
  }
  assert.ok(rules.some(rule => hasSelector(rule, '.workspace-tabs') && hasDeclaration(rule, 'overflow-x', 'auto')), 'Tabs must remain scrollable');
  assert.ok(rules.some(rule => hasSelector(rule, '.workspace-search-results') && rule.declarations.some(declaration => declaration.property === 'max-width' && declaration.value.includes('100vw'))), 'Search results fit narrow viewports');
});

test('both surfaces retain visible keyboard focus and scrollbar affordances in forced colors', () => {
  for (const { name, css } of sheets) {
    const rules = rulesOf(css);
    assert.ok(rules.some(rule => rule.selector.includes(':focus-visible') && rule.declarations.some(declaration => declaration.property === 'outline' && declaration.value.includes('2px'))), name);
    assert.ok(rules.some(rule => hasSelector(rule, '::-webkit-scrollbar-thumb:hover')), name);
    assert.ok(rules.some(rule => forced(rule) && hasDeclaration(rule, 'scrollbar-color', 'auto')), name);
    assert.ok(rules.some(rule => forced(rule) && hasSelector(rule, '::-webkit-scrollbar-thumb') && hasDeclaration(rule, 'background', 'ButtonText')), name + ': high-contrast thumb');
    if (name === 'studio') {
      for (const selector of [
        '.arcane-app :where(button,a,input,select,textarea,summary,[role=button]):focus-visible',
        '.workspace-search:focus-within', '.artifact-stage .asset-previews figure[role="button"]:focus-visible',
      ]) assert.ok(rules.some(rule => forced(rule) && hasSelector(rule, selector) && hasDeclaration(rule, 'outline-color', 'Highlight')), 'Forced-colors focus: ' + selector);
      assert.ok(rules.some(rule => forced(rule) && hasSelector(rule, '.artifact-stage .asset-previews figure[aria-pressed="true"]') && hasDeclaration(rule, 'outline', '2px solid Highlight')), 'Selected preview remains distinguishable');
    }
  }
});

test('studio: current functional metadata and preview labels have a 12px floor across breakpoints', () => {
  const rules = rulesOf(sheets.find(sheet => sheet.name === 'studio').css);
  const labels = [
    '.workspace-tab', '.artifact-toolbar nav button', '.nav-link', '.nav-link small', '.sidebar-label', '.sidebar-note',
    '.shell-notice', '.composer-tool-context', '.tool-context-header p', '.artifact-view-options', '.artifact-view-options button',
    '.preview-guide p', '.workspace-stage #codex-input-size', '.chat-stream-note', '.workspace-stage .codex-message .hint',
    '.field-label', '.artifact-stage .asset-previews figcaption', '.artifact-file', '.settings-summary span',
    '.codex-history-meta', '.codex-history-incomplete', '.codex-history-gap',
  ];
  for (const selector of labels) {
    const sizes = rules.filter(rule => hasSelector(rule, selector))
      .flatMap(rule => rule.declarations.filter(declaration => declaration.property === 'font-size').map(declaration => declaration.value));
    assert.ok(sizes.length, 'Cover an actual functional label: ' + selector);
    for (const size of sizes) {
      assert.match(size, /^\d+(?:\.\d+)?px$/, selector);
      assert.ok(parseFloat(size) >= 12, 'Functional text must stay readable across breakpoints: ' + selector + ' = ' + size);
    }
  }
  const status = rules.filter(rule => hasSelector(rule, '.chat-topline p')).at(-1);
  assert.ok(hasDeclaration(status, 'white-space', 'normal'), 'Live status must wrap');
  assert.ok(hasDeclaration(status, 'overflow', 'auto'), 'Long warnings remain scrollable above the composer');
  assert.ok(hasDeclaration(status, 'overflow-wrap', 'anywhere'));
  assert.ok(status.declarations.some(declaration => declaration.property === 'max-height' && parseFloat(declaration.value) > 0));
  assert.equal(status.declarations.some(declaration => /text-overflow|line-clamp/.test(declaration.property)), false, 'Warnings must not be truncated');
});

test('studio: native metadata overrides inherited small fonts and keeps live state as plain text', () => {
  const rules = rulesOf(sheets.find(sheet => sheet.name === 'studio').css);
  const floor = rules.findLast(rule => rule.selector.startsWith('.arcane-app :is(') && hasDeclaration(rule, 'font-size', 'max(12px,1em)'));
  assert.ok(floor, 'Native panels need a floor with enough specificity to override legacy font shorthands');
  const covered = splitTopLevel(floor.selector.slice('.arcane-app :is('.length, -1), ',').map(normalize);
  for (const selector of [
    'button', 'input', 'select', 'textarea', 'summary', 'label', 'legend', '.status-text', '.hint', 'pre', 'code',
    '.identity', '.history-meta', '.history-title', '.node-meta', '.baseline', '.task-id', '.instructions',
    '.evidence details', '.build-task p', '.build-task pre', '.evidence-artifact p', '.node-row p',
    '.diagnostics-table', '.diagnostics-table th', '.diagnostics-table td', '.key-record h3',
  ]) assert.ok(covered.includes(normalize(selector)), 'Native floor must cover ' + selector);
  assert.doesNotMatch(floor.selector, /wordmark|brand-card|rail-copy/, 'The metadata floor does not resize brand copy');
  for (const selector of ['#codex-scope', '#selected-ref']) {
    const matches = rules.filter(rule => hasSelector(rule, selector));
    const base = matches.filter(rule => !rule.context.length).at(-1);
    assert.ok(base && hasDeclaration(base, 'font-size', '12px'), 'ID-specific text must not defeat the shared floor: ' + selector);
    for (const rule of matches.filter(rule => rule.context.length)) for (const declaration of rule.declarations) {
      if (declaration.property === 'font-size') assert.ok(parseFloat(declaration.value) >= 12, selector);
    }
  }
  const state = rules.find(rule => hasSelector(rule, '.arcane-app :is(.badge,.status-text)'));
  assert.ok(state);
  for (const [property, value] of [['border', '0'], ['border-radius', '0'], ['background', 'transparent'], ['white-space', 'normal']]) {
    assert.ok(hasDeclaration(state, property, value), 'Live state stays plain readable text: ' + property);
  }
});

test('studio: sidebar thumb is narrow and quiet at rest, clear on hover/focus, and visible in forced colors', () => {
  const rules = rulesOf(sheets.find(sheet => sheet.name === 'studio').css);
  const native = rules.find(rule => rule.context.some(value => normalize(value) === '@supportsselector(::-webkit-scrollbar)')
    && hasSelector(rule, '.app-sidebar:hover') && hasSelector(rule, '.app-sidebar:focus-within'));
  assert.ok(native && hasDeclaration(native, 'scrollbar-color', 'auto') && hasDeclaration(native, 'scrollbar-width', 'auto'),
    'Chromium must retain custom thumb styling on hover/focus');
  const scrollbar = rules.find(rule => hasSelector(rule, '.app-sidebar::-webkit-scrollbar'));
  assert.ok(scrollbar && hasDeclaration(scrollbar, 'width', '6px'));
  const thumb = rules.find(rule => !forced(rule) && hasSelector(rule, '.app-sidebar::-webkit-scrollbar-thumb'));
  assert.ok(thumb);
  const alpha = value => Number(value.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1]);
  const rest = alpha(thumb.declarations.find(declaration => declaration.property === 'background')?.value ?? '');
  assert.ok(rest >= .2 && rest <= .4, 'A quiet resting thumb remains discoverable');
  const hover = rules.find(rule => !forced(rule) && hasSelector(rule, '.app-sidebar:hover::-webkit-scrollbar-thumb')
    && hasSelector(rule, '.app-sidebar:focus-within::-webkit-scrollbar-thumb'));
  assert.ok(hover);
  const active = alpha(hover.declarations.find(declaration => declaration.property === 'background')?.value ?? '');
  assert.ok(active >= .6 && active > rest, 'Keyboard/pointer interaction makes the thumb clearer');
  const standard = rules.find(rule => !rule.context.length && hasSelector(rule, '.app-sidebar') && hasDeclaration(rule, 'scrollbar-gutter', 'stable'));
  assert.ok(standard && hasDeclaration(standard, 'scrollbar-width', 'thin'));
  assert.ok(standard.declarations.some(declaration => declaration.property === 'scrollbar-color' && alpha(declaration.value) === rest), 'Standard scrollbars retain the same resting affordance');
  assert.ok(rules.some(rule => !rule.context.length && hasSelector(rule, '.app-sidebar:hover') && hasSelector(rule, '.app-sidebar:focus-within')
    && rule.declarations.some(declaration => declaration.property === 'scrollbar-color' && alpha(declaration.value) === active)), 'Standard scrollbar hover/focus remains clear');
  for (const selector of ['.app-sidebar::-webkit-scrollbar-thumb', '.app-sidebar:hover::-webkit-scrollbar-thumb', '.app-sidebar:focus-within::-webkit-scrollbar-thumb']) {
    assert.ok(rules.some(rule => forced(rule) && hasSelector(rule, selector) && hasDeclaration(rule, 'background', 'ButtonText')), 'High-contrast thumb must survive hover/focus specificity: ' + selector);
  }
});
