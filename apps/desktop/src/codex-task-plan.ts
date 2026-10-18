import type { TaskPlanReviewState, TaskPlanReviewView, TaskPlanReviewTaskState, TaskPlanState, TaskPlanStepKind, TaskPlanStepState, TaskPlanStepView,
  TaskPlanTerminal, TaskPlanView } from '../../../packages/protocol/src/chat-task-plan.js';

/** Display-only automatic plan and review card. It shows untrusted suggestions, parent updates and a
 * separate human review gate; it never approves, reviews, dispatches, chats or grants. Type-only protocol
 * import: no extra browser runtime module. The runtime tuples below are compile-checked against it. */
const LIMITS = { steps: 16, reviewTasks: 64, responseBytes: 65536, keyChars: 64, reasonChars: 64 } as const;
const PLAN_STATES = ['active', 'stopped', 'awaiting_review', 'unknown'] as const satisfies readonly TaskPlanState[];
const KINDS = ['worker', 'incorporation', 'evidence'] as const satisfies readonly TaskPlanStepKind[];
const STEP_STATES = ['reserved', 'acknowledged', 'completed', 'failed', 'unknown'] as const satisfies readonly TaskPlanStepState[];
const TERMINALS = ['completed', 'failed'] as const satisfies readonly TaskPlanTerminal[];
const REVIEW_STATES = ['pending_submission', 'awaiting_human_review', 'accepted', 'changes_requested', 'unavailable'] as const satisfies readonly TaskPlanReviewState[];
const REVIEW_TASK_STATES = ['pending', 'in_progress', 'needs_review', 'complete', 'failed', 'interrupted'] as const satisfies readonly TaskPlanReviewTaskState[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[^\x00-\x1f\x7f]{1,256}$/;

export class TaskPlanViewError extends Error { constructor(message: string) { super(message); this.name = 'TaskPlanViewError'; } }
const refuse = (message: string): never => { throw new TaskPlanViewError(message); };
type Plain = Record<string, unknown>;
/** Fresh JSON.parse output only: exact own keys (a "__proto__" key is an own key and refuses). */
function exact(value: unknown, keys: readonly string[]): Plain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Expected an object.');
  const own = Object.keys(value as object);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) refuse('Unexpected or missing field.');
  return value as Plain;
}
const reason = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > LIMITS.reasonChars || !/^[a-z0-9_]+$/.test(value)) refuse('Invalid reason code.');
  return value as string;
};
const member = <T extends string>(list: readonly T[], value: unknown): T => { if (typeof value !== 'string' || !list.includes(value as T)) refuse('Invalid enumerated value.'); return value as T; };

/** Raw JSON TEXT boundary: a non-string is refused without any property, prototype or serialization access;
 * the UTF-8 size is bounded BEFORE JSON.parse; only the freshly parsed plain data is validated. */
export function readTaskPlanView(value: unknown, expectedTaskId: string): TaskPlanView {
  if (typeof value !== 'string') refuse('Expected raw response text.');
  if (typeof expectedTaskId !== 'string' || !UUID.test(expectedTaskId)) refuse('Invalid expected task.');
  if (new TextEncoder().encode(value as string).byteLength > LIMITS.responseBytes) refuse('Plan response exceeds its bound.');
  let parsed: unknown; try { parsed = JSON.parse(value as string); } catch { refuse('Plan response is not JSON.'); }
  const top = exact(parsed, ['taskId', 'plan']);
  if (top.taskId !== expectedTaskId) refuse('Plan response belongs to another task.');
  if (top.plan === null) return Object.freeze({ taskId: expectedTaskId, plan: null });
  const plan = exact(top.plan, ['planId', 'state', 'reason', 'steps', 'review']);
  if (typeof plan.planId !== 'string' || !UUID.test(plan.planId)) refuse('Invalid plan.');
  if (!Array.isArray(plan.steps) || plan.steps.length > LIMITS.steps) refuse('Invalid plan steps.');
  const seen = new Set<string>();
  const steps = (plan.steps as unknown[]).map((raw, i): TaskPlanStepView => {
    const s = exact(raw, ['seq', 'kind', 'round', 'index', 'state', 'terminal', 'reason']);
    const kind = member(KINDS, s.kind), state = member(STEP_STATES, s.state);
    if (s.seq !== i + 1 || (s.round !== 1 && s.round !== 2) || !Number.isInteger(s.index) || (s.index as number) < 0 || (s.index as number) > (kind === 'worker' ? 2 : 0)) refuse('Invalid step order.');
    const terminal = s.terminal === null ? null : member(TERMINALS, s.terminal);
    // A terminal exists only for a completed parent incorporation; an acknowledgement is never terminal.
    if ((kind === 'incorporation' && state === 'completed') !== (terminal !== null)) refuse('Invalid step terminal.');
    const key = kind + ':' + s.round + ':' + s.index; if (seen.has(key)) refuse('Duplicate plan step.'); seen.add(key);
    return Object.freeze({ seq: i + 1, kind, round: s.round as 1 | 2, index: s.index as 0 | 1 | 2, state, terminal, reason: reason(s.reason) });
  });
  let review: TaskPlanReviewView | null = null;
  if (plan.review !== null) {
    if (!steps.some(step => step.kind === 'evidence')) refuse('A review needs an evidence reference.');
    const r = exact(plan.review, ['runId', 'state', 'reason', 'tasks']);
    if (typeof r.runId !== 'string' || !UUID.test(r.runId) || !Array.isArray(r.tasks) || r.tasks.length > LIMITS.reviewTasks) refuse('Invalid review.');
    const tasks = (r.tasks as unknown[]).map(raw => { const t = exact(raw, ['key', 'state']);
      if (typeof t.key !== 'string' || !t.key.length || t.key.length > LIMITS.keyChars || !/^[a-zA-Z0-9_-]+$/.test(t.key)) refuse('Invalid review task.');
      return Object.freeze({ key: t.key as string, state: member(REVIEW_TASK_STATES, t.state) }); });
    review = Object.freeze({ runId: r.runId as string, state: member(REVIEW_STATES, r.state), reason: reason(r.reason), tasks: Object.freeze(tasks) });
  }
  const state = member(PLAN_STATES, plan.state);
  // Defensive acceptance guard: "accepted" is only displayable once the plan awaits review, its evidence reference
  // is acknowledged, every parent incorporation (including the last) completed successfully, and nothing is still
  // reserved, acknowledged-without-terminal or unknown. A mis-ordered response can never render acceptance early.
  if (review?.state === 'accepted') {
    const incorporations = steps.filter(step => step.kind === 'incorporation'), evidence = steps.find(step => step.kind === 'evidence');
    if (state !== 'awaiting_review' || evidence?.state !== 'acknowledged' || !incorporations.length ||
      incorporations.some(step => step.state !== 'completed' || step.terminal !== 'completed') ||
      steps.some(step => step.state === 'reserved' || step.state === 'unknown' || step.state === 'acknowledged' && step.kind !== 'evidence'))
      refuse('Acceptance is not consistent with the plan steps.');
  }
  return Object.freeze({ taskId: expectedTaskId, plan: Object.freeze({ planId: plan.planId as string, state, reason: reason(plan.reason),
    steps: Object.freeze(steps), review }) });
}

export interface TaskPlanSelection { readonly connectionId: string; readonly threadId: string; readonly taskId: string }
/** Trusted host composition state: data descriptors are snapshotted so getters never run. A browser cannot
 * reliably detect proxies; the selection is host-owned, so this is an honest host-trust boundary. */
function snapshotSelection(value: unknown): TaskPlanSelection | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) refuse('Invalid plan selection.');
  const keys = Reflect.ownKeys(value as object), out: Record<string, string> = Object.create(null);
  if (keys.length !== 3) refuse('Invalid plan selection.');
  for (const key of ['connectionId', 'threadId', 'taskId']) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string') refuse('Invalid plan selection.');
    out[key] = field!.value as string;
  }
  if (!UUID.test(out.connectionId!) || !ID.test(out.threadId!) || !UUID.test(out.taskId!)) refuse('Invalid plan selection.');
  return Object.freeze({ connectionId: out.connectionId!, threadId: out.threadId!, taskId: out.taskId! });
}

const PLAN_LABEL: Record<TaskPlanState, string> = { active: 'In progress', stopped: 'Stopped', awaiting_review: 'Waiting for review', unknown: 'Outcome unknown' };
const REVIEW_LABEL: Record<TaskPlanReviewState, string> = { pending_submission: 'Evidence not submitted yet', awaiting_human_review: 'Waiting for your review',
  accepted: 'Accepted after your review', changes_requested: 'Changes requested', unavailable: 'Review unavailable' };
const REASON_LABEL: Record<string, string> = {
  task_cancelled: 'The task was stopped.', task_uncertain: 'The task outcome is uncertain.', fenced: 'Arcane is shutting down.', parent_retired: 'The task was replaced or stopped.',
  repair_reserved: 'A repair took over.', binding_changed: 'The conversation or model changed.', budget_exhausted: 'The plan reached its limit.',
  no_usable_proposals: 'No usable suggestions.', daemon_restarted: 'Arcane restarted.', step_unknown: 'A step outcome is unknown.',
  dispatch_uncertain: 'The request may not have finished.', terminal_unobserved: 'The result was not observed.', daemon_restarted_no_replay: 'Arcane restarted; not retried.',
  not_dispatched: 'Not sent.', not_requested: 'Not requested.', request_uncertain: 'The request may not have finished.', worker_failed: 'No suggestion.', worker_unknown: 'Outcome unknown.',
  evidence_changed: 'Evidence changed after review.', evidence_missing: 'Evidence is missing.', binding_missing: 'Review record not found.', binding_mismatch: 'Review record changed.',
  no_tasks: 'No review tasks.', task_failed: 'A review task failed.', store_unavailable: 'Review records are unavailable.',
};
function stepLabel(step: TaskPlanStepView): string {
  const title = step.kind === 'worker' ? 'Suggestion ' + (step.index + 1) : step.kind === 'incorporation' ? 'Main task update' : 'Review requested';
  const state = step.kind === 'incorporation'
    ? step.state === 'acknowledged' ? 'sent, waiting for result' : step.state === 'completed' ? (step.terminal === 'failed' ? 'main task reported a problem' : 'update finished')
      : step.state === 'reserved' ? 'preparing' : step.state === 'failed' ? 'not sent' : 'outcome unknown'
    : step.kind === 'evidence'
      ? step.state === 'acknowledged' ? 'review record created' : step.state === 'reserved' ? 'requesting' : step.state === 'failed' ? 'not requested' : 'outcome unknown'
      : step.state === 'completed' ? 'suggestion received' : step.state === 'reserved' ? 'working' : step.state === 'failed' ? 'no suggestion' : 'outcome unknown';
  return title + ' · ' + state;
}

export interface TaskPlanCardOptions { read(selection: TaskPlanSelection): Promise<string>; navigateReview(runId: string): void; safe?(text: string): string }
/** Controller: host supplies the selection and a raw-text read callback. One in-flight read per
 * selection generation; any change clears content immediately and ignores held responses. */
export class TaskPlanCard {
  #selection: TaskPlanSelection | null = null; #generation = 0; #inFlight: Promise<void> | null = null; #disposed = false;
  #view: TaskPlanView | null = null; #status: 'idle' | 'loading' | 'ready' | 'error' = 'idle'; #navigated: string | null = null;
  readonly #read: (selection: TaskPlanSelection) => Promise<string>; readonly #navigate: (runId: string) => void; readonly #safe: (text: string) => string;
  private constructor(private readonly doc: Document, private readonly host: HTMLElement, options: TaskPlanCardOptions) {
    const read = Object.getOwnPropertyDescriptor(options, 'read'), navigate = Object.getOwnPropertyDescriptor(options, 'navigateReview'), safe = Object.getOwnPropertyDescriptor(options, 'safe');
    if (!read || !Object.hasOwn(read, 'value') || typeof read.value !== 'function' || !navigate || !Object.hasOwn(navigate, 'value') || typeof navigate.value !== 'function' ||
      safe && (!Object.hasOwn(safe, 'value') || typeof safe.value !== 'function')) refuse('Invalid task plan card options.');
    this.#read = read!.value; this.#navigate = navigate!.value; this.#safe = safe?.value ?? ((text: string) => text);
  }
  static mount(doc: Document, host: HTMLElement, options: TaskPlanCardOptions): TaskPlanCard { const card = new TaskPlanCard(doc, host, options); card.#render(); return card; }
  setSelection(value: unknown): void {
    if (this.#disposed) return;
    const next = snapshotSelection(value), same = JSON.stringify(next) === JSON.stringify(this.#selection);
    if (same) return;
    this.#generation++; this.#selection = next; this.#view = null; this.#inFlight = null; this.#navigated = null;
    this.#status = next ? 'loading' : 'idle'; this.#render(); // stale content clears immediately
  }
  refresh(): Promise<void> {
    if (this.#disposed || !this.#selection) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight; // coalesce one held read per generation
    const generation = this.#generation, selection = this.#selection;
    if (!this.#view) { this.#status = 'loading'; this.#render(); }
    const run = (async () => {
      let text: unknown;
      try { text = await this.#read(selection); } catch { text = undefined; }
      if (this.#disposed || generation !== this.#generation) return; // a held/old response never reveals another conversation
      try { const next = readTaskPlanView(text, selection.taskId);
        if(this.#status==='ready'&&JSON.stringify(next)===JSON.stringify(this.#view))return; // retain keyboard focus during unchanged polling
        this.#view = next; this.#status = 'ready'; }
      catch { this.#view = null; this.#status = 'error'; }
      this.#render();
    })().finally(() => { if (generation === this.#generation) this.#inFlight = null; });
    this.#inFlight = run; return run;
  }
  dispose(): void { this.#disposed = true; this.#generation++; this.#inFlight = null; this.#view = null; this.host.replaceChildren(); this.host.hidden = true; }
  #el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = this.#safe(text); return element;
  }
  #render(): void {
    if (this.#disposed) return;
    const host = this.host; host.replaceChildren();
    if (!this.#selection || this.#status === 'ready' && this.#view?.plan === null) { host.hidden = true; host.setAttribute('aria-busy','false'); return; }
    host.hidden = false; host.setAttribute('aria-busy', String(this.#status === 'loading'));
    const header = this.#el('div', 'task-plan-header'), title = this.#el('h3', 'task-plan-title', 'Automatic plan'); title.id = 'codex-task-plan-title';
    const status = this.#el('p', 'task-plan-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    header.append(title, status); host.append(header);
    const plan = this.#view?.plan;
    if (this.#status === 'loading' && !this.#view) { status.textContent = this.#safe('Checking plan status…'); return; }
    if (this.#status === 'error') { status.textContent = this.#safe('Plan status unavailable.'); return; }
    if (!plan) { status.textContent = this.#safe('No automatic plan for this task.'); return; }
    status.textContent = this.#safe(PLAN_LABEL[plan.state] + (plan.reason && REASON_LABEL[plan.reason] ? ' · ' + REASON_LABEL[plan.reason] : ''));
    host.append(this.#el('p', 'task-plan-note', 'Suggestions are untrusted and only inform the main task. Nothing is accepted without your review.'));
    for (const round of [1, 2] as const) {
      const steps = plan.steps.filter(step => step.round === round && step.kind !== 'evidence'); if (!steps.length) continue;
      const group = this.#el('section', 'task-plan-phase'); group.append(this.#el('h4', 'task-plan-phase-title', 'Round ' + round));
      const list = this.#el('ol', 'task-plan-steps');
      for (const step of steps) { const item = this.#el('li', 'task-plan-step', stepLabel(step)); item.dataset.state = step.state; if (step.reason && REASON_LABEL[step.reason]) item.title = REASON_LABEL[step.reason]!; list.append(item); }
      group.append(list); host.append(group);
    }
    const evidence = plan.steps.find(step => step.kind === 'evidence');
    if (evidence || plan.review) {
      const group = this.#el('section', 'task-plan-phase task-plan-review'); group.append(this.#el('h4', 'task-plan-phase-title', 'Review'));
      if (evidence) group.append(this.#el('p', 'task-plan-step', stepLabel(evidence)));
      const review = plan.review;
      if (review) {
        const line = this.#el('p', 'task-plan-review-state', REVIEW_LABEL[review.state] + (review.reason && REASON_LABEL[review.reason] ? ' · ' + REASON_LABEL[review.reason] : ''));
        line.dataset.state = review.state; group.append(line);
        if (review.tasks.length) {
          const done = review.tasks.filter(task => task.state === 'complete').length;
          group.append(this.#el('p', 'task-plan-review-tasks', done + ' of ' + review.tasks.length + ' review items complete'));
        }
        // Read-only navigation to the exact current run: evidence attachment or human review happens there, never here.
        if (review.state === 'awaiting_human_review' || review.state === 'changes_requested' || review.state === 'pending_submission') {
          const button = this.#el('button', 'secondary task-plan-review-button', review.state === 'pending_submission' ? 'Open evidence' : 'Open review'); button.type = 'button'; button.disabled = this.#navigated === review.runId;
          const runId = review.runId, generation = this.#generation;
          button.addEventListener('click', event => {
            const input = event as MouseEvent;
            if (event.isTrusted !== true || event.defaultPrevented || input.button !== 0 || input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) return;
            if (this.#disposed || this.#navigated === runId || generation !== this.#generation || this.#view?.plan?.review?.runId !== runId) return;
            this.#navigated = runId; button.disabled = true; // at most one navigation per exact review run
            this.#navigate(runId);
          });
          group.append(button);
        }
      }
      host.append(group);
    }
  }
}
