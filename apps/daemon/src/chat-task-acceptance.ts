import { types } from 'node:util';
import { detachPlain, WorkStore, type WorkRun, type WorkTaskBinding } from '../../../packages/storage/src/work-store.js';

/** Task-bound evidence review for automatic planning. A proposal, plan or native parent saying "complete"
 * is never acceptance: only human-reviewed WorkStore tasks with current direct-file evidence are.
 *
 * Cross-database boundary: the plan journal reserves its evidence step BEFORE request(); its
 * acknowledgement records the returned runId afterwards. The two SQLite databases are not atomic together.
 * If the WorkStore commit lands but the response is lost (or the daemon restarts), the plan step stays
 * reserved/unknown and is never re-reserved; an explicit later status()/bindingFor() read reveals the exact
 * run, and an identical request() returns that same run (replayed) instead of allocating another. That
 * discovery never authorizes an unknown journal step to retry effects or revives a retired owner. */
export type TaskAcceptanceState = 'pending_submission' | 'awaiting_human_review' | 'accepted' | 'changes_requested' | 'unavailable';
export const TASK_ACCEPTANCE_REASONS = Object.freeze(['binding_missing', 'binding_mismatch', 'no_tasks', 'evidence_missing', 'evidence_changed', 'task_failed', 'store_unavailable'] as const);
export type TaskAcceptanceReason = typeof TASK_ACCEPTANCE_REASONS[number];
export interface TaskAcceptanceStatus {
  readonly state: TaskAcceptanceState; readonly reason: TaskAcceptanceReason | null; readonly runId: string | null;
  readonly tasks: readonly { readonly key: string; readonly state: string }[];
}
export interface TaskAcceptanceOwner { readonly signal: AbortSignal; assertActive(): void }
export class TaskAcceptanceError extends Error {
  constructor(readonly code: 'OWNER_RETIRED' | 'INPUT', message: string) { super(message); this.name = 'TaskAcceptanceError'; }
}
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function ownerOf(value: unknown): { signal: AbortSignal; assertActive: () => unknown } {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TaskAcceptanceError('INPUT', 'Expected the exact original task owner.');
  const keys = Reflect.ownKeys(value), signal = Object.getOwnPropertyDescriptor(value, 'signal'), assert = Object.getOwnPropertyDescriptor(value, 'assertActive');
  if (keys.length !== 2 || !signal || !Object.hasOwn(signal, 'value') || !(signal.value instanceof AbortSignal) || !assert || !Object.hasOwn(assert, 'value') || typeof assert.value !== 'function')
    throw new TaskAcceptanceError('INPUT', 'Expected the exact original task owner.');
  return { signal: signal.value, assertActive: assert.value };
}

const ids = (input: unknown, keys: string[]) => {
  const value = detachPlain(input) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') ||
    keys.some(key => typeof value[key] !== 'string')) throw new TaskAcceptanceError('INPUT', 'Expected an exact task acceptance envelope.');
  return value as Record<string, string>;
};
const status = (state: TaskAcceptanceState, reason: TaskAcceptanceReason | null, run: WorkRun | null): TaskAcceptanceStatus => Object.freeze({
  state, reason, runId: run?.id ?? null, tasks: Object.freeze((run?.tasks ?? []).slice(0, 64).map(task => Object.freeze({ key: task.key, state: task.state }))) });

/** Read-only historical predicate. The host supplies a fresh original project/view
 * guard; no provider continuation, work request, review or native capability is restored. */
export async function readTaskAcceptance(work: WorkStore, input: unknown, guard: () => void): Promise<TaskAcceptanceStatus> {
  if(!(work instanceof WorkStore)||typeof guard!=='function'||types.isProxy(guard))throw new TaskAcceptanceError('INPUT','Expected an owned read-only acceptance context.');
  const check=():void=>{
    const result:unknown=guard();
    if(types.isPromise(result))void Promise.prototype.catch.call(result,()=>{});
    if(result!==undefined)throw new TaskAcceptanceError('OWNER_RETIRED','The acceptance read guard is no longer current.');
  };
  const value = ids(input, ['taskId', 'planId', 'runId']);
  check(); await yieldTurn(); check();
  let found: { binding: WorkTaskBinding; run: WorkRun } | null;
  try { found = work.bindingFor(value.taskId!, value.planId!); } catch { return status('unavailable', 'store_unavailable', null); }
  if (!found) return status('unavailable', 'binding_missing', null);
  if (found.binding.runId !== value.runId || found.run.id !== value.runId) return status('unavailable', 'binding_mismatch', null);
  const run = found.run;
  if (!run.tasks.length) return status('unavailable', 'no_tasks', run);
  if (run.tasks.some(task => task.state === 'failed')) return status('unavailable', 'task_failed', run);
  if (run.tasks.some(task => task.state === 'needs_review')) return status('awaiting_human_review', null, run);
  if (run.tasks.some(task => task.state === 'pending' && task.reviewNote !== null)) return status('changes_requested', null, run);
  if (!run.tasks.every(task => task.state === 'complete')) return status('pending_submission', null, run);
  for (const task of run.tasks) {
    if (!task.evidence.length) return status('unavailable', 'evidence_missing', run);
    for (const evidence of task.evidence) {
      await yieldTurn(); check();
      let current: { sha256: string; bytes: number } | null = null, missing = false;
      try { current = work.verifyEvidence(evidence.path); } catch (error) { missing = !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'; }
      check();
      if (!current) return status('unavailable', missing ? 'evidence_missing' : 'evidence_changed', run);
      if (current.sha256 !== evidence.sha256 || current.bytes !== evidence.bytes) return status('unavailable', 'evidence_changed', run);
    }
  }
  // Final freshness boundary: re-read the exact bound run and re-verify every evidence file in ONE synchronous
  // pass with no further yield, so a change during an earlier yield cannot yield accepted. Cooperative filesystem
  // checks only: a same-user process can still change files after this read.
  check();
  let fresh: { binding: WorkTaskBinding; run: WorkRun } | null;
  try { fresh = work.bindingFor(value.taskId!, value.planId!); } catch { return status('unavailable', 'store_unavailable', null); }
  if (!fresh || fresh.binding.id !== found.binding.id || fresh.run.id !== run.id || JSON.stringify(fresh.run.tasks.map(t => [t.id, t.state, t.evidence])) !== JSON.stringify(run.tasks.map(t => [t.id, t.state, t.evidence])))
    return status('unavailable', 'binding_mismatch', fresh?.run ?? null);
  for (const task of fresh.run.tasks) for (const evidence of task.evidence) {
    let current: { sha256: string; bytes: number } | null = null;
    try { current = work.verifyEvidence(evidence.path); } catch { current = null; }
    if (!current || current.sha256 !== evidence.sha256 || current.bytes !== evidence.bytes) return status('unavailable', 'evidence_changed', fresh.run);
  }
  check();
  return status('accepted', null, fresh.run);
}

/** Host-only port. No browser/model/MCP capability, no review() call, no engine effects. */
export function createTaskAcceptancePort(options: { work: WorkStore; owner: TaskAcceptanceOwner }) {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).length !== 2 || !['work', 'owner'].every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value')))
    throw new TaskAcceptanceError('INPUT', 'Expected exact host acceptance options.');
  if (!(options.work instanceof WorkStore)) throw new TaskAcceptanceError('INPUT', 'Expected the owned WorkStore.');
  const work = options.work, owner = ownerOf(options.owner);
  /** Synchronous: the original owner must be live before every effect and after every await. */
  const check = (): void => {
    if (owner.signal.aborted) throw new TaskAcceptanceError('OWNER_RETIRED', 'The original task is no longer active.');
    let result: unknown;
    try { result = owner.assertActive(); } catch { throw new TaskAcceptanceError('OWNER_RETIRED', 'The original task is no longer active.'); }
    // An invalid async owner check is refused; observe its promise first so a rejection is never unhandled.
    if (result instanceof Promise) void result.catch(() => {});
    if (result !== undefined || owner.signal.aborted) throw new TaskAcceptanceError('OWNER_RETIRED', 'The original task is no longer active.');
  };
  return Object.freeze({
    /** Create (or rediscover after a lost acknowledgement) the one bound run. Snapshot before any await. */
    async request(input: unknown): Promise<{ runId: string; replayed: boolean }> {
      const snapshot = detachPlain(input); // proxies, accessors and exotic envelopes refused before any trap or getter runs
      check(); await yieldTurn(); check();
      const created = work.createForTask(snapshot);
      return Object.freeze({ runId: created.run.id, replayed: created.replayed });
    },
    /** Actual WorkStore records only. Accepted requires >=1 bound task, every task reviewed complete, and
     * every evidence file re-verified byte-identical now. */
    status(input: unknown): Promise<TaskAcceptanceStatus> { return readTaskAcceptance(work,input,check); }
  });
}
