/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTextOnlyChatSource } from './chat-source-contract.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { diffLines, diffSegments, renderScriptDiff, scriptDiffView, splitSourceLines, tokenizeLuauLine, type LuauLineState } from '../../apps/desktop/src/script-diff.js';
import { CodexChat, CodexChatApi, provideScriptChanges, readScriptChange, renderChangeCard, type ScriptChangeSources, type ToolChange } from '../../apps/desktop/src/codex-chat.js';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { READ_METHODS, WRITE_METHODS, type InstanceRef } from '../../packages/protocol/src/studio.js';

// In-memory DOM, fake transports and a temporary store only: no Electron, provider, Studio, network or inference.
const tick = () => new Promise<void>(done => setImmediate(done));
class Element extends EventTarget {
  tagName: string; id = ''; className = ''; type = ''; hidden = false; disabled = false; tabIndex = 0; focused = 0;
  children: Element[] = []; parent: Element | null = null; dataset: Record<string, string> = {};
  private content = ''; private attributes = new Map<string, string>();
  constructor(tag: string, readonly ownerDocument: DocumentFixture) { super(); this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = String(value); this.children = []; }
  set innerHTML(_value: string) { throw Error('innerHTML is forbidden'); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceWith(next: Element) { const parent = this.parent!; next.parent = parent; parent.children[parent.children.indexOf(this)] = next; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  focus() { this.focused++; }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string): Element[] { return this.all().filter(node => node.className.split(/\s+/).includes(selector.slice(1))); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
class DocumentFixture extends EventTarget {
  defaultView = null;
  createElement(tag: string) { return new Element(tag, this); }
  getElementById() { return null; }
}
const click = (target: Element) => target.dispatchEvent(new Event('click', { cancelable: true }));
const asDoc = (doc: DocumentFixture) => doc as unknown as Document;

test('line diff: trimmed common start/end, LCS middle, numbering and counts', () => {
  const before = 'local a = 1\nlocal b = 2\nprint(a)\nreturn a\n', after = 'local a = 1\nlocal b = 3\nlocal c = 4\nprint(a)\nreturn a\n';
  const diff = diffLines(before, after);
  assert.deepEqual(diff.lines.map(line => [line.kind, line.text, line.oldNo, line.newNo]), [
    ['same', 'local a = 1', 1, 1], ['del', 'local b = 2', 2, null], ['add', 'local b = 3', null, 2], ['add', 'local c = 4', null, 3],
    ['same', 'print(a)', 3, 4], ['same', 'return a', 4, 5]]);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 1); assert.equal(diff.approximate, false);
  assert.deepEqual(splitSourceLines('a\r\nb\r\n'), ['a', 'b']); assert.deepEqual(splitSourceLines(''), []);
  assert.deepEqual(diffLines('', 'x\ny').lines.map(line => line.kind), ['add', 'add']);
  assert.equal(scriptDiffView('same\n', 'same\n').identical, true);
  // Interleaved edits keep unchanged lines between them.
  assert.deepEqual(diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne').lines.map(line => line.kind), ['same', 'del', 'add', 'same', 'del', 'add', 'same']);
});

test('line diff is bounded: a huge middle becomes one removed and one added block; rows and folds are bounded', () => {
  const before = Array.from({ length: 30 }, (_, i) => 'old ' + i).join('\n'), after = Array.from({ length: 30 }, (_, i) => 'new ' + i).join('\n');
  const diff = diffLines(before, after, 10);
  assert.equal(diff.approximate, true); assert.equal(diff.removed, 30); assert.equal(diff.added, 30);
  assert.deepEqual([...new Set(diff.lines.slice(0, 30).map(line => line.kind))], ['del']);
  const long = Array.from({ length: 100 }, (_, i) => 'line ' + i);
  const changed = [...long]; changed[50] = 'changed';
  const segments = diffSegments(diffLines(long.join('\n'), changed.join('\n')).lines, 3);
  assert.deepEqual(segments.map(segment => [segment.kind, segment.lines.length]), [['collapsed', 47], ['lines', 8], ['collapsed', 46]]);
  const view = scriptDiffView(before, after, 12);
  assert.equal(view.truncated, true); assert.equal(view.segments.reduce((n, segment) => n + segment.lines.length, 0), 12);
});

test('Luau tokenizer: keywords, strings, comments, numbers and long brackets across lines', () => {
  const kinds = (line: string, state?: LuauLineState) => tokenizeLuauLine(line, state).map(token => [token.kind, token.text]);
  assert.deepEqual(kinds('local x = "end" -- done'), [['keyword', 'local'], [null, ' x = '], ['string', '"end"'], [null, ' '], ['comment', '-- done']]);
  assert.deepEqual(kinds('if n2 > 0x1F then return 3.5 end'), [['keyword', 'if'], [null, ' n2 > '], ['number', '0x1F'], [null, ' '], ['keyword', 'then'], [null, ' '], ['keyword', 'return'], [null, ' '], ['number', '3.5'], [null, ' '], ['keyword', 'end']]);
  assert.deepEqual(kinds("print('a\\'b')"), [[null, 'print('], ['string', "'a\\'b'"], [null, ')']]);
  const state: LuauLineState = { close: null, kind: null };
  assert.deepEqual(kinds('x = 1 --[[ start', state), [[null, 'x = '], ['number', '1'], [null, ' '], ['comment', '--[[ start']]);
  assert.deepEqual(kinds('still comment', state), [['comment', 'still comment']]);
  assert.deepEqual(kinds('end ]] local y', state), [['comment', 'end ]]'], [null, ' '], ['keyword', 'local'], [null, ' y']]);
  assert.deepEqual(kinds('s = [==[ a ]] b ]==]'), [[null, 's = '], ['string', '[==[ a ]] b ]==]']]);
  assert.deepEqual(kinds('t[1]'), [[null, 't['], ['number', '1'], [null, ']']]);
});

test('rendered diff is text-only with line numbers, +/- rows, colour spans and expandable unchanged regions', () => {
  const doc = new DocumentFixture();
  const long = Array.from({ length: 20 }, (_, i) => 'local v' + i + ' = ' + i);
  const after = [...long]; after[10] = 'local v10 = "<img src=x onerror=alert(1)>"';
  const panel = renderScriptDiff(asDoc(doc), { path: 'ServerScriptService.Spawner', before: long.join('\n'), after: after.join('\n') }) as unknown as Element;
  assert.equal(panel.getAttribute('aria-label'), 'Changes to ServerScriptService.Spawner');
  assert.equal(panel.querySelector('.script-diff-path')!.textContent, 'ServerScriptService.Spawner');
  assert.equal(panel.querySelector('.script-diff-counts')!.textContent, '+1-1');
  const rows = () => panel.querySelectorAll('.script-diff-row');
  assert.equal(rows().length, 8, 'three context lines around the one change');
  const added = panel.querySelector('.add')!;
  assert.deepEqual(added.children.map(node => node.textContent), ['', '11', '+', 'local v10 = "<img src=x onerror=alert(1)>"']);
  assert.equal(added.querySelector('.script-diff-str')!.textContent, '"<img src=x onerror=alert(1)>"', 'markup-looking source stays text');
  assert.equal(added.querySelector('.script-diff-kw')!.textContent, 'local');
  assert.equal(panel.querySelector('.del')!.querySelector('.script-diff-sign')!.textContent, '-');
  const folds = panel.querySelectorAll('.script-diff-expand');
  assert.deepEqual(folds.map(node => node.textContent), ['Show 7 unchanged lines', 'Show 6 unchanged lines']);
  click(folds[0]!);
  assert.equal(rows().length, 15); assert.equal(panel.querySelectorAll('.script-diff-expand').length, 1);
  assert.equal(panel.querySelector('.script-diff-unfolded')!.focused, 1, 'focus moves to the revealed lines');
  assert.equal(rows()[0]!.querySelector('.script-diff-no')!.textContent, '1');
  const same = renderScriptDiff(asDoc(doc), { path: 'P', before: 'a', after: 'a' }) as unknown as Element;
  assert.match(same.querySelector('.script-diff-note')!.textContent, /No line changes/);
});

const scriptChange: ToolChange = { kind: 'script', text: 'Edited script ServerScriptService.Spawner', receipt: 'cmd-script', path: 'ServerScriptService.Spawner' };
test('change card script rows: View changes reads once on demand, toggles, and Copy new source copies the exact new source', async () => {
  const doc = new DocumentFixture(); const reads: string[] = [], copied: string[] = [];
  const sources: ScriptChangeSources = { commandId: 'cmd-script', path: 'ServerScriptService.Spawner', before: 'return 1\n', after: 'return 2\n' };
  const card = renderChangeCard(asDoc(doc), [scriptChange, { kind: 'created', text: 'Created Part', receipt: 'cmd-create', path: null }],
    { copy: async text => { copied.push(text); }, scriptChange: async id => { reads.push(id); return sources; } }) as unknown as Element;
  const view = card.querySelector('.chat-change-diff')!;
  assert.equal(card.querySelectorAll('.chat-change-diff').length, 1, 'only script edits get a diff');
  assert.equal(view.getAttribute('aria-expanded'), 'false'); assert.equal(view.getAttribute('aria-label'), 'View changes to ServerScriptService.Spawner');
  assert.equal(reads.length, 0, 'nothing is read until asked');
  click(view); assert.equal(view.disabled, true); await tick(); await tick(); await tick();
  const panel = card.querySelector('.script-diff')!;
  assert.ok(panel); assert.equal(view.getAttribute('aria-expanded'), 'true'); assert.equal(view.textContent, 'Hide changes');
  assert.equal(view.getAttribute('aria-controls'), panel.id); assert.equal(view.disabled, false);
  assert.deepEqual(panel.querySelectorAll('.script-diff-row').map(row => row.className), ['script-diff-row del', 'script-diff-row add']);
  click(view); assert.equal(panel.hidden, true); assert.equal(view.getAttribute('aria-expanded'), 'false');
  click(view); assert.equal(panel.hidden, false);
  click(card.querySelector('.chat-change-copy-source')!); await tick(); await tick();
  assert.deepEqual(copied, ['return 2\n']); assert.deepEqual(reads, ['cmd-script'], 'sources are read once per card');
  assert.equal(card.querySelector('.chat-change-status')!.textContent, 'Copied the new source of ServerScriptService.Spawner');
});

test('change card script rows: failed reads explain themselves and retry; no reader means no diff actions', async () => {
  const doc = new DocumentFixture(); let fail = true;
  const card = renderChangeCard(asDoc(doc), [scriptChange], { scriptChange: async () => { if (fail) throw Error('gone'); return { commandId: 'cmd-script', path: 'X', before: '', after: 'y' }; } }) as unknown as Element;
  click(card.querySelector('.chat-change-diff')!); await tick(); await tick(); await tick();
  assert.match(card.querySelector('.chat-change-status')!.textContent, /Could not load the changes to ServerScriptService\.Spawner/);
  assert.equal(card.querySelector('.script-diff'), null);
  fail = false; click(card.querySelector('.chat-change-diff')!); await tick(); await tick(); await tick();
  assert.ok(card.querySelector('.script-diff'));
  const plain = renderChangeCard(asDoc(new DocumentFixture()), [scriptChange]) as unknown as Element;
  assert.equal(plain.querySelector('.chat-change-diff'), null); assert.ok(plain.querySelector('.chat-change-copy'));
  assert.equal((renderChangeCard(asDoc(doc), [scriptChange], { scriptChange: null }) as unknown as Element).querySelector('.chat-change-diff'), null);
});

test('script change API: human bearer GET of one exact receipt, strict envelope and bounded body; CodexChat provides it to every card', async () => {
  const token = 'a'.repeat(64), calls: { path: string; init: RequestInit }[] = [];
  let body: unknown = { change: { commandId: 'cmd-1', path: 'Workspace.Script', before: 'a', after: 'b' } }, type = 'application/json; charset=utf-8';
  const transport = (async (path: string, init: RequestInit) => { calls.push({ path, init }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } }); }) as unknown as typeof fetch;
  const api = new CodexChatApi(token, transport);
  assert.deepEqual(await api.scriptChange('cmd-1'), { commandId: 'cmd-1', path: 'Workspace.Script', before: 'a', after: 'b' });
  assert.equal(calls[0]!.path, '/v1/studio/script-diff/cmd-1'); assert.equal(calls[0]!.init.method, 'GET');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer ' + token);
  assert.equal(calls[0]!.init.credentials, 'omit'); assert.equal(calls[0]!.init.redirect, 'error');
  await assert.rejects(api.scriptChange('../commands'), /Choose one recorded script edit/); assert.equal(calls.length, 1);
  body = { change: { commandId: 'other', path: 'P', before: '', after: '' } }; await assert.rejects(api.scriptChange('cmd-1'), /not recognized/);
  body = 'x'.repeat(1536 * 1024 + 1); await assert.rejects(api.scriptChange('cmd-1'), /exceeded its bound/);
  type = 'text/html'; body = {}; await assert.rejects(api.scriptChange('cmd-1'), /not available/);
  assert.equal(readScriptChange({ change: { commandId: 'c', path: 'P', before: 'x'.repeat(100 * 1024 + 1), after: '' } }, 'c'), null);
  assert.equal(readScriptChange({ change: { commandId: 'c', path: 'P\n', before: '', after: '' } }, 'c'), null);
  // The chat that owns the token registers the reader for its document, so either provider's card gets the actions.
  const doc = new DocumentFixture(); type = 'application/json'; body = { change: { commandId: 'cmd-script', path: 'Workspace.Script', before: 'a', after: 'b' } };
  new CodexChat(asDoc(doc), api);
  const card = renderChangeCard(asDoc(doc), [scriptChange]) as unknown as Element;
  click(card.querySelector('.chat-change-diff')!); for (let i = 0; i < 8; i++) await tick();
  assert.equal(calls.at(-1)!.path, '/v1/studio/script-diff/cmd-script'); assert.ok(card.querySelector('.script-diff'));
  provideScriptChanges(asDoc(doc), async () => { throw Error('replaced'); });
});

test('codex-chat and script-diff stay text-only and storage-free', async () => {
  for (const name of ['codex-chat', 'script-diff']) {
    const source = await readFile(resolve('apps/desktop/src/' + name + '.ts'), 'utf8');
    assertTextOnlyChatSource(source, name);
  }
  const css = await readFile(resolve('apps/desktop/public/studio.css'), 'utf8');
  const block = css.slice(css.indexOf('/* ---- Script diff:'), css.indexOf('/* ---- End script diff ---- */'));
  assert.ok(block.length > 100); assert.doesNotMatch(block, /transition\s*:|animation\s*:/);
  assert.ok(css.indexOf('/* ---- End script diff ---- */') < css.lastIndexOf('@media(prefers-reduced-motion:reduce)'), 'block stays before the final reset');
  assert.match(block, /forced-colors:active/);
});

test('script diff route: launcher-human only, succeeded script edits only, exact recorded sources', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-script-diff-')); const store = new StudioStore({ directory });
  const human = 'launcher-human-diff-fixture', agent = 'launcher-agent-diff-fixture';
  const route = studioRoutes(store, directory, undefined, directory, agent);
  let origin = '';
  const server = createServer((request, response) => { void route(request, response, new URL(request.url ?? '/', origin), human, origin).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  t.after(async () => {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); store.close();
    const path = relative(tmpdir(), directory); assert.ok(path !== '' && !isAbsolute(path) && !path.startsWith('..')); rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  const grant = store.createGrant({ allowedRoots: ['ServerScriptService'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'diff-window', placeId: 0, universeId: 0, name: 'Diff fixture', pluginVersion: 'test' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const ref: InstanceRef = { instanceId: 'opaque-S', sessionId: pair.sessionId, root: 'ServerScriptService', pathSegments: ['Spawner'], className: 'Script' };
  const c = store.enqueue({ sessionId: pair.sessionId, requestId: 'diff-0001', method: 'script.update', args: { ref, expectedSource: 'return 1', source: 'return 2' } });
  const get = (id: string, bearer = human) => fetch(origin + '/v1/studio/script-diff/' + id, { headers: { Authorization: 'Bearer ' + bearer } });
  assert.equal((await get(c.id)).status, 400, 'a queued edit has no recorded change yet');
  store.poll(pair.sessionId);
  store.result({ sessionId: pair.sessionId, commandId: c.id, state: 'succeeded', result: { ref, mutation: { kind: 'script.update', ref, before: { source: 'return 1' }, after: { source: 'return 2' } } } });
  const ok = await get(c.id); assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { change: { commandId: c.id, path: 'ServerScriptService.Spawner', className: 'Script', before: 'return 1', after: 'return 2' } });
  assert.deepEqual(store.scriptChange(c.id), { commandId: c.id, path: 'ServerScriptService.Spawner', className: 'Script', before: 'return 1', after: 'return 2' });
  const refused = await get(c.id, agent); assert.equal(refused.status, 403); assert.equal((await refused.json()).error, 'SCOPE');
  assert.equal((await get(c.id, 'wrong')).status, 401);
  assert.equal((await get('unknown-command')).status, 400);
  assert.equal((await fetch(origin + '/v1/studio/script-diff/' + c.id + '?x=1', { headers: { Authorization: 'Bearer ' + human } })).status, 400);
  const read = store.enqueue({ sessionId: pair.sessionId, requestId: 'diff-0002', method: 'selection.read', args: {} });
  assert.throws(() => store.scriptChange(read.id), /succeeded script edit/);
});
