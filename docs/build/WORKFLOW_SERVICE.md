# Workflow coordinator foundation

The callable service is **apps/daemon/src/workflow-service.ts**. It constructs existing
WorkflowRecipe values, projects them into the existing WorkStore, and persists their
mapping, decisions, submissions, attempts and command journal in **workflow.sqlite**.
Production methods use actual SQLite records and hash-check actual project files.
Offline catalogues, receipts and verifier reports exist only in the unit fixtures.

## Host integration

Construct one coordinator for a fixed project and journal directory. Prefer borrowing
the daemon's existing WorkStore:

~~~ts
import { WorkflowService } from './workflow-service.js';

const workflow = new WorkflowService({
  directory: projectStateDirectory,
  projectPath,
  workStore: { store: existingWorkStore, projectPath },
  authorizeHuman: command => durableHumanReceipts.verify(command) === true,
  policyContext: () => ({
    connections: currentConnections(),
    studioSessions: currentStudioSessions(),
    capabilities: currentHumanHandoffCapabilities(),
  }),
  verifiers: [
    { action: 'verify-code', verify: deterministicCodeVerifier },
  ],
});
~~~

The example's receipt store, observations and verifier are real host dependencies to
implement or supply; the service supplies no placeholder success executor.
The host attests that a borrowed WorkStore actually uses the declared project root.
The existing WorkStore has no public project-identity accessor, so this attestation
cannot be independently inspected. Mismatched declared roots are rejected.
Borrowed stores are neither reopened nor closed, preserving other workers' ownership.
Without **workStore**, the service creates and owns a WorkStore in **directory**.

**authorizeHuman** is a synchronous, host-only authority seam. It must verify durable
receipts issued after a human reviewed the exact prepared command, including project,
workflow instance, action, decision and binding. A receipt hash alone is not proof.
Never implement this callback with a browser boolean, agent role, caller-provided
callback, or a request-scoped permissive flag. Missing callbacks, thrown errors,
promises and truthy non-boolean results deny authorization. Commands are deeply frozen.

Assessment calls this same callback for persisted recipe decisions, using the persisted
receipt hash and recomputed exact current binding. It requires **no ephemeral live
request proof**. Durable signed receipts or a host-owned receipt registry therefore
work after restart. Revoked or unavailable receipts block affected steps and dependents.
The host owns authenticating human HTTP requests, receipt issuance, revocation and safe
presentation of proof; those routes are left to the integration owner.

A recipe-gate authority command contains:

- **binding**: the coordinator's project/instance-bound review envelope.
- **recipeGate**: the exact core HumanDecisionCommand, including the **recipe ID**
  as its workflowId, workflowGateBinding(...) as its binding, and receipt hash.
- **subjectHashes** and **inputArtifacts**: current hash-pinned subjects supplied
  to recipe assessment, including step, role, path and byte count.
- The exact recipe and requested approved/rejected decision.

The durable workflow's **id** is a separate instance UUID. Do not confuse it with
**workflow.recipe.id**, the deterministic core recipe ID.

## Callable methods and public input

All mutation objects reject unexpected and missing fields. IDs/idempotency keys use
1..64 ASCII letters, digits, underscores or hyphens; receipts and gate bindings use
lowercase SHA-256 strings. Decision is **approved** or **rejected**, never a boolean.

| Method | Input |
| --- | --- |
| create | { request: WorkflowRecipeRequest, idempotencyKey, receiptHash } |
| recordDecision | { workflowId, idempotencyKey, decision: { stepKey, gate, decision, binding, receiptHash } } |
| submitHandoff | { workflowId, idempotencyKey, receiptHash, submission: WorkflowSubmission } |
| verify | { workflowId, stepKey, idempotencyKey }, asynchronous |
| review | { workflowId, stepKey, idempotencyKey, decision, receiptHash } |
| reconcile | { workflowId, idempotencyKey, receiptHash, resolution, observedRun? } |

Resolution is **halt** or **accept-observed**. ObservedRun, used only to reconcile
uncertain creation, is { runId, taskIds: Record<stepKey, taskId> }.

Preparation methods return a deeply frozen WorkflowHumanRequest, including its exact
human authority binding. Preparing never claims a task or authorizes execution:

~~~ts
const creation = workflow.prepareCreation(recipeRequest);
// Present creation.recipe and creation.binding to the human.
// Host issues a durable receipt after explicit approval.
const created = workflow.create({
  request: recipeRequest,
  idempotencyKey: creationRequestId,
  receiptHash: creationReceiptHash,
});

const instanceId = created.workflow.id;
const gate = workflow.prepareGate(instanceId, stepKey, gateName, 'approved');
// Host reviews the exact pinned inputs and issues a receipt for gate.binding.
workflow.recordDecision({
  workflowId: instanceId,
  idempotencyKey: gateRequestId,
  decision: {
    stepKey,
    gate: gateName,
    decision: 'approved',
    binding: gate.recipeGate!.binding,
    receiptHash: gateReceiptHash,
  },
});
~~~

The other preparation signatures are:

~~~ts
workflow.prepareSubmission(instanceId, submission);
workflow.prepareReview(instanceId, stepKey, 'approved'); // or 'rejected'
workflow.prepareReconciliation(instanceId, 'halt');
workflow.prepareReconciliation(instanceId, 'accept-observed', observedRun);
~~~

Submission and review receipts bind the exact output manifest as well as current inputs.
Gate receipts use the core prospective subject binding and do not silently authorize
evidence acceptance. Review requires a separate receipt.

Mutation results are { workflow, tasks, assessment, result }. Result is one of
**created**, **decided**, **submitted**, **busy**, **unsupported**, **reviewed**, or
**reconciled**. Get(instanceId) returns { workflow, tasks, assessment }; list() returns
{ id, recipeId, state }[]. Assessment is null during an operation and for uncertain
or halted workflows. Changed pins or out-of-band WorkStore changes produce an explicit
error instead of a misleading complete assessment. Returned snapshots are detached data.

Each idempotency key is journal-global, bound to action, target, payload and receipt.
An exact completed duplicate returns current state and its durable result without
executing again. Reusing a key for different input fails. A human receipt authorizes
at most one durable command, preventing reuse under fresh keys. Replaying uncertain
or still-running commands always fails, even after later reconciliation.

## Execution and acceptance

SubmitHandoff records evidence from an explicitly authorized external human/native
handoff. It does not launch that handoff. Existing recipe provider, capability,
dependency and human gates must pass before claiming/submitting the mapped WorkStore task.
There is no provider runner, inference/auth call, Studio client, renderer, arbitrary
command field, autoapproval, publication or upload.

Only **verify** executes a host callback. Registrations are fixed at construction and
restricted to **verify-code**, **verify-asset** and **verify-playtest**, each mapped to
its exact safe capability. Catalogue/browser capability claims cannot manufacture an
executor. Unsupported registrations are absent, leaving those recipe steps pending.

The deeply frozen verifier request contains projectId, canonical projectPath, instance
workflowId, recipeId, exact step, subjectDigest, and inputArtifacts. The host function
must deterministically inspect pinned bytes, preserve source artifacts, obey bounded
quality checks, and return:

~~~ts
{ status: 'evidence', submission: actualHashPinnedReportManifest }
// or
{ status: 'evidence-read-busy' }
// or
{ status: 'unsupported' }
~~~

The host materializes report output as a bounded project-local evidence file before
returning it. It must constrain report writes and never derive executable commands from
recipe instructions or artifact contents. The coordinator checks real hashes/sizes and
revalidates inputs and WorkStore state after awaiting the callback. This is a trusted
verifier contract, not an OS sandbox around arbitrary injected code.

Valid verifier evidence goes to **needs_review**, including reports with failed checks.
Passing checks alone cannot complete a task. A host-authenticated review receipt is
required; failed/missing/stale checks block acceptance. Completed recipe steps are
immutable; changed work requires a new explicitly reviewed workflow.

Busy evidence reads may retry through a fresh request only when canRetryWorkflowStep
permits it: unchanged subject digest, safe action and recipe attempt budget. The first
invocation counts. Default budget is two, maximum three, with 48 total attempts.
There is no retry loop. Unsupported results, failed reports and uncertain outcomes never
trigger automatic repair or replay.

## Persistence, bounds and lifecycle

The journal uses SQLite WAL with FULL synchronous durability, a schema version,
revision-checked writes and one live host writer per journal. Its canonical project
identity is pinned in metadata; opening the same directory for another project fails.
A live owner blocks a second coordinator; a dead owner can be recovered. PID reuse
fails conservatively and may require host intervention. Storage directories/databases
must not be linked.

Hard limits are 64 workflow records, 256 commands per record, 1 MiB per record and
16 MiB total workflow payload. Commands have a 1 KiB bound. Existing recipe bounds
still apply: 24 steps, 20 artifacts per submission and three attempts per safe step.
Each submission's aggregate artifact bytes are limited to 16 MiB.
No automatic pruning occurs; reaching capacity fails explicitly.

Evidence is project-relative, regular, nonempty and hash/size pinned. Credential/config
paths, traversal, symlinks/junctions and hard links are rejected. Reads are bounded even
if a file grows concurrently. Pins are rechecked at submission, assessment, verification
and review. WorkStore task IDs, run IDs, projected fields, states and evidence must match
the journal. Direct mutation of coordinator tasks through WorkStore is detected; callers
must route these tasks through this service.

Every mutation is journaled before invoking WorkStore or the verifier. The two databases
cannot commit atomically. A thrown/unknown result or restarted in-flight operation remains
durable **uncertain**, preserves intended output when known, blocks advancement, and
never executes again.

Human reconciliation can accept only an observed exact outcome:

- Creation: attach the exact untouched projected run using observedRun.
- Submission: accept the already observed needs_review task with matching pinned
  evidence; do not call the verifier or resubmit.
- Review: accept the already observed approved/rejected WorkStore state and identical evidence.

If no exact observed outcome exists, explicitly halt the workflow and create a newly
reviewed workflow. Reconciliation does not clear an ambiguous lease, reset attempts,
infer completion or rerun an action. WorkStore leases remain cooperative rather than
process isolation. A partially completed claim can require expiry or host inspection.

**close()** is idempotent and closes only owned resources. While verify() is active it
throws WORKFLOW_BUSY; the host must await the verifier before closing.
Reopening the journal marks unfinished commands/attempts uncertain. Borrowing WorkStore
preserves existing workers; owning/reopening it retains its existing restart behavior.

## Validation and integration boundary

Focused tests compile into unique temporary output, leaving shared dist, product build
and packaging outputs alone. They exercise actual project evidence and SQLite records,
offline verifiers, receipt validation, durable replay, failed checks, attempt bounds,
asynchronous input changes, cross-database response loss, reconciliation, ownership
and path/link checks.

Human HTTP routing, desktop UI, durable receipt issuance and production verifier
implementations are integration work for the main owner. Studio native tests remain
deferred. No live model, provider auth, paid API, or Studio execution is performed.

The separately owned Codex history service can use the official
[Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
This coordinator has no app-server transport dependency.

