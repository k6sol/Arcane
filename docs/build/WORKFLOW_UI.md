# Inline workflow controller MVP

The controller operates inside the existing conversation. Its implementation and
fixtures are `apps/desktop/src/workflow-panel.ts` and
`tests/unit/workflow-panel.test.ts`; this helper change owns only those two files and this document. Parent owns
styling, host/routes and same-composer context/append integration.
Frontend context wiring lives in `apps/desktop/src/studio.ts` and
`apps/desktop/src/codex-chat.ts`, with synthetic regressions in
`tests/unit/codex-chat-ui.test.ts` and `tests/unit/workspace-unified.test.ts`.
No native model, provider authentication, storage, host, product, lab, or visual
implementation is changed by the frontend wiring correction.

## Mount and public lifecycle

Parent provides exactly one `#workflow-panel` beside the existing native transcript.
Call `startWorkflowPanel(document, options)` after that element exists. Construction
builds only an owned `.arcane-workflow` section and makes **zero HTTP requests**.
It does not start a conversation, populate the native composer, infer a model,
create a workflow, execute a handoff, grant writes, or record a gate.

```ts
import { startWorkflowPanel } from './workflow-panel.js';
import type {
  NativeWorkflowConversation, WorkflowPanelOptions,
} from './workflow-panel.js';

// Values and subscription are supplied by the parent's existing controllers.
const options: WorkflowPanelOptions = {
  getToken: () => currentControlToken,
  getProjectPath: () => currentProjectPath,
  getNativeConversation: () => observedNativeConversation,
  getModelSelection: () => observedModelSelection,
  appendToDraft: (text, provenance) => existingChat.appendWorkflowDraft(text, provenance),
  subscribeContextChange: invalidate => contextChanges.subscribe(invalidate),
};
const workflow = startWorkflowPanel(document, options); // inert
await workflow.start(); // GET list and current-flow only
// Before switching/replacing the native/project context:
workflow.stop();
// After the parent has installed the new observations:
await workflow.resume(); // GET list and current-flow only
// On teardown:
workflow.cleanup();
```

These parent variable/function names are integration placeholders, not newly
introduced services. Public return shape is exactly
`{ start(): Promise<void>, resume(): Promise<void>, stop(): void, cleanup(): void }`.
Repeated `start()` while running does nothing. `resume()` explicitly refreshes.
`stop()` aborts requests, invalidates previews, clears context/form state, and
retains dispatched receipts in memory as unknown. It does not halt a durable
workflow or interrupt native work. `cleanup()` also removes listeners,
unsubscribes, and removes only this controller's subtree. Recreating the factory
for the same document cleans up its previous controller.

`getToken()` and `getProjectPath()` return a nonempty string or null. The token is
the existing **human control token**, never the agent or provider token. The path
is the currently installed host project root. The parent must update those
observations together with its host lifecycle; the browser cannot independently
resolve the physical project directory or derive a trustworthy project identity.

`getNativeConversation()` returns null or the exact observed shape:

```ts
interface NativeWorkflowConversation {
  provider: 'codex' | 'claude-code';
  threadId: string;      // existing observed native thread ID
  sessionId: string | null; // existing observed native session, explicitly null when absent
  connectionId?: string; // include observed native connectionId when available
  projectPath?: string;  // if supplied, must equal getProjectPath()
}
```

For Arcane's one-conversation integration, **provide this callback**. Null disables
new-work decisions. No native identifier has a browser input control. The optional
`getModelSelection()` returns only an observed
`{ provider, model, effort, connectionRevision }` or null. Without it, recipe
`model` is exactly null. Core RequestedModel provider remains 'codex' | 'claude', distinct from the native
conversation provider 'codex' | 'claude-code'. Neither callback selects or applies a
native model.

`subscribeContextChange(listener)` returns an unsubscribe function. Notify
synchronously whenever project, token, native connection/conversation, or model
observation changes, including changes away and back between requests. Without
notifications, callbacks are still checked before every action and after responses,
but transient changes cannot be detected. Stop before changing context, then resume,
or notify and use the explicit Refresh button. Requests and previews are cancelled
and staled; late responses cannot restore confirmation. No polling is installed.
Optional `fetch` is a test/parent transport seam; production defaults to the
document's fetch. Optional `timeoutMs` defaults to 10,000 and is bounded to 1–60,000.

## Installed frontend context wiring

`studio.ts` keeps `void import('./workflow-panel.js')` optional. A missing module
on an older daemon reports the existing workflow-only restart notice; it cannot
prevent the native chat/workbench imports from starting. Import completion after
pagehide leaves the workflow controller inert until the page resumes.

`createWorkflowContextOptions(getToken, workbench, chat, refresh)` supplies the
real callbacks. It subscribes directly to `StudioWorkbench.subscribeProjectChange`
and `CodexChat.subscribeWorkflowContextChange`. It does not subscribe to browser
`arcane:contextchange` events, DOM label mutations, tool selection, or polling ticks.
Every observed tuple is compared with the previous tuple before invalidating.
Actual changes invalidate synchronously; multiple changes in one observation turn
coalesce into one queued read-only workflow resume/refresh. Unsubscription cancels
queued refreshes. Workflow reads cannot publish either source notification, so they
cannot form a refresh loop.

The project source is the last valid canonical projectPath from authenticated
product metadata with protocolVersion 1. Its first arrival notifies subscribers,
including when the workflow module loaded before project metadata. Studio session
availability is independent of project metadata. Repeated product responses,
invalid path/protocol observations and unavailable product reads do not replace the
last trusted project path or invalidate an unrelated workflow preview.

The native source exactly mirrors the lab host's conversation callback:
`state.snapshot.thread` when configured, otherwise `state.nativeHistory`.
Cached binding is usable even with recorded:null: the host persists thread/session
identity separately from loaded history content. Neither lastSnapshot nor browser
thread inputs supply workflow identity. Native state decoding checks explicit
sessionId:string|null and rejects cached bindings from a different project.

The returned identity is `{provider:'codex', threadId, sessionId, projectPath}`.
It deliberately omits transient connectionId. A configured thread and a cached
binding with equal project/thread/session have equal semantics. Connection-handle
replacement, thread turn progress, busy flags, approvals, public deltas, model
labels/selections, and loaded-history content/timestamps do not change that tuple.
Actual project, thread, session or binding absence changes do. Metadata reads and
reconnect observations preserve the exact unsent composer text; they never create,
resume, run inference in, or grant writes to a native conversation.

**Active model proof is host-attested.** The installed Codex route projects only a
ready, configured native thread's exact model/effort and reported catalogue. The
host computes a bounded SHA-256 revision over its native connection, canonical
project/thread/session, subscription metadata, active selection and catalogue.
The browser validates this projection against the same snapshot and never derives
a revision from UUIDs, saved preferences, timestamps or labels. No proof means
model:null; no fallback is selected. Changing the model/catalogue invalidates
prepared workflow decisions. The host rechecks the exact current proof at recipe
preview and confirmation. This projection grants no write permission or model turn,
and entitlement remains unverified. A changed model revokes native write grants;
the next user message applies its exact pair to that same idle native thread.

Parent-owned GET get/current-flow attestation should attach the exact trusted
canonical top-level conversation only for bound workflows. The frontend consumes
it using the same identity above; unbound legacy fixtures are not assigned a
conversation. Bound snapshots now carry that exact trusted top-level conversation. Read-only exact receipt lookup is also wired.

Frontend validation compiles only the two impacted test files and their dependency
closure to a unique Temp directory with the repository's strict compiler options.
The focused run explicitly skips actual HTTP host/browser fixtures and leaves all
browser-module environment variables empty. It executes 24 synthetic tests,
including nine new context regressions; five pre-existing host/browser tests are
excluded by the test-skip pattern. No real browser, user app, Studio, installed native client, model inference,
shared build, package command, or provider authentication action is run.

## Exact integration IDs

Only `#workflow-panel` is required from the parent. All the following controls
are constructed inside it; parent should not construct duplicates:

| ID | Control |
| --- | --- |
| workflow-stored | Stored workflow selection |
| workflow-deliverable | code-change / production-asset / playtest-repair |
| workflow-engine | roblox / blender |
| workflow-title | Human title |
| workflow-prompt | Human prompt |
| workflow-scope | Exact files/directories; include every evidence output before creation |
| workflow-evidence-paths | Optional client-only planned output paths; never added to scope |
| workflow-scope-help | Scope/evidence guidance linked by aria-describedby |
| workflow-step | Existing recipe step selection |
| workflow-action | gate / handoff / review / reconcile |
| workflow-gate | Selected step's actual gates |
| workflow-decision | approved / rejected |
| workflow-evidence | Exact actual-evidence submission JSON |
| workflow-files-<role> | Selected non-verification step role paths |
| workflow-resolution | halt / accept-observed |
| workflow-mapping | Actual WorkStore mapping for interrupted creation |

Buttons use `data-workflow-action` values `refresh`, `inspect`, `recipe`,
`decision`, `confirm`, `discard`, `receipt`, `evidence-files`, and `draft`. They are semantic `type=button` controls.
Form submissions are prevented. HTTP actions require trusted browser click
activation; synthetic events cannot request previews or confirm commands.
Inherited typography, charcoal surfaces, square controls, thin rules, and a red
confirmation boundary follow the supplied reference. Scoped styles live in the existing external studio.css; no inline stylesheet or CSP relaxation is used. There is no duplicate navigation,
chat, decorative eyebrow, pill, fabricated telemetry, or completion claim.

## HTTP assumptions and confirmation

The exact base contract remains [WORKFLOW_HTTP.md](WORKFLOW_HTTP.md).
Same-origin routes are used without query strings:

- GET `/v1/workflows`: `{ projectId, workflows: [{ id, recipeId, state }] }`.
- GET `/v1/workflows/current-flow`: a `WorkflowSnapshot` or null.
- GET `/v1/workflows/:id`: selected `WorkflowSnapshot`.
- POST `/v1/workflows/preview`: exactly one documented preview input.
- POST `/v1/workflows/execute`: exactly
  `{ preview: completePreviouslyReturnedPreview, idempotencyKey }`.
- POST `/v1/workflows/receipt`: that same original envelope, but observation only; no replay or binding write.
- POST `/v1/workflows/evidence`: read-only file references; see exact helper contract below.
- POST `/v1/workflows/draft`: read-only same-conversation step text; see exact helper contract below.

Each request carries `Authorization: Bearer <human-control-token>`. POST uses
`application/json`; browser supplies same-origin Origin. Cache is no-store,
credentials are same-origin, redirects are errors, referrer policy is no-referrer.
Responses must be HTTP 200 UTF-8 JSON. GETs have no body. Transport bounds the
actual decoded stream to 4 MiB (512 KiB for evidence/draft helpers), strictly
decodes UTF-8, checks declared size, and
cancels rejected/stalled streams. Requests, including the complete execute envelope,
are bounded to 128 KiB, depth 16, and 16,000 nodes. Invalid/prototype data fails
closed. Error response bodies and exception details are not exposed in the UI.

Recipe preview body is `{action:'recipe', request:{deliverable, engine, title,
prompt, scope, model}}`. Scope contains 1–20 relative paths; secrets/configuration
paths and traversal are rejected. Playtest repair requires Roblox. Server recipe
default budgets/attempt bounds appear in the prepared recipe. No browser-selected
Studio target, capability claims, commands, executables, or native IDs are added.

Existing steps and actual assessment blockers are readable. The preview displays
all step scopes, gates, execution kinds, required evidence, acceptance criteria,
pinned input paths/hashes/bytes, decision, project/workflow identity, and the entire
returned JSON (including policy, submission, interrupted operation, receipt hash,
and future metadata). The base contract supplies no cost estimate; that absence
is stated, while any returned cost fields remain visible in the complete preview.

Only a separate trusted **Confirm exact preview** action dispatches execute. A
cryptographic UUID, fitting the 1–64 ASCII identifier contract, is generated once
for that command. The exact envelope is retained and readable with its key and
receipt. Double confirmation cannot redispatch. Form edits, refresh, context
changes, and stop discard a prepared preview. Execute acknowledgements are checked
against action/result, recipe, project, workflow, and creation receipt when
applicable. A recorded command does not imply completed steps or native execution.

Gate and review decisions use the documented approved/rejected bodies. Handoff
accepts only `{key, artifacts, subjectHashes, checks}`. Artifacts require actual
`{path, role, sha256, bytes}`; checks use
`{id, outcome, evidenceSha256, subjectDigest, value?}`. Submission order is normalized
like the host. Verification steps cannot use handoff. Review is available only for
submitted steps in needs_review. The host remains the authority on evidence,
policy, signatures, capabilities and current file bytes.

## Conversation attestation extension

The installed product binds workflows to the canonical native provider/thread/session via host-only ConversationWorkStore. Project-only compatibility fixtures are not the installed product contract.
The controller never invents one or changes the request schema. It accepts,
displays, and returns the complete server preview unchanged, including optional
extensions on its outer object or prepared request. The integrating server must
accept and bind its extensions during execute; otherwise its existing exact-field
validator will refuse them.

For a compatible optional `conversation` field on the preview, prepared request,
snapshot, or stored workflow, the controller compares provider/threadId/sessionId
against the trusted callback. The signed server binding is exactly
{provider:'codex'|'claude-code', threadId, sessionId:string|null}; sessionId is
required even when null. Local callback connectionId/projectPath extras are not
required in the server binding and are not added to it. Both outer and inner
attestations are checked when present. Returned data is preserved, not manufactured.

For another server attestation shape, provide
`isWorkflowInNativeConversation(value, conversation): boolean`. This trusted parent
adapter receives the complete preview or snapshot and must return literal true
only for a verified association. It is not sent over HTTP and grants no permission.
The installed host excludes unlinked legacy workflows and refuses their reads and decisions; it never backfills them into a chat. A workflow created and acknowledged in this controller is associated
with its current conversation in memory; that association cannot migrate to a
different chat. After reload, existing workflows need server attestation or the
trusted adapter. Without getNativeConversation, compatibility mode is project-only
and is not the intended one-conversation integration.

## Unknown outcomes and receipt reconciliation

HTTP 202 WORKFLOW_UNCERTAIN, network loss, timeout, cancellation after dispatch,
5xx, malformed/truncated acknowledgements, and contradictory results retain an
**unknown** receipt. There is no background retry, replay button, automatic
reconciliation, or fresh preview substituted for a dispatched command. Explicit
Refresh/Inspect reads workflow state and can locate an uncertain creation by its
exact creationReceiptHash. Merely seeing a workflow does not declare the command
successful. Unknown commands block ordinary subsequent decisions for that context.

For an inspected uncertain workflow with an interrupted operation, select
Reconcile, then halt or accept-observed. Interrupted creation's accept-observed
requires real `{runId, taskIds:{[stepKey]:taskId}}` WorkStore observations. The new
reconciliation preview exposes the operation, evidence, resolution, and mapping;
only explicit confirmation executes it under a new key. Successful reconciliation
marks matching earlier unknown receipts reconciled. The interrupted mutation is
never repeated. A definitive 4xx refusal is shown as refused, not successful.

For each unknown receipt, Check original receipt performs one explicit read-only
POST with its exact signed original preview and idempotency key. Only a validated
done command, bound conversation, available exact snapshot and matching result
clear uncertainty. Missing/running/uncertain/unbound/unavailable receipts stay
unknown. This check never executes a command, assigns a missing association,
retries a mutation, or treats an unrelated current workflow as receipt proof.
Receipts are memory-only (up to 32 retained); teardown/reload requires durable host
inspection. No token, preview, receipt, or native identifier uses localStorage.

## Read-only file evidence and same-chat draft helpers

These helpers do not execute workflow commands. Their buttons require a trusted
human click, an inspected active workflow, a matching bound conversation, no
interrupted operation or unknown command, and reported human-handoff readiness.
The selected step stays selected; the panel never chooses the next ready step.

### Scope planning before creation

Every produced brief, requirements, plan, review, patch/export/preview/report and
other evidence file must match a listed scope file or fall inside a listed
directory. This guidance appears before creating a workflow. A narrow scope
containing only a code target does not permit separate evidence files.

Optional #workflow-evidence-paths provides client-only preflight for up to 20
planned relative output paths. Out-of-scope entries prevent the preview request
and identify the path. This list sends no extra HTTP fields, writes no file and
**never adds to or broadens workflow scope or permissions**. To allow more outputs,
the human must edit the exact scope and review its normal preview. An empty
preflight list is not proof that all future outputs fit.

Actual file-helper paths and explicitly entered manual submission artifact paths
are checked against the selected step's existing scope before HTTP. This is
lexical preflight, not filesystem authority; host private-path, directory/link,
current-byte and policy checks remain authoritative.

### Prepare evidence from files

Select Handoff and a non-verification step. Each required evidence role receives
a labelled paths textarea, one relative path per line. Enter at least one path
per required role; the combined request is limited to 20 unique paths. Private,
absolute, traversal and malformed paths are refused locally; the host remains
authoritative for filesystem exclusions and actual bytes.

`data-workflow-action="evidence-files"` / **Prepare evidence from files** sends
one POST `/v1/workflows/evidence`, with no query string:

```json
{"workflowId":"<inspected id>","stepKey":"<selected key>","files":[{"path":"<normalized relative path>","role":"<required role>"}]}
```

Required response: `{projectId, workflowId, stepKey, workflowRevision,
conversation?, submission}`. The revision must equal the inspected workflow's
revision. In native-bound mode conversation is mandatory and must be exactly
`{provider:'codex'|'claude-code', threadId, sessionId:string|null}`, matching the
trusted callback's core identity. Callback connectionId/projectPath extras are
not required on the server. Project-only compatibility fixtures may omit it.

The submission uses the existing exact schema `{key, artifacts, subjectHashes,
checks}`. Its key, normalized file paths and roles must match the request.
Artifacts require valid host-returned SHA-256 hashes and positive bounded byte
counts; subjectHashes must equal the inspected step's pinned input hashes.
Checks must be empty: this helper cannot manufacture measurements or passes.
Verification steps remain host-only. The validated response, including identity,
revision and hashes, is displayed as text and only the submission fills
`#workflow-evidence`. **Advanced evidence JSON** remains editable. No preview,
execute, review, gate approval or completion follows automatically.

Role controls use `#workflow-files-<role>`; they are replaced only when the
selected workflow/step/role set changes. They reuse the parent's existing CSS.

Generated JSON is pinned in memory to project/workflow/step/revision, trusted
context fingerprint and canonical conversation, exact normalized requested
file/role list, and the exact filled value. The detached pin is deeply frozen.
Workflow, step, revision, context or source-path changes invalidate and clear it.
Preview rechecks paths and value too, refusing silent DOM substitution. Late
responses cannot overwrite changed paths or new manual input.

All JSON, including manual fallback, belongs to its inspected workflow/step/
revision/context and is cleared when that owner changes. The human must supply
manual JSON again after a selection change; it cannot silently carry between
workflows sharing step keys. Actual editing of generated JSON enters manual
fallback for the current owner, retaining all schema, scope, subject and host
checks. An unchanged input notification does not detach the generated pin.
Same-owner/same-revision refresh preserves valid prepared evidence.

### Add step to chat draft

`data-workflow-action="draft"` / **Add step to chat draft** is disabled until the
selected step is native-handoff, its assessment is pending/human-handoff with no
blockers, and the exact recipe model equals the trusted `getModelSelection()`
observation, including catalogue connectionRevision. Native provider codex maps
to RequestedModel provider codex; claude-code maps to claude. A saved preference,
recipe selection alone, generic model name or invented revision is not proof.
An observed bound conversation and `appendToDraft` callback are also required.

The trusted click sends one POST `/v1/workflows/draft` with only
`{workflowId, stepKey}`. No prompt, model, file text or native identifier is
accepted from the browser body. Required response:
`{projectId, workflowId, stepKey, workflowRevision, conversation, model, text,
requiresHumanSubmit:true, startsNativeTurn:false}`. Exact identity, inspected
revision, conversation and model proof are checked before append. Extra fields,
contradictory flags and stale revisions are refused.

Text must be nonempty and at most **64 KiB UTF-8**, not 64 KiB characters. It is
preserved intact or refused; the client never truncates it. The server owns
construction from the actual recipe/scope/objective/acceptance and hash-pinned
inputs, identifies evidence as untrusted, and grants no permission.

Parent integration must supply `appendToDraft(text: string, provenance: WorkflowDraftProvenance): boolean` as an atomic
append to the existing native composer: preserve unsent content, enforce its
**128 KiB total UTF-8** cap before changing anything, dispatch only input, and
never submit. Literal false leaves the existing draft unchanged and the panel
explains unavailable/full. No duplicate composer, native API call, turn, resume,
grant, workflow submission or audit completion is initiated by this helper.
The panel does not claim native execution or a completed step.

WorkflowDraftProvenance is exported; its second callback argument is REQUIRED on
every production call. One-argument fixture functions remain TypeScript-assignable.
Production parents must consume and track this metadata:

~~~ts
interface WorkflowDraftProvenance {
  readonly projectPath: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly stepKey: string;
  readonly conversation: Readonly<Pick<NativeWorkflowConversation, 'provider' | 'threadId' | 'sessionId'>>;
  readonly model: Readonly<RequestedModel>;
}
~~~

Only validated server fields and live trusted context form this exact whitelist.
After response, generation, context, selected-step and revision checks,
projectPath comes from live context; all other fields come from the validated
response. Conversation contains only canonical provider/threadId/sessionId,
without callback connection/project extras. The whole object and nested
conversation/model are detached and deeply frozen. No token, authority, gate or
permission is included.

Parent owns CodexChat.appendWorkflowDraft(text, provenance) and its boot callback,
provenance tracking before atomic append, stale-Send guards and explicit human
context-review dialog. Pure append utility aliases remain parent-owned. The
panel neither submits a native turn nor grants permissions.


### Transport and stale-result contract

Both helper POST bodies retain the **128 KiB** request bound. Their responses
have a separate **512 KiB** bound (declared and streamed), fatal UTF-8 decoding,
existing MIME/status/deadline checks and cancellation. Other workflow transport
retains its 4 MiB response bound. No automatic retry or follow-up read occurs.

Project, token, canonical native context or exact model changes, away/back
notifications, any form edit, selected-step change, stop and cleanup abort and
discard pending helper responses. A stale/missing workflowRevision must not fill
JSON or append a draft; the user is asked to refresh explicitly. Read failures do
not create execution receipts or clear existing execution uncertainty. Existing
preview/explicit-confirm/unique-receipt/reconciliation behavior is unchanged.

Integration needs: parent-provided `#workflow-panel`, the existing trusted context
callbacks, optional exact active-model proof and atomic append callback, and the
two read-only routes with the exact response fields above. Missing model proof or
append callback intentionally leaves draft preparation unavailable. These private
fixtures do not prove live model availability or packaged/browser rendering.
## Focused proof

Strict isolated compilation inherits root ES2023/NodeNext options, strict,
noUncheckedIndexedAccess, exactOptionalPropertyTypes, and verbatimModuleSyntax,
with explicit repository Node type roots. Only workflow-panel.test.ts and its
import dependency closure are compiled to a unique Temp directory. The browser
module uses type-only imports; it has no runtime daemon/storage/recipe dependency.
Historical worker attempt (2026-10-12, **superseded**): 11 diagnostics occurred in
then-in-progress workflow-evidence-builder.ts, first at line 36. They are not
current source diagnostics. Parent subsequently reports current source clean
with 114 explicit product source inputs, 107 assistance checks passed, plus 35 provenance-controller checks passed and
four opt-in browser cases skipped. These are parent-reported results, not an
independent compile or browser run claimed by this worker.

The worker's last executed private document/HTTP-double run passed 78 tests. The
final unchanged-input regression was added afterward; current panel source has
79 tests; the parent subsequently compiled current source and ran all 79 successfully. No shared build,
package command, Git, installed CLI, Studio action or inference was run here.

79 offline test cases cover private document fixtures and HTTP Response/stream doubles:
inert lifecycle/cleanup and native draft preservation; real Event objects remaining
untrusted; all three deliverables; exact preview/execute preservation and unique
keys; model callback and context invalidation; late response cancellation;
unattested/wrong-chat denial; optional metadata preservation; gate/handoff/review
schemas and host-verification exclusion; 202 unknown/explicit reconciliation and
observed creation mapping; stopped dispatches; malformed/wrong-project/wrong-receipt/
null-result/5xx/4xx outcomes; XSS text rendering; scope/evidence validation; exact
routes and transport budgets; fatal UTF-8/MIME/status/size handling; deadlines;
and absence of native execution, HTML sinks, polling, and browser storage. Added
helper cases cover exact path/role/hash/subject validation, 64 KiB UTF-8 text,
same-composer append/false preservation, disabled readiness/proof, stale revisions,
512 KiB helper transport and late-response context/form/teardown cancellation.
New cases cover cross-workflow/manual evidence reuse, revision and source-path/
value pinning, same-revision refresh, late silent form changes, scope preflight
without permission expansion, exact immutable detached callback provenance, and
live context/form/workflow races.

The fixture's trusted-action-shaped events exercise handler logic privately; they
do not provide a production trust bypass. These controller tests do not themselves prove browser rendering. Separate actual factory/HTTP tests cover the installed mount/module routes, exact conversation binding, restart replay and complete owned-resource cleanup. The installed context wiring refreshes only on canonical changes. No native model turn or Studio action is part of these proofs.

## Parent-integrated validation (2026-10-12)

Current-source strict product compilation passed with **114 explicit source files**.
The combined actual-file helper/authenticated HTTP/panel/composer run passed **107/107**.
Following independent review, the final panel's **79/79** fixtures and native projection/
durable reconnect's **8/8** fixtures passed. The provenance/composer controller run
passed **35 checks**, with four separate browser opt-ins skipped in that controller run.

A separate real, owned Edge 155 renderer run passed the complete file preparation,
separate preview/confirmation/review/gate flow, same-composer append, cross-thread
submission block, human draft re-review, tool switching and reload in **33,816 ms**.
It used actual local HTTP services, real owned files and durable work/association
stores, but **borrowed synthetic installed-cli metadata**. No installed CLI client,
model turn, provider probe, Studio operation or asset job was started. This establishes
renderer/route integration, not provider entitlement or live Studio acceptance.

Parent source also tracks appended workflow provenance in memory. A project, canonical
thread/session or active-model mismatch disables sending and preserves every unsent
byte. **Review draft context** opens a full-text comparison with original metadata and
the current target. Its explicit checkbox/confirmation refreshes state, refuses races,
and only re-reviews text; it cannot submit a turn, grant writes, move the workflow or
approve evidence. A subsequent send remains a separate human action. Provenance is
cleared on an empty composer or explicit turn submission, not on tool/context switching.
No browser storage or copied native chat is created by this mechanism.

Proof inventory: `runtime/verification/workflow-assistance-fba6a3c0-c3b0-4181-a06f-cc2bf8b4abf7/focused-evidence.json`.
Actual renderer screenshot: `runtime/verification/workflow-browser-a95bc791-fe41-4f1d-87a1-00c4b6579169/workflow.png`.
Full-product native workflows, asset execution, verifier registry and live engine
acceptance remain open; passing these components must not close those gates.
