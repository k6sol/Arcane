import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bounded, codeOf, delay, digest, fail, freeze, identifier, observationSchema, parse, proposalSchema, sameBinding, systemScheduler,
  type LogSummary, type Scheduler, type TestAdapter, type TestBinding, type TestCode, type TestProposal, type TestObservation } from './contracts.js';
import { recordHumanConsent, type ConsentDisplay, type HumanTestVerifier, type TestEvent, type TestLedger } from './ledger.js';
import { SCENARIO_ACTIONS, type ScenarioReview } from './scenario.js';

export interface TestReview {
  runId: string | null; evidence: 'fixture' | 'native'; nativeAcceptance: false;
  binding: TestBinding | null; scopeDigest: string | null;
  phase: 'idle' | 'admitting' | 'starting' | 'observing' | 'waiting' | 'stopping' | 'done';
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'rejected' | null;
  code: TestCode; cleanup: 'not_started' | 'running' | 'complete' | 'unknown';
  startedAt: number | null; deadline: number | null; cleanupDeadline: number | null;
  watchdog: { armed: boolean; fired: boolean; reason: TestCode | null };
  observations: number; logs: readonly LogSummary[]; logsTruncated: boolean;
  requiresHumanReview: boolean; canStartAnotherOperation: boolean;
  scenario?: ScenarioReview;
}
export interface TestControllerOptions {
  adapter: TestAdapter; ledger: TestLedger; humanVerifier: HumanTestVerifier;
  scheduler?: Scheduler; requestTimeoutMs?: number; cleanupGraceMs?: number; proofMaxAgeMs?: number;
  onStatus?: (status: Readonly<TestReview>) => void;
  /** Trusted service-owned setup/restore capability; never supplied by JSON. */
  temporary?: { setup(signal: AbortSignal): Promise<void>; restore(signal: AbortSignal): Promise<void>;
    verifySubjects(signal: AbortSignal): Promise<void>; release(): void };
}
const startSchema = z.strictObject({ proposalId: identifier, consentId: identifier });
const idSchema = z.strictObject({ runId: identifier });
/** One controller owns one run. Construct new controllers with the SAME durable
 * host ledger and dedicated adapter; do not expose privileged hooks to models. */
export class BoundedStudioTestController {
  readonly #options: TestControllerOptions; readonly #scheduler: Scheduler;
  readonly #timeout: number; readonly #grace: number; readonly #freshness: number;
  #prepared: { id: string; display: Readonly<ConsentDisplay> } | null = null;
  #confirming = false; #preparing = false; #controller = new AbortController();
  #run: Promise<void> | null = null; #runId: string | null = null; #scopeDigest = '';
  #admission: Promise<void> | null = null; #resolveAdmission: (() => void) | null = null;
  #stopReason: TestCode | null = null;
  #cancelWatchdog: (() => void) | null = null; #journalFailed = false;
  #closed = false; #baseline = new Set<string>(); #seen = new Set<string>();
  #status: TestReview;
  constructor(options: TestControllerOptions) {
    this.#options = Object.freeze({ ...options }); this.#scheduler = options.scheduler ?? systemScheduler;
    this.#timeout = options.requestTimeoutMs ?? 1000; this.#grace = options.cleanupGraceMs ?? 5000; this.#freshness = options.proofMaxAgeMs ?? 1000;
    for (const value of [this.#timeout, this.#grace, this.#freshness]) if (!Number.isInteger(value) || value < 1 || value > 15_000) fail('INVALID_REQUEST');
    this.#status = { runId: null, evidence: options.adapter.evidence, nativeAcceptance: false, binding: null, scopeDigest: null, phase: 'idle', outcome: null,
      code: 'OK', cleanup: 'not_started', startedAt: null, deadline: null, cleanupDeadline: null,
      watchdog: { armed: false, fired: false, reason: null }, observations: 0, logs: [], logsTruncated: false,
      requiresHumanReview: options.ledger.unresolved(), canStartAnotherOperation: false };
  }
  status(): Readonly<TestReview> { return freeze(structuredClone(this.#status)); }
  #publish(): void { try { this.#options.onStatus?.(this.status()); } catch { /* Host display errors never grant authority or stop cleanup. */ } }
  async prepare(input: unknown): Promise<Readonly<{ proposalId: string; display: Readonly<ConsentDisplay>; displayDigest: string }>> {
    if (this.#closed || this.#run || this.#admission || this.#confirming || this.#preparing) fail('BUSY');
    if (this.#options.ledger.unresolved()) fail('FENCED');
    const proposal = freeze(parse(proposalSchema, input));
    if (!!proposal.scenario !== !!proposal.subjectDigest) fail('INVALID_REQUEST');
    // Bound both sampling volume and total native requests for a single run.
    if (proposal.observationIntervalMs > proposal.durationMs || Math.ceil(proposal.durationMs / proposal.observationIntervalMs) > 128) fail('INVALID_REQUEST');
    this.#preparing = true;
    try {
      if(proposal.scenario){
        if(!this.#options.adapter.prepareScenario||!this.#options.adapter.runScenario||
            proposal.scenario.capture.required&&!this.#options.adapter.captureScenario||!this.#options.temporary)fail('UNSUPPORTED_TOOL');
        await bounded(this.#scheduler,this.#timeout,new AbortController().signal,signal=>this.#options.adapter.prepareScenario!(proposal.scenario!,signal));
      }
      const observation = this.#checkObservation(await bounded(this.#scheduler, this.#timeout, new AbortController().signal,
        signal => this.#options.adapter.observe(proposal.binding, signal)), proposal);
      if (observation.mode !== 'Edit') fail('MODE_MISMATCH');
      const display: ConsentDisplay = freeze({ proposal, cleanupGraceMs: this.#grace, requestTimeoutMs: this.#timeout,
        proofMaxAgeMs: this.#freshness, consentExpiresAt: this.#scheduler.now() + 60_000, guarantee: 'observed-non-atomic',
        actions: proposal.scenario ? SCENARIO_ACTIONS : ['start', 'observe-state-and-console', 'stop-owned-play'],
        raceDisclosure: 'Observed checks cannot atomically fence the native call.' });
      this.#prepared = { id: randomUUID(), display };
      if(proposal.scenario)this.#status.scenario={scenarioDigest:digest(proposal.scenario),subjectDigest:proposal.subjectDigest!,state:'not_started',inputRelease:'not_started',temporary:'not_started',steps:[],capture:null,consoleCoverage:'ambiguous'};
      return freeze({ proposalId: this.#prepared.id, display, displayDigest: digest(display) });
    } finally { this.#preparing = false; }
  }
  /** ONLY the authenticated human control integration receives this method. */
  async confirm(proposalId: string, authenticatedContext: unknown): Promise<string> {
    if (this.#closed || this.#run || this.#admission || this.#confirming || this.#preparing) fail('BUSY');
    const prepared = this.#prepared;
    if (!prepared || proposalId !== prepared.id) fail('INVALID_REQUEST');
    if (prepared.display.consentExpiresAt <= this.#scheduler.now()) fail('CONSENT_EXPIRED');
    this.#confirming = true;
    try {
      return await bounded(this.#scheduler, this.#timeout, new AbortController().signal, signal => recordHumanConsent(
        this.#options.ledger, this.#options.humanVerifier, authenticatedContext, prepared.display,
        this.#scheduler.now(), this.#options.adapter.evidence, signal));
    } finally { this.#confirming = false; }
  }
  async start(input: unknown): Promise<Readonly<TestReview>> {
    const request = parse(startSchema, input), prepared = this.#prepared;
    if (this.#closed || this.#run || this.#admission || this.#confirming || this.#preparing) fail('BUSY');
    if (!prepared || request.proposalId !== prepared.id) fail('INVALID_REQUEST');
    const runId = randomUUID(); this.#options.ledger.claimRun(runId);
    this.#admission = new Promise<void>(resolve => { this.#resolveAdmission = resolve; });
    const now = this.#scheduler.now(); this.#runId = runId; this.#scopeDigest = digest(prepared.display);
    this.#status.binding = prepared.display.proposal.binding; this.#status.scopeDigest = this.#scopeDigest;
    this.#status.runId = runId; this.#status.phase = 'admitting'; this.#status.startedAt = now;
    this.#status.deadline = now + prepared.display.proposal.durationMs;
    this.#status.cleanupDeadline = this.#status.deadline + this.#grace;
    try {
      await bounded(this.#scheduler, this.#timeout, new AbortController().signal,
        () => this.#options.ledger.consume(request.consentId, this.#scopeDigest, now, this.#options.adapter.evidence));
      await this.#event('admit', 'OK');
    } catch (error) {
      this.#options.ledger.releaseRun(runId); this.#status.phase = 'done'; this.#status.outcome = 'rejected'; this.#status.code = codeOf(error);
      this.#status.cleanup = 'complete'; this.#status.requiresHumanReview = this.#options.ledger.unresolved(); this.#publish();
      this.#finishAdmission(); throw error;
    }
    if (!this.#stopReason) {
      this.#status.watchdog.armed = true;
      this.#cancelWatchdog = this.#scheduler.schedule(Math.max(0, this.#status.deadline - this.#scheduler.now()), () => this.#requestStop('DURATION_EXPIRED'));
    }
    this.#run = this.#execute(prepared.display.proposal).catch(() => {
      // Unexpected failures never erase a fence or become a success.
      this.#status.phase = 'done'; this.#status.cleanup = 'unknown'; this.#status.requiresHumanReview = true;
      this.#status.outcome ??= 'failed'; this.#status.code = this.#status.code === 'OK' ? 'EFFECT_UNKNOWN' : this.#status.code;
      if(this.#status.scenario?.state==='running')this.#status.scenario.state='unknown';
      this.#status.canStartAnotherOperation = false; this.#cancelWatchdog?.(); this.#status.watchdog.armed = false; this.#publish();
    });
    this.#publish(); this.#finishAdmission(); return this.status();
  }
  async wait(input: unknown): Promise<Readonly<TestReview>> {
    const { runId } = parse(idSchema, input); if (!this.#run || runId !== this.#runId) fail('INVALID_REQUEST');
    await this.#run; return this.status();
  }
  async stop(input: unknown): Promise<Readonly<TestReview>> {
    const { runId } = parse(idSchema, input);
    if ((!this.#run && !this.#admission) || runId !== this.#runId) fail('INVALID_REQUEST');
    // Admission already owns this run ID. Fence synchronously while its durable
    // consume/admit is pending, then await that same admission and owned cleanup.
    // A rejected admission keeps its original rejection outcome/code.
    this.#requestStop('CANCELLED'); await this.#admission; await this.#run; return this.status();
  }
  /** Trusted connection/lifecycle hooks; exact current run is captured internally. */
  onDisconnect(): void { this.#requestStop('DISCONNECTED'); }
  async shutdown(): Promise<void> { this.#closed = true; this.#requestStop('SHUTDOWN'); await this.#admission; await this.#run; }
  #finishAdmission(): void { this.#resolveAdmission?.(); this.#resolveAdmission = null; this.#admission = null; }
  #requestStop(reason: TestCode): void {
    if (!this.#runId || this.#status.phase === 'done' || this.#status.phase === 'stopping' || this.#stopReason) return;
    this.#stopReason = reason; this.#status.watchdog = { armed: false, fired: true, reason };
    this.#cancelWatchdog?.(); this.#controller.abort(); this.#publish();
  }
  async #operation<T>(action: (signal: AbortSignal) => Promise<T>, cleanup = false): Promise<T> {
    return bounded(this.#scheduler, Math.min(this.#timeout, (cleanup ? this.#status.cleanupDeadline! : this.#status.deadline!) - this.#scheduler.now()),
      cleanup ? new AbortController().signal : this.#controller.signal, action);
  }
  async #event(kind: TestEvent['kind'], code: TestCode, extra: Partial<TestEvent> = {}): Promise<void> {
    if (this.#journalFailed) fail('JOURNAL_FAILED');
    try {
      // Bound disk waiting too. A late write can preserve a fence, never dispatch.
      await bounded(this.#scheduler, this.#timeout, new AbortController().signal, () => this.#options.ledger.append({
        kind, code, id: this.#runId!, at: this.#scheduler.now(), scopeDigest: this.#scopeDigest,
        evidence: this.#options.adapter.evidence, ...extra,
      }));
    } catch { this.#journalFailed = true; fail('JOURNAL_FAILED'); }
  }
  async #observe(proposal: TestProposal, baseline: boolean): Promise<void> {
    const observation = this.#checkObservation(await this.#operation(signal => this.#options.adapter.observe(proposal.binding, signal)), proposal);
    if (observation.mode !== (baseline ? 'Edit' : 'Play')) fail('MODE_MISMATCH');
    if (baseline) { for (const log of observation.logs) this.#baseline.add(log.digest); return; }
    const fresh = observation.logs.filter(log => !this.#baseline.has(log.digest) && !this.#seen.has(log.digest));
    for (const log of fresh) this.#seen.add(log.digest);
    if (this.#seen.size > 256) fail('BAD_NATIVE_RESPONSE');
    this.#status.logs = [...this.#status.logs, ...fresh].slice(-64); this.#status.observations++;
    this.#status.logsTruncated ||= observation.logsTruncated || fresh.length > 8 || this.#seen.size > 64;
    await this.#event('observe', 'OK', { logs: fresh.slice(0, 8), logsTruncated: this.#status.logsTruncated });
    this.#publish();
    if (proposal.failOnRuntimeError && fresh.some(log => log.level === 'error')) fail('RUNTIME_ERROR');
  }
  #checkObservation(value: unknown, proposal: TestProposal): TestObservation {
    const observation = parse(observationSchema, value, 'BAD_NATIVE_RESPONSE'), now = this.#scheduler.now();
    if (!sameBinding(observation.binding, proposal.binding)) fail('BINDING_CHANGED');
    if (observation.observedAt > now || now - observation.observedAt > this.#freshness || observation.expiresAt <= now) fail('STALE_PROOF');
    return observation;
  }
  async #execute(proposal: TestProposal): Promise<void> {
    let outcome: NonNullable<TestReview['outcome']> = 'succeeded', code: TestCode = 'OK';
    try {
      this.#status.phase = 'starting'; await this.#observe(proposal, true);
      if(proposal.scenario)await this.#operation(signal=>this.#options.temporary!.verifySubjects(signal));
      if(proposal.scenario?.temporaryEdits?.length){
        await this.#event('setup_intent','OK');this.#status.scenario!.temporary='running';this.#publish();
        await this.#operation(signal=>this.#options.temporary!.setup(signal));
        await this.#event('setup_result','OK');
      }
      await this.#event('start_intent', 'OK');
      if (this.#controller.signal.aborted) fail('CANCELLED');
      await this.#operation(signal => this.#options.adapter.start(proposal.binding, this.#runId!, this.#status.deadline!, signal));
      await this.#event('start_result', 'OK');
      if(proposal.scenario){
        const status=this.#status.scenario!;
        await this.#event('scenario_intent','OK');status.state='running';status.inputRelease='unknown';this.#status.phase='observing';this.#publish();
        const result=await this.#operation(signal=>this.#options.adapter.runScenario!(proposal.binding,this.#runId!,proposal.scenario!,this.#status.deadline!,signal));
        status.state=result.outcome;status.inputRelease=result.inputRelease;status.steps=result.steps;
        await this.#event('scenario_result',result.code,{scenario:structuredClone(status)});this.#publish();
        if(result.inputRelease!=='unknown'&&(result.outcome==='passed'||result.code==='ASSERTION_FAILED'))await this.#observe(proposal,false);
        if(proposal.scenario.capture.required&&result.inputRelease!=='unknown'&&(result.outcome==='passed'||result.code==='ASSERTION_FAILED')){
          await this.#event('capture_intent','OK');
          status.capture=await this.#operation(signal=>this.#options.adapter.captureScenario!(proposal.binding,this.#runId!,signal));
          await this.#event('capture_result','OK',{scenario:structuredClone(status)});this.#publish();
        }
        if(result.outcome!=='passed')fail(result.code==='OK'?'BAD_NATIVE_RESPONSE':result.code);
        // Native screen_capture currently supplies no datamodel provenance.
        // Keep its bytes for human review, never substitute focus for proof.
        if(proposal.scenario.capture.required)fail('UNSUPPORTED_TOOL');
      }
      const maximumObservations = Math.ceil(proposal.durationMs / proposal.observationIntervalMs);
      while (this.#scheduler.now() < this.#status.deadline!) {
        // Timer callbacks may fire just before their requested boundary. Never
        // let rounding/jitter add a native request beyond the admitted budget.
        if (this.#status.observations < maximumObservations) {
          this.#status.phase = 'observing'; await this.#observe(proposal, false);
        }
        this.#status.phase = 'waiting'; this.#publish();
        const remaining = this.#status.deadline! - this.#scheduler.now();
        await delay(this.#scheduler, this.#status.observations >= maximumObservations ? remaining : Math.min(proposal.observationIntervalMs, remaining), this.#controller.signal);
      }
    } catch (error) {
      code = codeOf(error);
      if (this.#stopReason === 'DURATION_EXPIRED' && this.#status.phase === 'waiting' && code === 'CANCELLED') { outcome = 'succeeded'; code = 'OK'; }
      else if (this.#stopReason === 'CANCELLED') { outcome = 'cancelled'; code = 'CANCELLED'; }
      else if (this.#stopReason) { outcome = this.#stopReason === 'DURATION_EXPIRED' ? 'timed_out' : 'failed'; code = this.#stopReason; }
      else outcome = code === 'TIMEOUT' ? 'timed_out' : 'failed';
    }
    this.#cancelWatchdog?.(); this.#cancelWatchdog = null; this.#status.watchdog.armed = false;
    if(this.#status.scenario?.state==='running')this.#status.scenario.state='unknown';
    // Outcome is fixed once; cleanup has its own status and cannot rewrite it.
    this.#status.outcome = outcome; this.#status.code = code; this.#status.phase = 'stopping'; this.#status.cleanup = 'running'; this.#publish();
    try {
      if (this.#stopReason) await this.#event('watchdog', this.#stopReason);
      await this.#event('terminal', code, { outcome });
    } catch { /* Disk failure still invokes consented bounded cleanup. */ }
    let clean = false;
    try {
      if (!await this.#operation(signal => this.#options.adapter.settle(signal), true)) fail('EFFECT_UNKNOWN');
      // Intent must be durable while storage is healthy. In a disk failure the
      // already durable admit/start intent and human scope permit only watchdog
      // compensation; retain the host fence even when physical cleanup succeeds.
      if (!this.#journalFailed) await this.#event('stop_intent', 'OK');
      await this.#operation(signal => this.#options.adapter.stop(proposal.binding, this.#runId!, this.#status.cleanupDeadline!, signal), true);
      clean = true;
      if (!this.#journalFailed) await this.#event('stop_result', 'OK');
      if(proposal.scenario){
        const status=this.#status.scenario!;
        if(status.temporary==='running'){
          if(!this.#journalFailed)await this.#event('restore_intent','OK');
          try {await this.#operation(signal=>this.#options.temporary!.restore(signal),true);status.temporary='restored';}
          catch {status.temporary='unknown';throw new Error('Temporary restoration is unknown.');}
          if(!this.#journalFailed)await this.#event('restore_result','OK',{scenario:structuredClone(status)});
        }
        await this.#operation(signal=>this.#options.temporary!.verifySubjects(signal),true);
        if(status.inputRelease==='unknown')clean=false;
        if(clean&&!this.#journalFailed)this.#options.temporary!.release();
      }
    } catch { clean = false; }
    this.#status.cleanup = clean && !this.#journalFailed ? 'complete' : 'unknown';
    try { await this.#event('cleanup', clean ? code : 'EFFECT_UNKNOWN', { cleanup: this.#status.cleanup }); }
    catch { this.#status.cleanup = 'unknown'; }
    this.#status.phase = 'done'; this.#status.requiresHumanReview = this.#status.cleanup !== 'complete' || this.#options.ledger.unresolved();
    this.#status.canStartAnotherOperation = !this.#status.requiresHumanReview;
    this.#options.ledger.releaseRun(this.#runId!); this.#publish();
  }
}
/** Split these ports when registering routes/tools. The agent-facing port has no
 * confirm, connection, client, proof, journal or lifecycle injection surface. */
export function createStudioTestControl(options: TestControllerOptions) {
  const controller = new BoundedStudioTestController(options);
  return Object.freeze({
    requests: Object.freeze({ prepare: controller.prepare.bind(controller), start: controller.start.bind(controller),
      status: controller.status.bind(controller), stop: controller.stop.bind(controller), wait: controller.wait.bind(controller) }),
    humanControl: Object.freeze({ confirm: controller.confirm.bind(controller) }),
    lifecycle: Object.freeze({ onDisconnect: controller.onDisconnect.bind(controller), shutdown: controller.shutdown.bind(controller) }),
  });
}
