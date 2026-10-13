# Bounded disposable native plugin acceptance

Prepared runner: `runtime/verification/prepare-plugin-acceptance.mjs`. Preparation and this implementation work do not install a plugin, open Studio, connect a session, run inference, upload or publish. Parent owns every live Studio action. This plan covers only a fresh unpublished disposable baseplate; Hunted and existing work are excluded.

## Parent prerequisites

1. Resolve the exact disposable native Studio ID and confirm edit mode in that window. Record its identity and empty baseplate context. Preserve all existing work in other windows. Installation/loading authorization is limited to the disposable window and Arcane's own plugin.
2. Follow [PLUGIN.md](PLUGIN.md) and inspect `scripts/install-plugin.mjs` before installation. Load exactly one genuine native `.lua` bundle whose installed bytes match `plugin/build/manifest.json`; record its SHA-256. The installer migrates Arcane's model alternatives to backups outside the active plugin directory and can overwrite an Arcane Lua bundle, so the parent must verify the actual folder and existing files first. Building alone does not certify installation/loading.
3. Connect through the installed plugin's masked API Key field with a human-issued key granting **only `Workspace` and explicit writes**. The current UI uses `/v1/plugin/connect`; the URL/code pairing description in the older `BRIDGE_CONTRACT.md` is compatibility documentation, not the current native UI. Do not invoke legacy pairing from this runner.
4. Corroborate the exact plugin lifetime `clientSessionId` and returned Arcane session ID against that same disposable native window. Record exact paired name, `connectedAt`, plugin version, place ID `0` and universe ID `0`. Place ID `0` by itself cannot identify an unpublished window. Parent must verify the mapping externally; the Arcane bridge does not expose the built-in MCP Studio ID.
5. Use a dedicated idle pairing for this run. Prevent manual edits, other command clients and place switching until the runner stops. The daemon must select the Arcane repository as its project; WorkStore hashes evidence under that project. Inject its scoped **agent bearer** into `ARCANE_LOCAL_TOKEN` in the runner process, without reading credential files or placing a token in CLI arguments, plans, reports or screenshots. Do not use the plugin API key, plugin bearer or provider credential.

## Offline preparation

Node 24 or later. Preparation makes no HTTP request and needs no bearer. Every identity field is mandatory; no active/default session is selected. Replace the placeholders with exact nonsecret observations:

```powershell
node runtime/verification/prepare-plugin-acceptance.mjs --prepare `
  --daemon-url 'http://127.0.0.1:PORT' `
  --studio-id 'EXACT_NATIVE_STUDIO_ID' `
  --session-id 'EXACT_ARCANE_SESSION_ID' `
  --client-session-id 'EXACT_PLUGIN_CLIENT_SESSION_ID' `
  --place-id 0 --universe-id 0 --place-name 'EXACT_PAIRED_NAME' `
  --plugin-version '0.1.0' --connected-at 'EXACT_SESSION_TIMESTAMP' `
  --artifact-sha256 'INSTALLED_NATIVE_LUA_SHA256'
```

The runner writes a new `runtime/verification/plugin-acceptance-UUID/plan.json` and prints its plan UUID and `disposable-baseplate:SHA256` confirmation. The confirmation binds the complete target, artifact hash, fixed operations and bounds. The place name is stored as a digest. Preparation does not verify the installation or pairing; the parent prerequisites do that. Runtime files are ignored by Git, including the requested runner path; preserve/hand off this runner explicitly if transferring the change.

## Parent-only execution

After corroborating the target and pairing, use the printed UUID and confirmation:

```powershell
# ARCANE_LOCAL_TOKEN is already injected into this process by the parent.
node runtime/verification/prepare-plugin-acceptance.mjs --execute `
  --plan-id 'PLAN_UUID' --confirm 'disposable-baseplate:PLAN_SHA256' `
  --parent-verified-target
```

`--parent-verified-target` attests to the prerequisites, including native identity mapping, genuine installed artifact, current edit mode and exclusive fixture use. It is not a substitute for observing them. Confirmation is required before HTTP or an execution record. No arbitrary plan/output path is accepted. Linked ancestors and hardlinked plan files are refused. Exclusive execution-start creation prevents replay of a used plan, including after a crash.

Execution uses the genuine existing HTTP bridge and daemon WorkStore only:

1. Recheck the daemon project, exact session/lifetime/place/name/version/pairing timestamp, sole `Workspace` write grant, supported methods, fresh heartbeat and idle session history. Create and claim one scoped WorkStore task before any Studio command. WorkStore failure stops execution.
2. Resolve the actual registered Workspace root through bounded `scene.search`. Opaque references come from plugin results; the runner never invents an Instance ID or resolves a display path. Read an untruncated Workspace baseline, limited to 16 children, with only Camera, Terrain, Baseplate and optional SpawnLocation. A Baseplate Part must exist. This is an additional structural guard, not proof of a disposable window.
3. Create **one empty Model**, `ArcaneAcceptance_UUID`, directly under that root. Verify its genuine `scene.create` receipt, exact Name and zero children through `scene.inspect`.
4. Rename only that Model to `ArcaneAcceptance_UUID_Changed` using `scene.update` with the exact original Name baseline. Verify the before/after receipt and actual inspected Name.
5. Undo the rename through `POST /v1/studio/restore` with its succeeded command ID. The daemon builds the inverse from the immutable receipt; the plugin also verifies its private receipt and current after-state. Inspect the original Name and zero children again.
6. Restore the creation receipt, removing only that unchanged privately owned empty Model. Require `{restored:true,ref}` for both restores. Read Workspace again and compare the complete bounded child membership, IDs, names, classes and child counts to the original baseline.
7. Submit `report.json` once to `/v1/work/submit`; verify the returned evidence hash and `needs_review` state. The runner cannot approve its own work and never calls the human review endpoint. Parent adds its native evidence separately and reviews the actual result.

The fixed sequence has **10 Studio commands, at most four writes**, one Model and one Name property change. No scripts, Parts, assets, play launch or account operations. Each command has one POST and GET-only receipt polling, a 15-second enqueue/wait bound and a five-second HTTP bound. Execution has a 120-second total bound plus 15 seconds for final evidence/journal handling, 420 total HTTP requests maximum, 1 MiB responses and 16 KiB requests. Grants, identity, idle state and foreign commands are rechecked before every command. Work progress renews only this task's cooperative lease. HTTP uses literal IPv4 loopback without proxy discovery or redirect following.

## Failure, unknown and evidence handling

Every command intent is written before its POST; acknowledgement and terminal summaries are written exclusively as separate files. They retain request and command IDs, observed state, lease/expiry and cryptographic receipt/result digests. The final redacted report includes validated owned mutation receipts, restore command summaries, baseline digest and outcome. It omits bearer/lease tokens, raw service errors, source, untrusted scene text and other sessions. The daemon retains the authoritative full command receipts; the report is a summary, not a replacement journal.

A failed, cancelled, partial, reconciliation, timeout, invalid acknowledgement, concurrent command or identity mismatch stops the sequence. **There is no compensating write in `finally`, automatic command retry, cleanup deletion, revoke, re-pair or inference fallback.** A successful earlier creation may remain in the disposable fixture. Treat an unacknowledged or timed-out command as unknown; it may execute later. The daemon currently assigns commands a 180-second expiry, so the runner's shorter timeout does not cancel execution. Keep the disposable window isolated and inspect the retained exact-session receipts before recovery.

When possible, failure/unknown evidence is also submitted to WorkStore as `needs_review`, with its failed/unknown outcome explicit. Submission itself is sent once and can become unknown; `submission-unknown.json` instructs the parent to inspect the run. WorkStore has no public failed/interrupted setter, so the runner cannot manufacture that task state. Unsubmitted claimed work remains in progress until its genuine lease expires. A report file is never rewritten after submission. Exit 0 means both guarded restores, baseline comparison and hashed submission succeeded; it still requires parent review. Nonzero never certifies failure before a mutation was applied or successful restoration.

## Exact API gaps and verification limits

- **Native identity/provenance:** `StudioIdentity` has client lifetime, place/universe IDs, name and plugin version; it has no built-in MCP Studio ID, installed artifact digest or proof of a native plugin. `/v1/studio/sessions` still returns the initial pairing snapshot. The updated plugin pins that exact initial engine identity, watches changes and compares current PlaceId/GameId/Name before polling/dispatch, after HTTP waits, in operation/callback guards and around editor calls. An observed change blocks the old session permanently even if values revert; existing receipt delivery cannot re-enable work. See [PLUGIN_IDENTITY_FENCE.md](PLUGIN_IDENTITY_FENCE.md) for offline verification and engine scheduling/tuple limitations. The parent must rebuild/reinstall this updated artifact; the previously installed hash lacks the fence. Parent corroboration and no place switching remain prerequisites. This runner cannot independently prove installation/provenance/current-window mapping.
- **Atomic reservation:** there is no HTTP session reservation/compare-and-enqueue token. History checks detect observed foreign commands, but cannot close the race after a GET and before enqueue. WorkStore leases coordinate file scopes and are not Studio locks. A dedicated fixture session with parent-enforced exclusive use is required.
- **Cancellation/reconciliation:** no control endpoint cancels an acknowledged queued command or repairs an unknown native outcome. Stopping a client wait does not stop Studio. Retain the command IDs/request IDs and inspect history without resubmitting.
- **Global native Undo:** no bridge method exposes ChangeHistoryService Undo, history inventory or its native UI. `Operations.record` commits a native recording before returning mutation success, and both restore mutations create recordings, but receipts do not enumerate the Undo stack. This runner tests explicit guarded receipt restoration. Parent may separately inspect the native Undo affordance/recordings in the disposable window; report it separately. Never claim that the runner clicked Undo or validated the whole Undo stack.
- **Restore receipt shape:** `scene.restore` returns `{restored:true,ref}` rather than an inverse `MutationReceipt`. The runner validates that genuine response and reads the actual Model/Workspace afterward. It does not fabricate before/after restore receipts.
- **Restoration breadth:** the final check proves bounded Workspace child membership and the owned Model's Name restoration/removal. It is not a byte-for-byte saved place diff or proof that all properties of every existing object were unchanged.
- **Fault/native coverage:** GUI masking/loading/unload, editor source concurrency, duplicate delivery, dropped acknowledgements, actual engine HTTP redirect behavior and play-mode fences remain outside this deliberately tiny acceptance. Use the broader [PLUGIN.md](PLUGIN.md) native matrix only within separately authorized scope. This runner never calls built-in `execute_luau` or any raw Luau fallback.

These gaps do not justify inventing an endpoint or silently weakening a guard. If the parent cannot satisfy the prerequisites, retain the prepared plan and do not execute it. Local syntax/offline protocol checks are not native Studio acceptance evidence.

## Preparation verification

On 2026-10-13, `node --check`, CLI help and actual offline CLI preparation passed. An isolated temporary loopback harness compiled the current `studioRoutes`, `StudioStore` and `WorkStore` sources and used **synthetic plugin responses**, never a Studio instance. Its successful case verified 10 commands, four write attempts, two receipt restores, removal of the owned Model and genuine hashed `needs_review` submission. A failed update stopped after five commands with the Model retained; an applied create with a withheld receipt stopped after three commands as unknown, retaining its exact request/command IDs and issuing no cleanup. A pairing identity mismatch issued zero Studio commands. Confirmation, unpublished-place/name/endpoint/budget guards, replay refusal, redirect refusal, HTTP timeout, response-size rejection and report token/error redaction also passed. These checks establish local runner behavior only; native plugin acceptance remains unrun and parent-owned. Only synthetic fixture output directories were removed after these checks; the runner retains failures/unknowns from a parent native run.
