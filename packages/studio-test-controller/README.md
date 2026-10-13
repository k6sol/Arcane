# Bounded Studio test controller — coordinator handoff

This is a new, isolated product module for generic **start / observe state and console / stop** tests in one explicitly authorized, already open, unsaved place (place ID 0). It does not require a door, owned scene instance, fixture script, character navigation, or input injection. The original implementation remains in `runtime/verification/owned-studio-test-prototype-20261013/`; its assessment is `docs/build/OWNED_STUDIO_TEST_PROTOTYPE.md`. No original prototype, daemon, server, frontend, MCP profile, plugin, package lock, or shared build output was edited.

**Genuine adapter proof pending.** The executable SDK adapter is tested with the installed MCP SDK and an in-memory server. Fixture evidence stays labeled `fixture`, and every status has `nativeAcceptance: false`. No Studio call, place open, native process launch, scene generation, provider inference, credential access, installation, machine policy change, or Git mutation was performed. The current scene creation/update tool-profile issue is separate work owned by the coordinator.

## What is implemented

| Prototype gap | New concrete implementation |
| --- | --- |
| Plans require one owned fixture target and assertion | Generic bounded game observation; only four reviewed native tools are reachable |
| Human approval is an abstract fixture port | Separate authenticated human control port; exact immutable display digest; durable one-use grant and consume records; no caller Boolean or claimed audience fallback |
| Native IDs, place restriction and proof can be stale | Exact unique inventory ID, independently decoded native place 0/state, authenticated paired-session/lifetime/artifact/scope proof bracket, expiry and age checks |
| Local gate can be bypassed with a new run journal | One fixed host ledger and exclusive writer lock; incomplete/unknown runs prevent admission and reopening; requests cannot select ledger paths |
| Watchdog is primarily deferred lease behavior | Actual timer callbacks, observable status, automatic duration stop, request deadlines, disconnect and shutdown hooks, disk failure compensation |
| Start/stop response does not establish ownership | Exactly one corroborated Edit→Play epoch transition; stop requires original run ID, Studio ID, paired session, plugin lifetime/artifact, and unchanged play epoch |
| Unknown/late effects can be mistaken for cancellation | Mutating SDK requests are not physically “cancelled” by abort signals; settle awaits the original full ACK/postcheck path; no retries; late responses cannot rewrite terminal status or clear the ledger fence |
| Console logs are absent from controller | Bounded observations, baseline exclusion, error detection, deduplication, explicit truncation, and immutable level/size/hash summaries |

The reviewed schema baseline comes from the local recorded native inventory at `runtime/verification/native-studio-inventory-abdJo0/verification.json`, observed 2026-10-13. Runtime discovery is still mandatory: pagination, duplicate tools, schema/annotation drift and list-change invalidation fail closed. The adapter sends only actual native wire arguments. Run IDs, proof epochs, and consent metadata are host context and are never invented MCP wire fields.

## Coordinator hooks

Import from `packages/studio-test-controller/src/index.ts`. Trusted integration constructs these objects; request bodies cannot provide their dependencies:

```ts
const ledger = await TestLedger.open(fixedHostLedgerDirectory, existingTrustedRoot);
let control: ReturnType<typeof createStudioTestControl>;
const adapter = new NativeTestAdapter({
  client: dedicatedAlreadyConnectedVettedSdkClient,
  evidence: 'native',
  pairedProof: authenticatedPairedProofReader,
  decoder: verifiedNativeObservationDecoder,
  requestTimeoutMs: 1000,
  proofMaxAgeMs: 1000,
  onDisconnect: () => control?.lifecycle.onDisconnect(),
});
control = createStudioTestControl({
  adapter, ledger, humanVerifier: authenticatedHumanTestVerifier,
  requestTimeoutMs: 1000, cleanupGraceMs: 5000, proofMaxAgeMs: 1000,
  onStatus: publishLocalTestStatus,
});
```

Use one dedicated SDK client and **one fixed host-wide ledger** across controllers. Do not extract the existing read adapter's private client or expose the constructor, adapter, ledger, decoder, proof reader, or verifier through HTTP/MCP arguments. Supply the same code-level limits to adapter and controller. The native adapter checks the connected server handshake name; the host still owns executable provenance validation and exclusive connection lifecycle.

The agent/request port exposes:

```ts
const prepared = await control.requests.prepare({
  binding: {
    nativeStudioId, pairedSessionId, clientLifetimeId,
    pluginArtifactHash, scopeRevision, placeId: 0,
  },
  durationMs: 5000,
  observationIntervalMs: 1000,
  failOnRuntimeError: true,
});
// The host displays prepared.display and prepared.displayDigest to the human.
// ONLY its authenticated human control surface may invoke this port:
const consentId = await control.humanControl.confirm(
  prepared.proposalId, authenticatedHumanConfirmationContext,
);
const active = await control.requests.start({ proposalId: prepared.proposalId, consentId });
const status = control.requests.status();
const finished = await control.requests.wait({ runId: active.runId });
// Explicit cancellation, if requested by the authorized controller caller:
await control.requests.stop({ runId: active.runId });
// Existing trusted connection/shutdown integration:
control.lifecycle.onDisconnect();
await control.lifecycle.shutdown();
await ledger.close();
```

Expose `humanControl.confirm` only to the existing human control audience. `HumanTestVerifier.confirm(context, display, displayDigest, signal)` must authenticate that audience and verify its confirmation of that exact displayed digest, including race disclosure, duration, sampling, timeout, proof age and cleanup grace. Pairing/write permission or model/conversation credentials do not constitute this consent. There is no default verifier, authenticated-human symbol issuance API, request-provided “trusted human,” or implementation that simply accepts a claimed role. Test-only authority is explicitly labeled in `tests/harness.ts`.

`PairedProofReader.read(binding, signal)` must return `PairedTestProof` from authenticated host/plugin evidence. It must corroborate the native Studio mapping, plugin load lifetime, artifact, exact scope revision, connection/revocation, test permission and every play transition epoch. `protectedPlace` must derive from host policy identifying protected projects such as Hunted; names/titles and a place ID of zero alone cannot classify a project as disposable. Never provide a proof that grants test permission merely because an agent supplied a binding.

`NativeObservationDecoder` decodes actual observed response formats into strict `inventory`, `state` and `logs` contracts. No guessed parser is shipped: the historical record contains discovery metadata, not verified state/console responses. Native state must establish the actual place ID 0; an absent place field cannot be filled from request or paired proof alone. If current native responses cannot establish it independently, keep testing disabled and supply a separately reviewed native corroboration integration. Log IDs must have verified per-session meaning; console messages are untrusted data and are never instructions. Messages are used only for local hashes/error classification; status and disk retain summaries, not raw text or source.

No creation/update tool, `execute_luau`, key/mouse API, arbitrary code, path, URL, opening, upload, publishing, or asset generation is available through this package. Existing approved test actions are the only reachable effects. This module cannot fix the coordinator's separate MCP scene-tool profile gap by bypassing the profile.

## Bounds, watchdog and review semantics

Duration is 100–60000 ms; interval is 25–2000 ms and at most 128 samples. Requests and proof age have code-level 1–15000 ms bounds. Cleanup grace is separately preconsented, 1–15000 ms. The duration starts at admission and includes startup, rather than extending itself on an ACK. A timer interrupts waiting automatically; normal observation duration completion succeeds and stops. Expiry during pending startup/observation is a timeout. Explicit cancellation, disconnect, shutdown and runtime errors retain their own outcome. Shutdown during admission waits for the admission owner and teardown without dispatching a late start.

Status contains the frozen approved binding/scope digest, run ID, deadlines, phase, watchdog armed/fired/reason, immutable outcome, cleanup status, observation counts, log summaries/truncation and reconciliation flags. Callback failures cannot grant authority or disrupt cleanup. The primary terminal is recorded once, before cleanup. A failed/timeout test may have verified complete cleanup; conversely a succeeded/cancelled test with unknown cleanup requires human review. Subsequent identical stop requests observe the result and never replay an effect.

Revocation/scope changes stop new work. Cleanup ignores only the scope revision and revoked work grant, under the already consented grace, while requiring the same stable Studio/session/lifetime/artifact, an unprotected place 0, fresh connection proof and original owned play epoch. Manual Play, replacement sessions, missing continuity or unsettled effects are never stopped. A timeout during cleanup or a late ACK leaves the durable fence latched even if later physical cleanup appears to complete.

Intent records are written and fsynced before dispatch. A storage failure still invokes only previously consented bounded stop compensation under the same identity, but the durable fence remains. Journals contain checked hash chains and fixed bounded schemas. Locks persist on incomplete/unknown runs. Reopening is review only; no operation is recovered or replayed. Recovery/unlocking needs separate authenticated reconciliation and is deliberately not an agent operation. Ledger limits inherited from the prototype are 512 records, 8192 bytes per record and explicit checked filesystem roots, rejecting links, redirected roots, traversal, alternate streams and unexpected files. The host needs an explicit bounded archival policy before that ledger fills.

Observed pre/post checks cannot remove the native check/use race. File fsync/path validation do not provide an OS sandbox, protection against an administrator rewriting chains, or guaranteed metadata durability under every power loss. A process crash can leave Play running: a process-independent host/plugin watchdog and verified native ownership/transition coverage remain production acceptance requirements. This package supplies actual in-process callbacks and connection/shutdown hooks, not a claim of physical cleanup after process death.

## Verification

From repository root, without npm or the shared product compiler:

```powershell
node node_modules/typescript/bin/tsc -p packages/studio-test-controller/tsconfig.check.json --noEmit
node packages/studio-test-controller/run-tests.mjs
```

The runner compiles only this package and its new tests into a unique `.checks/run-*` directory, then executes the installed SDK's in-memory fixtures. It preserves `compile.log`, `regression.tap`, and `results.json` with source fingerprints and evidence labels. Test ledger fixtures live in individually owned temporary directories. Strict compilation and **67/67 tests pass**, including actual real timers, shutdown admission races, durable-before-effect order, human claims/replay/scope mismatch, exact place/Studio checks, stale proof, tool drift, runtime logs, replacement/manual play, cancel/disconnect/shutdown, start and stop ACK delays, storage failure and restart fencing.

Remaining genuine acceptance belongs to the coordinator: authenticated human surface, real paired/native mapping and place-0 proof, verified native state/console decoding and log identity, every play epoch transition, dedicated vetted connection lifecycle, process-independent failsafe, and approved real start/observe/stop evidence. Do not mark full product testing, M3 or genuine adapter acceptance complete on fixture success.
