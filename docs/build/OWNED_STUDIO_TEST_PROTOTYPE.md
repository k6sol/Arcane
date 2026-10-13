# Owned Studio test controller prototype — 13 October 2026

**Status: executable isolated prototype; partial native integration, not M3 complete.** The controller and an observed MCP execution backend compile and run against authoritative local fixtures using the installed official SDK 1.32.1. No real Studio calls, native executables, inference, publishing, asset uploads, installs, account-file access or Git operations were performed. Parent integration waits for the frozen full-regression gate to finish.

All implementation, fixtures, compiled outputs and run journals live in `runtime/verification/owned-studio-test-prototype-20261013/`. This document is the only other owned output. Existing apps, packages, tests, scripts, skills, currentplans and tasks.json are unchanged by this work. The existing native read adapter retains its read-only surface.

## Run and evidence

From the repository root:

```powershell
node runtime/verification/owned-studio-test-prototype-20261013/run.mjs
```

The runner invokes the installed TypeScript compiler with its own strict tsconfig, then Node tests with concurrency 1. It emits only into the prototype: `compiled/`, `compile.log`, `regression.tap`, `results.json`, and immutable per-case journals in `runs/`. It does not invoke the parent's build/test scripts or share their output directory. No dependency installation is needed.

**Verification: 35/35 tests pass; strict compilation passes.** `results.json` includes the actual exit codes, case totals and SHA-256 fingerprints of sources/config/fixtures. Every Studio/authority model is expressly fixture evidence. Virtual time controls leases, ACK deadlines and cancellation; ordinary asynchronous SDK/file I/O completes without advancing virtual time. IDs and journal directories are random; test behavior and outcomes are deterministic.

Cases cover success with a door attribute predicate driven by fixture keyboard input; same-name two windows; missing/exact identity; every binding component; stale/missing/future proof; ambiguous paths; authorization/scope tampering; raw code/eval/publishing/upload/extra fields; modes; tool removal/schema drift; single operation; delayed ACK; timeout; cancellation while input is held; duration and unused-lease expiry; unknown effect; assertion failure; cleanup unknown; lost/manual play ownership; crash projection; filesystem bounds; and atomic versus observed check/use races. Three cases exercise the reusable observed MCP backend against plain SDK tool results, without fake upstream command IDs or play tokens.

`fixtures/tool-discovery.json` copies six actual schema records from the read-only native inventory observation `runtime/verification/native-studio-inventory-abdJo0/verification.json`, observed **2026-10-13T13:12:34.436Z**. It retains the source hash, observation time, annotations and machine schema, under an explicit recorded-schema fixture label. This is historical discovery evidence, not a live binding or fresh capability proof. No property called `toolDiscovery` is claimed as an upstream wire field: it is this prototype's internal metadata projection. The recorded schemas contain no paired-session, private ownership, artifact hash, atomic compare/dispatch or owned-play-token arguments.

## Exact API

Types and strict runtime schemas are in `src/contracts.ts`; implementation is `src/controller.ts`:

```ts
new OwnedTestController({
  transport: TrustedNativeTransport, // trusted code injection only
  human: HumanAuthority,            // authenticated human consent port
  journal: DurableJournal,
  clock?: Clock,
  gate?: OperationGate,             // share across the host's controllers
  requestTimeoutMs?: number,        // default 1000; maximum 15000
  cleanupGraceMs?: number,          // default 5000; maximum 15000
  proofMaxAgeMs?: number,           // default 1000; maximum 15000
});

await controller.createLease(request: LeaseRequest): Promise<Lease>;
await controller.run(leaseId: string): Promise<ReviewProjection>;
await controller.cancel(leaseId: string): Promise<void>;
controller.review(): ReviewProjection;

await DurableJournal.open(absoluteDirectory, trustedExistingRoot);
await readJournal(absoluteDirectory, trustedExistingRoot);
project(entries); // restart/offline review; incomplete runs require reconciliation
await journal.close();
```

`LeaseRequest` accepts exactly `{ binding, steps, durationMs, approvalId, guarantee }`. Duration is 100–60000ms. Guarantee is explicitly `atomic` or `observed-non-atomic`; unsupported guarantees are refused. `HumanAuthority.consume(approvalId, scope, now)` must consume one exact human approval for `{ bindingDigest, planDigest, durationMs, cleanupGraceMs, guarantee }`. A caller-supplied audience, Boolean grant, bearer or claimed human identity is insufficient. Factory dependencies and transport options are never request fields. The fixture authority is a labeled test implementation, not production authentication.

The deeply frozen binding contains exactly:

```ts
{
  nativeStudioId, pairedSessionId, clientLifetimeId,
  pluginArtifactHash, scopeRevision,
  ownedMarkerProof: { registryId, instanceRef, nonce, nativeInstanceId }
}
```

The two session identifiers correspond to the bridge's paired `sessionId` and plugin-load `clientSessionId`; they remain distinct from native `studio_id`. `nonce` is an exact challenge corroborated against the private registry and native instance, not an attribute independently granting ownership. Plugin artifact and scope are SHA-256 values. Inventory names are display data only. No first-window selection, Name-only mapping, place-ID aliasing or guessed native identity is permitted. An exact unique native path is required only for addressing an already proven object, and cannot establish ownership.

Fixed declarative steps:

| Step | Arguments | Execution |
| --- | --- | --- |
| `startPlay` | none; exactly once, first | Edit precheck, fixed `start_stop_play`, Play/ownership postcheck |
| `navigateOwned` | none | verified owned object's exact unique path, Client navigation, speed 1 |
| `inputDown`, `inputUp` | key: E, F or Space | one Client key action; no text, arbitrary paths or action batches |
| `wait` | durationMs: 1–2000 | cancellable local timer, bounded by lease expiry |
| `assertOwned` | approved attribute name and Boolean expected | exact owned snapshot attribute; no executable predicate |

Plans have 2–32 steps, at least one assertion, one start and balanced input. No caller Lua, source evaluation, shell commands, external URLs, arbitrary native tool names, server mutation, inference, publication, generation, insertion or uploading is available. Expanding this registry requires reviewed code and separate consent. The controller does not create/edit a door or restore scene mutations; the parent prepares the disposable fixture through its existing typed edit infrastructure.

`TrustedNativeTransport` exposes only `evidence`, `supportedGuarantees`, `snapshot(binding, signal)`, `perform(command, signal)`, and `quiesce(signal)`. `NativeCommand` carries immutable binding/digests, local command/lease IDs, expected revision/mode, expiry, owned-play receipt, guarantee, cleanup flag and one fixed typed tool/action. These are **host transport context**, not invented SDK arguments. Only the recorded native arguments are sent over MCP. ACK receipts explicitly identify `fixture`, `host-observation` or `native-attestation` provenance.

## Guarantees and the executable observed backend

Atomic operation is optional. `native-atomic-v1` means a connector actually supports native compare-and-dispatch plus attested play ownership. Existing SDK schemas provide neither. No current native atomic implementation is supplied or implied; atomic fixture behavior is labeled as such.

`src/observed-mcp-transport.ts` implements `ObservedMcpTransport(alreadyConnectedSdkClient, observedProofSource, clock, evidence?)`, negotiating **only observed non-atomic** operation. It invokes the ordinary `start_stop_play`, `character_navigation`, and `user_keyboard_input` schemas. It adds strict local argument checks and fresh independent proof observations. Native responses are wrapped as local host receipts; no SDK atomic fence, native command ID or native play token is fabricated. This execution adapter works locally with real SDK in-memory tools; the missing production proof source is specified below.

`ObservedProofSource.observe(binding, signal)` returns `{ snapshot, playEpoch, continuitySupported }`. `snapshot` is the authoritative observation portion of `Snapshot`, excluding host-synthesized `play`, `playContinuity`, `evidence`, `corroboration`, and `heldInputs`. `playEpoch` is an independently observed paired-plugin transition counter. It is **not a field from get_studio_state**. The backend creates a host observed-play receipt only after Edit→Play is corroborated with exactly one epoch transition and unchanged lifetime/private proof. Any later epoch change or absent continuity makes stop ownership unverified. Native token ownership is a separate tagged type used only by an actually supporting transport.

Observed mode requires distinct human consent acknowledging that an effect can occur between the last check and dispatch. The controller checks exact binding before and after effects; the observed adapter rechecks before its MCP call. These checks detect changes but cannot make the call atomic. The race regression intentionally allows a navigation effect before a scope postcheck fails; no further test input is sent. Scope-revision changes stop new work and permit only bounded release/stop under the original stable identity, private proof and play receipt. A lifetime, marker, artifact, native ID or play-continuity change prevents stop of an unproven/manual/replacement session. Cleanup is then explicitly unknown.

At most one lease/controller operation is admitted per shared gate. No hidden queue or automatic retry exists. Input is conservatively marked held before dispatch. Timeout/cancel cannot clear an unknown effect: the original transport must settle before any further call. The observed backend keeps its mutating SDK request alive for its bounded original response, because SDK request cancellation does not prove the Studio effect stopped. `quiesce` awaits the whole original perform path; deadline/error/unknown settlement blocks further effects. A late ACK cannot revise the immutable terminal outcome. Cleanup key-up is a separately authorized compensation, not a replay of the original command; an unknown cleanup effect is never retried.

Lease expiry prevents work, and an unused admitted lease also expires automatically. Cleanup receives only its preconsented grace deadline. Cancellation of a running test is recorded by the run that owns journal ordering. Successful cleanup verifies Edit/no owned play and an empty tracked-input ledger. Unknown effect or cleanup latches review/fencing even if a later fixture response would succeed.

## Durable review and filesystem boundary

Each event is an exclusive sequence file, written and fsynced before dispatch. Records form a checked SHA-256 chain. Intent/result, one terminal outcome, cancellation and successive cleanup statuses are immutable records; teardown does not rewrite the test outcome. Raw source, native results, names, paths, tokens, marker nonces, human identities and exception text are excluded. Only fixed codes, approved action kinds/keys, evidence/guarantee, opaque lease ID and binding/plan digests enter the journal.

`ReviewProjection` supplies evidence/guarantee, digests, immutable steps, terminal, cleanup, held inputs, `requiresHumanReview` and `canStartAnotherOperation`. The raw terminal remains visible in the records; a succeeded test with unknown cleanup projects `needs_reconciliation`. An active lease displays an active/null terminal. Reopening an incomplete journal for offline review yields reconciliation, and the controller refuses any existing journal. No dispatch is recovered or replayed. `nativeAcceptance` remains false because this prototype cannot certify a live M3 gate.

Before generic journal mkdir/open/read/unlink, `src/paths.ts` requires an explicit existing trusted root, absolute descendant path, bounded path/depth and safe segments; checks all existing ancestors; and refuses symlinks/junctions, files as directories, alternate streams, traversal, reserved Windows names and redirected roots. Only regular single-link sequence/lock files are permitted. Limits: 512 records, 8192 bytes/file, 514 directory entries, 2048 path characters, 16 levels below root. Unknown filenames, oversized files and duplicate writers are refused before reads/writes. The standalone runner likewise checks its root and compiler/output trees before writing, with fixed output filenames and 1MiB file limits.

The managed Windows filesystem denied real link creation. Link/hardlink rejection uses explicitly labeled stat fixtures; oversized files and ordinary journal locks/hash validation are exercised on disk. These guards are not an OS sandbox or protection against a hostile filesystem racing path checks. Records are immutable through this API and hash-checked, not protected against an administrator recomputing the whole chain. A crash retains its writer lock; human reconciliation is required. Disk failures after an effect cannot certify teardown and require the host failsafe below.

## Exact missing production implementations

The observed execution adapter is implemented; **a trustworthy live binding source is not**. Parent integration must supply these concrete components after its current gate:

1. **`ObservedProofSource.observe` live implementation.** Add a bounded authenticated paired-plugin proof read exposing the current private registry ownership, exact challenge nonce/ref/native unique ID, plugin-load lifetime, installed plugin artifact hash, grants/scope revision, revocation and monotonic play transition epoch. Existing bridge v1 does not expose this proof/epoch endpoint. Corroborate it independently with fresh native `list_roblox_studios`, `get_studio_state` and exact single-match `inspect_instance` uniqueId/challenge attributes. Read plugin proof before/after native observation, compare identity/revision and reject ambiguity/unsupported epoch. Validate the actual state response format; do not guess it from a window title. Supply actual fresh bounded SDK listTools metadata (including list-change invalidation/pagination). The real challenge/native UniqueId relationship across Edit and Client datamodels must be tested in a disposable place. Unverified mapping remains disabled.
2. **Production `HumanAuthority.consume`.** Authenticate the human control audience, bind a displayed immutable plan to one-use durable consent including observed-race disclosure and bounded cleanup, preserve loopback/Origin rules, and exclude agent/model credentials. Plugin write pairing alone is not this test approval.
3. **Exclusive connection and durable host fence.** Give the observed adapter an independently owned SDK client under vetted existing installation discovery; do not expose or weaken the read adapter's private client. Share one gate and integrate a durable host-wide writer/reconciliation fence. The prototype's process gate plus per-journal lock does not prevent a fresh process/new journal from bypassing a prior unresolved run. Parent startup must detect unresolved journals before allowing any new test.
4. **Host/plugin failsafe and live gate proof.** Wire disconnect/shutdown/disk-failure handling to a bounded cleanup watchdog for only this owned testplay/input ledger. A process crash can leave native effects; the local prototype cannot promise physical key release afterward. Validate real play-epoch coverage, held-input release and ACK semantics. Then run the actual disposable-door proximity assertion, conflict/runtime-error/disconnect/cancel cases, and safe restoration. Screenshots, multiplayer, scene setup/restoration and M3 acceptance remain open.

These missing implementations are usable observational/native connectors and lifecycle integration, not a demand for an upstream atomic SDK redesign. Never replace missing proof with Name/window guessing or raw Lua. Parent must integrate and validate them only after its frozen full-regression gate finishes.
