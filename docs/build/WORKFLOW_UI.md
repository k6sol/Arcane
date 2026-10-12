# Inline workflow controller MVP

The controller operates inside the existing conversation. Its implementation and
fixtures are `apps/desktop/src/workflow-panel.ts` and
`tests/unit/workflow-panel.test.ts`; parent owns that controller and styling.
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

**Model proof is currently unavailable.** Native snapshot selection identifies a
model/effort but exposes no connectionRevision matching the workflow policy's
server-side catalogue. The installed options omit getModelSelection, so recipe
model remains null. Generic saved preferences, connection UUIDs, browser-generated
hashes and timestamps are not substituted for an active native catalogue revision.
A future parent-owned proof contract must attest that exact mapping before wiring
the model callback.

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
| workflow-scope | One relative scope per line |
| workflow-step | Existing recipe step selection |
| workflow-action | gate / handoff / review / reconcile |
| workflow-gate | Selected step's actual gates |
| workflow-decision | approved / rejected |
| workflow-evidence | Exact actual-evidence submission JSON |
| workflow-resolution | halt / accept-observed |
| workflow-mapping | Actual WorkStore mapping for interrupted creation |

Buttons use `data-workflow-action` values `refresh`, `inspect`, `recipe`,
`decision`, `confirm`, `discard`, and `receipt`. They are semantic `type=button` controls.
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

Each request carries `Authorization: Bearer <human-control-token>`. POST uses
`application/json`; browser supplies same-origin Origin. Cache is no-store,
credentials are same-origin, redirects are errors, referrer policy is no-referrer.
Responses must be HTTP 200 UTF-8 JSON. GETs have no body. Transport bounds the
actual decoded stream to 4 MiB, strictly decodes UTF-8, checks declared size, and
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

## Focused proof

Strict isolated compilation inherits root ES2023/NodeNext options, strict,
noUncheckedIndexedAccess, exactOptionalPropertyTypes, and verbatimModuleSyntax,
with explicit repository Node type roots. Only workflow-panel.test.ts and its
import dependency closure are compiled to a unique Temp directory. The browser
module uses type-only imports; it has no runtime daemon/storage/recipe dependency.
Only the emitted workflow-panel.test.js is run with node --test. No shared build,
package command, socket, provider, Studio action, or native model is started.

47 offline tests exercise private document fixtures and HTTP Response/stream doubles:
inert lifecycle/cleanup and native draft preservation; real Event objects remaining
untrusted; all three deliverables; exact preview/execute preservation and unique
keys; model callback and context invalidation; late response cancellation;
unattested/wrong-chat denial; optional metadata preservation; gate/handoff/review
schemas and host-verification exclusion; 202 unknown/explicit reconciliation and
observed creation mapping; stopped dispatches; malformed/wrong-project/wrong-receipt/
null-result/5xx/4xx outcomes; XSS text rendering; scope/evidence validation; exact
routes and transport budgets; fatal UTF-8/MIME/status/size handling; deadlines;
and absence of native execution, HTML sinks, polling, and browser storage.

The fixture's trusted-action-shaped events exercise handler logic privately; they
do not provide a production trust bypass. The 47 controller tests do not themselves prove browser rendering. Separate actual factory/HTTP tests cover the installed mount/module routes, exact conversation binding, restart replay and complete owned-resource cleanup. The installed context wiring refreshes only on canonical changes. No native model turn or Studio action is part of these proofs.




