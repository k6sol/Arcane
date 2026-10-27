import type { TestReview } from '../../studio-test-controller/src/controller.js';

/** Metadata is descriptive. Only the issuing host's exact object identity is a
 * capability; reconstructing this interface from JSON never authorizes a task. */
export interface StudioTestTaskOrigin {
  readonly kind: 'studio-test-task-origin';
  readonly taskId: string;
  readonly projectId: string;
  readonly provider: 'codex';
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly incarnationId: string;
}

export interface StudioTestTaskPrepared {
  readonly jobId: string;
  readonly displayDigest: string;
  readonly scenarioDigest: string | null;
  readonly subjectDigest: string | null;
}

/** Emitted only after the original input, Play epoch, temporary changes and
 * reservation have settled. Unknown evidence remains reportable, never resumable. */
export interface StudioTestTaskSettled extends StudioTestTaskPrepared {
  readonly reportDigest: string;
  readonly review: Readonly<TestReview>;
  readonly scenario: Readonly<{
    outcome: 'passed' | 'failed' | 'incomplete';
    requiredEvidence: 'complete' | 'missing';
    inputRelease: 'complete' | 'unknown';
    restoration: 'not_required' | 'complete' | 'unknown';
    subjects: 'current' | 'changed' | 'unobserved';
  }> | null;
}

/** Private host wiring, never a route/MCP input or caller-selected callback. */
export interface StudioTestTaskWork {
  readonly kind: 'studio-test-task-work';
  readonly signal: AbortSignal;
  /** Admission for new effects only; original cleanup remains usable after retirement. */
  assertActive(): void;
}

/** Original service lifetime and compensation, registered before allocation.
 * Promise completion is a join observation, never independent physical proof. */
export type StudioTestTaskWorkRegistration =
  | Readonly<{ kind: 'prepare'; completion: Promise<void>; cancel: () => Promise<void> }>
  | Readonly<{ kind: 'revalidate'; jobId: string; reportDigest: string;
      completion: Promise<void>; cancel: () => Promise<void> }>;

/** Private host wiring; exact issuing object identities never survive JSON. */
export interface StudioTestTaskPort {
  capture(actorId: string): StudioTestTaskOrigin | null;
  assert(origin: StudioTestTaskOrigin): void;
  registerWork(origin: StudioTestTaskOrigin, registration: StudioTestTaskWorkRegistration): StudioTestTaskWork;
  prepared(origin: StudioTestTaskOrigin, value: StudioTestTaskPrepared, work: StudioTestTaskWork): void;
  terminal(origin: StudioTestTaskOrigin, value: StudioTestTaskSettled, work: StudioTestTaskWork): Promise<void> | void;
}

export interface StudioTestTaskCancellation {
  cancelExact(jobId: string, origin: StudioTestTaskOrigin): Promise<void>;
  /** Read-only source check after the requesting native turn has settled. */
  revalidateExact(jobId: string, origin: StudioTestTaskOrigin, reportDigest: string): Promise<'current'|'changed'|'unobserved'>;
}
