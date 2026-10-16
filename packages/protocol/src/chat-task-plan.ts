/** Display-only task plan and review status contract (browser-compatible types and constants only).
 * It carries no identity hashes, native operation handles, credentials, prompts or generated text, and
 * grants no create/review/grant/dispatch capability. A plan or native parent completion is never
 * acceptance; only `review.state === 'accepted'` reflects a separate human review gate. */
export const TASK_PLAN_DISPLAY_LIMITS = Object.freeze({ steps: 16, reviewTasks: 64, responseBytes: 65536, keyChars: 64, reasonChars: 64 } as const);
export const TASK_PLAN_STATES = ['active', 'stopped', 'awaiting_review', 'unknown'] as const;
export const TASK_PLAN_STEP_KINDS = ['worker', 'incorporation', 'evidence'] as const;
export const TASK_PLAN_STEP_STATES = ['reserved', 'acknowledged', 'completed', 'failed', 'unknown'] as const;
export const TASK_PLAN_TERMINALS = ['completed', 'failed'] as const;
export const TASK_PLAN_REVIEW_STATES = ['pending_submission', 'awaiting_human_review', 'accepted', 'changes_requested', 'unavailable'] as const;
export const TASK_PLAN_REVIEW_TASK_STATES = ['pending', 'in_progress', 'needs_review', 'complete', 'failed', 'interrupted'] as const;
export type TaskPlanState = typeof TASK_PLAN_STATES[number];
export type TaskPlanStepKind = typeof TASK_PLAN_STEP_KINDS[number];
export type TaskPlanStepState = typeof TASK_PLAN_STEP_STATES[number];
export type TaskPlanTerminal = typeof TASK_PLAN_TERMINALS[number];
export type TaskPlanReviewState = typeof TASK_PLAN_REVIEW_STATES[number];
export type TaskPlanReviewTaskState = typeof TASK_PLAN_REVIEW_TASK_STATES[number];
export interface TaskPlanStepView {
  readonly seq: number; readonly kind: TaskPlanStepKind; readonly round: 1 | 2; readonly index: 0 | 1 | 2;
  readonly state: TaskPlanStepState; readonly terminal: TaskPlanTerminal | null; readonly reason: string | null;
}
export interface TaskPlanReviewView {
  readonly runId: string; readonly state: TaskPlanReviewState; readonly reason: string | null;
  readonly tasks: readonly { readonly key: string; readonly state: TaskPlanReviewTaskState }[];
}
export interface TaskPlanView {
  readonly taskId: string;
  readonly plan: null | {
    readonly planId: string; readonly state: TaskPlanState; readonly reason: string | null;
    readonly steps: readonly TaskPlanStepView[]; readonly review: TaskPlanReviewView | null;
  };
}
