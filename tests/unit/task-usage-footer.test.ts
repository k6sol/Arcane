import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodexChat } from '../../apps/desktop/src/codex-chat.js';
import { startTaskUsageFooter } from '../../apps/desktop/src/task-usage-ui.js';

function fixture() {
  let now = 1000;
  const attributes = new Map<string, string>();
  const field = { hidden: true, textContent: '', setAttribute(name: string, value: string) { attributes.set(name, value); }, removeAttribute(name: string) { attributes.delete(name); } };
  const snapshot: any = { connectionId: 'fixture-connection', connected: true,
    thread: { threadId: 'fixture-thread', sessionId: null, configured: true, writeGranted: false,
      selection: { model: 'fixture-model', effort: 'low' }, turnId: 'fixture-turn', turnStatus: 'inProgress' },
    account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
    events: [{ seq: 1, type: 'turn', threadId: 'fixture-thread', turnId: 'fixture-turn', status: 'inProgress' }],
    lastEventSeq: 1, droppedEvents: 0,
    operations: [{ method: 'thread/start', state: 'acknowledged', threadId: 'fixture-thread' }] };
  const view: any = { state: { projectPath: 'C:/fixture/project', snapshot }, fresh: true, switching: false, nativeBoundToActiveChat: true };
  const listeners = new Set<() => void>();
  const timers = new Set<() => void>();
  const source = {
    currentStateView: () => view as ReturnType<CodexChat['currentStateView']>,
    subscribeStateChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const doc = { getElementById: (id: string) => id === 'codex-task-usage' ? field : null } as unknown as Document;
  const controller = startTaskUsageFooter(doc, source, { now: () => now, schedule(callback, milliseconds) {
    assert.equal(milliseconds, 1000); timers.add(callback); return () => { timers.delete(callback); };
  } });
  return { controller, field, attributes, view, snapshot, listeners, timers,
    advance(value: number) { now = value; for (const callback of [...timers]) { timers.delete(callback); callback(); } },
    notify() { for (const listener of [...listeners]) listener(); } };
}

test('task footer shows observed elapsed and reported tokens, never fabricated usage or subscription charges', () => {
  const f = fixture();
  assert.equal(f.field.hidden, false);
  assert.match(f.field.textContent, /Tokens pending.*Included in plan.*Observed elapsed/);
  assert.doesNotMatch(f.field.textContent, /Tokens 0|\$0|billed|fixture-model/);
  assert.equal(f.attributes.get('aria-live'), 'off', 'Visual clock does not repeatedly announce every second.');
  assert.equal(f.timers.size, 1);
  f.advance(3500); assert.match(f.field.textContent, /Observed elapsed 2s/);
  const usage = { source: 'thread/tokenUsage/updated', continuity: 'reported',
    total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 },
    last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: null };
  f.snapshot.events.push({ seq: 2, type: 'usage', threadId: 'fixture-thread', turnId: 'fixture-turn', usage },
    { seq: 3, type: 'turn', threadId: 'fixture-thread', turnId: 'fixture-turn', status: 'completed' });
  f.snapshot.lastEventSeq = 3; f.snapshot.thread.turnStatus = 'completed'; f.notify();
  assert.match(f.field.textContent, /Tokens 150/);
  assert.equal(f.timers.size, 0, 'Terminal tasks stop the presentation timer.');
  f.controller.cleanup(); assert.equal(f.listeners.size, 0); assert.equal(f.field.hidden, true);
});

test('stale state, a draft tab or a chat transition cannot display another native task as current', () => {
  const f = fixture();
  for (const property of ['fresh', 'nativeBoundToActiveChat', 'switching'] as const) {
    f.view[property] = property === 'switching'; f.notify();
    assert.equal(f.field.hidden, true); assert.equal(f.field.textContent, ''); assert.equal(f.timers.size, 0);
    f.view[property] = property !== 'switching';
  }
  f.controller.cleanup();
});

test('page lifecycle repeatedly stops/resumes one observer and releases timers without any native operation', () => {
  const f = fixture();
  f.controller.stop(); f.controller.stop();
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.field.hidden, true);
  f.controller.resume(); f.controller.resume(); assert.equal(f.listeners.size, 1); assert.equal(f.timers.size, 1);
  f.controller.cleanup(); f.controller.resume();
  assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.field.hidden, true);
});
