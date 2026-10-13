# Native MCP chat authority: design and implementation

The per-incarnation registry, durable conversation seal, separate human asset grants, native-only routes, MCP audience adapter, creation admission callbacks and permission UI are now implemented in source. Explicit provider/runtime fixtures exercise actual HTTP, SQLite and SDK wiring; installed Codex/Claude and Studio acceptance remain user-deferred. The new source is not yet in the last accepted bO9gOu executable. Do not claim provider-originating-turn provenance: the credential and local admission window attest a conversation, not the originating remote turn.

Independent review reproduced a journal-failure revocation bug and a session-notification identity bug. Fixes and regression proof are being integrated before a new package. Original failed verification reports remain retained; no automatic replay or permission relaxation is used.

## Baseline evidence before implementation

- `apps/daemon/src/asset-routes.ts::assetRoutes` authenticates `conversation-start` and `conversation-jobs` with `assertLearningHumanRequest`. `asset-conversation-host.ts::startHuman` captures one host conversation before creation, validates storage, then binds the returned job ID; persistence failure returns `association:unknown,retry:false`.
- `lab-server.ts::createConnectionLab` supplies that host conversation from configured `codex.state().snapshot.thread`, otherwise durable `nativeHistory`. That fallback supports human history/association; it cannot attest a live agent session.
- The same launcher creates one generic `agentToken`, supplies it to `CodexServiceOptions.arcaneMcp`, and accepts it on global asset routes. `apps/mcp/src/server.ts::createMcpServer` maps `assets_start` to `DaemonClient.assetsStart`, which posts `/v1/assets/start` directly to `AssetService.start`. It bypasses conversation association entirely. The separate `startAgent` host method deliberately returns unscoped and is not this HTTP path.
- Actual native identity evidence is in `packages/codex-client/src/session.ts::#openThread`: it correlates the native thread acknowledgement with the requested/observed ID, checks cwd/model/policy, and completes Arcane isolation before setting configured. `codex-service.ts::runAction` commits acknowledged thread identity into `native_history`. `sessionId` is optional native response data; the current type/storage permit exact null. These source checks are not installed-provider verification.

## Minimal private authority lifecycle

Add a narrow host-owned native-asset authority registry at `createConnectionLab`, integrated with `createCodexService`'s factory. It is not a generic profile service or HTTP registration endpoint.

Each randomly minted agent bearer maps privately to one launch incarnation, connection ID, canonical project path/project ID, provider, exact thread/session tuple, capabilities, and revocation/admission generation. Keep keys out of public snapshots, logs, URLs, argv, and durable association records.

Do not mint or supply mutation-bearing Arcane authority to the initial inherited-server discovery child. Use a secret-free/deny-mutation discovery specification with only already supported fixed process-local fields; never forward the generic daemon agent bearer as a convenience. If the required discovery isolation cannot be established with the installed contract, refuse this embedded route rather than reading or rewriting user config or silently switching routes. After discovery is closed and the isolated child specification is known, mint a fresh per-incarnation native key, initially unbound and denied all mutation routes, including generic fallbacks. Seal once from that exact client's successful configured thread acknowledgement plus the host's durable action commit. Notifications alone, pending setup, UI selection, saved history, and caller-supplied IDs cannot seal it. Reject every later identity change, including null-to-string session changes; never retarget a key. Retain `sessionId:null` as exact absence, with launch incarnation separately identifying authority lifetime.

Preserve `#openThread`'s existing one-thread-per-connection restriction. Reconnect/resume creates a fresh key and connection incarnation even for the same thread/session. A→B→A cannot revive A's old key.

Add synchronous private lifecycle callbacks at thread configuration, dispatch, terminal notification, interrupt/revoke, disconnect, and close; do not poll browser-visible state for authorization. Fence before awaiting cleanup. Account/isolation failures, unknown native ACKs, journal exhaustion, project mismatch, shutdown, or explicit asset revocation revoke admission immediately.

`packages/codex-client/src/index.ts::connectCodexClient` currently launches an inventory child, closes it, then launches the isolated child using the same process specification. Give each incarnation a different key; retire the inventory key before final launch. `session.ts::readHistoryProcess` also reuses that specification today: its helper must receive no asset authority and must not inherit the authority-bearing Arcane launch entry.

`mcp-profile.ts::prepareCodexProcess` remains a fixed bundled child/environment builder. Extend only trusted lifecycle seams in `types.ts`/factory/session; do not add asserted identity fields to provider RPC or copy provider OAuth/config.

## Dedicated actor routes and permissions

Add native-agent-only `/v1/assets/native/start`, `jobs`, `manifest`, and `cancel` routes. Retain literal-loopback host/peer checks, Origin rejection, bounded bodies/responses, duplicate-authorization rejection, and constant-time credential comparison. Authentication resolves a registry entry into an immutable host capability; request data contains bounded asset input, pagination, or job ID only. No project, conversation, role, grant, or callback assertion is accepted.

Add host methods such as `startNative`, `listNative`, and `bindingNative` in `asset-conversation-host.ts`; these use resolved private scope, never its human `conversation()` callback. Reuse normalization and `ConversationWorkStore.list/binding/bind` constraints. Hydrate only associated jobs; adapt `asset-conversation-page.ts::assetConversationJobPage` to accept a captured actor listing without routing agents through `listHuman`. Check ownership before manifest/cancel and after asynchronous reads; foreign and missing IDs must not disclose foreign metadata.

Give scoped native credentials no fallback to global asset routes. Human endpoints retain their distinct control bearer and approval rules. Generic caller/MCP bearer starts remain deliberately unscoped, and generic bearers are denied every bound route.

In `apps/mcp/src/main.ts`, `server.ts`, `daemon-client.ts`, and `asset-schemas.ts`, add a trusted launch adapter selecting native routes and validating scoped ACK/history envelopes. An adapter flag can select routing but cannot grant authority. Existing generic installations keep their generic adapter.

A dedicated human asset-execution grant enables start/cancel for this exact authority; scoped list/manifest are read capabilities. Add strict human-only grant/revoke actions to `codexActionInput`/`runAction`, authenticated by `codexRoutes`; resolve the exact live client internally and emit no provider RPC for the asset grant. Tool annotations, model text, and possession of a read capability do not grant mutation. NativeProvider outer grants/native file-command `ThreadState.writeGranted`, Studio pairing/root/write/edit-mode permissions, and human workflow review remain separate. This key authorizes none of their approvals or operations.

## Conversation binding versus turn fencing

Conversation authority is necessary for every durable asset association. Exact originating-turn attribution is a separate claim.

Add a private dispatch hook in `transport.ts::JsonlTransport.request` after successful local JSONL submission, used by `session.ts::startTurn`. Reserve the host operation/intent before dispatch; only successful dispatch opens its pending admission window. Failed isolation preflight opens nothing. This attests the host's dispatched intent, not remote acceptance.

A tool can arrive before the `turn/start` ACK, including before a native turn ID exists. Permit conversation-scoped admission under the sealed key, explicit asset grant, and dispatched pending intent. Do not wait for the ACK while servicing the tool: that can deadlock native execution. Native `#message`/`#serverRequest` can observe lifecycle IDs before ACK, but those IDs do not correlate a separate MCP call automatically. Terminal-before-ACK remains terminal; a late ACK cannot reopen admission.

Capture immutable authority/admission generation at first host ingress. Recheck after body reads, queue waits, and immediately before mutation. Never refresh a queued request into a newer generation. Terminal, interrupt, revoke, disconnect, and unknown ACK close the window. Retire old keys before reconnect; old queued/in-flight requests cannot execute through new A/B/A state.

Current MCP handlers expose `extra.signal`, with no proven provider-origin thread/turn linkage. Admission during a window does not prove the call originated in that turn. A prior-turn request first delivered during a later window of the same native session still has valid conversation scope; keep originating intent unproven. Strict rejection of that case requires a verified provider-correlated invocation seam or isolated per-intent child/capability delivery. Do not claim it from static environment credentials, MCP request IDs, current-turn lookup, or UI chat. This limitation must remain explicit until that separate seam is established.

## Creation, durability, and unknown outcomes

`AssetService.start` awaits `flushed()` before `pipeline.start`, then awaits persistence again. Route-entry checks alone race revocation. Add a host-private start reservation/guard rechecked immediately before `pipeline.start`, and a created-ID callback capturing its returned handle ID before subsequent awaits. Serialize that admission point with synchronous revocation.

After admission, completion and binding retain the original tuple even if the user switches chat or revokes access. Revocation prevents new mutations; it cannot rewrite accepted work. Perform association at most once using the captured ID. Only a durably confirmed association yields `bound`; expose verified results, not invented completion evidence.

Creation/service/association persistence are separate transactions. If creation may have occurred, return a structured unknown outcome with the known ID when available, association status, and `retry:false`; never turn a post-creation failure into a definitive safe-to-retry rejection. If no ID is witnessed, preserve unknown without guessing from name/time or attaching an existing global job.

Lost HTTP ACK: observe scoped history/association, never repeat start automatically. Association commit uncertainty remains unknown even when a later read finds its original row. Restart retains bindings, retires all keys/intents, and never replays work. A fresh attested authority may read the identical stored tuple; differing provider/session/project stays isolated. Missing bindings/orphans stay unknown/unscoped and require human inspection; reads never backfill them.

`ConversationWorkStore.bind` already enforces unique `(kind,work_id)` and refuses different exact native ownership. Preserve this conflict behavior and its scope-bound cursors. During shutdown, fence first and settle admitted scoped creation/binding before closing the association store; borrowed asset service ownership stays with its launcher.

## Concrete acceptance work, when authorized

Extend existing `tests/unit/asset-conversation-host.test.ts`, `asset-conversation-http.test.ts`, `conversation-work-store.test.ts`, `codex-http.test.ts`, `codex-mcp-isolation.test.ts`, and `mcp.test.ts` fixtures:

1. Distinct generic/human/native keys; unbound/forged/foreign/revoked keys rejected before side effects; scoped keys cannot call global routes or approve workflows/Studio/native grants.
2. Start binds once; isolated list/manifest/cancel; exact null/session/provider/project separation; foreign cursors and existing ownership conflicts.
3. Tool-before-ACK and terminal-before-ACK; failed preflight; reconnect/A→B→A; delayed body/queue/persistence races with revoke; no resurrection or context refresh.
4. Lost creation/HTTP/association ACK, pre/post-commit failure, restart and shutdown: no recreation/rebinding; unknown preserves witnessed identity; legacy jobs never adopted.
5. Inventory/history helper credentials cannot access bound routes. Test the explicit same-session prior-turn limitation without asserting fabricated turn provenance.

Acceptance requires source fixtures plus resumed installed-native tests proving actual dedicated-child isolation, credential delivery, request ordering, reconnect/revoke behavior, and any claimed invocation correlation. Claude's interactive `nativeLaunchPlan` handoff currently provides no host-attested conversation lifecycle; leave it unscoped until a real seam is demonstrated. Studio verification remains independently deferred. No probes, native turns, auth/config/token reads, Studio calls, AV/ACL changes, or git/remote changes were performed for this design. Arbitrary reference-model/image/rig/native-feature goals remain open.
