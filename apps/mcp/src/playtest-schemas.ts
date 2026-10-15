import { z } from 'zod';
import { bindingSchema, codes, digest, logSummarySchema, proposalSchema }
  from '../../../packages/studio-test-controller/src/contracts.js';
import { scenarioPlanSchema, scenarioReviewSchema, scenarioEvidenceIssue, SCENARIO_ACTIONS } from '../../../packages/studio-test-controller/src/scenario.js';

export interface PlaytestRequest {
  sessionId: string; nativeStudioId?: string | undefined; durationMs?: number;
  observationIntervalMs?: number; failOnRuntimeError?: boolean;
  scenario?: z.input<typeof scenarioPlanSchema> | undefined;
}

const timestamp = z.number().int().nonnegative().safe();
const timeout = z.number().int().min(1).max(15_000);
const evidence = z.enum(['fixture', 'native']);
// JavaScript's $ also accepts a final line terminator. Wire identities/hashes
// must consume the whole string, including inside reused controller shapes.
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const binding = bindingSchema.extend({
  nativeStudioId: identifier, pairedSessionId: identifier, clientLifetimeId: identifier,
  pluginArtifactHash: fingerprint, scopeRevision: fingerprint,
});
const logSummary = logSummarySchema.extend({ idDigest: fingerprint, digest: fingerprint });
export const playtestRequestInput = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(),
  durationMs: z.number().int().min(5_000).max(60_000).default(15_000),
  observationIntervalMs: z.number().int().min(250).max(2_000).default(1_000),
  failOnRuntimeError: z.boolean().default(true),
  scenario: scenarioPlanSchema.optional(),
});
const proposal = proposalSchema.extend({
  binding,
  durationMs: z.number().int().min(5_000).max(60_000),
  observationIntervalMs: z.number().int().min(250).max(2_000),
}).refine(value => value.observationIntervalMs <= value.durationMs &&
  Math.ceil(value.durationMs / value.observationIntervalMs) <= 128, 'Unbounded playtest observations.');
const display = z.strictObject({
  proposal, cleanupGraceMs: timeout, requestTimeoutMs: timeout, proofMaxAgeMs: timeout,
  consentExpiresAt: timestamp, guarantee: z.literal('observed-non-atomic'),
  actions: z.union([z.tuple([z.literal('start'), z.literal('observe-state-and-console'), z.literal('stop-owned-play')]),z.tuple(SCENARIO_ACTIONS.map(action=>z.literal(action)) as [z.ZodLiteral<'start'>,z.ZodLiteral<'execute-approved-scenario'>,z.ZodLiteral<'observe-state-and-console'>,z.ZodLiteral<'capture-viewport'>,z.ZodLiteral<'stop-owned-play'>,z.ZodLiteral<'restore-temporary-changes'>])]),
  raceDisclosure: z.literal('Observed checks cannot atomically fence the native call.'),
});

const review = z.strictObject({
  runId: identifier.nullable(), evidence, nativeAcceptance: z.literal(false),
  binding: binding.nullable(), scopeDigest: fingerprint.nullable(),
  phase: z.enum(['idle', 'admitting', 'starting', 'observing', 'waiting', 'stopping', 'done']),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'rejected']).nullable(),
  code: z.enum(codes), cleanup: z.enum(['not_started', 'running', 'complete', 'unknown']),
  startedAt: timestamp.nullable(), deadline: timestamp.nullable(), cleanupDeadline: timestamp.nullable(),
  watchdog: z.strictObject({ armed: z.boolean(), fired: z.boolean(), reason: z.enum(codes).nullable() }),
  observations: z.number().int().min(0).max(128), logs: z.array(logSummary).max(64),
  logsTruncated: z.boolean(), requiresHumanReview: z.boolean(), canStartAnotherOperation: z.boolean(),
  scenario: scenarioReviewSchema.optional(),
}).superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: 'custom', message });
  const runFields = [value.runId, value.binding, value.scopeDigest, value.startedAt, value.deadline, value.cleanupDeadline];
  if (value.phase === 'idle' ? runFields.some(field => field !== null) : runFields.some(field => field === null)) {
    reject('Incomplete playtest run identity.');
  }
  if (value.phase === 'idle' && (value.outcome !== null || value.code !== 'OK' || value.cleanup !== 'not_started' ||
      value.observations !== 0 || value.logs.length !== 0 || value.logsTruncated || value.watchdog.armed || value.watchdog.fired ||
      value.canStartAnotherOperation)) reject('Invalid pending review.');
  if (['admitting', 'starting', 'observing', 'waiting'].includes(value.phase) &&
      (value.outcome !== null || value.code !== 'OK' || value.cleanup !== 'not_started')) reject('Invalid active review.');
  if (value.phase === 'stopping' && (value.outcome === null || value.cleanup === 'not_started')) reject('Invalid cleanup review.');
  if (value.phase === 'done' && (value.outcome === null || !['complete', 'unknown'].includes(value.cleanup) || value.watchdog.armed)) {
    reject('Invalid terminal review.');
  }
  if (value.outcome === 'succeeded' && value.code !== 'OK' || value.outcome === 'cancelled' && value.code !== 'CANCELLED' ||
      value.outcome === 'timed_out' && !['TIMEOUT', 'DURATION_EXPIRED'].includes(value.code)) reject('Contradictory playtest outcome.');
  if (value.watchdog.fired !== (value.watchdog.reason !== null) || value.watchdog.armed && value.watchdog.fired) reject('Invalid watchdog review.');
  if (value.canStartAnotherOperation && (value.phase !== 'done' || value.cleanup !== 'complete' || value.requiresHumanReview)) {
    reject('Unverified cleanup cannot permit another operation.');
  }
  if (value.phase === 'done' && value.cleanup === 'unknown' && (!value.requiresHumanReview || value.canStartAnotherOperation)) {
    reject('Unknown terminal cleanup must remain fenced.');
  }
});

/** Decode reports, never infer human consent or native acceptance from them. Job
 * state and controller phase are separate snapshots during approval/cleanup. */
export const playtestJob = z.strictObject({
  id: identifier, targetName: z.string().min(1).max(200), actor: identifier,
  state: z.enum(['needs_approval', 'running', 'complete', 'cancelled']),
  display, displayDigest: fingerprint, review, evidence, nativeAcceptance: z.literal(false),
}).superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: 'custom', message });
  if (digest(value.display) !== value.displayDigest) reject('Wrong playtest display digest.');
  if (value.evidence !== value.review.evidence) reject('Inconsistent playtest evidence.');
  const plan=value.display.proposal.scenario,scenario=value.review.scenario;
  if(!!plan!==!!scenario||!!plan!==!!value.display.proposal.subjectDigest)reject('Incomplete scenario evidence.');
  if(plan&&scenario){
    if(scenario.scenarioDigest!==digest(plan)||scenario.subjectDigest!==value.display.proposal.subjectDigest||digest(value.display.actions)!==digest(SCENARIO_ACTIONS))reject('Wrong scenario scope.');
    const stepIssue=scenarioEvidenceIssue(plan,scenario.steps,scenario.state==='passed',scenario.inputRelease);
    if(stepIssue)reject(stepIssue);
    if(value.review.cleanup==='complete'&&scenario.inputRelease==='unknown')reject('Input release is unverified.');
    if(value.review.phase==='done'&&value.review.cleanup==='complete'&&plan.temporaryEdits?.length&&scenario.temporary!=='restored'&&scenario.temporary!=='not_started')reject('Temporary restoration is unverified.');
    if(value.review.outcome==='succeeded'&&(scenario.state!=='passed'||scenario.steps.length!==plan.steps.length||scenario.steps.some(step=>step.outcome!=='passed')||plan.capture.required))reject('Required gameplay evidence is incomplete.');
  }else if(value.display.actions.length!==3)reject('Unexpected scenario authority.');
  if (value.review.binding !== null && digest(value.review.binding) !== digest(value.display.proposal.binding)) reject('Wrong playtest run binding.');
  if (value.review.scopeDigest !== null && value.review.scopeDigest !== value.displayDigest) reject('Wrong playtest run scope.');
  if (value.display.proposal.failOnRuntimeError && value.review.outcome === 'succeeded' &&
      value.review.logs.some(log => log.level === 'error')) reject('Runtime error contradicts the admitted success policy.');
  if (value.review.startedAt !== null && value.review.deadline !== null && (value.review.deadline !== value.review.startedAt + value.display.proposal.durationMs ||
      value.review.cleanupDeadline !== value.review.deadline + value.display.cleanupGraceMs)) reject('Wrong playtest deadlines.');
  if (value.review.observations > Math.ceil(value.display.proposal.durationMs / value.display.proposal.observationIntervalMs)) reject('Playtest observation budget exceeded.');
});

export function playtestPreparedResponse(input: PlaytestRequest) {
  // Capture primitives before submission; caller mutation while awaiting an ACK
  // must not change which submitted scope/settings the response must describe.
  const { sessionId, nativeStudioId, durationMs = 15_000, observationIntervalMs = 1_000, failOnRuntimeError = true } = input;
  const scenario=input.scenario===undefined?undefined:scenarioPlanSchema.parse(input.scenario);
  return z.strictObject({ job: playtestJob }).refine(({ job }) => {
    const proposal = job.display.proposal;
    return job.state === 'needs_approval' && job.review.phase === 'idle' &&
      proposal.binding.pairedSessionId === sessionId &&
      (nativeStudioId === undefined || proposal.binding.nativeStudioId === nativeStudioId) &&
      proposal.durationMs === durationMs && proposal.observationIntervalMs === observationIntervalMs &&
      proposal.failOnRuntimeError === failOnRuntimeError && digest(proposal.scenario??null)===digest(scenario??null);
  }, 'Wrong prepared playtest scope.');
}

export function playtestJobResponse(jobId: string) {
  return z.strictObject({ job: playtestJob }).refine(value => value.job.id === jobId, 'Wrong playtest job.');
}

export const playtestListResponse = z.strictObject({ jobs: z.array(playtestJob).max(64) })
  .refine(value => new Set(value.jobs.map(job => job.id)).size === value.jobs.length, 'Duplicate playtest jobs.');
