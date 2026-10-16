import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WorkTaskBinding } from '../../../packages/storage/src/work-store.js';
import { z } from 'zod';
import { ChatTaskStore, ChatTaskProposalLimitError, CHAT_TASK_PROPOSAL_LIMITS, type ChatTaskPlanRecord, type ChatTaskPlanReason, type ChatTaskProposalReason, type ChatTaskProposalRecord, type ChatTaskProposalResult, type ChatTaskRecord } from '../../../packages/storage/src/chat-task-store.js';
import { startChatTaskPlan } from './chat-task-plan-runner.js';
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
  /** Live native account identity of this exact owned client. Owners without it gain no proposal authority. */
  accountIdentity?(): string | null;
  /** Original native client and opaque parent continuation, captured by host composition. */
  plan?(owner: ChatTaskProposalWorkerInput['owner']): ChatTaskNativePlan;
}
export interface ChatTaskNativePlan {
  waitForInitial(): Promise<void>;
  incorporate(text: string, acknowledge: (value: { operationId: string; turnId: string }) => void): Promise<'completed' | 'failed'>;
}
/** Display-only proposal worker: one turn, no approvals, write grants, MCP or parent continuation. */
export interface ChatTaskProposalWorker {
  propose(text: string): Promise<{ readonly threadId: string; readonly sessionId: string | null; readonly turnId: string; readonly text: string }>;
  close(): Promise<void>;
}
/** Trusted host input built only from the original task, never from an action envelope or proposal text. */
export interface ChatTaskProposalWorkerInput {
  readonly accountIdentity: string; readonly selection: { readonly model: string; readonly effort: string };
  readonly owner: { readonly signal: AbortSignal; assertActive(): void };
}
export type ChatTaskProposalFactory = (input: ChatTaskProposalWorkerInput) => Promise<ChatTaskProposalWorker>;
export const CHAT_TASK_PROPOSAL_CONCURRENCY = Object.freeze({ perTask: 1, total: 2 });
/** Bounded worker admission shared by every coordinator that uses it. Slots whose
 * closure was never confirmed stay quarantined for the budget lifetime; this is an
 * admission rule, not evidence of descendant-process containment. */
export class ChatTaskProposalBudget {
  #inFlight = 0; #unsafe = 0;
  available(): boolean { return this.#inFlight + this.#unsafe < CHAT_TASK_PROPOSAL_CONCURRENCY.total; }
  acquire(): void { if (!this.available()) throw new ChatTaskProposalError('BUSY', 'Wait for the current proposal to finish.'); this.#inFlight++; }
  release(closed: boolean): void { this.#inFlight--; if (!closed) this.#unsafe++; }
  get quarantined(): number { return this.#unsafe; }
}
/** Process-wide default: survives coordinator and project replacement. */
const PROCESS_PROPOSAL_BUDGET = new ChatTaskProposalBudget();
export class ChatTaskProposalError extends Error {
  constructor(readonly code: 'TASK_SCOPE' | 'ACCOUNT_IDENTITY' | 'BUSY' | 'CLOSED' | 'ARGUMENTS' | 'IDEMPOTENCY' | 'JOURNAL_FAILURE', message: string) {
    super(message); this.name = 'ChatTaskProposalError';
  }
}
interface OwnedTask { origin: StudioTestTaskOrigin; admission: StudioTestTaskOrigin | null; admissionOperation: string | null;
  jobOrigins: Map<string,StudioTestTaskOrigin>; currentJob:StudioTestTaskPrepared|null; settledJobs:Set<string>;
  actorId: string; owner: ChatTaskOwner; revoked: boolean; advancing: boolean;
  /** One re-request after an unapproved job expired/cancelled before start; in-memory like every task capability. */
  unstartedRetried: boolean;
  /** Aborted on EVERY retirement path, always before owner.revoke(). */
  controller: AbortController;
  /** Exact original account captured at begin; never recaptured later. */
  accountIdentity: string | null;
  proposal: Promise<void> | null; planController: AbortController | null; planDispatch: string | null; planCompletion: Promise<ChatTaskPlanRecord> | null }
const PROPOSAL_ACCOUNT = /^[a-f0-9]{64}$/;
const errorCode = (error: unknown) => error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
const wellFormedText = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const resultId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
/** Strict projection of the worker's own ProposalResult; anything else is output_rejected. */
function proposalResult(value: unknown): ChatTaskProposalResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value).map(String).sort().join(',');
  if (keys !== 'sessionId,status,text,threadId,turnId' && keys !== 'sessionId,text,threadId,turnId') return null;
  const row = value as Record<string, unknown>;
  if ('status' in row && row.status !== 'proposed') return null;
  if (!resultId(row.threadId) || !resultId(row.turnId) || !(row.sessionId === null || resultId(row.sessionId)) || typeof row.text !== 'string' ||
      !row.text.length || !wellFormedText(row.text) || Buffer.byteLength(row.text) > CHAT_TASK_PROPOSAL_LIMITS.textBytes) return null;
  return Object.freeze({ threadId: row.threadId as string, sessionId: row.sessionId as string | null, turnId: row.turnId as string, text: row.text,
    textSha256: createHash('sha256').update(row.text).digest('hex'), textBytes: Buffer.byteLength(row.text) });
}

/** Executes one bounded repair, never a WorkStore graph or caller-supplied runner.
 * Its capability objects and native handles deliberately do not survive restart. */
export class ChatTaskCoordinator {
  readonly #store: ChatTaskStore;
  readonly #owners = new Map<string, OwnedTask>();
  readonly #actors = new Map<string, OwnedTask>();
  readonly #origins = new WeakMap<object, OwnedTask>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #stopping = new Map<string, Promise<void>>();
  #cancellation: StudioTestTaskCancellation | null = null;
  #closed = false;
  #fenced = false;
  readonly #budget: ChatTaskProposalBudget;
  readonly playtests: StudioTestTaskPort;
  /** proposalBudget: trusted composition/isolated fixtures only; never from an action envelope. */
  constructor(options: { directory: string; projectPath: string; proposalBudget?: ChatTaskProposalBudget }) {
    this.#budget = options.proposalBudget ?? PROCESS_PROPOSAL_BUDGET;
    if (!(this.#budget instanceof ChatTaskProposalBudget)) throw new Error('Expected an owned proposal budget.');
    this.#store = new ChatTaskStore({ directory: options.directory, projectPath: options.projectPath });
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
  begin(input: { id: string; actorId: string; snapshot: Snapshot; allowWorkspaceWrites: boolean; allowAssets: boolean; owner: ChatTaskOwner; accountIdentity?: string }): StudioTestTaskOrigin {
    if (!this.available() || this.#actors.has(input.actorId) || this.#owners.size >= 128) throw new Error('A fresh task incarnation is required.');
    if (input.accountIdentity !== undefined && (typeof input.accountIdentity !== 'string' || !PROPOSAL_ACCOUNT.test(input.accountIdentity))) throw new Error('Task account identity is not exact.');
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
    const entry: OwnedTask = { origin, admission:null, admissionOperation:null, jobOrigins:new Map(),currentJob:null,settledJobs:new Set(), actorId: input.actorId, owner: input.owner, revoked: false, advancing: false, unstartedRetried: false,
      controller: new AbortController(), accountIdentity: input.accountIdentity ?? null, proposal: null, planController: null, planDispatch: null, planCompletion: null };
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
  #assertTask(entry:OwnedTask,allowVerified=false): void {
    const task = this.#store.get(entry.origin.taskId), snapshot = entry.owner.snapshot(), thread = snapshot.thread;
    if (this.#closed || this.#fenced || entry.revoked || !ACTIVE.has(task.state)&&!(allowVerified&&task.state==='verified') || !snapshot.connected || !snapshot.ready || snapshot.mcpIsolation !== 'arcane-only-verified' ||
        snapshot.account?.auth !== 'subscription' || snapshot.connectionId !== task.connectionId || !thread?.configured ||
        thread.threadId !== task.threadId || thread.sessionId !== task.sessionId || thread.selection.model !== task.model || thread.selection.effort !== task.effort) {
      throw new Error('The original task incarnation is unavailable.');
    }
  }
  dispatched(id: string, operationId: string): void {
    const entry = this.#owners.get(id); if (!entry) throw new Error('Unknown owned task.'); this.#assertTask(entry);
    const plan = this.#store.plan(id), plannedStep = entry.planDispatch ? this.#store.planSteps(plan!.id).find(step => step.id === entry.planDispatch) : null;
    if (entry.planDispatch && (plan?.state !== 'active' || plannedStep?.kind !== 'incorporation' || plannedStep.state !== 'reserved' || entry.planController?.signal.aborted))
      throw new Error('Task incorporation dispatch no longer owns its reservation.');
    this.#store.update(id, task => {
      if (task.operationId && task.round === 0 && !plannedStep || task.round === 1 && task.repairDispatch !== 'reserved') throw new Error('Task dispatch was already recorded.');
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
    this.#retire(entry);
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
    // A job whose consent expired or was cancelled before start() never claimed a
    // run: no Studio effect, nothing to review and no evidence slot is consumed.
    const review = value.review as typeof value.review & { runId?: unknown };
    const notStarted = review.runId === null && review.phase === 'idle' && review.outcome === null && review.cleanup === 'not_started';
    let retried = false;
    this.#store.update(origin.taskId, task => {
      const existing = task.evidence.find(report => report.jobId === value.jobId);
      if (existing) { if (existing.reportDigest !== value.reportDigest) throw new Error('Verification terminal changed.'); return; }
      const expected = task.prepared;
      if (!expected || expected.jobId !== value.jobId || expected.displayDigest !== value.displayDigest ||
          expected.scenarioDigest !== value.scenarioDigest || expected.subjectDigest !== value.subjectDigest) throw new Error('Verification scope changed.');
      if (notStarted) {
        if (entry.revoked || task.state !== 'awaiting_verification') return;
        if (entry.unstartedRetried) { task.state = 'cancelled'; task.reason = 'verification_consent_expired'; return; }
        // Allow exactly one fresh request for this same round.
        retried = true; task.prepared = null;
        task.state = task.round === 1 ? 'repairing' : 'working'; task.reason = 'verification_not_started_rerequest_allowed';
        return;
      }
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
    if (retried) entry.unstartedRetried = true;
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
    this.#stopPlan(entry, 'repair_reserved');
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
      this.#retire(entry);
      await this.#cleanup(entry).catch(()=>{});
    }
  }
  async cancel(id: string, reason: string): Promise<void> {
    const entry = this.#owners.get(id); if (!entry) throw new Error('Task has no live owned incarnation.');
    this.#retire(entry);
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
      }finally{try{await entry.owner.cancel();}finally{if(entry.proposal)await entry.proposal;}}
    })();
    this.#stopping.set(id,pending);return pending;
  }
  /** Host-private synchronous parent owner; never exported to routes, tools or proposal text. */
  #proposalOwner(entry: OwnedTask): ChatTaskProposalWorkerInput['owner'] {
    const signal = entry.controller.signal;
    return Object.freeze({ signal, assertActive: (): void => { this.#assertProposalParent(entry); } });
  }
  #assertProposalParent(entry: OwnedTask): void {
    if (entry.controller.signal.aborted) throw new ChatTaskProposalError('TASK_SCOPE', 'The original task is no longer active.');
    this.#assertTask(entry);
    const live = typeof entry.owner.accountIdentity === 'function' ? entry.owner.accountIdentity() : null;
    if (!entry.accountIdentity || live !== entry.accountIdentity) throw new ChatTaskProposalError('ACCOUNT_IDENTITY', 'The original task account is unavailable or changed.');
  }
  proposals(taskId: string): ChatTaskProposalRecord[] { return this.#store.proposals(taskId); }
  plan(taskId: string): ChatTaskPlanRecord | null { return this.#store.plan(taskId); }
  planSteps(planId: string) { return this.#store.planSteps(planId); }
  /** Exact native actor may submit only its own bound evidence while the final
   * parent operation is active. Persisted identity data is never a capability. */
  authorizeBoundWork(actorId:string,binding:WorkTaskBinding):void {
    const entry=this.#actors.get(actorId);
    if(!entry||entry.origin.taskId!==binding.taskId||!entry.planDispatch||entry.planController?.signal.aborted)throw new Error('No original task work authority.');
    this.#assertProposalParent(entry);
    const task=this.#store.get(binding.taskId),plan=this.#store.plan(binding.taskId),snapshot=entry.owner.snapshot();
    if(!plan||plan.id!==binding.planId||plan.state!=='active'||plan.objectiveSha256!==binding.objectiveSha256||!isDeepStrictEqual(plan.binding,binding.original)||
      task.repairDispatch!=='not_requested'||task.nativeSettled||!task.operationId||entry.admissionOperation!==task.operationId||
      !snapshot.thread||!['starting','inProgress'].includes(snapshot.thread.turnStatus))throw new Error('Bound task work no longer owns its native operation.');
    const steps=this.#store.planSteps(plan.id),parent=steps.find(step=>step.id===entry.planDispatch),review=steps.find(step=>step.kind==='evidence');
    const operation=snapshot.operations.find(operation=>operation.operationId===task.operationId);
    if(parent?.kind!=='incorporation'||parent.round!==2||!['reserved','acknowledged'].includes(parent.state)||review?.state!=='acknowledged'||
      review.evidence?.runId!==binding.runId||!operation||operation.method!=='turn/start'||!['pending','acknowledged'].includes(operation.state))
      throw new Error('Only the original final parent can submit this bound work.');
    if(entry.revoked||entry.planController?.signal.aborted)throw new Error('Bound task work owner retired.');
  }
  /** Read-only evidence observation may outlive a measured successful task, but
   * never its original account/client, cancellation or permission incarnation. */
  planObservationOwner(taskId: string): ChatTaskProposalWorkerInput['owner'] {
    const entry = this.#owners.get(taskId); if (!entry || !entry.planController) throw new Error('Task plan owner is unavailable.');
    const signal = entry.planController.signal;
    return Object.freeze({ signal, assertActive: (): void => {
      if (signal.aborted) throw new Error('Task plan owner retired.'); this.#assertTask(entry,true);
      if (!entry.accountIdentity || entry.owner.accountIdentity?.() !== entry.accountIdentity) throw new Error('Task plan account changed.');
    } });
  }
  /** Host-only orchestration. Native and evidence ports come from the original owned task;
   * no route or model can supply a factory, account identity, grant or continuation. */
  startPlan(input: { taskId: string; objective: string; inputSha256: string; factory: ChatTaskProposalFactory;
    evidence: (plan: ChatTaskPlanRecord, owner: ChatTaskProposalWorkerInput['owner']) => Promise<{ runId: string }> }): ChatTaskPlanRecord {
    const entry = this.#owners.get(input.taskId);
    if (!entry || typeof entry.owner.plan !== 'function' || typeof input.factory !== 'function' || typeof input.evidence !== 'function') throw new Error('Task plan ports are unavailable.');
    this.#assertProposalParent(entry);
    const prior = this.#store.plan(input.taskId);
    if (prior) {
      if (prior.objectiveSha256 !== createHash('sha256').update(input.objective).digest('hex') || prior.inputSha256 !== input.inputSha256) throw new Error('Task plan input changed.');
      return prior;
    }
    if (entry.proposal) throw new Error('An existing task proposal is still running.');
    const controller = new AbortController(); entry.planController = controller;
    const retire = () => controller.abort(); entry.controller.signal.addEventListener('abort', retire, { once: true });
    controller.signal.addEventListener('abort', () => entry.controller.signal.removeEventListener('abort', retire), { once: true });
    const owner = Object.freeze({ signal: controller.signal, assertActive: (): void => {
      if (controller.signal.aborted) throw new Error('Task plan retired.');
      this.#assertProposalParent(entry);
      if (this.#store.get(input.taskId).repairDispatch !== 'not_requested') throw new Error('Task repair reserved.');
    } });
    try {
      const native = entry.owner.plan(owner);
      const started = startChatTaskPlan({ store: this.#store, taskId: input.taskId, objective: input.objective, inputSha256: input.inputSha256,
        accountIdentity: entry.accountIdentity!, ports: Object.freeze({ signal: owner.signal, assertActive: owner.assertActive,
          waitForInitial: async () => { owner.assertActive(); await native.waitForInitial(); owner.assertActive(); },
          propose: async (record: ChatTaskProposalRecord, text: string) => {
            owner.assertActive();
            if (entry.proposal || !this.#budget.available()) { this.#store.settleProposal(record.id, { state: 'failed', reason: 'worker_failed_before_dispatch' }); return; }
            this.#budget.acquire();
            const task = this.#store.get(input.taskId), workerInput = Object.freeze({ accountIdentity: entry.accountIdentity!,
              selection: Object.freeze({ model: task.model, effort: task.effort }), owner });
            const tracked = this.#runProposal(entry, record, text, input.factory, workerInput).finally(() => {
              if (entry.proposal === tracked) entry.proposal = null; this.#pending.delete(tracked);
            });
            entry.proposal = tracked; this.#pending.add(tracked); void tracked.catch(() => {}); await tracked;
          },
          incorporate: async (text: string, acknowledge: (value: { operationId: string; turnId: string }) => void) => {
            owner.assertActive();
            const plan = this.#store.plan(input.taskId)!, step = this.#store.planSteps(plan.id).at(-1)!;
            if (step.kind !== 'incorporation' || step.state !== 'reserved' || entry.planDispatch) throw new Error('No exact parent reservation.');
            entry.planDispatch = step.id;
            try { return await native.incorporate(text, value => {
              this.acknowledged(input.taskId);
              const task = this.#store.get(input.taskId);
              if (!task.acknowledged || task.operationId !== value.operationId || task.turnId !== value.turnId) throw new Error('Parent acknowledgement changed its owned operation.');
              acknowledge(value);
            }); } finally { if (entry.planDispatch === step.id) entry.planDispatch = null; }
          },
          requestEvidence: async (plan: ChatTaskPlanRecord) => { owner.assertActive(); const reference = await input.evidence(plan, owner); owner.assertActive(); return reference; },
        }) });
      const tracked = started.completion.then(value => {
        if (value.state === 'unknown') this.uncertain(input.taskId, 'task_plan_unknown_no_replay');
        return value;
      }).finally(() => { this.#pending.delete(tracked); });
      entry.planCompletion = tracked; this.#pending.add(tracked); void tracked.catch(() => { try { this.uncertain(input.taskId, 'task_plan_journal_failed_no_replay'); } catch { /* The owner is still fenced. */ } });
      return started.plan;
    } catch (error) { controller.abort(); throw error; }
  }
  #stopPlan(entry: OwnedTask, reason: ChatTaskPlanReason): void {
    entry.planController?.abort(); entry.planDispatch = null;
    const plan = this.#store.plan(entry.origin.taskId);
    if (plan) this.#store.stopPlan({ planId: plan.id, reason });
  }
  proposalByRequest(requestId: string): ChatTaskProposalRecord | null { return this.#store.proposalByRequest(requestId); }
  /** Human-triggered, display-only proposal for one exact owned parent task. The
   * attempt is durable BEFORE the factory can spawn and is never replayed. */
  startProposal(input: { taskId: string; requestId: string; text: string; factory: ChatTaskProposalFactory }): ChatTaskProposalRecord {
    if (typeof input.text !== 'string' || !input.text.length || !wellFormedText(input.text) || Buffer.byteLength(input.text) > CHAT_TASK_PROPOSAL_LIMITS.promptBytes || typeof input.factory !== 'function')
      throw new ChatTaskProposalError('ARGUMENTS', 'Supply one bounded proposal prompt.');
    const promptSha256 = createHash('sha256').update(input.text).digest('hex'), promptBytes = Buffer.byteLength(input.text);
    const prior = this.#store.proposalByRequest(input.requestId);
    if (prior) {
      if (prior.taskId !== input.taskId || prior.promptSha256 !== promptSha256) throw new ChatTaskProposalError('IDEMPOTENCY', 'This request ID already identifies a different proposal.');
      return prior; // Original observation; never a second dispatch.
    }
    const entry = this.#owners.get(input.taskId);
    if (this.#closed || this.#fenced) throw new ChatTaskProposalError('CLOSED', 'Managed task admission has been fenced.');
    if (!entry || !entry.accountIdentity || typeof entry.owner.accountIdentity !== 'function') throw new ChatTaskProposalError('TASK_SCOPE', 'This task has no live proposal authority.');
    try { this.#assertProposalParent(entry); }
    catch (error) { throw error instanceof ChatTaskProposalError ? error : new ChatTaskProposalError('TASK_SCOPE', 'The original task incarnation is unavailable.'); }
    if (entry.proposal || this.#store.plan(input.taskId)?.state === 'active' || !this.#budget.available())
      throw new ChatTaskProposalError('BUSY', 'Wait for the current proposal to finish.');
    if (this.#store.proposals(input.taskId).length >= CHAT_TASK_PROPOSAL_LIMITS.perTask) throw new ChatTaskProposalError('BUSY', 'This task has no proposal capacity left.');
    const task = this.#store.get(input.taskId);
    let record: ChatTaskProposalRecord;
    try { record = this.#store.reserveProposal({ id: randomUUID(), taskId: input.taskId, requestId: input.requestId, promptSha256, promptBytes }); }
    catch { throw new ChatTaskProposalError('JOURNAL_FAILURE', 'The proposal attempt could not be reserved. No worker was started.'); }
    this.#budget.acquire();
    const workerInput: ChatTaskProposalWorkerInput = Object.freeze({ accountIdentity: entry.accountIdentity,
      selection: Object.freeze({ model: task.model, effort: task.effort }), owner: this.#proposalOwner(entry) });
    const tracked: Promise<void> = this.#runProposal(entry, record, input.text, input.factory, workerInput).catch(() => {})
      .finally(() => { if (entry.proposal === tracked) entry.proposal = null; this.#pending.delete(tracked); });
    entry.proposal = tracked; this.#pending.add(tracked);
    return record;
  }
  async #runProposal(entry: OwnedTask, record: ChatTaskProposalRecord, text: string, factory: ChatTaskProposalFactory, input: ChatTaskProposalWorkerInput): Promise<void> {
    type Outcome = { state: 'proposed'; result: ChatTaskProposalResult } | { state: 'failed' | 'unknown'; reason: ChatTaskProposalReason };
    let closed = true;
    const retired = () => entry.controller.signal.aborted || entry.revoked || this.#closed || this.#fenced;
    const outcome = await (async (): Promise<Outcome> => {
      await Promise.resolve(); // Never spawn inside the reserving call stack.
      try { input.owner.assertActive(); } catch { return { state: 'failed', reason: 'parent_retired' }; }
      let worker: ChatTaskProposalWorker;
      try { worker = await factory(input); }
      catch (error) {
        if (errorCode(error) === 'PROCESS_EXIT_UNCONFIRMED') { closed = false; return { state: 'failed', reason: 'worker_close_unconfirmed' }; }
        if (retired() || errorCode(error) === 'PARENT_SCOPE') return { state: 'failed', reason: 'parent_retired' };
        return { state: 'failed', reason: ['CLI_MISSING', 'PROCESS_PATH'].includes(errorCode(error) ?? '') ? 'worker_unavailable' : 'worker_failed_before_dispatch' };
      }
      let dispatched = false, threw = false, failure: unknown, value: unknown;
      try { input.owner.assertActive(); dispatched = true; value = await worker.propose(text); }
      catch (error) { threw = true; failure = error; }
      // propose() closes its own worker; this joins that retained closure and reports it.
      try { await worker.close(); } catch { closed = false; }
      if (errorCode(failure) === 'PROCESS_EXIT_UNCONFIRMED') closed = false;
      if (!closed) return { state: dispatched ? 'unknown' : 'failed', reason: 'worker_close_unconfirmed' };
      if (!dispatched) return { state: 'failed', reason: 'parent_retired' };
      if (threw) return errorCode(failure) === 'PROPOSAL_OUTPUT' ? { state: 'failed', reason: 'output_rejected' }
        : { state: 'unknown', reason: retired() || errorCode(failure) === 'PARENT_SCOPE' ? 'parent_retired' : 'dispatch_uncertain' };
      // Display data only for the same live original parent at record time.
      try { input.owner.assertActive(); } catch { return { state: 'unknown', reason: 'parent_retired' }; }
      const result = proposalResult(value);
      return result ? { state: 'proposed', result } : { state: 'failed', reason: 'output_rejected' };
    })().catch((): Outcome => ({ state: 'unknown', reason: 'dispatch_uncertain' }));
    try {
      try { this.#store.settleProposal(record.id, outcome); }
      catch (error) {
        // A valid but escape-heavy result cannot be retained exactly: reject it explicitly, never truncate.
        if (!(error instanceof ChatTaskProposalLimitError) || outcome.state !== 'proposed') throw error;
        this.#store.settleProposal(record.id, { state: 'failed', reason: 'output_rejected' });
      }
    } catch { /* Remains reserved; restart records unknown and never replays it. */ }
    finally { this.#budget.release(closed); }
  }
  async drain(): Promise<void> { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  /** Synchronous host shutdown boundary; callbacks cannot queue another repair. */
  fence():void{
    this.#fenced=true;
    for(const entry of this.#owners.values()){try{this.#retire(entry);}catch{/* Still close every owned native client. */}}
  }
  /** Abort owned proposal work BEFORE the revoke callback can run or throw. */
  #retire(entry: OwnedTask): void {
    entry.revoked = true; entry.admission = null;
    try { entry.controller.abort(); this.#stopPlan(entry, 'parent_retired'); } finally { entry.owner.revoke(); }
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
