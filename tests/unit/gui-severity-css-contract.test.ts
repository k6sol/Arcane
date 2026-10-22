import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile('apps/desktop/public/studio.css', 'utf8');
const OPEN = '/* ---- Studio output severity', CLOSE = '/* ---- End Studio output severity ---- */';
const start = css.indexOf(OPEN), end = css.indexOf(CLOSE);
const block = css.slice(start, end + CLOSE.length);
const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
const revampEnd = css.indexOf('/* ---- End C22 revamp ---- */');
const reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');

interface Rule { selector: string; context: readonly string[]; declarations: ReadonlyMap<string, string> }
function rulesOf(text: string, context: readonly string[] = []): Rule[] {
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open < 0) break;
    const selector = text.slice(cursor, open).trim();
    let close = open + 1, depth = 1;
    for (; close < text.length && depth > 0; close++) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
    }
    assert.equal(depth, 0, 'balanced block: ' + selector);
    const body = text.slice(open + 1, close - 1);
    if (selector.startsWith('@')) rules.push(...rulesOf(body, [...context, selector]));
    else {
      const declarations = new Map(body.split(';').map(value => value.trim()).filter(Boolean).map(value => {
        const colon = value.indexOf(':');
        assert.ok(colon > 0, 'declaration has a property: ' + value);
        return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()] as const;
      }));
      rules.push({ selector, context, declarations });
    }
    cursor = close;
  }
  return rules;
}

const rules = rulesOf(clean);
const forced = (rule: Rule) => rule.context.some(value => value.replace(/\s/g, '') === '@media(forced-colors:active)');
const NEUTRAL = '.arcane-app :is(.studio-diagnostics--neutral,.studio-diagnostics[data-severity=unknown])';
const STATES = ['clear', 'warnings', 'errors'] as const;
const find = (selector: string, inForcedColors = false): Rule => {
  const matches = rules.filter(rule => rule.selector === selector && forced(rule) === inForcedColors);
  assert.equal(matches.length, 1, 'exactly one rule: ' + selector + (inForcedColors ? ' (forced colours)' : ''));
  return matches[0]!;
};
const value = (rule: Rule, property: string): string => {
  const found = rule.declarations.get(property);
  assert.ok(found !== undefined, rule.selector + ' sets ' + property);
  return found;
};
const tokens = (selector: string): ReadonlyMap<string, string> => {
  const matches = rules.filter(rule => rule.selector === selector);
  assert.equal(matches.length, 1, 'one token rule: ' + selector);
  return matches[0]!.declarations;
};
const dark = tokens('.arcane-app .studio-diagnostics');
const preferredLight = tokens(':root:not([data-theme=dark]) .arcane-app .studio-diagnostics');
const explicitLight = tokens(':root[data-theme=light] .arcane-app .studio-diagnostics');

const channel = (colour: string, index: number): number => {
  const level = parseInt(colour.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4;
};
const luminance = (colour: string): number => 0.2126 * channel(colour, 0) + 0.7152 * channel(colour, 1) + 0.0722 * channel(colour, 2);
const contrast = (a: string, b: string): number => {
  const [light, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (darker + 0.05);
};
const hex = (map: ReadonlyMap<string, string>, token: string): string => {
  const found = map.get(token);
  assert.ok(found !== undefined && /^#[0-9a-f]{6}$/i.test(found), token + ' is a hex colour');
  return found.toLowerCase();
};

test('one owned severity block sits after the C22 revamp block and immediately before the final reduced-motion reset', () => {
  assert.ok(revampEnd > 0 && start > revampEnd && end > start && reset > end, 'revamp, severity block, reset');
  assert.equal(css.indexOf(OPEN, start + 1), -1, 'a single severity block');
  assert.equal(css.slice(end + CLOSE.length, reset).trim(), '', 'nothing between the block and the reset');
  assert.match(css.slice(reset), /^@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{[^{}]*\}\}\s*$/, 'the reset stays last');
  assert.equal((block.match(/\{/g) ?? []).length, (block.match(/\}/g) ?? []).length, 'balanced braces');
});

test('the block is static: no animation, keyframes, transitions or change hooks', () => {
  assert.doesNotMatch(block, /@keyframes/);
  assert.doesNotMatch(clean, /animation|transition|transform|will-change|data-changed|prefers-reduced-motion/);
});

test('only colour, edge and weight change, so layout, breakpoints, pickers and the viewer keep their geometry', () => {
  const allowed = new Set(['background', 'box-shadow', 'color', 'border-color', 'font-weight', 'outline', 'outline-offset']);
  for (const rule of rules) for (const property of rule.declarations.keys()) {
    assert.ok(property.startsWith('--sev-') || allowed.has(property), rule.selector + ' must not set ' + property);
  }
  for (const rule of rules) assert.match(rule.selector, /\.studio-diagnostics/, 'scoped to the Studio output pill: ' + rule.selector);
  assert.doesNotMatch(clean, /width|height|composer-model-popover|picker|asset-viewer|artifact|preview/);
});

test('unknown and non-current reads are neutral for the status mark and the count, and neutral wins', () => {
  const badge = find(NEUTRAL + ' .studio-diagnostics-badge');
  const icon = find(NEUTRAL + ' .studio-diagnostics-badge .icon');
  const count = find(NEUTRAL + ' .studio-diagnostics-count');
  assert.equal(value(badge, 'border-color'), 'var(--glass-line)');
  assert.equal(value(icon, 'color'), 'var(--text-secondary)', 'grey status mark');
  assert.equal(value(count, 'background'), 'none');
  assert.equal(value(count, 'color'), 'var(--text-secondary)', 'grey count');
  for (const rule of [badge, icon, count]) {
    assert.doesNotMatch([...rule.declarations.values()].join(';'), /--sev-|#3fbf7f|#145c38|#f2c14e|#ff2b2b|green/i, 'no severity colour when not current');
  }
  // Later in the cascade and one attribute more specific than any severity rule, so a stray severity class cannot paint green.
  const lastSeverity = Math.max(...STATES.map(state => rules.indexOf(find('.arcane-app .studio-diagnostics--' + state + ' .studio-diagnostics-count'))));
  assert.ok(rules.indexOf(count) > lastSeverity, 'neutral count comes after the severity counts');
  // data-severity=none is written for any empty list, so it never selects a severity colour.
  assert.doesNotMatch(clean, /data-severity=(?:none|warning|error)\b/);
});

test('current clear, warnings and errors are distinct and readable', () => {
  assert.equal(hex(dark, '--sev-clear'), '#3fbf7f');
  assert.equal(hex(dark, '--sev-warn'), '#f2c14e');
  assert.equal(hex(dark, '--sev-error'), '#ff2b2b');
  for (const light of [preferredLight, explicitLight]) {
    assert.equal(hex(light, '--sev-clear'), '#145c38', 'light theme darkens the clear text');
    assert.equal(hex(light, '--sev-warn-ring'), '#6b4700', 'light theme rings the yellow fill');
  }
  const counts = STATES.map(state => find('.arcane-app .studio-diagnostics--' + state + ' .studio-diagnostics-count'));
  const [clear, warnings, errors] = counts as [Rule, Rule, Rule];
  assert.equal(value(clear, 'background'), 'none');
  assert.equal(value(clear, 'color'), 'var(--sev-clear)');
  assert.equal(value(warnings, 'background'), 'var(--sev-warn)');
  assert.equal(value(warnings, 'color'), 'var(--sev-warn-ink)');
  assert.equal(value(errors, 'background'), 'var(--sev-error)');
  assert.equal(value(errors, 'color'), 'var(--sev-error-ink)');
  assert.equal(new Set(counts.map(rule => value(rule, 'background') + '|' + value(rule, 'color') + '|' + value(rule, 'box-shadow'))).size, 3);
  assert.equal(value(find('.arcane-app .studio-diagnostics--errors .studio-diagnostics-badge'), 'border-color'), 'var(--sev-error)');
  assert.equal(value(find('.arcane-app .studio-diagnostics--errors .studio-diagnostics-badge .icon'), 'color'), 'var(--sev-error)');

  // The hover fill is the worst-case pill surface in each theme.
  assert.match(css, /--hover:#1c1c20/);
  assert.match(css, /--hover:#ececee/);
  assert.ok(contrast(hex(dark, '--sev-clear'), '#1c1c20') >= 4.5, 'clear text, dark');
  assert.ok(contrast(hex(explicitLight, '--sev-clear'), '#ececee') >= 4.5, 'clear text, light');
  assert.ok(contrast(hex(dark, '--sev-warn-ink'), hex(dark, '--sev-warn')) >= 4.5, 'warnings count');
  // White on #ff2b2b is 3.73:1 (large text only); the count keeps its 12px size, so its ink must pass AA as normal text.
  assert.ok(contrast(hex(dark, '--sev-error-ink'), hex(dark, '--sev-error')) >= 4.5, 'errors count');
  assert.ok(contrast(hex(explicitLight, '--sev-warn-ring'), '#ececee') >= 3, 'light warnings ring');
  assert.ok(contrast(hex(dark, '--sev-error'), '#ececee') >= 3 && contrast(hex(dark, '--sev-error'), '#1c1c20') >= 3, 'errors fill and edge');
});

test('forced colours use system colours and separate states by edge or fill, not colour alone', () => {
  const system = /^(?:none|ButtonFace|ButtonText|Highlight|HighlightText|-?\d+px|\d+px (?:solid|dashed) ButtonText)$/;
  const forcedCounts = [...STATES.map(state => '.arcane-app .studio-diagnostics--' + state + ' .studio-diagnostics-count'), NEUTRAL + ' .studio-diagnostics-count']
    .map(selector => find(selector, true));
  for (const rule of forcedCounts) {
    for (const [property, declared] of rule.declarations) assert.match(declared, system, rule.selector + ' ' + property);
    assert.equal(value(rule, 'box-shadow'), 'none', 'no literal shadow leaks past forced-color-adjust:none');
  }
  const [clear, warnings, errors, neutral] = forcedCounts as [Rule, Rule, Rule, Rule];
  assert.equal(value(neutral, 'outline'), '1px dashed ButtonText');
  assert.equal(value(clear, 'outline'), '1px solid ButtonText');
  assert.equal(value(warnings, 'outline'), '2px solid ButtonText');
  assert.equal(value(errors, 'background'), 'Highlight');
  assert.equal(value(errors, 'color'), 'HighlightText');
  assert.equal(new Set(forcedCounts.map(rule => value(rule, 'background') + '|' + value(rule, 'outline'))).size, 4, 'four distinct shapes');
});

test('the block carries no internal paths, coordination notes or connection inference', () => {
  assert.doesNotMatch(block, /runtime\/|claude-audit|codex-team|mailbox|handoff|proposed-hunks|plan\.md|\.patch\b|\bC\d+(?:\.\d+)+\b|TODO|FIXME/i);
  assert.doesNotMatch(block, /studio-status--|data-studio|sidebar-status|api key|credential/i, 'no Studio connection or key-health styling');
});
