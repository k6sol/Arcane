# Workflow HTTP host integration

The integration consists of **apps/daemon/src/workflow-host.ts** and
**apps/daemon/src/workflow-routes.ts**. It wraps the existing WorkflowService and
WorkflowStore. It does not listen on a socket, launch a model, run a verifier,
invoke a CLI, edit Studio, authorize a Studio API key, upload, or call a paid API.
Native execution and Studio integration remain deferred.

## Exact factory and wiring

~~~ts
import { createWorkflowHost } from './workflow-host.js';
import { workflowRoutes } from './workflow-routes.js';

const workflow = createWorkflowHost({
  directory: projectStateDirectory,
  projectPath,
  workStore: { store: existingProjectWorkStore, projectPath },
  policyContext: () => ({
    connections: currentConnectionObservations(),
    studioSessions: currentStudioObservations(),
    capabilities: currentHumanHandoffObservations(),
  }),
});
const dispatchWorkflow = workflowRoutes(workflow);

// Inside the host's existing request dispatcher, after constructing its URL:
if (await dispatchWorkflow(request, response, url, controlToken, origin, agentToken)) {
  return;
}

// During project replacement/shutdown, before closing existingProjectWorkStore:
workflow.close();
~~~

The observations in the example are dependencies of the integrating host, not
functions supplied by this module. Omit policyContext to leave unavailable work
blocked. Capability labels cannot manufacture a verifier. No verifier registration
or browser-selected host callback is accepted by this factory.

Factory options are exactly directory, projectPath, workStore, and optional
policyContext. workStore is required. Its projectPath is a trusted host attestation
that the borrowed store belongs to that project; a different declared project is
rejected. WorkStore does not expose an independently inspectable project identity.
The factory never reopens or closes the borrowed store. Only its own workflow
journal and receipt authority are closed. Construction is synchronous and lazy:
unauthenticated HTTP requests cannot create the journal or receipt directory.
The existing WorkStore must already have created the state directory.

The returned API is list(), get(workflowId), currentFlow(), preview(input,
IncomingMessage, authority), execute(input, IncomingMessage, authority), close().
authority has exactly controlToken, origin, agentToken. preview and execute
independently authenticate even when invoked outside the route dispatcher.
The factory does not expose the coordinator, a signing helper, its key, or an
authorization callback. Metadata methods are for trusted in-process callers;
the HTTP wrapper authenticates all reads.

Main owns lab/product dispatch, project replacement, UI integration, and desktop
launch. None of those modules is changed by this integration.

## Routes and bodies

All routes are under /v1/workflows, with the same dispatcher signature as
learningRoutes. Unrelated routes return false.

| Method | Path | Result |
| --- | --- | --- |
| GET | /v1/workflows | { projectId, workflows: [{ id, recipeId, state }] } |
| GET | /v1/workflows/:workflowId | WorkflowSnapshot |
| GET | /v1/workflows/current-flow | Newest non-halted WorkflowSnapshot, or null |
| POST | /v1/workflows/preview | WorkflowPreview; no workflow mutation |
| POST | /v1/workflows/execute | WorkflowCommandResult, or a redacted error |

current-flow is a derived newest non-halted workflow in journal insertion order.
It is not a persisted UI selection or a runner. Completed workflows remain visible
until halted; the existing coordinator has no separate completed workflow state.

Preview accepts exactly one of these shapes:

~~~ts
{ action: 'recipe', request: WorkflowRecipeRequest }
{ action: 'gate', workflowId, stepKey, gate, decision: 'approved' | 'rejected' }
{ action: 'handoff', workflowId, submission: WorkflowSubmission }
{ action: 'review', workflowId, stepKey, decision: 'approved' | 'rejected' }
{ action: 'reconcile', workflowId, resolution: 'halt' | 'accept-observed',
  observedRun?: { runId, taskIds: { [stepKey]: taskId } } }
~~~

Recipe, submission, gate, and quality contracts come from
packages/core/src/workflow-recipes.ts. A model selection or Studio target is recipe
metadata only. Missing selections, observations, capabilities, evidence, and gates
remain subject to the coordinator's existing policy. Verification steps cannot be
submitted through the handoff route.

A WorkflowPreview contains prepared (the complete WorkflowHumanRequest),
receiptHash, and only the necessary creation request or reconciliation
resolution/observedRun fields. The UI should present the prepared recipe/action,
approved/rejected decision, project/workflow identity, gate, pinned input
artifacts, submission and interrupted operation for human review. Obtaining a
preview signs its representation but does not execute or record its decision.

After the human explicitly confirms that displayed preview, POST exactly:

~~~ts
{ preview: previouslyReturnedWorkflowPreview, idempotencyKey: 'bounded-opaque-id' }
~~~

An idempotency key is 1–64 ASCII letters, digits, underscores, or hyphens.
Do not substitute a freshly generated preview when repeating the same exact
confirmed request: a fresh preview has a distinct receipt. Browser role/boolean
claims, arbitrary capabilities, commands, executable/model paths, callbacks, and
extra fields are rejected.

The execute route checks the signature and project, uses the signed prepared
fields to construct the coordinator command, and checks creation/reconciliation
extras against their exact binding. For a new mutation, the coordinator invokes
the same durable authority against its freshly prepared current request and
rechecks pinned file bytes and policy. A stale or changed representation fails
closed. Exact completed journal replays return the stored result with a current
snapshot. They can consequently still fail current evidence validation.
One receipt may authorize only one durable command, enforced by WorkflowStore.

## Durable human receipts and key confinement

The only secret read is the factory's own fixed direct child file:

~~~
<directory>/workflow-human-receipts/key-v1
~~~

The factory creates 32 random bytes using exclusive creation, flushes the file,
and flushes the containing directory on POSIX. Existing receipt directories with
missing or damaged keys are refused rather than regenerated. Preserve this
directory with workflow.sqlite when retaining workflows. No provider credential,
browser credential file, or Studio key is read or copied.

receiptHash is an opaque 64-character lowercase hex receipt compatible with the
existing journal. Its first 16 hex characters encode a random 64-bit nonce; the
remaining 48 encode a 192-bit truncated HMAC-SHA256 tag. The HMAC input is:

~~~
"arcane.workflow.human-receipt.v1\0"
+ nonceHex + "\0"
+ canonicalPreparedRequest
~~~

Canonicalization recursively sorts object keys, preserves array order, and uses
JSON primitive/string encoding. Every field of the prepared WorkflowHumanRequest
is covered, including its binding, project, workflow instance, recipe, action,
decision, pinned input artifacts, submission, recipeGate, and operation. When
validating a coordinator WorkflowHumanCommand, only the outer receiptHash and
recipeGate.receiptHash are removed to recover the exact signed request.
There is no live request permit, static control-token hash, or browser proof in
persisted gate validation. Stored gates can therefore validate after a restart
or human control-token rotation, provided the key and current evidence remain
valid. Signature comparison is constant time.

The factory guards every ancestor against symbolic links/junction redirection,
guards the fixed file against hard links, validates its regular-file type and
exact 32-byte size before reading, and checks descriptor/path identity and
timestamps after reading. It revalidates the file and compares its contents with
the startup key on each signing/verification operation. A changed live key cannot
replace the running authority. The receipt/state directory cannot be supplied as
a project write scope or handoff artifact, including when state is under the
project root. New handoff paths are checked before evidence is read.

POSIX requires owner-only directory mode 0700 and key mode 0600, with current-user
ownership. **Windows Node file modes do not describe Windows ACLs.** The integrating
host must provision the state/receipt directory with an owner-private ACL and
protect its ancestors from untrusted writes. This module cannot independently
verify or establish those ACLs without an additional platform facility; it does
not spawn PowerShell/icacls or claim Windows ACL verification. Local processes
already able to read/write the authority's private files are outside this HTTP
boundary. Treat Windows private-directory provisioning as a required lifecycle
integration condition.

Receipts do not expire or support individual revocation. Retiring the private key
invalidates existing signatures; losing or replacing it must be handled explicitly
by the lifecycle owner rather than an automatic repair. Never put it in the UI,
a model prompt, or a project evidence bundle.

## HTTP boundary, bounds, and unknown outcomes

assertLearningHumanRequest is reused. It rejects an agent token even if it equals
the human control token, compares the human bearer token in constant time, enforces
the exact Host and Origin, denies supplied fetch-site values other than same-origin,
and rejects duplicate Host/Authorization/Origin/fetch-site headers. Mutations need
Origin; GET may omit it but cannot contain a body. Content/framing singleton
duplicates are also rejected. No CORS permission is returned.

The wrapper rejects all query strings, absolute request targets, normalized
traversal aliases and URL credentials/fragments. JSON is restricted to UTF-8
application/json (optional UTF-8 charset), no content encoding, 128 KiB, depth 16,
and 16,000 nodes. Duplicate object keys, including escaped aliases, prototype
keys, malformed/nonfinite numbers and invalid UTF-8 are rejected. Body reads have
a two-second deadline; rejected streams drain at most one bounded body for
100 milliseconds and close stalled/excessive connections. Coordinator operations
are synchronous bounded local filesystem/SQLite operations; the body timer is
not cancellation of an already-started durable mutation.

Responses set no-store, nosniff and no-referrer. Input values containing either
host token are rejected before signing/storage, including normalized strings and
escaped JSON strings. Responses redact decoded string values before JSON encoding.
Errors expose allowlisted codes and fixed messages, never exception text, paths,
connection diagnostics or bearer values.

WORKFLOW_UNCERTAIN returns HTTP 202 with:

~~~json
{
  "error": "WORKFLOW_UNCERTAIN",
  "outcome": "unknown",
  "retry": false,
  "message": "Inspect the workflow and explicitly reconcile the observed outcome. No operation was retried."
}
~~~

There is no Retry-After, background retry, replay of an uncertain command, or
automatic reconciliation. A 202 is not successful acceptance. Inspect list/get/
current-flow, then obtain and explicitly confirm a new reconciliation preview.
accept-observed requires the coordinator's exact observed evidence/state;
interrupted creation additionally requires its real WorkStore run/task mapping.
halt preserves the durable uncertain command and stops that workflow. Neither
resolution repeats the interrupted mutation.

## Focused validation

tests/unit/workflow-http.test.ts uses real SQLite stores, actual local proof files,
and loopback HTTP only. It covers authentication, equal-token denial, header
duplicates, strict JSON and deadline limits, receipt tampering and restart,
idempotency, current evidence, persisted gates, unknown outcomes/reconciliation,
linked/missing/replaced keys, private evidence paths, borrowed-store lifecycle,
cross-project denial and error redaction.

Compile only this test and the existing workflow-service/workflow-store tests with
their dependency closure into a temporary directory, using the repository's strict
compiler options, then run those emitted test files with node --test. No full root
build, native launch, model inference, Studio action or commit is required.
