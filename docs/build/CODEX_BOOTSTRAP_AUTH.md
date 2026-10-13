# Codex bootstrap account announcements

Focused regression proof, 2026-10-13. The parent owns the production changes in `packages/codex-client/src/session.ts` and `index.ts`. This contribution writes only:

- `tests/unit/codex-bootstrap-auth.test.ts`
- `docs/build/CODEX_BOOTSTRAP_AUTH.md`

## Problem and parent contract

The supplied authorized-CLI observation is an `account/updated` notification with `authMode: "chatgpt"` during initialization, before initial account metadata settles. Previously, that announcement retired the freshly issued UNBOUND native asset key and initialization failed with `ACCOUNT_CHANGED` before connection completed. This observation was supplied by the parent; no installed CLI was invoked for this proof.

During initial bootstrap (`initializing && !ready && !thread`), an announcement still invalidates cached account metadata, increments the account revision, clears approvals and emits the account-change event. It preserves the fresh UNBOUND key while metadata is reconciled. Bootstrap metadata differences also cannot retire that key merely because an earlier provisional read returned a different plan.

Initialization checks the revision after the concurrent initial `account/read` and model catalogue requests complete. One complete account read is stable only when the revision advances by exactly two: read entry and read completion, with no intervening account announcement. If the initial pair is unstable, initialization makes at most two additional read-only `account/read` attempts with `refreshToken: false`. It never retries the catalogue, refreshes credentials, starts a thread or starts a model turn. Continued churn fails closed with `ACCOUNT_CHANGED`; stopping the transport retires hooks once.

After readiness, every account announcement retires native hooks, including another `chatgpt` announcement. Future metadata cannot restore readiness or authority. Existing strict thread setup and turn lifecycle behavior remains owned by the parent; this suite never opens a successful thread or starts a turn.

Signed-out account metadata may connect successfully. The reported catalogue retains unverified entitlement. Selecting a catalogue pair conveys no subscription entitlement: thread start/resume and write grants remain refused with `SUBSCRIPTION_REQUIRED`.

An own `account` field and boolean `requiresOpenaiAuth` are mandatory. Only explicit `account: null` means signed-out. An omitted account is incomplete protocol metadata and fails closed with `PROTOCOL`; it is not an instruction to ask a signed-in user to log in again. Two added fixture cases cover omission on the initial read and first reread. The bound above is explicitly two **additional** reads (three total), not two total; no inference or credential-refresh retries are performed.

## Synthetic proof

The tests construct the actual `CodexSession`, which constructs and uses the actual `JsonlTransport`. The only spawned executable is `process.execPath` running an inline Node JSONL peer. No session or transport implementation is replaced. Explicit frozen `NativeAssetHooks` doubles represent one freshly issued UNBOUND key and count dispatch, completion and retirement callbacks; they do not issue a real asset credential or invoke the authority registry.

The peer reads only owned fixture gates and writes synthetic JSONL receipts. Account and model replies are separately gated. Notification/response batches use one stdout write where exact ordering matters. Each gate gets a completion marker only after its JSON has been fully written, avoiding partial reads and Windows sandbox rename restrictions. Fixtures close the actual child and verify their resolved temporary-directory boundary before cleanup.

The 16 tests cover:

- Quiet startup, a ChatGPT announcement before the initialize ACK, and duplicate announcements before the first account read: ready metadata with no key retirement.
- A ChatGPT announcement during a held initial account read, with the model response both before and after the account response: a stable fresh reread replaces provisional metadata.
- An announcement after the first account response settles but before the model response: account metadata is visibly invalidated and initialization requires a reread. Receipts assert this order.
- Churn on the initial read and first reread followed by a stable second reread: three total account reads, one catalogue request and no retirement.
- Churn on all three account reads: `ACCOUNT_CHANGED`, disconnected transport, no readiness, one synchronous retirement from transport stop and no fourth read. The same proof runs with a throwing retirement double.
- Incomplete account metadata on the initial read or first reread: `PROTOCOL`, transport closure and retirement rather than a stability claim or another attempt.
- Post-ready `chatgpt`, `apikey` and null auth announcements while a future account read is held: retirement occurs before that response settles, cached metadata is cleared, and a subsequent metadata result cannot restore readiness. Repeated close never retires twice.
- Signed-out startup with and without an announcement: ready metadata, no automatic model selection, no thread or write grant and no asset intent.

Every test verifies that the only outgoing methods are `initialize`, `initialized`, `account/read` and `model/list`; every account read uses `refreshToken: false`. The thread, lifecycle-operation and approval collections remain empty, and dispatch/completion hook counts stay zero. The successful bootstrap cases assert that the key remains UNBOUND before cleanup.

## Private verification

| Check | Result |
| --- | --- |
| Scoped TypeScript 7.0.2 compile | Exit 0 |
| Node 24.21.0 synthetic suite | 16 passed, 0 failed, 0 skipped |
| Suite duration | Approximately 4.43 seconds |

The private compiler configuration extends the repository's strict options, names only the new test as an explicit root plus its import closure, sets empty `include`/`exclude` lists, uses an absolute Node type root and emits into an owned temporary directory. The tests pass the unchanged `CODEX_LIMITS` object directly to the real session, including the production 15-second request and 60-second approval timeouts. The test runner's own deadline and fixture gate polling do not alter product limits.

Retained verification directory:

`C:/Users/alexk/AppData/Local/Temp/arcane-bootstrap-auth-build-df8f4eb38d5e478ba5afb42766f6ecc1`

It contains `tsconfig.json`, ESM `package.json`, `manifest.json`, `compile.txt`, `bootstrap-tests.txt` and emitted source with source maps under `out`. The manifest records source fingerprints and verification results. The final successful run replaced the first fixture-only failure report after completion markers replaced renames.

Reproduce compilation from the repository:

```powershell
node node_modules/typescript/bin/tsc -p C:/Users/alexk/AppData/Local/Temp/arcane-bootstrap-auth-build-df8f4eb38d5e478ba5afb42766f6ecc1/tsconfig.json
```

Run the emitted suite from that private directory:

```powershell
node --test --test-concurrency=1 ./out/tests/unit/codex-bootstrap-auth.test.js
```

Verified source SHA-256:

- Parent `session.ts`: `7E99AFBD57F38FB1258E25F2CCCEE7D0F5777D135573A2121C476362CEB009CC`
- New test: `ACDD1A81E89FC8834FFE5EEBED73A77D54A3A6E3530ACE000D23BFBCE6C444FF`

No root compile or shared root `dist` output was used. No installed CLI, Studio, provider configuration/authentication read or write, discovery probe, network request or native inference was performed. Original application use cases requiring native inference remain deferred; this proof is limited to synthetic bootstrap metadata and authority fencing.
