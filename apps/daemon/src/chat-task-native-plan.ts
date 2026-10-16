import { types } from 'node:util';
import type { CodexSession } from '../../../packages/codex-client/src/session.js';
import type { NativeIncorporationChain, NativeTaskContinuation, Snapshot } from '../../../packages/codex-client/src/index.js';

/** Original-native-parent plan port. It drives ONLY the original owned Codex client through its bounded
 * incorporation chain. It never connects, closes, interrupts, revokes, grants, or spends the single repair
 * continuation; a plan-only abort just fences this helper. The root coordinator owns task retirement and
 * closure. Cooperative observation of an owned client, not a claim of descendant-process containment. */
export type NativePlanClient = Pick<CodexSession, 'snapshot' | 'taskAccountIdentity' | 'openIncorporationChain' | 'issueIncorporationPermit' | 'continueIncorporation'>;
export interface NativePlanOriginal {
  readonly connectionId: string; readonly threadId: string; readonly sessionId: string | null; readonly accountIdentity: string;
  readonly model: string; readonly effort: string; readonly allowWorkspaceWrites: boolean; readonly operationId: string; readonly turnId: string;
}
export interface ChatTaskNativePlan {
  waitForInitial(): Promise<void>;
  incorporate(text: string, acknowledge: (value: { operationId: string; turnId: string }) => void): Promise<'completed' | 'failed'>;
}
export const NATIVE_PLAN_TIMING = Object.freeze({ pollMs: 50, deadlineMs: 300_000 });
export const NATIVE_PLAN_STEPS = 2;
export class NativePlanError extends Error {
  constructor(readonly code: 'INPUT' | 'RETIRED' | 'SCOPE' | 'ORDER' | 'FENCED' | 'TIMEOUT' | 'UNCERTAIN', message: string) { super(message); this.name = 'NativePlanError'; }
}
const fail = (code: NativePlanError['code'], message: string): never => { throw new NativePlanError(code, message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, HEX64 = /^[a-f0-9]{64}$/;
const idText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
/** Plain own-data fields only: a proxy is refused before any trap; accessors are never invoked. */
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INPUT', 'Expected an exact plain host envelope.');
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value as object);
  if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
    required.some(key => !keys.includes(key))) fail('INPUT', 'Unexpected or missing host field.');
  // Null-prototype output defined per key: a __proto__ key is kept as data and never invokes a prototype setter.
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT', 'Host fields must be plain data.');
    Object.defineProperty(out, key, { value: field!.value, enumerable: true, writable: false, configurable: false });
  }
  return out;
}

export function createChatTaskNativePlan(input: {
  client: NativePlanClient; continuation: NativeTaskContinuation; original: NativePlanOriginal;
  owner: { signal: AbortSignal; assertActive(): void }; timing?: { pollMs: number; deadlineMs: number };
}): ChatTaskNativePlan {
  const top = fields(input, ['client', 'continuation', 'original', 'owner'], ['timing']);
  const client = top.client as NativePlanClient, continuation = top.continuation as NativeTaskContinuation;
  if (!client || typeof client !== 'object' || types.isProxy(client) || !continuation || typeof continuation !== 'object' || types.isProxy(continuation)) fail('INPUT', 'Expected the original owned client and continuation.');
  const o = fields(top.original, ['connectionId', 'threadId', 'sessionId', 'accountIdentity', 'model', 'effort', 'allowWorkspaceWrites', 'operationId', 'turnId']);
  if (typeof o.connectionId !== 'string' || !UUID.test(o.connectionId) || !idText(o.threadId) || !(o.sessionId === null || idText(o.sessionId)) ||
    typeof o.accountIdentity !== 'string' || !HEX64.test(o.accountIdentity) || !idText(o.model) || !idText(o.effort) || typeof o.allowWorkspaceWrites !== 'boolean' ||
    !idText(o.operationId) || !idText(o.turnId)) fail('INPUT', 'Invalid original task identity.');
  const original = Object.freeze({ ...o }) as unknown as NativePlanOriginal;
  const ownerFields = fields(top.owner, ['signal', 'assertActive']);
  if (!(ownerFields.signal instanceof AbortSignal) || typeof ownerFields.assertActive !== 'function') fail('INPUT', 'Expected the exact plan owner.');
  const signal = ownerFields.signal as AbortSignal, assertActive = ownerFields.assertActive as () => unknown;
  let timing: { pollMs: number; deadlineMs: number } = NATIVE_PLAN_TIMING;
  if (top.timing !== undefined) {
    const t = fields(top.timing, ['pollMs', 'deadlineMs']);
    if (!Number.isSafeInteger(t.pollMs) || (t.pollMs as number) < 10 || (t.pollMs as number) > 1000 || !Number.isSafeInteger(t.deadlineMs) ||
      (t.deadlineMs as number) < 1 || (t.deadlineMs as number) > NATIVE_PLAN_TIMING.deadlineMs) fail('INPUT', 'Invalid bounded plan timing.');
    timing = Object.freeze({ pollMs: t.pollMs as number, deadlineMs: t.deadlineMs as number });
  }

  let fenced = false, initialDone = false, inFlight = false, calls = 0, lastSucceeded = false, chain: NativeIncorporationChain | null = null;
  const fence = (code: NativePlanError['code'], message: string): never => { fenced = true; return fail(code, message); };
  /** A host callback must return exactly undefined. A real (including cross-realm) promise is observed
   * before refusal so it can never be unhandled; arbitrary thenables are never inspected or invoked. */
  const synchronous = (result: unknown): boolean => {
    if (result === undefined) return true;
    if (types.isPromise(result)) void Promise.prototype.catch.call(result, () => {});
    return false;
  };
  const check = (): void => {
    if (signal.aborted) fence('RETIRED', 'The plan owner retired.');
    let result: unknown;
    try { result = assertActive(); } catch { fence('RETIRED', 'The plan owner retired.'); }
    if (!synchronous(result) || signal.aborted) fence('RETIRED', 'The plan owner retired.');
  };
  /** Exact original identity, isolation, account, selection and write policy on every observation. */
  const identity = (): Snapshot => {
    let snapshot: Snapshot, account: string | null;
    try { snapshot = client.snapshot(); account = client.taskAccountIdentity(); } catch { return fence('SCOPE', 'The original client is unavailable.'); }
    const thread = snapshot.thread;
    if (!snapshot.connected || !snapshot.ready || snapshot.mcpIsolation !== 'arcane-only-verified' || snapshot.account?.auth !== 'subscription' ||
      account !== original.accountIdentity || snapshot.connectionId !== original.connectionId || !thread?.configured || thread.threadId !== original.threadId ||
      thread.sessionId !== original.sessionId || thread.selection.model !== original.model || thread.selection.effort !== original.effort ||
      snapshot.selection?.model !== original.model || snapshot.selection.effort !== original.effort || !original.allowWorkspaceWrites && thread.writeGranted)
      fence('SCOPE', 'The original task identity, isolation or policy changed.');
    return snapshot;
  };
  /** Bounded abort-aware observation of exactly one turn. Timers and listeners are cleared on every path. */
  const observe = (operationId: string, turnId: string): Promise<'completed' | 'failed'> => new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const deadline = Date.now() + timing.deadlineMs;
    const finish = (error: unknown, value?: 'completed' | 'failed') => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (error) { fenced = true; reject(error); } else resolve(value!);
    };
    const aborted = () => finish(new NativePlanError('RETIRED', 'The plan owner retired.'));
    const poll = () => {
      try {
        check(); const snapshot = identity(), thread = snapshot.thread!;
        const operation = snapshot.operations.find(entry => entry.operationId === operationId);
        if (!operation || operation.method !== 'turn/start' || operation.state !== 'acknowledged' || operation.turnId !== turnId || operation.threadId !== original.threadId)
          return finish(new NativePlanError('SCOPE', 'The observed operation is not the exact owned turn.'));
        if (thread.turnId !== turnId) return finish(new NativePlanError('SCOPE', 'A different turn replaced the observed turn.'));
        // Strict bound: checked after validation and before any terminal is accepted.
        if (Date.now() >= deadline) return finish(new NativePlanError('TIMEOUT', 'The observed turn did not finish within its bound.'));
        if (thread.turnStatus === 'completed' || thread.turnStatus === 'failed') return finish(null, thread.turnStatus);
        if (!['starting', 'inProgress'].includes(thread.turnStatus)) return finish(new NativePlanError('UNCERTAIN', 'The observed turn did not reach a usable terminal state.'));
        timer = setTimeout(poll, Math.max(0, Math.min(timing.pollMs, deadline - Date.now())));
      } catch (error) { finish(error); }
    };
    signal.addEventListener('abort', aborted, { once: true });
    poll();
  });

  return Object.freeze({
    async waitForInitial(): Promise<void> {
      if (fenced) fail('FENCED', 'This plan port is fenced.');
      if (initialDone || inFlight) fail('ORDER', 'The original turn was already observed.');
      inFlight = true;
      try {
        check(); identity();
        const terminal = await observe(original.operationId, original.turnId);
        check();
        if (terminal !== 'completed') fence('ORDER', 'The original turn did not complete successfully.');
        initialDone = true; lastSucceeded = true;
      } finally { inFlight = false; }
    },
    async incorporate(text: string, acknowledge: (value: { operationId: string; turnId: string }) => void): Promise<'completed' | 'failed'> {
      if (fenced) fail('FENCED', 'This plan port is fenced.');
      if (typeof text !== 'string' || typeof acknowledge !== 'function' || types.isProxy(acknowledge)) fail('INPUT', 'Expected exact incorporation input.');
      if (!initialDone || inFlight || !lastSucceeded || calls >= NATIVE_PLAN_STEPS) fail('ORDER', 'Incorporation needs a prior successful terminal, one flight and remaining budget.');
      inFlight = true; calls++; lastSucceeded = false;
      try {
        check(); const before = identity();
        let permit;
        try { chain ??= client.openIncorporationChain({ continuation, maxSteps: NATIVE_PLAN_STEPS }); permit = client.issueIncorporationPermit({ chain }); }
        catch { return fence('SCOPE', 'The original task continuation no longer admits incorporation.'); }
        const prior = new Set(before.operations.map(entry => entry.operationId));
        check();
        let thread;
        try { thread = await client.continueIncorporation({ chain, permit, text }); }
        catch { return fence('UNCERTAIN', 'The incorporation dispatch was refused or is uncertain; it is never replayed.'); }
        check(); const after = identity();
        const created = after.operations.filter(entry => !prior.has(entry.operationId) && entry.method === 'turn/start');
        const owned = created.length === 1 ? created[0]! : null;
        if (!owned || owned.state !== 'acknowledged' || !owned.turnId || owned.turnId !== thread.turnId || owned.threadId !== original.threadId || thread.threadId !== original.threadId)
          fence('UNCERTAIN', 'The incorporation acknowledgement is not one exact owned turn.');
        const acknowledged = Object.freeze({ operationId: owned!.operationId, turnId: owned!.turnId! });
        check();
        try { if (!synchronous(acknowledge(acknowledged))) throw new Error('nonvoid'); }
        catch { fence('UNCERTAIN', 'The acknowledgement could not be recorded; the turn is never dispatched again.'); }
        check();
        const terminal = await observe(acknowledged.operationId, acknowledged.turnId);
        check();
        lastSucceeded = terminal === 'completed';
        if (!lastSucceeded) fenced = true; // A failed parent turn ends planning honestly; repair stays separate.
        return terminal;
      } finally { inFlight = false; }
    },
  });
}
