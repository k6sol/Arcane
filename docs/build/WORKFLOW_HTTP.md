# Workflow HTTP host integration

The integration consists of **apps/daemon/src/workflow-host.ts** and
**apps/daemon/src/workflow-routes.ts**. It wraps the existing WorkflowService and
WorkflowStore and optional ConversationWorkStore. It does not listen on a socket, launch a model, run a verifier,
invoke a model CLI, edit Studio, authorize a Studio API key, upload, or call a paid API. Windows private-key protection uses only the fixed native PowerShell security operation described below.
Native execution and Studio integration remain deferred.

## Exact factory and wiring

~~~ts
import { createWorkflowHost } from './workflow-host.js';
import { workflowRoutes } from './workflow-routes.js';

const workflow = createWorkflowHost({
  directory: projectStateDirectory,
  projectPath,
  workStore: { store: existingProjectWorkStore, projectPath },
  conversation: () => currentNativeConversation, // NativeConversation or null
  workAssociations: existingProjectConversationWorkStore,
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
blocked. Capability labels cannot manufacture a verifier. Optional verifiers are fixed trusted host functions typed by WorkflowServiceOptions; HTTP JSON cannot register them, and these routes expose no verifier execution endpoint. Browser-selected host callbacks are rejected.

Factory options are exactly directory, projectPath, workStore, and optional policyContext, conversation, workAssociations, verifiers. workStore is required. Its projectPath is a trusted host attestation
that the borrowed store belongs to that project; a different declared project is
rejected. WorkStore does not expose an independently inspectable project identity.
The factory never reopens or closes the borrowed store. Only its own workflow
journal and receipt authority are closed. Construction is synchronous and lazy:
unauthenticated HTTP requests cannot create the journal or receipt directory.
The existing WorkStore must already have created the state directory.

The returned API is list(), get(workflowId), currentFlow(), preview(input,
IncomingMessage, authority), execute(input, IncomingMessage, authority),
receipt(input, IncomingMessage, authority), close().
authority has exactly controlToken, origin, agentToken. preview, execute and receipt
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
| POST | /v1/workflows/receipt | Read-only exact WorkflowReceiptResponse |

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
POSIX: <directory>/workflow-human-receipts/key-v1
Windows: <home>/.arcane-private-receipts-v1/<scope>/workflow-human-receipts/key-v1
~~~

The exported workflowReceiptParent(directory, projectId) returns the exact platform-specific parent. On Windows scope is SHA-256(projectId + NUL + lowercase absolute state directory), separating projects and state directories without storing a provider credential. Tests use this helper, including temporary-fixture cleanup; they do not substitute or weaken ACL checks.

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
+ canonical(prepared) // without native conversation context
// With context, the last term is canonical({ prepared, conversation }).
~~~

Canonicalization recursively sorts object keys, preserves array order, and uses
JSON primitive/string encoding. Every field of the prepared WorkflowHumanRequest
is covered, including its binding, project, workflow instance, recipe, action,
decision, pinned input artifacts, submission, recipeGate, and operation. When
validating a coordinator WorkflowHumanCommand, only the outer receiptHash and
recipeGate.receiptHash are removed to recover the exact signed request.
When conversation is configured, its exact provider/threadId/sessionId also participates in the signature. There is no live request permit, static control-token hash, or browser proof in
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
ownership. Windows uses the fixed workflow-private-storage.ts operation through
native Windows PowerShell, a fixed system security module search path, a five-second
timeout, bounded output, and strict descriptor validation. It rejects linked paths,
unsafe ancestor permissions, non-owner storage, and non-private existing key folders
or keys. Only a newly created empty direct key folder receives the narrower DACL.
Existing ACLs are inspected, never repaired. Permissions are not relaxed for cloud,
package or temporary paths. The home-derived parent avoids such exceptions. Local
processes already able to access the private authority files remain outside this
HTTP boundary. No executable path or PowerShell text comes from HTTP/workflow JSON.

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

## Native conversation association

When conversation is configured, workAssociations is required and must be the
host's ConversationWorkStore for the same canonical project. The callback supplies
exact server-owned { provider: 'codex' | 'claude-code', threadId, sessionId: string |
null }. No current context means creation/execution is denied and scoped reads
show no workflows. HTTP fields cannot select or replace that context.

Creation binds the resulting workflow ID to that exact conversation. list/get/
current-flow filter by the persisted binding; provider, thread, session, null
session and case differences remain distinct. A preview includes conversation and
signs it with the prepared request. Context changes reject old previews, including
completed creation replays; editing the envelope to the new context cannot forge
the signature. Omit conversation only for an explicitly unscoped host.

Metadata reads and restarts never associate legacy or unbound workflows. A binding
failure after durable creation returns WORKFLOW_ASSOCIATION_UNKNOWN as HTTP 202,
outcome unknown, retry false. The workflow may already exist, so the caller must
inspect/reconcile rather than blindly run another creation. Exact authenticated
execute replay uses the coordinator journal, so it does not create a second
WorkStore run. The association store is borrowed and remains open after host.close().

## Focused validation

tests/unit/workflow-http.test.ts and tests/unit/workflow-conversation-host.test.ts use real SQLite stores, actual local proof files,
and loopback HTTP only. It covers authentication, equal-token denial, header
duplicates, strict JSON and deadline limits, receipt tampering and restart,
idempotency, current evidence, persisted gates, unknown outcomes/reconciliation,
linked/missing/replaced keys, private evidence paths, borrowed-store lifecycle,
cross-project denial and error redaction.

Compile these two test files and their dependency closure into an isolated temporary
directory, using the repository's strict
compiler options, then run those emitted test files with node --test. No full root
build, native launch, model inference, Studio action or commit is required.


## Exact read-only command receipt recovery

POST **/v1/workflows/receipt** accepts the same unchanged body as execute:

~~~ts
{ preview: originalWorkflowPreview, idempotencyKey: originalCommandKey }
~~~

It uses the identical strict JSON/body/header/Origin parser and human control-token
checks. The host verifies the original prepared HMAC, canonical project and exact
server-owned provider/thread/session context. Creation checks the supplied original
request against its signed preparation; reconciliation checks the original resolution
and optional observed run mapping against the prepared binding. Changed envelopes,
wrong recorded keys, foreign projects and cross-conversation probes expose no receipt
metadata. No browser-selected authority, current-context substitution or fresh preview
is used to validate a previously sent command.

Successful lookup returns HTTP 200 with exactly this response contract:

~~~ts
interface WorkflowReceiptResponse {
  state: 'not-recorded' | 'running' | 'uncertain' | 'done';
  command: null | {
    idempotencyKey: string;
    kind: 'create-recipe' | 'recipe-gate' | 'submit-evidence' | 'review-evidence' | 'reconcile';
    workflowId: string;
    result: 'created' | 'decided' | 'submitted' | 'busy' | 'unsupported' | 'reviewed' | 'reconciled' | null;
  };
  association: 'bound' | 'unknown' | 'unscoped' | null;
  snapshot: (WorkflowSnapshot & { conversation?: NativeConversation }) | null;
  snapshotStatus: 'available' | 'not-recorded' | 'unbound' | 'unavailable' | 'too-large';
  retry: false;
}
~~~

The command journal must match **key, request hash, receipt hash, kind and workflow
instance ID**. A creation preparation has workflowId null; its recorded command supplies
the durable instance ID and must still match that instance's recipe and creation receipt.
Metadata is allowlisted and bounded to one command. It contains no prepared prompt,
raw journal payload, receipt signature, native/provider file data or key material.

- **not-recorded**: no journal entry under this exact key. command/association/snapshot
  are null and snapshotStatus is not-recorded. This does not prove that work was never
  created under another key; it never authorizes another create or execution attempt.
- **running / uncertain**: report the journal's exact state and null command result.
  The lookup never reconciles or replays it, even if a current snapshot is available.
- **done + bound**: confirms that command's recorded outcome. The UI can clear the
  lost-response uncertainty for that exact command without executing it again. Any
  later workflow uncertainty or blocked state still comes from the current snapshot.
- **done + unknown**: creation may have completed but its association is missing.
  snapshot is null, snapshotStatus is unbound, and attribution must remain unknown.
  Reads and restart never create the missing association.

A snapshot is returned only after the persisted association matches the canonical
project and all three native conversation fields. A conflicting association is refused.
An explicitly unscoped host returns association unscoped and no attested receipt
snapshot. Snapshot failures caused by missing/current evidence, mapping or observations
retain the exact command metadata with snapshotStatus unavailable. A response over
**512 KiB** omits the snapshot and reports too-large. Nothing is truncated into a partial
snapshot. Receipt requests retain the existing 128 KiB input bound and depth/node limits.

The coordinator's **receipt(input)** accepts prepared, receiptHash, idempotencyKey,
and only reconciliation's required resolution/optional observedRun. It reuses the exact
trusted human receipt verifier and denies absent authority. It only observes the journal;
it never enters replay, appends a command, creates work, hands off evidence or invokes a
verifier. The host uses the existing get(workflowId, true) read-only snapshot mode, which
keeps mapping/evidence/policy checks and skips WorkStore.ready lease expiry. Receipt
lookup therefore cannot mutate unrelated expired worker leases.

All lookup results have retry false. Send the original preview/key to **receipt**, not
execute, after losing an execute response. Missing/uncertain attribution requires explicit
observation and reconciliation by the parent. The read API cannot issue or authorize that
reconciliation. Existing private key storage, ACL, reparse and ancestor checks remain
unchanged. Invalid stored command metadata returns the fixed WORKFLOW_RECEIPT_CORRUPT
503 response; storage is never repaired or reset.

## Conversation attestation on host snapshots

With a configured conversation and an exact persisted workflow association, get,
current-flow and successful execute responses include top-level **conversation**:

~~~json
{ "provider": "codex", "threadId": "exact-native-thread", "sessionId": null }
~~~

Receipt snapshots include that same top-level canonical field. Nonempty bound list
responses include it alongside projectId/workflows. This is server-provided attribution,
not an in-memory UI ownership cache; it remains available after host restart. Empty
unbound lists and missing receipt associations do not claim attestation. Hosts configured
without a conversation option retain their original list/get/current-flow/execute shapes.

**tests/unit/workflow-receipts.test.ts** adds synthetic, offline SQLite/loopback tests
for exact journal identity, read-only lost-response recovery, restart attestation,
unknown associations, unchanged strict controls, snapshot bounds and worker lease
preservation. Compile it and the existing backend regression tests into unique temporary
output using the repository's strict options. No shared build, packaging, Git mutation,
provider credential, native model or Studio operation is needed.
