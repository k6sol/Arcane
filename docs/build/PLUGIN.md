# Arcane local Studio plugin

## Artifact and rebuild

Run `node scripts/build-plugin.mjs` from the Arcane repository. The dependency-free builder writes:

- `plugin/build/ArcaneLocalBridge.rbxm`
- `plugin/build/ArcaneLocalBridge.rbxmx` — preferred modular local plugin
- `plugin/build/manifest.json`

Both model files contain identical **Roblox XML v4**, including the `.rbxm` compatibility filename; this is not a binary RBXM serializer. The manifest reports the format, byte counts and SHA-256 for each normalized source and both artifacts. The installer, daemon import preparation, doctor and release package use the preferred `.rbxmx`. `node scripts/build-plugin.mjs --check` verifies every output against current source without writing. Input order, BOM and CRLF differences do not change the package. CDATA terminators are split without altering script text; invalid XML characters, lone surrogates, missing modules and individual sources exceeding 199,999 bytes are refused. The combined hierarchy can exceed that individual-script bound.

The builder retains an in-memory factory representation for offline VM fixtures; it is never written to the build or shipped as a plugin. It validates literal module imports without runtime source evaluation. A rebuild removes an owned legacy generated `.lua` file; an unrecognized file is preserved and causes failure. Check mode and release packaging refuse a stale single-script delivery.

The only root item is an enabled Script named `ArcaneLocalBridge`. Its thirteen child ModuleScripts preserve the hierarchy declared by `PLUGIN_SOURCES` and `plugin/default.project.json`. Main requires `script.<Module>`; each child module requires `script.Parent.<Module>`. The plugin artifacts contain neither test doubles nor fixtures.

Plugin 0.1.9 also advertises the private host-owned `asset.reconstruct` capability. It consumes the actual sealed receiver once, allocates detached EditableMeshes through AssetService, and keeps their ownership private until cleanup. Its metadata receipt remains `imported:false` and `engineVerification:"pending"`; historical receipts never establish current resource lifetime, upload rights or native acceptance. See [the reconstruction boundary and verification note](STUDIO_RECONSTRUCTION_20261015.md).

## Installation handoff

Installation and native testing belong to the parent. Build does not install, open Studio or modify a place.

Prefer `ArcaneLocalBridge.rbxmx` and install exactly one Arcane artifact to avoid duplicate bridge workers. The installer verifies the complete deterministic build before changing a plugin folder. It preflights all three known filenames, refuses unrelated files, retains backups outside the active directory, installs the preferred artifact, and migrates owned legacy `.lua` and `.rbxm` files. A repeated install with matching bytes and no legacy files reports unchanged. Actual loading, reload and engine behavior remain a separate native acceptance gate. This packaging change does not install anything into Studio or verify that gate.

The plugin exposes exactly one **API Key** input and one red **Connect / Disconnect** button. Its compact charcoal panel uses a white/orange Arcane mark, a subtle divider, a masked field, actual connection status and returned root/write grants. There are no URL, pairing-code, credits or quota controls. Green appears only after a confirmed daemon session; connecting, unavailable, disconnected and reconciliation states remain distinct.

Issue a key through the human Arcane workbench (`POST /v1/studio/keys` with explicit `allowedRoots` and `allowWrites`). Model-agent bearers cannot issue or revoke keys; those controls belong to the parent workbench implementation. Keys are persistent until revoked and persisted hashed by the daemon. Revoking a key revokes associated sessions. Enter the Arcane-issued key in the plugin and click Connect. The plugin does not reuse third-party service keys or copy credentials from screenshots.

The canonical key format is `arcane_local_v1_<port>_<64 lowercase hex characters>`, matching the parent's backend parser. Port is ASCII decimal 1–65535 without leading zeros. The plugin rejects whitespace, Unicode digits, uppercase secret characters, suffixes, paths and alternate URLs. It derives only `http://127.0.0.1:PORT`; the user cannot supply an independent URL.

Connect sends `POST /v1/plugin/connect` with `{apiKey,protocolVersion:1,identity,capabilities}` and no bearer. The result has exactly `{sessionId,token,protocolVersion,allowedRoots,allowWrites}`. Only the returned session bearer is retained for poll/result/disconnect, and every operation rechecks the existing exact-session/lease/edit/write fences. The input is visually masked with hidden native text glyphs plus a fixed mask, then cleared before queuing a connection. Queued keys are discarded on replacement, disconnect or unload; exchanged keys are discarded before the yielding HTTP call, with the request itself necessarily carrying the transient key. No secret is echoed, logged, put in saved DataModel properties/attributes or plugin settings. Plugin GUI input exists transiently in memory.

An uncertain connect never automatically retries or stores the key for reconnection. The human must re-enter the key and click Connect again. Subsequent polling and identical receipt delivery retain bounded backoff. Legacy `requestPair(url,code)` and `/v1/plugin/pair` remain compatibility paths for fixtures only; Main exposes neither.

## Implemented defenses

Only literal `http://127.0.0.1:PORT` is accepted: no hostname, HTTPS, userinfo, path, query, fragment or external URL. Only connect, legacy pair, poll, result and disconnect plugin routes can be requested. The native plugin omits browser Origin; the daemon owns optional-Origin enforcement and distinct control/plugin bearer routing. Connect/pair use no bearer; subsequent routes use the in-memory session token.

There is one HTTP worker, a two-second poll interval and bounded exponential backoff to 30 seconds. A human-triggered key connection or legacy one-use exchange is never automatically retried after an uncertain response. Generation changes immediately fence disconnect/re-pair/unload, including source callbacks. Results retry identically until acknowledgement. Completed command IDs remain cached even after acknowledgement; capacity exhaustion refuses work rather than evicting IDs and allowing re-execution.

Every operation validates exact session/client IDs, protocol, grants, dispatched state, increasing lease epoch, expiry, method and edit mode. Writes require the paired write grant. References are opaque registered IDs scoped to this session and current granted root; duplicate names cannot alias and display paths do not resolve Instances. Traversal and outputs are bounded.

JSON output uses a canonical custom encoder with explicit null and array markers. A bounded parser preserves incoming null fields and array positions, differentiates empty objects/arrays, and rejects duplicate/reserved keys, malformed JSON and excessive nesting. Only string unescaping uses native JSONDecode. Source is limited to 100 KiB UTF-8, arguments to 256 KiB, results to 512 KiB. Source receipt encoding is checked before mutation, including JSON escape expansion.

Properties/classes/materials use explicit allowlists. Creation validates all input before allocation/parenting; new Script/LocalScript instances are disabled. Update baselines must cover exactly the changed properties. Receipts snapshot actual engine values, including float32 vectors/colors, rather than caller representations.

Source reads use GetEditorSource. UpdateSourceAsync checks the exact baseline and session fence in every non-yielding callback; a conflict stays cancelled across callback reinvocations. It rereads the editor after completion. Restore requires the immutable local receipt and current exact after-state. Create restoration additionally requires private ownership, unchanged parent/supported properties/source/attributes/tags and zero children, checked again immediately before destruction.

Mutations use ChangeHistoryService recordings. Any potentially partial write reports a failed result with recovery details, `rollbackVerified:false` and reconciliation required, and blocks further work. A broad undo is not claimed as a safe rollback of concurrent user edits. No arbitrary Luau evaluator, numeric/external require, publish, asset insertion, play launch, purchase or persistence endpoint exists.

## Local verification

Run in PowerShell with an **already installed** official Luau toolchain:

```powershell
$env:ARCANE_LUAU_BIN = 'C:\Users\alexk\AppData\Local\Temp\arcane-luau-tools\luau.exe'
$env:ARCANE_LUAU_COMPILE = 'C:\Users\alexk\AppData\Local\Temp\arcane-luau-tools\luau-compile.exe'
node --test tests/plugin/*.test.mjs
node scripts/build-plugin.mjs --check
```

Without those environment variables, the compiler/runtime tests explicitly skip; nothing is downloaded. Tests inspect XML nesting and source/module names independently, reconstruct CDATA, verify source require relationships and manifest hashes, test deterministic output and stale detection, compile the generated native `.lua` artifact, execute its original Main and module cache with GUI doubles, and execute `plugin/fixtures/Logic.spec.luau` in the real Luau VM with `MockEngine.luau` doubles both through source modules and through the generated factories. Tests create only disposable directories and remove those exact directories. They do not certify native Studio behavior.

## Parent's disposable native acceptance

Use a newly created, unpublished disposable baseplate with a uniquely recorded Studio ID. **Hunted and all existing work are outside scope.** Parent owns the native fixture; none is automatically run or packaged here.

1. Verify native `.lua` toolbar/widget creation and unload cleanup; when testing an XML alternative, additionally verify model import and six child ModuleScripts. Load exactly the manifest-hashed artifact.
2. Verify the single masked key field, absence of URL/code/quota controls, immediate field clearing, initially nongreen status, and actual `/v1/plugin/connect` from the installed file plugin. Confirm read-only grants, exact roots/session/client identity, same-name sibling references, empty selection/search JSON, and that inspection never returns Source automatically.
3. Disconnect and connect with a human-issued key granting explicit writes; create a Folder, Part and disabled Script. Update allowlisted properties with expected baselines. Verify actual receipt values and one Studio undo recording per mutation.
4. Open a script in the editor, make an unsaved change, read it, update against that exact baseline, and introduce a concurrent edit. Confirm baseline conflict never overwrites the user's edit and the callback does not yield.
5. Restore a successful update/source receipt only while its after-state matches. Refuse restoration after later changes. For create, test child, name, parent, Disabled, source, attribute and tag changes; only the unchanged owned object may be destroyed.
6. Enter play mode and verify commands fail their edit fence. Disconnect/reconnect while a poll or editor update is outstanding; revoke the human key and verify associated session rejection. Restart daemon and verify old bearer/session rejection without replay. Drop a result acknowledgement and verify only identical receipt retries occur.
7. Use a separate loopback test server to validate native timeout and HTTP redirect behavior. Test 301/302/303/307/308 with a second loopback listener and a synthetic test token; record whether any redirected request arrives. Do not use a real session bearer or external endpoint for this check. Do not label strict no-redirect transport verified unless the installed engine actually refuses redirects or a enforceable transport change exists.

## API verification and remaining native limits

Checked current primary Roblox docs on 2026-10-11: [HttpService request options](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/HttpService.yaml) explicitly include positive integer `Timeout`; the plugin uses 10 seconds. [Plugin](https://create.roblox.com/docs/reference/engine/classes/Plugin) documents `CreateDockWidgetPluginGuiAsync`; [DockWidgetPluginGuiInfo](https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo) supplies the constructor. [ScriptEditorService](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/ScriptEditorService.yaml) documents callback reinvocation, no yielding, and nil cancellation.

The HTTP API documents no redirect-disable request option or final response URL. Code refuses exposed 3xx responses and never reads Location or constructs a response-directed URL; **engine-followed redirects cannot be proven absent by static or doubled tests**. This is a native acceptance limitation, not a claimed solved defense. Model-extension compatibility, native widget loading, editor concurrency and actual undo behavior also require the parent's Studio test.
