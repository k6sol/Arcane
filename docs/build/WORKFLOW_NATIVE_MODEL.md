# Native selected-model workflow proof

`workflowNativeModel` in `apps/daemon/src/workflow-native-model.ts` projects public
in-memory Codex observations into `{ proof, connection }`, or returns `null`. The
proof type is `NativeWorkflowModelProof` in `packages/protocol/src/workflow-model.ts`.
This projection is metadata only: it does not launch a CLI, probe a provider, read
provider credentials/auth/config files, execute a model, change native configuration or access Studio.

## Exact source and revision

The source is the configured **active native thread's** `selection`, rather than the
snapshot's picker selection. The exact model must exist in the reported catalogue and
the exact effort must be a known Arcane effort reported for that model. Display IDs,
aliases, automatic selection, unknown future effort values and unsupported pairs do
not supply substitutes. Unknown catalogue efforts are filtered out; a model with no
known efforts cannot support the active selection. An unknown default effort becomes
null and never changes the selected pair to a fallback.

The SHA-256 `connectionRevision` uses domain `arcane.workflow.native-catalogue.v2\0`
(the suffix is a NUL byte). It binds provenance, the exact project path, thread/session
IDs, reported account auth/plan requirements, the active pair and the usable catalogue.
Model and effort ordering are canonical. **Transport `connectionId` is excluded**:
a ready reconnect with the same exact context/catalogue/selection keeps the revision.
Display names, catalogue row display IDs, picker selection, events, progress, terminal
operation/action receipts and historical last snapshots also do not change it. A changed
active pair, usable catalogue, project/thread/session, account plan or provenance changes
it; unsupported auth observations deny projection rather than supplying another model.

Transport freshness is separate: `proof.connectionId` is always the exact current live
snapshot ID. The proof envelope remains version 1; only the revision hash domain is v2.
The browser's existing `readCodexState` independently compares that proof ID with the
live snapshot ID, so an old proof is rejected even when the catalogue revision matches.
Disconnected/not-ready/reconnecting state still supplies no proof. This does not reuse
an old connection, auto-resume a native thread or grant a new permission.

Account scope means only the public reported auth mode, plan and authentication
requirement. It does **not** establish account identity or distinguish two accounts
reporting identical metadata. No credential, auth file, native configuration or provider
account lookup is read to strengthen that observation. Entitlement remains unverified.

Projection requires a ready connected personal-local Codex snapshot, configured native
thread, bounded catalogue, subscription account observation and supported provenance.
Connecting/closing/display-limited state, missing/invalid identity or catalogue,
signed-out/unsupported account, and pending/unknown operations or current-connection
actions deny proof. Unresolved actions from another historical connection do not claim
current native state. A previous snapshot cannot replace a missing active snapshot.

`spawned-node-fixture` yields `connection.installed: false`. The proof and every model
retain `entitlement: 'unverified'`, including for an `installed-cli` provenance observation.
Synthetic installed provenance in a unit test is an input value, not proof of an installed
CLI or entitlement. A catalogue observation is not evidence of a successful inference.

## Actual product wiring

`codexRoutes(service, { workflowModels: true })` includes `state.workflowModel`, using
this host-produced proof or explicit null. Omitting the opt-in preserves the original
route shape. The actual `createConnectionLab` dispatcher enables projection and supplies
both workflow `modelSelection` and policy connections from the same current projection.
The UI consumes this proof rather than manufacturing a catalogue hash in the browser.

For a non-null recipe model, the workflow host checks the exact current provider/model/
effort/revision at **preview and execute**. Changes after preview return
`WORKFLOW_MODEL_CURRENT` (HTTP 409) before workflow creation. A model alias, another
reported but inactive pair, browser-made revision, or missing current proof cannot
satisfy that check. Null model is permitted for planning and leaves model-dependent
work unsupported/pending; it does not choose or execute a model.

A same-context transport reconnect permits a still-exact recipe preview to execute and
keeps an existing recipe's model requirement current. It does not approve any gate or
remove missing capabilities: evidence, review and exact human model-handoff decisions
are still required. During transport downtime the current-model guard still refuses
creation. There is no automatic retry or model handoff. Hashes from the old v1 domain
are deliberately not equivalent to v2; existing v1 catalogue revisions remain immutable contracts.
A genuinely mismatched legacy contract requires an explicit **new human-reviewed recipe**.
The original approved recipe, source and pinned evidence are preserved: there is no silent
rebinding, migration, replacement of an approved model selection or re-signing of old records.

The parent-owned origin review/confirm path also checks live connection freshness; a
stable model revision does not bypass that UI check. This metadata/HTTP regression does
not claim that an old browser confirmation can be reused after reconnect.
A previously completed command's **receipt** remains a read-only journal observation
when the active model later changes in the same exact conversation. Its original
preview/HMAC/key and persisted conversation binding must still match. The current
snapshot may reflect stale model requirements; receipt lookup does not update the
recipe, execute the old request again or call `WorkStore.ready`. Executing the old model
preview, including an execute replay, is refused by the current-model guard.

## Focused offline regression scope

`tests/unit/workflow-native-model.test.ts` owns this sidecar's tests. Its pure projection
cases cover active-thread versus picker selection, canonical stable revisions, revision
changes, aliases/future efforts, bounds, invalid state and honest fixture provenance.
A separate loopback route test checks opt-in projection and explicit null.

The actual-product HTTP test uses `createConnectionLab`, an owned temporary project,
a **WorkStore double** and a **CodexService double**. It exercises the production
`/v1/codex/state`, workflow preview/execute and receipt routes. Counters assert zero
native actions, provider probes, handoff/review mutations and borrowed-store closes.
Only one workflow metadata creation is permitted. The completed receipt check asserts
that the double's data and ready counter are unchanged after a model change.
No StudioStore, real CLI, native protocol child, provider/account probe, provider
credential or paid-model test is involved. Existing HMAC/private-key ACL and ancestor
checks are used unchanged; no timeout or security assertion is relaxed.

## Reconnect regression (parent verified)

The v2 regression pins the hash domain, preserves selection revision across a new
connection ID, checks the new live proof ID and rejects the stale proof through the
actual browser decoder. Pending/unknown actions on the new connection and disconnected/
not-ready state still deny projection. Existing model/catalogue/project/thread/session/
plan/provenance-change and honest `spawned-node-fixture` tests remain.

An additional actual `createConnectionLab` HTTP fixture uses a real, borrowed project-
bound WorkStore, durable workflow journal/private receipt key, owned brief bytes and a
CodexService double. Its **explicitly borrowed synthetic `installed-cli` public metadata**
exercises policy prerequisites; it is not proof of an installed CLI or model integration.
Every native action and provider probe is forbidden. The case prepares creation, refuses
execution during downtime, then previews/executes/reads the same recipe after reconnect.
It separately prepares real hash-pinned brief evidence, submits and approves it through
human decisions, then prepares/executes an exact model-handoff gate across a second
reconnect. Reads and read-only draft preparation must retain human-handoff readiness,
while local patch/verification capabilities remain unsupported and the native task stays
pending. Creation replay must not duplicate a run; receipt/draft reads must not mutate
work, the agent token must be refused, and product cleanup must leave the borrowed store
open. Private-key ACL/path guards, 15-second HTTP deadlines and the 60-second fixture
bound are unchanged. No CLI process, model turn, Studio or provider/auth/config read is
part of this test.

Historical pre-v2 verification: **6 tests passed, 0 failed, 0 skipped**, approximately
14 seconds total. That result does not verify this reconnect patch. Parent later compiled 114 explicit product sources and ran the final eight projection/route/product/reconnect tests successfully (zero failures/skips). The assigned source,
test and doc were frozen before the parent's regressions; the worker did not
launch an independent compiler or test. Only `workflow-native-model.ts`, its unit test
and this document are changed; the browser fixture and Git state are untouched.
