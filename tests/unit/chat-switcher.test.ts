import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatSwitchFocus, chatSwitchOpenSection, chatSwitchSummary, restoreChatSwitchFocus } from '../../apps/desktop/src/chat-tabs.js';

// Narrow chat switcher shared by the ChatGPT and Claude tab strips. Local fake DOM only.
class Node extends EventTarget {
  children: Node[] = []; parentElement: Node | null = null; dataset: Record<string, string> = {}; className = ''; type = ''; title = '';
  disabled = false; open = false; content = ''; focused = 0; private attrs = new Map<string, string>();
  constructor(readonly tagName: string, private readonly doc: Doc) { super(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes); }
  all(): Node[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string) { const tags = selector.split(',').map(tag => tag.trim().toUpperCase()); return this.all().filter(node => tags.includes(node.tagName)); }
  closest(selector: string): Node | null { for (let node: Node | null = this; node; node = node.parentElement) if (node.tagName === selector.toUpperCase()) return node; return null; }
  focus() { this.focused++; this.doc.activeElement = this; }
  click() { this.dispatchEvent(new Event('click')); }
}
class Doc { activeElement: Node | null = null; createElement(tag: string) { return new Node(tag.toUpperCase(), this); } }

const rows = [
  { key: 'a', label: 'Obby lobby', current: false, selectDisabled: false, closeDisabled: false },
  { key: 'b', label: 'Leaderboard', current: true, selectDisabled: false, closeDisabled: true },
];

test('the switcher lists open chats with aria-current, close buttons and New chat, and closes the sheet on choice', () => {
  const doc = new Doc(), menu = doc.createElement('details'), calls: string[] = [];
  menu.open = true;
  const section = chatSwitchOpenSection(doc as unknown as Document, menu as unknown as HTMLDetailsElement, rows,
    { select: key => calls.push('select ' + key), close: key => calls.push('close ' + key), newChat: () => calls.push('new'), newDisabled: false }) as unknown as Node;
  assert.equal(section.getAttribute('role'), 'group'); assert.equal(section.getAttribute('aria-label'), 'Open chats');
  const buttons = section.all().filter(node => node.tagName === 'BUTTON');
  const select = buttons.filter(node => node.className === 'chat-switch-select'), close = buttons.filter(node => node.className === 'chat-switch-close');
  assert.deepEqual(select.map(node => [node.textContent, node.getAttribute('aria-current')]), [['Obby lobby', 'false'], ['Leaderboard', 'true']]);
  assert.deepEqual(close.map(node => node.getAttribute('aria-label')), ['Close Obby lobby', 'Close Leaderboard']);
  assert.equal(close[1]!.disabled, true, 'a sending chat cannot be closed');
  select[0]!.click(); assert.equal(menu.open, false); assert.deepEqual(calls, ['select a']);
  menu.open = true; select[1]!.click(); assert.equal(menu.open, false); assert.deepEqual(calls, ['select a'], 'choosing the current chat only closes the sheet');
  close[0]!.click(); assert.deepEqual(calls, ['select a', 'close a']);
  menu.open = true; buttons.find(node => node.className === 'chat-switch-new')!.click(); assert.equal(menu.open, false); assert.deepEqual(calls.at(-1), 'new');
});

test('the summary names the current chat first and keeps the Saved chats label; re-rendering keeps focus', () => {
  const doc = new Doc(), menu = doc.createElement('details');
  const summary = chatSwitchSummary(doc as unknown as Document, 'Leaderboard', 'claude') as unknown as Node;
  assert.deepEqual(summary.children.map(node => [node.className, node.textContent]), [['chat-switch-current', 'Leaderboard'], ['chat-switch-label', 'Saved chats']]);
  menu.append(summary, chatSwitchOpenSection(doc as unknown as Document, menu as unknown as HTMLDetailsElement, rows, { select() {}, close() {}, newChat() {}, newDisabled: false }) as unknown as Node);
  menu.open = true;
  const old = menu.all().find(node => node.dataset.closeChat === 'a')!; old.focus();
  const match = chatSwitchFocus(doc as unknown as Document, menu as unknown as HTMLElement);
  menu.replaceChildren(chatSwitchSummary(doc as unknown as Document, 'Leaderboard', 'claude') as unknown as Node,
    chatSwitchOpenSection(doc as unknown as Document, menu as unknown as HTMLDetailsElement, rows, { select() {}, close() {}, newChat() {}, newDisabled: false }) as unknown as Node);
  restoreChatSwitchFocus(menu as unknown as HTMLDetailsElement, match);
  assert.notEqual(doc.activeElement, old); assert.equal(doc.activeElement?.dataset.closeChat, 'a');
  menu.open = false; restoreChatSwitchFocus(menu as unknown as HTMLDetailsElement, match);
  assert.equal(doc.activeElement?.tagName, 'SUMMARY', 'a closed sheet returns focus to its summary');
  doc.activeElement = null; assert.equal(chatSwitchFocus(doc as unknown as Document, menu as unknown as HTMLElement), null);
});

test('studio.css keeps the tab strip on wide layouts and swaps to the switcher on narrow ones', () => {
  const css = readFileSync('apps/desktop/public/studio.css', 'utf8').replace(/\s+/g, ' ');
  assert.match(css, /\.arcane-app \.chat-tabs-history :is\(\.chat-switch-open,\.chat-switch-current\)\{display:none\}/);
  const narrow = css.slice(css.indexOf('@media(max-width:1099px){'));
  assert.ok(narrow.length > 0 && narrow.indexOf('.arcane-app .workspace-chat-tabs{display:none}') > 0);
  assert.match(narrow, /\.chat-tabs-history \.chat-switch-open\{display:block\}/);
  assert.match(narrow, /\.chat-switch-select\[aria-current=true\]/);
  assert.match(narrow, /z-index:var\(--z-menu\)/);
});
