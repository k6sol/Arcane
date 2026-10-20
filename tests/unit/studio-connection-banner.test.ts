import test from 'node:test';
import assert from 'node:assert/strict';
import { startStudioConnectionBanner, STUDIO_BANNER_TEXT } from '../../apps/desktop/src/setup-checklist.js';

// In-memory DOM double and a scripted workbench liveness signal: no daemon, Studio or plugin runs.
class Node extends EventTarget {
  id = ''; className = ''; type = ''; textContent = ''; hidden = false; disabled = false;
  children: Node[] = []; parentElement: Node | null = null; private attributes = new Map<string, string>();
  constructor(readonly tagName: string) { super(); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  insertBefore(node: Node, before: Node) { node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); }
}
function fixture(initial: boolean | null) {
  const scroll = new Node('div'), messages = new Node('div'); messages.id = 'codex-messages'; scroll.append(messages);
  const doc = { getElementById: (id: string) => id === 'codex-messages' ? messages : null, createElement: (tag: string) => new Node(tag.toUpperCase()) };
  let live = initial, refreshes = 0; const listeners = new Set<() => void>();
  const pending: { fn: () => void; ms: number }[] = [];
  const workbench = {
    studioConnected: () => live,
    subscribeStudioChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: async () => { refreshes++; },
  };
  const banner = startStudioConnectionBanner(doc as unknown as Document, { workbench, graceMs: 60000,
    timers: { set: (fn, ms) => { const entry = { fn, ms }; pending.push(entry); return entry; }, clear: handle => { const at = pending.indexOf(handle as never); if (at >= 0) pending.splice(at, 1); } } });
  const set = (value: boolean | null) => { live = value; for (const listener of [...listeners]) listener(); };
  const root = () => scroll.children.find(node => node.id === 'studio-connection-banner')!;
  const run = () => { const entry = pending.shift()!; entry.fn(); return entry.ms; };
  return { banner, set, root, run, pending, listeners, refreshes: () => refreshes, messages, scroll };
}

test('no banner before Studio was ever connected; a drop shows reconnecting, then Reconnect Studio after the grace period', async () => {
  const f = fixture(false);
  assert.equal(f.banner.state(), 'hidden'); assert.equal(f.root().hidden, true, 'first-run setup is the checklist, not this banner');
  assert.equal(f.scroll.children.indexOf(f.root()), 0, 'mounted above the conversation');
  assert.equal(f.root().getAttribute('role'), 'status');
  f.set(true); assert.equal(f.root().hidden, true);
  f.set(false);
  assert.equal(f.banner.state(), 'reconnecting'); assert.equal(f.root().hidden, false);
  assert.equal(f.root().children[0]!.textContent, 'Studio disconnected — reconnecting…');
  assert.equal(f.run(), 60000);
  assert.equal(f.banner.state(), 'offline'); assert.equal(f.root().children[0]!.textContent, STUDIO_BANNER_TEXT.offline);
  const button = f.root().children[1]!;
  assert.deepEqual([button.textContent, button.type, button.hidden], ['Reconnect Studio', 'button', false]);
  button.dispatchEvent(new Event('click'));
  assert.equal(f.root().children[0]!.textContent, STUDIO_BANNER_TEXT.checking); assert.equal(button.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.refreshes(), 1); assert.equal(f.banner.state(), 'offline'); assert.equal(button.disabled, false);
  // The plugin's own recovery reconnects: a short confirmation, then the banner hides.
  f.set(true);
  assert.equal(f.banner.state(), 'reconnected'); assert.equal(f.root().children[0]!.textContent, 'Studio reconnected.'); assert.equal(button.hidden, true);
  assert.equal(f.run(), 4000); assert.equal(f.banner.state(), 'hidden'); assert.equal(f.root().hidden, true);
});

test('a quick reconnect cancels the grace timer; stop hides and cleanup unsubscribes', () => {
  const f = fixture(true);
  f.set(false); assert.equal(f.pending.length, 1);
  f.set(true); assert.equal(f.banner.state(), 'reconnected');
  assert.deepEqual(f.pending.map(entry => entry.ms), [4000], 'the offline timer was cleared');
  f.set(false); f.banner.stop(); assert.equal(f.root().hidden, true);
  f.banner.resume(); assert.equal(f.root().hidden, false);
  f.banner.cleanup(); assert.equal(f.listeners.size, 0); assert.equal(f.root().hidden, true);
});

test('chat wording: an offline-session refusal and recorded outages read as plain next steps', async () => {
  const { describeToolActivity, readToolResultText, codexFailureHint, CodexChatApi, CODEX_SERVICES_UNREACHABLE_TEXT, STUDIO_OFFLINE_TOOL_TEXT } = await import('../../apps/desktop/src/codex-chat.js');
  const refused = readToolResultText('{"error":{"code":"SESSION_OFFLINE","message":"Studio session is not live."}}');
  assert.equal(refused.state, 'failed');
  const line = describeToolActivity('mcp__arcane__scene_create', { className: 'Part', name: 'Door' }, refused.result, 'failed');
  assert.ok(line.text.endsWith(STUDIO_OFFLINE_TOOL_TEXT)); assert.equal(line.change, null);
  assert.ok(!describeToolActivity('mcp__arcane__scene_create', {}, { error: { code: 'BUSY' } }, 'failed').text.includes(STUDIO_OFFLINE_TOOL_TEXT));
  assert.match(codexFailureHint('CLI_MISSING')!, /provider setup/); assert.match(codexFailureHint('DAEMON_RESTART')!, /not sent again/);
  assert.equal(codexFailureHint('NATIVE_ERROR'), null); assert.equal(codexFailureHint(null), null); assert.equal(codexFailureHint('toString'), null);
  // A refused local connection (services stopped or restarting) is plain words; a mutable request stays uncertain.
  const api = new CodexChatApi('a'.repeat(64), (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
  await assert.rejects(api.request('/v1/codex/state'), (error: Error & { unknown?: boolean }) => error.message === CODEX_SERVICES_UNREACHABLE_TEXT && error.unknown === false);
  await assert.rejects(api.request('/v1/codex/action', { connectionId: 'x' }), (error: Error & { unknown?: boolean }) => error.message === CODEX_SERVICES_UNREACHABLE_TEXT && error.unknown === true);
});
