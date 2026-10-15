import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChatTaskStore, type ChatTaskRecord } from '../../../packages/storage/src/chat-task-store.js';
import type { Snapshot } from '../../../packages/codex-client/src/types.js';
import type { StudioTestTaskCancellation, StudioTestTaskOrigin, StudioTestTaskPort, StudioTestTaskPrepared,
  StudioTestTaskSettled } from '../../../packages/protocol/src/chat-task-playtest.js';

const ACTIVE = new Set(['working','awaiting_verification','repair_queued','repairing']);
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const preparedSchema = z.strictObject({ jobId: z.string().uuid(), displayDigest: hash, scenarioDigest: hash.nullable(), subjectDigest: hash.nullable() });
const scenarioSchema = z.strictObject({ outcome: z.enum(['passed','failed','incomplete']), requiredEvidence: z.enum(['complete','missing']),
  inputRelease: z.enum(['complete','unknown']), restoration: z.enum(['not_required','complete','unknown']), subjects: z.enum(['current','changed','unobserved']) });
const terminalSchema = preparedSchema.extend({ reportDigest: hash, review: z.object({ phase: z.string(), outcome: z.string().nullable(),
  cleanup: z.string(), evidence: z.enum(['fixture','native']), nativeAcceptance: z.literal(false) }).passthrough(), scenario: scenarioSchema.nullable() });

export interface ChatTaskOwner {
  snapshot(): Snapshot;
  /** Uses only this owned client's opaque native continuation capability. */
  repair(report: StudioTestTaskSettled): Promise<void>;
  revoke(): void;
  cancel(): Promise<void>;
}
interface OwnedTask { origin: StudioTestTaskOrigin; admission: StudioTestTaskOrigin | null; admissionOperation: string | null;
  jobOrigins: Map<string,StudioTestTaskOrigin>; currentJob:StudioTestTaskPrepared|null; settledJobs:Set<string>;
  actorId: string; owner: ChatTaskOwner; revoked: boolean; advancing: boolean }

/** Executes one bounded repair, never a WorkStore graph or caller-supplied runner.
 * Its capability objects and native handles deliberately do not survive restart. */
export class ChatTaskCoordinator {
  readonly #store: ChatTaskStore;
  readonly #owners = new Map<string, OwnedTask>();
  readonly #actors = new Map<string, OwnedTask>();
  readonly #origins = new WeakMap<object, OwnedTask>();
  readonly #pending = new Set<Promise<void>>();
  readonly #stopping = new Map<string, Promise<void>>();
  #cancellation: StudioTestTaskCancellation | null = null;
  #closed = false;
  #fenced = false;
  readonly playtests: StudioTestTaskPort;
  constructor(options: { directory: string; projectPath: string }) {
    this.#store = new ChatTaskStore(options);
    this.playtests = Object.freeze({ capture: (actorId: string) => this.#capture(actorId),
      assert: (origin: StudioTestTaskOrigin) => { this.#assert(origin); },
      prepared: (origin: StudioTestTaskOrigin, value: StudioTestTaskPrepared) => this.#prepared(origin, value),
      terminal: (origin: StudioTestTaskOrigin, value: StudioTestTaskSettled) => this.#terminal(origin, value) });
  }
  attachCancellation(port: StudioTestTaskCancellation): void {
    if (this.#closed || this.#cancellation || !Object.isFrozen(port) ||
        !['cancelExact','revalidateExact'].every(key => typeof Object.getOwnPropertyDescriptor(port,key)?.value === 'function') ||
        Reflect.ownKeys(port).length !== 2) throw new Error('Expected one fixed private playtest cancellation port.');
    this.#cancellation = port;
  }
  available(): boolean { return !this.#closed && !this.#fenced && this.#cancellation !== null; }
  configured():boolean{return this.#cancellation!==null;}
  list(): ChatTaskRecord[] { return this.#store.list(); }
  summaries() { return this.#store.summaries(); }
  owns(id: string): boolean { return this.#owners.has(id); }
  belongs(id:string,threadId:string,sessionId:string|null):boolean{const origin=this.#owners.get(id)?.origin;return origin?.threadId===threadId&&origin.sessionId===sessionId;}
  activeFor(threadId: string, sessionId: string | null): ChatTaskRecord[] {
    return this.list().filter(task => task.threadId === threadId && task.sessionId === sessionId && ACTIVE.has(task.state));
  }
  async cancelFor(threadId:string,sessionId:string|null,reason:string):Promise<void>{
    const owned=[...this.#owners.values()].filter(entry=>entry.origin.threadId===threadId&&entry.origin.sessionId===sessionId);
    const results=await Promise.allSettled(owned.map(entry=>this.cancel(entry.origin.taskId,reason)));
    const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }
  begin(input: { id: string; actorId: string; snapshot: Snapshot; allowWorkspaceWrites: boolean; allowAssets: boolean; owner: ChatTaskOwner }): StudioTestTaskOrigin {
    if (!this.available() || this.#actors.has(input.actorId) || this.#owners.size >= 128) throw new Error('A fresh task incarnation is required.');
    const thread = input.snapshot.thread;
    if (!thread?.configured || !input.snapshot.connected || !input.snapshot.ready || input.snapshot.mcpIsolation !== 'arcane-only-verified' ||
        input.snapshot.account?.auth !== 'subscription' || thread.turnStatus === 'unknown') throw new Error('Task identity is not attested.');
    const incarnationId = randomUUID();
    const task = this.#store.create({ id: input.id, provider: 'codex', threadId: thread.threadId, sessionId: thread.sessionId,
      connectionId: input.snapshot.connectionId, incarnationId, model: thread.selection.model, effort: thread.selection.effort,
      allowWorkspaceWrites: input.allowWorkspaceWrites || thread.writeGranted, allowAssets: input.allowAssets,
      state: 'working', round: 0, operationId: null, turnId: null, nativeSettled: false, acknowledged: false,
      repairDispatch: 'not_requested', prepared: null, evidence: [], reason: null });
    const origin = Object.freeze({ kind: 'studio-test-task-origin' as const, taskId: task.id, projectId: task.projectId, provider: 'codex' as const,
      threadId: task.threadId, sessionId: task.sessionId, incarnationId });
    const entry: OwnedTask = { origin, admission:null, admissionOperation:null, jobOrigins:new Map(),currentJob:null,settledJobs:new Set(), actorId: input.actorId, owner: input.owner, revoked: false, advancing: false };
    this.#owners.set(task.id, entry); this.#actors.set(input.actorId, entry); this.#origins.set(origin, entry);
    return origin;
  }
  #capture(actorId: string): StudioTestTaskOrigin | null {
    const entry = this.#actors.get(actorId); if (!entry) return null;
    this.#assertTask(entry);
    if(!entry.admission || this.#store.get(entry.origin.taskId).operationId!==entry.admissionOperation)throw new Error('Task operation admission is unavailable.');
    return entry.admission;
  }
  #owned(origin: StudioTestTaskOrigin): OwnedTask {
    const entry = origin && typeof origin === 'object' ? this.#origins.get(origin) : undefined;
    if (!entry) throw new Error('Foreign task capability.'); return entry;
  }
  #assert(origin: StudioTestTaskOrigin): OwnedTask {
    const entry=this.#owned(origin);this.#assertTask(entry);
    if(entry.admission!==origin || this.#store.get(origin.taskId).operationId!==entry.admissionOperation)throw new Error('Task operation admission is unavailable.');
    return entry;
  }
  #assertTask(entry:OwnedTask): void {
    const task = this.#store.get(entry.origin.taskId), snapshot = entry.owner.snapshot(), thread = snapshot.thread;
    if (this.#closed || this.#fenced || entry.revoked || !ACTIVE.has(task.state) || !snapshot.connected || !snapshot.ready || snapshot.mcpIsolation !== 'arcane-only-verified' ||
        snapshot.account?.auth !== 'subscription' || snapshot.connectionId !== task.connectionId || !thread?.configured ||
        thread.threadId !== task.threadId || thread.sessionId !== task.sessionId || thread.selection.model !== task.model || thread.selection.effort !== task.effort) {
      throw new Error('The original task incarnation is unavailable.');
    }
  }
  dispatched(id: string, operationId: string): void {
    const entry = this.#owners.get(id); if (!entry) throw new Error('Unknown owned task.'); this.#assertTask(entry);
    this.#store.update(id, task => {
      if (task.operationId && task.round === 0 || task.round === 1 && task.repairDispatch !== 'reserved') throw new Error('Task dispatch was already recorded.');
      task.operationId = operationId; task.turnId = null; task.acknowledged = false; task.nativeSettled = false;
    });
    const origin=Object.freeze({...entry.origin});entry.admission=origin;entry.admissionOperation=operationId;this.#origins.set(origin,entry);
  }
  acknowledged(id: string): void {
    const entry = this.#owners.get(id); if (!entry || entry.revoked) return;
    const snapshot = entry.owner.snapshot(), thread = snapshot.thread;
    this.#store.update(id, task => {
      const operation = snapshot.operations.find(value => value.operationId === task.operationId);
      if (!operation || operation.state !== 'acknowledged' || !thread || operation.turnId !== thread.turnId ||
          thread.threadId !== task.threadId || thread.sessionId !== task.sessionId) throw new Error('Task acknowledgement changed.');
      task.acknowledged = true; task.turnId = operation.turnId;
      task.nativeSettled = ['completed','failed'].includes(thread.turnStatus);
      if (task.round === 1) task.repairDispatch = 'acknowledged';
    });
    this.#schedule(entry);
  }
  ended(id: string, operationId: string): void {
    const entry = this.#owners.get(id); if (!entry || entry.revoked) return;
    const snapshot = entry.owner.snapshot(), thread = snapshot.thread, task = this.#store.get(id);
    if (task.operationId !== operationId || !thread || thread.threadId !== task.threadId || thread.sessionId !== task.sessionId) return;
    if (!['completed','failed'].includes(thread.turnStatus)) return;
    this.#store.update(id, value => { value.nativeSettled = true; value.turnId = thread.turnId; }); this.#schedule(entry);
  }
  uncertain(id: string, reason: string, unknown = true): void {
    const entry = this.#owners.get(id); if (!entry || entry.revoked) return;
    entry.revoked = true; entry.admission=null; entry.owner.revoke();
    try{this.#store.update(id, task => { if (ACTIVE.has(task.state)) task.state = unknown ? 'unknown' : 'paused'; task.reason = reason;
      if (task.repairDispatch === 'reserved') task.repairDispatch = 'unknown'; });}
    finally{const pending=this.#cleanup(entry).catch(()=>{}).finally(()=>this.#pending.delete(pending));this.#pending.add(pending);}
  }
  #prepared(origin: StudioTestTaskOrigin, input: StudioTestTaskPrepared): void {
    const entry=this.#assert(origin); const value = preparedSchema.parse(input);
    this.#store.update(origin.taskId, task => {
      if (!['working','repairing'].includes(task.state) || task.prepared) throw new Error('Verification was already prepared.');
      if (task.round === 1 && task.evidence[0]?.scenarioDigest !== value.scenarioDigest) throw new Error('Repair must reverify the same bounded scenario.');
      task.prepared = value; task.state = 'awaiting_verification';
    });
    entry.jobOrigins.set(value.jobId,origin);
    entry.currentJob=value;
  }
  #terminal(origin: StudioTestTaskOrigin, input: StudioTestTaskSettled): void {
    const entry = this.#owned(origin);
    if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw new Error('Verification evidence exceeds its bound.');
    terminalSchema.parse(input); const value = structuredClone(input);
    if(entry.jobOrigins.get(value.jobId)!==origin)throw new Error('Foreign verification job capability.');
    this.#store.update(origin.taskId, task => {
      const existing = task.evidence.find(report => report.jobId === value.jobId);
      if (existing) { if (existing.reportDigest !== value.reportDigest) throw new Error('Verification terminal changed.'); return; }
      const expected = task.prepared;
      if (!expected || expected.jobId !== value.jobId || expected.displayDigest !== value.displayDigest ||
          expected.scenarioDigest !== value.scenarioDigest || expected.subjectDigest !== value.subjectDigest) throw new Error('Verification scope changed.');
      task.evidence.push(value);
      if (entry.revoked || !ACTIVE.has(task.state)) return;
      const scenario = value.scenario;
      if (value.review.outcome === 'cancelled') { task.state = 'cancelled'; task.reason = 'verification_cancelled'; return; }
      const settled = value.review.phase === 'done' && value.review.cleanup === 'complete' && scenario !== null &&
        value.review.canStartAnotherOperation===true && value.review.requiresHumanReview===false &&
        scenario.requiredEvidence === 'complete' && scenario.inputRelease === 'complete' && scenario.restoration !== 'unknown' && scenario.subjects === 'current';
      if (!settled || value.scenarioDigest === null || value.subjectDigest === null) { task.state = 'paused'; task.reason = 'verification_requires_review'; return; }
      task.state = 'awaiting_verification'; task.reason = 'settled_evidence_waiting_for_native_terminal';
    });
    entry.settledJobs.add(value.jobId);
    this.#schedule(entry);
  }
  #schedule(entry: OwnedTask): void {
    if (entry.advancing || this.#closed || this.#fenced || entry.revoked) return;
    entry.advancing = true;
    const pending = Promise.resolve().then(() => this.#advance(entry)).catch(() => {
      try{this.uncertain(entry.origin.taskId, 'task_coordination_failed_no_replay');}catch{/* Cleanup still runs if the task journal fails. */}
    }).finally(() => {
      entry.advancing = false; this.#pending.delete(pending);
      if (!this.#closed && !entry.revoked) {
        const task = this.#store.get(entry.origin.taskId);
        if ((task.state === 'repair_queued' && task.repairDispatch === 'not_requested' || task.state === 'awaiting_verification' && task.evidence.at(-1)?.jobId === task.prepared?.jobId) && task.acknowledged && task.nativeSettled) this.#schedule(entry);
      }
    });
    void pending.catch(()=>{}); // Observe failure even before a lifecycle drain.
    this.#pending.add(pending);
  }
  async #advance(entry: OwnedTask): Promise<void> {
    const id = entry.origin.taskId;
    let task = this.#store.get(id);
    if (entry.revoked || !task.acknowledged || !task.nativeSettled) return;
    this.#assertTask(entry);
    if (task.state === 'awaiting_verification' && task.evidence.at(-1)?.jobId === task.prepared?.jobId) {
      const report = task.evidence.at(-1)!;
      const current = await this.#cancellation!.revalidateExact(report.jobId, entry.jobOrigins.get(report.jobId)!, report.reportDigest);
      if (entry.revoked || this.#closed) return;
      this.#assertTask(entry);
      task = this.#store.update(id, value => {
        if (current !== 'current') { value.state = 'paused'; value.reason = 'verification_sources_'+current; return; }
        if (report.scenario?.outcome === 'passed' && report.review.outcome === 'succeeded' && String(report.review.code)==='OK') { value.state = 'verified'; value.reason = 'bounded_scenario_verified'; }
        else if (report.scenario?.outcome === 'failed' && report.review.outcome==='failed' && String(report.review.code)==='ASSERTION_FAILED' && value.round === 0) { value.state = 'repair_queued'; value.reason = 'bounded_scenario_failed'; }
        else { value.state = report.scenario?.outcome==='failed'&&report.review.outcome==='failed'&&String(report.review.code)==='ASSERTION_FAILED'&&value.round===1 ? 'failed' : 'paused'; value.reason = 'repair_budget_or_evidence'; }
      });
    }
    if (task.state !== 'repair_queued' || task.repairDispatch !== 'not_requested') return;
    const report = task.evidence.at(-1)!;
    entry.admission=null; // Fence every held original-turn preparation before repair reservation.
    this.#store.update(id, value => { value.round = 1; value.state = 'repairing'; value.repairDispatch = 'reserved';
      value.prepared = null; value.operationId = null; value.turnId = null; value.nativeSettled = false; value.acknowledged = false; });
    try { await entry.owner.repair(report); this.acknowledged(id); }
    catch (error) {
      if (entry.revoked) return;
      const dispatched = error instanceof Error && 'dispatched' in error && error.dispatched === true;
      this.#store.update(id, value => { value.state = dispatched ? 'unknown' : 'paused'; value.reason = 'repair_dispatch_not_replayed';
        if (dispatched) value.repairDispatch = 'unknown'; });
      entry.revoked = true; entry.admission=null; entry.owner.revoke();
      await this.#cleanup(entry).catch(()=>{});
    }
  }
  async cancel(id: string, reason: string): Promise<void> {
    const entry = this.#owners.get(id); if (!entry) throw new Error('Task has no live owned incarnation.');
    entry.revoked = true; entry.admission=null; entry.owner.revoke();
    let failure:unknown;
    try{this.#store.update(id, value => { if (ACTIVE.has(value.state)) value.state = 'cancelled'; value.reason = reason; });}catch(error){failure=error;}
    try{await this.#cleanup(entry);}catch(error){failure??=error;}
    if(failure)throw failure;
  }
  #cleanup(entry: OwnedTask): Promise<void> {
    const id=entry.origin.taskId,existing=this.#stopping.get(id);if(existing)return existing;
    const pending=(async()=>{
      try {
        if(entry.currentJob&&!entry.settledJobs.has(entry.currentJob.jobId)){
          if(!this.#cancellation)throw new Error('Owned verification cancellation is unavailable.');
          await this.#cancellation.cancelExact(entry.currentJob.jobId,entry.jobOrigins.get(entry.currentJob.jobId)!);
        }
      }finally{await entry.owner.cancel();}
    })();
    this.#stopping.set(id,pending);return pending;
  }
  async drain(): Promise<void> { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  /** Synchronous host shutdown boundary; callbacks cannot queue another repair. */
  fence():void{
    this.#fenced=true;
    for(const entry of this.#owners.values()){entry.revoked=true;entry.admission=null;try{entry.owner.revoke();}catch{/* Still close every owned native client. */}}
  }
  async stopAll(reason: string): Promise<void> {
    this.fence();const cleanups:Promise<void>[]=[],failures:unknown[]=[];
    for(const[id,entry]of this.#owners){
      try{this.#store.update(id,task=>{if(ACTIVE.has(task.state))task.state='unknown';task.reason=reason;if(task.repairDispatch==='reserved')task.repairDispatch='unknown';});}catch(error){failures.push(error);}
      cleanups.push(this.#cleanup(entry));
    }
    const settled=await Promise.allSettled(cleanups);await this.drain();
    for(const result of settled)if(result.status==='rejected')failures.push(result.reason);
    if(failures.length)throw failures[0];
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.fence();this.#closed = true;
    try { await Promise.allSettled([...this.#owners.keys()].map(id => this.cancel(id, 'application_closed'))); await this.drain(); }
    finally { this.#store.close(); }
  }
}
