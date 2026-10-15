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
export interface StudioTestTaskPort {
  capture(actorId: string): StudioTestTaskOrigin | null;
  assert(origin: StudioTestTaskOrigin): void;
  prepared(origin: StudioTestTaskOrigin, value: StudioTestTaskPrepared): void;
  terminal(origin: StudioTestTaskOrigin, value: StudioTestTaskSettled): Promise<void> | void;
}

export interface StudioTestTaskCancellation {
  cancelExact(jobId: string, origin: StudioTestTaskOrigin): Promise<void>;
  /** Read-only source check after the requesting native turn has settled. */
  revalidateExact(jobId: string, origin: StudioTestTaskOrigin, reportDigest: string): Promise<'current'|'changed'|'unobserved'>;
}
