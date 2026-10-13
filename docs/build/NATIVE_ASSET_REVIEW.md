# Native asset authority integration review

Reviewed 2026-10-13. Two actionable findings: one P1 revocation failure and one P2 session identity failure. Both were reproduced against current TypeScript source with explicit fixtures.

Product code was read only. The only repository write from this review is this document. No provider executable, provider configuration/authentication probe, Studio, Blender, AV/ACL change, Git mutation, root compile, or lab-server/lab-test edit was performed. Parent UI/route work and Ptolemy's lab work remain separate.

## Findings

### P1 — Journal failures can leave native mutation authority live after a requested revoke

Locations: **apps/daemon/src/codex-service.ts:209**, **:258-261**, **:299-303**.

The pending action INSERT executes before the lifecycle try/catch and before the revoke/disconnect/interrupt fence. If SQLite rejects that INSERT, an exact human revoke-assets action throws without calling revokeGrant() or retiring the incarnation. The existing credential and already captured actors remain usable. The comment at line 261 says the fence runs before the journal, but it runs only before the final journal update, after the initial INSERT.

The final transaction has a second escape: BEGIN IMMEDIATE at line 299 is outside its protective try/catch. If another connection obtains the SQLite write lock while a turn action awaits its native ACK, BEGIN throws after dispatch without calling retireAssets(). The dispatched admission remains open although the final receipt could not be committed. Also, the catch at line 303 attempts ROLLBACK before retirement, so a cleanup failure could bypass retirement too.

Reproduced using actual createCodexService, registry and SQLite, with a labelled fake client:

1. Connect, obtain a configured durable seal, grant assets and dispatch a synthetic turn.
2. Open a second connection to the owned fixture journal and hold BEGIN IMMEDIATE.
3. Submit an exact revoke-assets action with a fresh request UUID.
4. It rejects with ERR_SQLITE_ERROR: database is locked; granted and admissionOpen stay true, and the old credential still captures a mutation actor.
5. In a separate fixture, acquire that lock inside fake startTurn() after dispatch but before returning its ACK. The service's final BEGIN fails with the same live authority result.

Impact: a failed persistence operation prevents the user's stop control from fencing authority, or permits further native asset mutations while durable action state is uncertain. The HTTP error does not stop an already running native client.

Action: validate exact safety scope and fence it before fallible receipt persistence, or ensure every journal failure synchronously retires authority and closes the owned client. Cover the initial reads/INSERT and transaction BEGIN, and make retirement unconditional even when rollback fails. Preserve unknown/non-replayable receipts where persistence remains possible; do not redispatch model work to repair a receipt.

Missing regression: journal saturation is covered by tests/unit/codex-http.test.ts:154, but that does not exercise SQLite lock/I/O failures and does not include revoke-assets. Add lock fixtures for revoke, disconnect, interrupt and failure after dispatch; assert both fresh captures and preexisting actors are refused before the failed action settles.

### P2 — Setup notifications can replace the session from the configured ACK before durable sealing

Locations: **packages/codex-client/src/session.ts:526**, **:542-550**, **:561-564**, **:674-679**; downstream **apps/daemon/src/codex-service.ts:274-277**, **:305-309**.

#adoptThread() verifies the thread ID but assigns any non-null incoming session ID to the existing thread object. During the awaited initial MCP inventory, #threadOperation remains set, so a later thread/started notification for the same thread can replace the session obtained from the settings-validated thread ACK. The inventory checks retain object identity, turn state, account revision and model selection, but omit session identity.

The service then persists and seals the mutated snapshot. Its post-commit comparison against stagedHistory cannot detect the substitution: both copies came from that already changed snapshot.

Two reproduced sequences used the real session/transport logic, an in-memory protocol peer and the actual service journal/registry:

| Sequence | Configured ACK session | Durable and sealed session | Result |
| --- | --- | --- | --- |
| ACK, then same-thread notification during inventory | ack-session | notification-session | Acknowledged, configured, sealed |
| Notification, then ACK with explicit null session | null | notification-session | Acknowledged, configured, sealed |

For the second sequence, the null ACK never clears the earlier non-null session because #adoptThread() only assigns non-null values. A third sequence with conflicting non-null notification/ACK sessions is accepted by silently overwriting the notification with the ACK.

Impact: assets can be attributed to a session that the configured native ACK did not establish. Null is supposed to be an exact separate scope, not a fallback to earlier metadata. The registry's changed-seal fence does not help: the first seal already contains the substituted identity. This requires an inconsistent provider notification sequence; it is not a JSON actor forgery.

Action: retain the canonical tuple from the decoded configured ACK independently of mutable notification state. Define missing/null session semantics explicitly and compare the complete tuple after every setup await. Refuse and retire on incompatible identity updates; do not silently retain or replace a session. Persist/seal only the exact acknowledged tuple.

Missing regression: codex-client.test.ts checks malformed ACKs and changed thread IDs, and codex-mcp-isolation.test.ts:263, :273, :300 check disconnect/lifecycle/account changes during inventory. Add same-thread session substitutions before ACK and during held inventory, including null, and assert no seal/grant, no rewritten durable binding and no turn dispatch.

## Existing protections and remaining test gaps

Static review found the intended safeguards at these boundaries:

- native-asset-authority.ts:74-86, :150-156: WeakMap actors cannot be recreated by JSON/cloning; rechecks retain the original generation and exact project/conversation scope.
- native-asset-routes.ts:46, :59: capture precedes body reads and the same actor is checked afterward. Manifest/probe reads recheck after their awaits (:55-57, :74).
- asset-conversation-host.ts:173-192: creation admission rechecks after service preflight; witnessed allocation attempts one binding to the original capture even after revocation. Subsequent uncertainty never backfills or rebinds.
- codex-service.ts:301-313: successful normal commit precedes seal/grant; final grant is not applied before the human receipt commits.
- packages/codex-client/src/index.ts:61-90 and transport.ts:69-87: final credential acquisition follows discovery close, and local admission opens only after the turn write boundary. This is local dispatch intent, not proof of originating provider turn.

Current native HTTP integration tests use whole-body fetches and explicit runtime/client doubles. Component coverage is substantial, but the following boundary combinations still need focused regressions:

1. Hold a real native HTTP start/cancel body after capture; revoke, revoke/regrant, end the intent, or disconnect before releasing it. Assert zero allocation/cancel calls and no upgrade to a newer epoch. Host tests cover delayed service preflight, and shared asset HTTP tests cover body limits/draining; neither substitutes for this native body/authority combination.
2. Hold native manifest/probe completion across revocation or retirement and verify the original capture denies disclosure. Add native ingress cases for duplicate sensitive headers, wrong Host/origin, noncanonical paths and rejected chunked/stalled uploads.
3. Exercise journal INSERT, BEGIN, commit and rollback failures with actual authority, not only receipt saturation or host binding failure. Assert a failed thread receipt never seals and a failed grant receipt never grants; assert existing authority is fenced on uncertain dispatched work.
4. Carry host creation/binding ambiguity through the actual native HTTP route to the SDK: witnessed ID plus service persistence failure, missing witness, lost binding ACK, and foreign binding conflict. Require 202 with creation/association unknown, preserved original evidence and retry false, without recreation, scope adoption or fallback. Cancel failure after its synchronous mutation should similarly remain 202 unknown with its exact job UUID.
5. Extend immutable-session tests through service reopen and captures. UI stale-snapshot tests cannot validate that the backend sealed the right identity.

Relevant coverage read: native authority, native conversation host, native HTTP integration, Codex asset lifecycle, Codex client/isolation/discovery, Codex HTTP/history service, asset start admission, shared asset HTTP, and native MCP schema/SDK tests. The documented first delivery of an old request during a later valid conversation window remains a provenance limitation, not a claimed turn authentication guarantee. Conservative unknown creation results are intentional and are not a separate finding.

## Verification evidence

A targeted Node 24.21.0 harness loaded current .ts source with in-memory TypeScript transformation; it did not use stale dist output or compile the root. Provider spawn imports were redirected to a rejecting function or an explicit in-memory peer. Actual SQLite journals lived only under:

C:\Users\alexk\AppData\Local\Temp\arcane-native-asset-review-xNwisT

Observed assertions:

- INSERT-lock revoke failure: old credential can mutate; grant/admission remain live.
- Final-BEGIN-lock failure after dispatch: same result.
- Late same-thread session notification: ACK ack-session, persisted/sealed notification-session.
- Explicit null-session ACK following a notification: persisted/sealed notification-session.
- Conflicting non-null notification/ACK: accepted without a conflict fence.

Harness exit code: 0. These are passing reproductions of the findings, not a passing product regression suite. No repository test suite was run.

Finding-source SHA-256 values at review time:

- apps/daemon/src/codex-service.ts: CD3A77ED4A46BC057F533305C69AA059C21A4F32B812EB7CC99D8D12A889779E
- packages/codex-client/src/session.ts: 38BCE9B8AEB9F8123AFF06512AAF3D79102ABC364339CA9B4C0131097959D61F

Line references reflect the current source observed during this review; route/test refinements were arriving concurrently.

