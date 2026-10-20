import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERENCE_USD_RATES, TaskUsageTracker, costConversion, costConversionNote, currencyForLocale, estimateUsageUsd, formatUsageCost, readCostPreferences, usagePrice, readTaskUsage, taskUsageCost, type ReadonlyTaskUsageState, type TaskUsageRateCard, type TaskUsageSnapshot, type TaskUsageScope } from '../../apps/desktop/src/task-usage.js';
import type { NativeTokenUsage, SessionEvent, ThreadState, TokenUsageBreakdown } from '../../packages/codex-client/src/types.js';

const scope: TaskUsageScope = { projectId: 'project:A', connectionId: 'connection:A', threadId: 'thread:A', turnId: 'turn:1' };
const model = 'fixture-model';
function tokens(input: number, output: number, cached = 0, reasoning = 0, write = 0): TokenUsageBreakdown {
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: write, outputTokens: output, reasoningOutputTokens: reasoning };
}
const usage = (total = tokens(100, 20, 10, 5), last = total): NativeTokenUsage => ({ source: 'thread/tokenUsage/updated', total, last, modelContextWindow: 1000, continuity: 'reported' });
const usageEvent = (seq: number, u = usage(), turnId = scope.turnId): SessionEvent => ({ seq, type: 'usage', threadId: scope.threadId, turnId, usage: u });
const turnEvent = (seq: number, status: string, turnId = scope.turnId): SessionEvent => ({ seq, type: 'turn', threadId: scope.threadId, turnId, status });
function snapshot(events: SessionEvent[] = [], status: ThreadState['turnStatus'] = 'inProgress', fresh = true): TaskUsageSnapshot {
  return { connectionId: scope.connectionId, connected: true,
    thread: { threadId: scope.threadId, sessionId: null, selection: { model, effort: 'low' }, configured: true, writeGranted: false, turnId: scope.turnId, turnStatus: status },
    account: { auth: 'subscription', plan: 'plus', requiresOpenaiAuth: true },
    events, lastEventSeq: events.at(-1)?.seq ?? 0, droppedEvents: 0,
    operations: fresh ? [{ operationId: 'op:thread', method: 'thread/start', state: 'acknowledged', threadId: scope.threadId, turnId: null, requestId: 1, errorCode: null }] : [] };
}
const state = (s: TaskUsageSnapshot, projectId = scope.projectId, live = false): ReadonlyTaskUsageState => ({ projectId, snapshot: s, ...(live ? { liveTurnId: scope.turnId } : {}) });
const card = (overrides: Partial<TaskUsageRateCard> = {}): TaskUsageRateCard => ({ authorized: true, scope, model, currency: 'USD', inputPerMillion: 10, cachedInputPerMillion: 2, cacheWriteInputPerMillion: 12, outputPerMillion: 20, provenance: { id: 'synthetic-test-rates', asOf: '2026-10-13' }, ...overrides });

test('missing telemetry never fabricates token zero or cost; footer requires an active task or reliable measurement', () => {
  const tracker = new TaskUsageTracker(() => 0);
  const active = tracker.read(state(snapshot()));
  assert.equal(active.current, null); assert.equal(active.cost.label, 'Included in plan');
  assert.ok(active.footer.visible); assert.match(active.footer.text, /Tokens pending/); assert.doesNotMatch(active.footer.text, /Tokens 0|\$0/);
  const idle = new TaskUsageTracker(() => 0).read(state(snapshot([], 'completed')));
  assert.equal(idle.elapsedMs, null); assert.equal(idle.footer.visible, false);
});

test('current task, reported thread cumulative and last request remain distinct', () => {
  const tracker = new TaskUsageTracker(() => 0);
  const first = usage(tokens(100, 20), tokens(30, 5));
  let s = snapshot([usageEvent(1, first)], 'completed');
  let v = tracker.read(state(s));
  assert.equal(v.current?.totalTokens, 120); assert.equal(v.lastRequest?.totalTokens, 35);
  s = snapshot([usageEvent(1, first), turnEvent(2, 'completed'), turnEvent(3, 'inProgress', 'turn:2'), usageEvent(4, usage(tokens(180, 40), tokens(40, 10)), 'turn:2')]);
  s.thread!.turnId = 'turn:2';
  v = tracker.read(state(s));
  assert.equal(v.current?.totalTokens, 100); assert.equal(v.cumulative?.totalTokens, 220); assert.equal(v.lastRequest?.totalTokens, 50);
  assert.equal(v.current?.inputTokens, 80); assert.equal(v.current?.outputTokens, 20);
});

test('resume without a baseline reports thread usage and no task total or estimate', () => {
  const v = new TaskUsageTracker(() => 200).read(state(snapshot([usageEvent(1, usage(tokens(100, 20), tokens(30, 5)))], 'inProgress', false)), card());
  assert.equal(v.current, null); assert.equal(v.cumulative?.totalTokens, 120); assert.equal(v.cost.estimate, null);
  assert.equal(v.elapsedKind, 'observed'); assert.match(v.footer.detail, /Thread total 120/);
  assert.match(v.footer.text, /Last reported tokens 35 \(request\)/); assert.doesNotMatch(v.footer.text, /Tokens 120/);
});

test('native decreases and resets suppress subtraction, permanently for that task', () => {
  const tracker = new TaskUsageTracker(() => 0);
  tracker.read(state(snapshot([usageEvent(1)])));
  let v = tracker.read(state(snapshot([usageEvent(1), usageEvent(2, usage(tokens(10, 2)))])));
  assert.equal(v.current, null); assert.equal(v.cumulative, null);
  v = tracker.read(state(snapshot([usageEvent(3, usage(tokens(300, 40)))])));
  assert.equal(v.current, null); assert.equal(v.cost.estimate, null);
});

test('duplicates and stale snapshots do not rewind totals or use stale auth', () => {
  const tracker = new TaskUsageTracker(() => 0);
  const latest = snapshot([usageEvent(1), usageEvent(2, usage(tokens(200, 30, 10, 5)))]);
  assert.equal(tracker.read(state(latest)).current?.totalTokens, 230);
  assert.equal(tracker.read(state(latest)).current?.totalTokens, 230);
  const stale = snapshot([usageEvent(1)]); stale.account = null;
  const view = tracker.read(state(stale));
  assert.equal(view.current?.totalTokens, 230); assert.equal(view.cost.label, 'Included in plan');
});

test('sequence gaps keep cumulative usage but invalidate a task baseline', () => {
  const tracker = new TaskUsageTracker(() => 0);
  tracker.read(state(snapshot([usageEvent(1)])));
  const s = snapshot([usageEvent(3, usage(tokens(200, 30, 10, 5)))]); s.droppedEvents = 1;
  const v = tracker.read(state(s));
  assert.equal(v.current, null); assert.equal(v.cumulative?.totalTokens, 230);
});

test('snapshot report recovers ring eviction without inventing a task baseline', () => {
  const s = snapshot([], 'completed', false); s.lastEventSeq = 20; s.droppedEvents = 20;
  s.usage = { ...usage(), threadId: scope.threadId, turnId: scope.turnId, seq: 19 };
  const v = new TaskUsageTracker(() => 0).read(state(s));
  assert.equal(v.current, null); assert.equal(v.cumulative?.totalTokens, 120);
});

test('older report fallback cannot overwrite a newer usage event', () => {
  const tracker = new TaskUsageTracker(() => 0);
  const s = snapshot([usageEvent(1), usageEvent(2, usage(tokens(200, 20, 10, 5)))]);
  s.usage = { ...usage(), threadId: scope.threadId, turnId: scope.turnId, seq: 1 };
  assert.equal(tracker.read(state(s)).current?.totalTokens, 220);
});

test('project, connection, thread and turn identities do not leak or subtract across scopes', () => {
  const tracker = new TaskUsageTracker(() => 0);
  tracker.read(state(snapshot([usageEvent(1)])));
  for (const which of ['project', 'connection', 'thread', 'turn']) {
    const s = snapshot([], 'completed', false); s.lastEventSeq = 1;
    s.usage = { ...usage(), threadId: scope.threadId, turnId: scope.turnId, seq: 1 };
    if (which === 'connection') s.connectionId = 'connection:B';
    if (which === 'thread') s.thread!.threadId = 'thread:B';
    if (which === 'turn') s.thread!.turnId = 'turn:B';
    const view = tracker.read(state(s, which === 'project' ? 'project:B' : scope.projectId));
    assert.equal(view.current, null);
    if (which === 'thread' || which === 'turn') assert.equal(view.cumulative, null);
    assert.equal(view.cost.estimate, null);
  }
});

test('monotonic clock includes cancellation wait, stops at real completion and never revives on stale active state', () => {
  let now = 100;
  const tracker = new TaskUsageTracker(() => now);
  const s = snapshot([turnEvent(1, 'inProgress')]);
  assert.equal(tracker.read(state(s, scope.projectId, true)).elapsedKind, 'elapsed');
  now = 1100; s.thread!.turnStatus = 'cancelling';
  assert.equal(tracker.read(state(s)).elapsedMs, 1000);
  now = 2100; s.thread!.turnStatus = 'completed'; s.events.push(turnEvent(2, 'completed')); s.lastEventSeq = 2;
  assert.equal(tracker.read(state(s)).elapsedMs, 2000);
  now = 9000; s.thread!.turnStatus = 'inProgress';
  const v = tracker.read(state(s)); assert.equal(v.elapsedMs, 2000); assert.equal(v.active, false); assert.equal(v.status, 'completed');
});

test('unknown or disconnection freezes the task and same-cursor active state cannot resume elapsed', () => {
  let now = 0; const tracker = new TaskUsageTracker(() => now), s = snapshot([turnEvent(1, 'inProgress')]);
  tracker.read(state(s, scope.projectId, true));
  now = 1000; s.connected = false; s.thread!.turnStatus = 'unknown';
  assert.equal(tracker.read(state(s)).elapsedMs, 1000);
  now = 9000; s.connected = true; s.thread!.turnStatus = 'inProgress';
  const stale = tracker.read(state(s)); assert.equal(stale.active, false); assert.equal(stale.elapsedMs, 1000);
  s.events.push(turnEvent(2, 'inProgress')); s.lastEventSeq = 2;
  assert.equal(tracker.read(state(s)).active, true);
  now = 10000; assert.equal(tracker.read(state(s)).elapsedMs, 2000);
});

test('restored completion only uses explicit native duration and never wall-clock timestamps', () => {
  const s = snapshot([turnEvent(1, 'completed')], 'completed', false);
  s.thread!.durationMs = 8765;
  const v = new TaskUsageTracker(() => 123456).read(state(s));
  assert.equal(v.elapsedMs, 8765); assert.equal(v.elapsedKind, 'reported'); assert.match(v.footer.text, /Reported elapsed 8s/);
});

test('backwards and invalid clock readings never decrease or inflate elapsed', () => {
  let now = 100; const tracker = new TaskUsageTracker(() => now), s = snapshot(); tracker.read(state(s));
  now = 1100; assert.equal(tracker.read(state(s)).elapsedMs, 1000);
  now = -500; assert.equal(tracker.read(state(s)).elapsedMs, 1000);
  now = Infinity; assert.equal(tracker.read(state(s)).elapsedMs, 1000);
});

test('clear and project switches do not count unobserved background time', () => {
  let now = 0; const tracker = new TaskUsageTracker(() => now), s = snapshot(); tracker.read(state(s));
  now = 1000; tracker.clear(); now = 9000;
  const view = tracker.read(state(s)); assert.equal(view.elapsedMs, 1000); assert.equal(view.elapsedKind, 'observed');
  now = 10000; tracker.read(state(snapshot([], 'completed', false), 'project:B'));
  now = 20000; assert.equal(tracker.read(state(s)).elapsedMs, 2000);
});

test('pinned authorized estimate separates cached input and never charges reasoning twice', () => {
  const c = tokens(100, 20, 30, 10, 5);
  const cost = taskUsageCost(scope, model, c, false, card());
  assert.equal(cost.kind, 'estimate'); assert.ok(Math.abs(cost.estimate!.amount - 0.00117) < 1e-12);
  assert.match(cost.label, /Estimate.*API equivalent/);
  const included = taskUsageCost(scope, model, c, true, card());
  assert.equal(included.label, 'Included in plan'); assert.ok(included.estimate); assert.doesNotMatch(included.label, /\$0|billed/);
});

test('default estimates unavailable without configuration, exact model/scope, authorization and provenance', () => {
  const c = tokens(100, 20);
  assert.equal(taskUsageCost(scope, model, c, false).label, 'Estimate unavailable');
  for (const bad of [card({ model: 'alias' }), card({ scope: { ...scope, projectId: 'other' } }), card({ scope: { ...scope, connectionId: 'other' } }),
    card({ scope: { ...scope, threadId: 'other' } }), card({ scope: { ...scope, turnId: 'other' } }), card({ inputPerMillion: -1 }), card({ outputPerMillion: Infinity }),
    card({ authorized: false } as unknown as Partial<TaskUsageRateCard>), card({ provenance: { id: '', asOf: '2026-10-13' } })]) {
    assert.equal(taskUsageCost(scope, model, c, false, bad).estimate, null);
  }
});

test('unknown cache-write counts and missing applicable cache rates cannot produce an estimate', () => {
  const c = tokens(100, 20, 30); delete c.cacheWriteInputTokens;
  assert.equal(taskUsageCost(scope, model, c, false, card()).estimate, null);
  assert.ok(taskUsageCost(scope, model, c, false, card({ missingCacheWrite: 'not-applicable' })).estimate);
  const noCache = card(); delete (noCache as { cachedInputPerMillion?: number }).cachedInputPerMillion;
  assert.equal(taskUsageCost(scope, model, tokens(100, 20, 30), false, noCache).estimate, null);
});

test('only explicit subscription evidence gives the plan label', () => {
  for (const auth of ['signed-out', 'unsupported', null] as const) {
    const s = snapshot(); s.account = auth === null ? null : { auth, plan: 'plus', requiresOpenaiAuth: true };
    const v = new TaskUsageTracker(() => 0).read(state(s));
    assert.equal(v.cost.label, 'Estimate unavailable'); assert.doesNotMatch(v.footer.text, /Estimate|Included|\$0/);
  }
});

test('pending native turn identity exposes only pending metrics, never a fabricated task key or elapsed zero', () => {
  const s = snapshot([], 'starting'); s.thread!.turnId = null;
  const v = new TaskUsageTracker(() => 0).read(state(s));
  assert.equal(v.scope, null); assert.equal(v.active, true); assert.equal(v.elapsedMs, null); assert.equal(v.current, null);
  assert.match(v.footer.text, /Tokens pending.*Elapsed unavailable/);
});

test('an unavailable initial monotonic clock does not invent an elapsed measurement', () => {
  const v = new TaskUsageTracker(() => NaN).read(state(snapshot()));
  assert.equal(v.elapsedMs, null); assert.equal(v.elapsedKind, 'unavailable');
});

test('malformed usage rejects negatives, huge counts, fractions, nonfinite, missing counts, and inconsistent subsets', () => {
  for (const bad of [-1, 0.5, Infinity, NaN, 1_000_000_000_001, '100', null]) {
    const u = usage(); (u.total as unknown as Record<string, unknown>).inputTokens = bad; assert.equal(readTaskUsage(u), null);
  }
  const u = usage(); u.total.cachedInputTokens = 101; assert.equal(readTaskUsage(u), null);
  const missing = usage(); delete (missing.total as unknown as Record<string, unknown>).outputTokens; assert.equal(readTaskUsage(missing), null);
});

test('usage getters never execute and secret/provider extra fields do not reach views or accessible text', () => {
  let invoked = 0; const getter = Object.defineProperty({}, 'total', { enumerable: true, get() { invoked++; return tokens(100, 20); } });
  assert.equal(readTaskUsage(getter), null); assert.equal(invoked, 0);
  const u = { ...usage(), accessToken: 'SYNTHETIC_SECRET', apiKey: 'SYNTHETIC_SECRET', provider: 'SYNTHETIC_SECRET' };
  const v = new TaskUsageTracker(() => 0).read(state(snapshot([usageEvent(1, u)])));
  assert.doesNotMatch(JSON.stringify(v), /SYNTHETIC_SECRET|accessToken|apiKey/);
  assert.match(v.footer.accessibleLabel, /Task usage.*input/);
});

test('explicitly reported zero usage is visible and defensive view copies cannot corrupt future readings', () => {
  const tracker = new TaskUsageTracker(() => 0), s = snapshot([usageEvent(1, usage(tokens(0, 0)))], 'completed');
  const v = tracker.read(state(s)); assert.equal(v.current?.totalTokens, 0); assert.match(v.footer.text, /Tokens 0/);
  v.current!.totalTokens = 999;
  assert.equal(tracker.read(state(s)).current?.totalTokens, 0);
});

test('cross-turn events without acknowledged identity cannot poison a baseline', () => {
  const tracker = new TaskUsageTracker(() => 0);
  const s = snapshot([usageEvent(1), usageEvent(2, usage(tokens(999, 99)), 'unrelated:turn')]);
  assert.equal(tracker.read(state(s)).current?.totalTokens, 120);
});

test('model selection for the next task does not erase the prior terminal usage', () => {
  const tracker = new TaskUsageTracker(() => 0), s = snapshot([usageEvent(1), turnEvent(2, 'completed')], 'completed');
  assert.equal(tracker.read(state(s), card()).cost.estimate?.amount, 0.00132);
  s.thread!.selection.model = 'next-model';
  assert.equal(tracker.read(state(s), card()).current?.totalTokens, 120);
  assert.equal(tracker.read(state(s), card()).cost.estimate?.amount, 0.00132);
});

test('same-cursor snapshot of an old turn cannot replace the latest human task', () => {
  const tracker = new TaskUsageTracker(() => 0);
  tracker.read(state(snapshot([usageEvent(1), turnEvent(2, 'completed')], 'completed')));
  const newer = snapshot([turnEvent(3, 'inProgress', 'turn:2'), usageEvent(4, usage(tokens(200, 30, 10, 5)), 'turn:2')]);
  newer.thread!.turnId = 'turn:2';
  assert.equal(tracker.read(state(newer)).scope?.turnId, 'turn:2');
  const stale = snapshot([], 'completed'); stale.lastEventSeq = 4;
  stale.usage = { ...usage(), threadId: scope.threadId, turnId: scope.turnId, seq: 1 };
  const v = tracker.read(state(stale)); assert.equal(v.scope?.turnId, 'turn:2'); assert.equal(v.current?.totalTokens, 110);
});

test('price table: exact model IDs only, cached input at the cached rate, unknown models never priced', () => {
  assert.deepEqual(usagePrice('gpt-5.1-codex'), { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 });
  assert.equal(usagePrice('claude-sonnet-5-5')?.outputPerMillion, 10);
  assert.equal(usagePrice('claude-haiku-4-5-20251001')?.inputPerMillion, 1, 'a release date suffix is ignored');
  for (const unknown of ['fixture-model', 'gpt-5.1-codex-ultra', 'sonnet', '', null, 42]) assert.equal(usagePrice(unknown), null);
  // 1M input of which 400k cached, 100k output on gpt-5.1-codex: 600k*1.25 + 400k*0.125 + 100k*10 per million = 0.75 + 0.05 + 1.0
  assert.ok(Math.abs(estimateUsageUsd('gpt-5.1-codex', { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 })! - 1.8) < 1e-9);
  assert.equal(estimateUsageUsd('fixture-model', { inputTokens: 10, outputTokens: 10 }), null);
});

test('cost formatting: ~$ by default, local currency at the approximate or user rate, tiny amounts not rounded to zero', () => {
  const usd = readCostPreferences(null);
  assert.deepEqual(usd, { show: true, currency: 'USD', rate: null });
  assert.equal(formatUsageCost(2.456, usd), '~$2.46');
  assert.equal(formatUsageCost(0.0042, usd), '~$0.0042');
  assert.equal(formatUsageCost(0, usd), '~$0.00');
  const euroNoRate = readCostPreferences({ currency: 'EUR' });
  assert.match(formatUsageCost(2, euroNoRate, 'de-DE'), /^~1,84\s€$/, 'without a user rate the approximate reference rate converts');
  assert.deepEqual(costConversion(euroNoRate), { currency: 'EUR', rate: REFERENCE_USD_RATES.EUR, source: 'reference' });
  // A UK viewer: the locale picks GBP and the cost reads in pounds without any setup.
  const uk = readCostPreferences(null, currencyForLocale('en-GB'));
  assert.equal(uk.currency, 'GBP'); assert.equal(formatUsageCost(2.46, uk, 'en-GB'), '~£1.94');
  assert.match(costConversionNote(uk), /^ Converted at an approximate rate of 0\.79 GBP per USD \(\d{4}-\d{2}-\d{2}\); set your own rate/);
  assert.equal(formatUsageCost(2, readCostPreferences({}, currencyForLocale('ja-JP')), 'ja-JP'), '~￥300', 'yen has no minor units');
  assert.equal(costConversionNote(usd), '');
  for (const code of ['EUR', 'GBP', 'JPY', 'CAD', 'INR']) assert.ok(REFERENCE_USD_RATES[code]! > 0, code);
  const euro = readCostPreferences({ currency: 'EUR', rate: 0.5, show: true });
  assert.match(formatUsageCost(2, euro, 'de-DE'), /^~1,00\s€$/);
  assert.equal(readCostPreferences({ currency: 'XXX', rate: -1, show: 'no' }).currency, 'USD');
  assert.equal(readCostPreferences({ show: false }).show, false);
  assert.equal(currencyForLocale('en-GB'), 'GBP'); assert.equal(currencyForLocale('fr-FR'), 'EUR'); assert.equal(currencyForLocale('xx'), 'USD');
  assert.equal(readCostPreferences({}, currencyForLocale('ja-JP')).currency, 'JPY');
});

test('a known model gets a table estimate in the footer: API-equivalent for plans, tokens only for unknown models or when hidden', () => {
  const known = 'gpt-5.1-codex', s = snapshot([usageEvent(1, usage(tokens(1_000_000, 100_000, 400_000)))]);
  s.thread!.selection.model = known;
  const tracker = new TaskUsageTracker(() => 0);
  tracker.costDisplay = { preferences: readCostPreferences(null), locale: 'en-US' };
  const v = tracker.read(state(s));
  assert.equal(v.cost.kind, 'included'); assert.ok(Math.abs(v.cost.estimate!.amount - 1.8) < 1e-9);
  assert.match(v.footer.text, /^Tokens 1,100,000 \(~\$1\.80\) · Included in plan/);
  assert.match(v.footer.detail, /~\$1\.80 is an estimated API-equivalent cost; your plan is not charged per token/);
  tracker.costDisplay = { preferences: { show: false, currency: 'USD', rate: null }, locale: 'en-US' };
  assert.doesNotMatch(tracker.read(state(s)).footer.text, /~\$/);
  const unknown = new TaskUsageTracker(() => 0); unknown.costDisplay = { preferences: readCostPreferences(null), locale: 'en-US' };
  assert.doesNotMatch(unknown.read(state(snapshot([usageEvent(1)]))).footer.text, /~\$|\$/);
});
