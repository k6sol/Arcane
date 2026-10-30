/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTextOnlyChatSource } from './chat-source-contract.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MARKDOWN_LIMITS, parseInline, renderMessageText } from '../../apps/desktop/src/codex-chat.js';

// A minimal DOM double: elements and text nodes only. innerHTML/outerHTML writes throw, and no node can carry an event
// handler attribute or a navigable href unless the renderer sets one (which it must never do).
class Node {
  children: Node[] = []; parent: Node | null = null; className = ''; tabIndex = -1; dataset: Record<string, string> = {};
  private own = ''; readonly attributes = new Map<string, string>();
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.own + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.own = String(value); this.children = []; }
  set innerHTML(_: string) { throw Error('innerHTML is forbidden'); }
  set outerHTML(_: string) { throw Error('outerHTML is forbidden'); }
  append(...nodes: Node[]) { for (const node of nodes) { assert.ok(node instanceof Node, 'only nodes are appended'); node.parent = this; this.children.push(node); } }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  all(): Node[] { return this.children.flatMap(child => [child, ...child.all()]); }
  tags(): string[] { return this.children.map(child => child.tagName); }
  find(tag: string): Node[] { return this.all().filter(node => node.tagName === tag); }
}
const textDoc = { createElement: (tag: string) => new Node(tag.toUpperCase()), createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node; } };
const spanDoc = { createElement: (tag: string) => new Node(tag.toUpperCase()) };
const render = (value: string, doc: object = textDoc) => renderMessageText(doc as unknown as Document, value) as unknown as Node;
const ALLOWED = new Set(['#text', 'DIV', 'PRE', 'CODE', 'P', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'SPAN', 'STRONG', 'EM', 'DEL', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
function assertInert(root: Node) {
  for (const node of [root, ...root.all()]) {
    assert.ok(ALLOWED.has(node.tagName), 'unexpected element ' + node.tagName);
    for (const name of node.attributes.keys()) assert.ok(['title', 'data-language', 'start', 'scope', 'role', 'aria-label'].includes(name), 'unexpected attribute ' + name);
  }
}

test('plain prose stays one pre.message-text, exactly as written', () => {
  for (const value of ['Hello there.', 'Two\n\nparagraphs, no markup.', 'snake_case_name and 2 * 3 = 6', 'C:\\Users\\me\\file.lua', '']) {
    const out = render(value);
    assert.equal(out.tagName, 'PRE'); assert.equal(out.className, 'message-text'); assert.equal(out.textContent, value);
  }
});

test('headings, emphasis, code, lists, quotes, rules and tables render as DOM nodes', () => {
  const out = render([
    '# Title', '## Part *two*', '#### Small ##', '##### not a heading',
    '', 'Some **bold**, *italic*, ~~gone~~ and `x = 1` text.', '',
    '- one', '- two', '  - nested **a**', '  - nested b', '- three', '',
    '3. third', '4. fourth', '', '> quoted *text*', '> more', '', '---', '',
    '| Name | Size |', '|:-----|-----:|', '| Part | 4 |', '| Rock \\| stone | 12 | extra |',
  ].join('\n'));
  assert.equal(out.className, 'message-text claude-message-body'); assert.equal(out.dataset.format, 'rich');
  assert.deepEqual(out.tags(), ['H3', 'H4', 'H6', 'P', 'P', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'DIV']);
  assert.equal(out.children[0]!.textContent, 'Title'); assert.equal(out.children[2]!.textContent, 'Small');
  assert.equal(out.children[1]!.find('EM')[0]!.textContent, 'two');
  assert.equal(out.children[3]!.textContent, '##### not a heading');
  const p = out.children[4]!;
  assert.deepEqual(p.tags(), ['#text', 'STRONG', '#text', 'EM', '#text', 'DEL', '#text', 'CODE', '#text']);
  assert.equal(p.textContent, 'Some bold, italic, gone and x = 1 text.');
  const ul = out.children[5]!; assert.deepEqual(ul.tags(), ['LI', 'LI', 'LI']);
  const nested = ul.children[1]!.find('UL')[0]!; assert.deepEqual(nested.children.map(li => li.textContent), ['nested a', 'nested b']);
  assert.equal(nested.find('STRONG')[0]!.textContent, 'a');
  const ol = out.children[6]!; assert.equal(ol.getAttribute('start'), '3'); assert.equal(ol.children.length, 2);
  assert.deepEqual(out.children[7]!.tags(), ['P']); assert.equal(out.children[7]!.textContent, 'quoted text\nmore');
  const wrap = out.children[9]!; assert.equal(wrap.className, 'md-table'); assert.equal(wrap.tabIndex, 0); assert.equal(wrap.getAttribute('role'), 'region');
  const [head, body] = wrap.children[0]!.children;
  assert.deepEqual(head!.find('TH').map(th => [th.textContent, th.dataset.align ?? '']), [['Name', 'left'], ['Size', 'right']]);
  assert.deepEqual(body!.children.map(tr => tr.children.map(td => td.textContent)), [['Part', '4'], ['Rock | stone', '12']], 'rows are cut to the header width; \\| is a literal pipe');
  assertInert(out);
});

test('fences keep working beside markdown: code, choices and nested markdown in text parts', () => {
  const out = render('## Steps\n\n1. Make a part\n\n```lua\nlocal x = "**not bold**"\n```\n\n```arcane-choices\n{"question":"Which?","options":["A","B"]}\n```');
  assert.deepEqual(out.tags().slice(0, 3), ['H4', 'OL', 'PRE']);
  const code = out.find('CODE')[0]!; assert.equal(code.textContent, 'local x = "**not bold**"'); assert.equal(code.getAttribute('data-language'), 'lua');
  assert.equal(out.find('BUTTON').length, 2, 'the choices fence still becomes buttons');
});

test('links are shown as text with the address beside them, never as anchors', () => {
  const out = render('See [the docs](https://example.com/a_b) or [https://x.test](https://x.test) and [bad](javascript:alert(1)).');
  assertInert(out);
  assert.equal(out.find('A').length, 0);
  const links = out.find('SPAN').filter(node => node.className === 'md-link');
  assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('title')]), [['the docs', 'https://example.com/a_b'], ['https://x.test', 'https://x.test'], ['bad', 'javascript:alert(1']]);
  assert.deepEqual(out.find('SPAN').filter(node => node.className === 'md-link-url').map(node => node.textContent), [' (https://example.com/a_b)', ' (javascript:alert(1)']);
});

test('markup-looking and hostile input stays inert text (fuzz)', () => {
  const pieces = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '**', '*', '_', '`', '~~', '[', ']', '(', ')',
    '|', '\n', '\n\n', '# ', '- ', '1. ', '> ', '---', '\\', '<a href="javascript:void(0)">', '&lt;', '"onload="', 'text', ' ', '|---|---|', '\u202e', '\u0000'];
  let seed = 12345; const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 400; round++) {
    let value = ''; const count = 1 + Math.floor(next() * 40);
    for (let k = 0; k < count; k++) value += pieces[Math.floor(next() * pieces.length)];
    for (const doc of [textDoc, spanDoc]) {
      const out = render(value, doc); assertInert(out);
      if (out.tagName === 'PRE') assert.equal(out.textContent, value, 'plain text is kept verbatim');
    }
  }
  const hostile = render('**<script>alert(1)</script>** and <img src=x onerror=alert(1)>\n\n- [a](javascript:alert(1))');
  assert.match(hostile.textContent, /<script>alert\(1\)<\/script> and <img src=x onerror=alert\(1\)>/);
  assertInert(hostile);
});

test('parsing stays fast on pathological input and oversized text falls back to paragraphs', () => {
  const n = 100_000;
  for (const value of ['*a'.repeat(n / 2), '_a '.repeat(n / 3), '['.repeat(n), '[a]('.repeat(n / 4), '`'.repeat(n), '` ``'.repeat(n / 4), '**a *'.repeat(n / 5),
    '~~a'.repeat(n / 3), '- '.repeat(n / 2), ('|a'.repeat(50) + '\n').repeat(n / 101), ('> '.repeat(20) + 'x\n').repeat(n / 42), ('  - x\n').repeat(n / 6)]) {
    const start = performance.now(); const out = render(value); const elapsed = performance.now() - start;
    assert.ok(elapsed < 1500, 'rendered ' + JSON.stringify(value.slice(0, 12)) + ' in ' + Math.round(elapsed) + 'ms');
    assertInert(out);
  }
  const big = '**x** '.repeat(MARKDOWN_LIMITS.chars / 6 + 10);
  const out = render(big); assert.equal(out.tagName, 'PRE', 'oversized text is shown plainly');
  assert.deepEqual(parseInline('a'.repeat(MARKDOWN_LIMITS.inline + 1) + '**b**').length, 1);
});

test('streaming: unfinished spans and tables stay literal until they close, finished blocks keep their shape', () => {
  assert.equal(render('Here is **bol').tagName, 'PRE');
  assert.equal(render('Here is **bol').textContent, 'Here is **bol');
  assert.equal(render('Intro\n\n| a | b |').tagName, 'PRE', 'a header row without its separator is plain text');
  const partial = render('# Plan\n\n- one\n- tw'), done = render('# Plan\n\n- one\n- two\n\nNext **step**');
  assert.deepEqual(partial.tags(), ['H3', 'UL']); assert.deepEqual(done.tags(), ['H3', 'UL', 'P']);
  assert.equal(partial.children[1]!.children[0]!.textContent, done.children[1]!.children[0]!.textContent);
});

test('codex-chat stays text-only and the markdown styles are static, themed and forced-colors aware', async () => {
  const source = await readFile(resolve('apps/desktop/src/codex-chat.ts'), 'utf8');
  assertTextOnlyChatSource(source);
  assert.doesNotMatch(source, /createElement\('a'\)|\.href\s*=|insertAdjacentHTML|DOMParser/);
  const css = await readFile(resolve('apps/desktop/public/studio.css'), 'utf8');
  const start = css.indexOf('/* ---- Chat markdown:'), end = css.indexOf('/* ---- End chat markdown ---- */');
  assert.ok(start > 0 && end > start); const block = css.slice(start, end);
  assert.doesNotMatch(block, /transition\s*:|animation\s*:|#[0-9a-f]{3,8}\b/i, 'no motion and no raw colours: shared tokens only');
  assert.match(block, /forced-colors:active/);
  assert.ok(end < css.lastIndexOf('@media(prefers-reduced-motion:reduce)'), 'block stays before the final reset');
});

test('text-only contract permits reviewed display labels but refuses asset calls, aliases and sinks', () => {
  const display = "    case 'assets_start':case 'assets_procedural':return make(['Starting','Started'],['Blender job','Blender jobs'],null);";
  assert.doesNotThrow(() => assertTextOnlyChatSource(display));
  for (const mutation of [
    "assets_start({name:'tree'});", "api.assetsStart({name:'tree'});", "api.assetsCancel?.(id);",
    "const start = api.assetsStart;", "const start = assets_start;", "const method = 'assets_procedural'; api[method]({});",
    "api['assets_start']({});", "api['assets_prepare_studio_import']({});", "const start = api.assets_prepare_studio_import;",
    "assets_adopt_glb({});", "fetch('/v1/assets/start', {method:'POST'});",
    "localStorage.setItem('x','y');", "sessionStorage.getItem('x');", "node.innerHTML = input;", "node.outerHTML = input;", "const body = { initiatedBy : 'human' };",
    display.replace("return make", "api.assetsStart({});return make"),
  ]) assert.throws(() => assertTextOnlyChatSource(mutation), { code: 'ERR_ASSERTION' }, mutation);
});
