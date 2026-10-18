# Native Windows workspace preferences proof — 2026-10-13

**PASS within this isolated native integration scope:** installed Electron 44.7.0,
real Windows DPAPI via Electron safeStorage, production preferences/preload IPC,
and exact restart recovery for the same canonical project after a loopback port
change. Both hidden Electron app processes exited 0. The run finished at
**2026-10-13 17:12:33.160 UTC**, in **11,793 ms**. Packaged user UX and frontend
controller hydration remain **unverified**; parent UI/daemon work remains unfrozen.

The authoritative evidence is
`runtime/verification/native-workspace-preferences-proof-20261013/run-0af90bc3-173d-44cf-b448-62cecf74a1d2/`.
runner.json (`runtime/verification/native-workspace-preferences-proof-20261013/run-0af90bc3-173d-44cf-b448-62cecf74a1d2/runner.json`, local evidence, not committed)
and completion.json (`runtime/verification/native-workspace-preferences-proof-20261013/run-0af90bc3-173d-44cf-b448-62cecf74a1d2/completion.json`, local evidence, not committed)
both record `passed: true`. Phase reports retain actual IPC event identity,
generic rejection results and real filesystem operation observations, without
arguments, decrypted preferences or draft contents.

The existing executable was
`C:\Users\alexk\OneDrive\Documents\GitHub\Arcane\node_modules\electron\dist\electron.exe`,
SHA-256 `2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8`.
Both apps reported Electron `44.7.0`, Chromium `152.0.7977.130`, Node `24.21.0`,
`win32` and `isPackaged: false`. Each required native encryption availability,
then encrypted and decrypted a generated synthetic roundtrip sentinel with the
real Electron safeStorage object. The production factory received that object
directly, with no crypto double or plaintext fallback. Explicit native decryption
of the preferences ciphertext also matched the complete expected sealed payload.
Successful `available: true` observations were made only in this real native
encryption environment. The separate `enabled: false` probe returned exactly
`{available:false,preferences:null}` and rejected save. An actual DPAPI-unavailable
Windows environment was not tested.

All profile/session data, crash/log/temp paths, canonical projects A/B/C and
prepared runtime state live inside the run directory. The host supplied
`window`, `origin`, `epoch`, `projectPath`, `projectId`, `stateRoot` and `userRoot`.
The project SHA is SHA-256 of the lowercased canonical Windows path; the state
root is exactly `<owned profile>/runtime/projects/<project SHA>`. Renderer
`projectPath` is advisory only. Main-owned authority was never derived from
renderer input. The production main accessor was read to reproduce its trusted
tuple, but `main.cjs` startup was not executed.

The runner exclusively listened on `127.0.0.1:49183` for save, closed that server,
then exclusively listened on `127.0.0.1:49184` for the fresh-process read. An
occupied fixed port fails; there is no port-selection retry. Actual hidden owner
main frames loaded canonical `/studio` at their current owned origin. Windows
used unchanged production `preload.cjs`, sandbox and context isolation, ordinary
Node integration disabled, denied permissions/window creation, and production
request/navigation policy. The renderer bridge was frozen with exactly
`read,save,version`, version 1; renderer Node globals were absent and localStorage
was empty. Factory construction, handler installation and initial renderer load
made zero observed preferences-file accesses.

Harness-only `WebFrameMain.executeJavaScript` issued explicit test intents through
the production bridge. A registration observer forwarded genuine Electron
events and arguments unmodified into production handlers on real `ipcMain`.
Filesystem observers forwarded real filesystem methods and logged operation
names/owned paths only. No fake IPC event, direct handler invocation, live user
window, native CUA, product daemon or provider was involved.

| Native assertion | Observed result |
| --- | --- |
| Initial supported read | Exact `{available:true,preferences:null}`. |
| Production save ACK | Exact `{saved:true}` from owner IPC after real encrypted persistence. Uppercase advisory project input persisted the host canonical path. |
| Save/restart sequence | Save app PID **49832**: **5** real IPC intents, exit **0**. Fresh read app PID **51308**: **17** real IPC intents, exit **0**, after port **49183 → 49184**. |
| Snapshot restoration | Exact required fields: version/projectPath/provider/tabs/activeTabId, plus every localId/title/provider/threadId/sessionId/draft/modelId/effort/tool/previewOpen field. Top-level Claude selection, mixed provider tabs, null values, all three native tool labels, preview flags and active selection recovered exactly. IDs remained advisory; no resume or provider action was started. |
| Draft bytes | Exact UTF-8 comparison in the renderer before and after restart: **313, 0, 313 bytes**. Includes leading/trailing spaces and tabs, CRLF/LF, NUL, astral emoji, combining accent, CJK, Arabic and Unicode line/paragraph separators. |
| Native storage | Canonical outer envelope contains only `version,ciphertext`; **2,766 bytes**, **2,051 ciphertext bytes**, **2,020 decrypted UTF-8 bytes**. Native decryption matched the full snapshot and encrypted host project SHA. No raw drafts, tab metadata, project binding/path or plaintext preference JSON in either envelope or decoded ciphertext bytes. |
| Same project/fresh factory | Both fresh app and newly installed factory read the identical snapshot; construction/install remained inert. |
| Wrong project | Wrong advisory project save rejected before preferences-file access. Host-selected B read empty. A's copied native ciphertext in B rejected its encrypted project binding and was retained unchanged. B paired with A's state root rejected before preferences-file access. |
| Changed epoch | Read and save changed the trusted epoch after the actual IPC handler entered its async boundary; both rejected before preferences-file access. |
| Foreign window | A second hidden window on the same canonical origin used production preload; both read/save rejected before preferences-file access. Events recorded `sameOwner:false, mainFrame:true`. |
| Real owner child frame | Both read/save rejected before preferences-file access with `sameOwner:true, mainFrame:false`. The actual frame URL was policy-accepted `http://127.0.0.1:49184/`, so a disallowed URL did not explain rejection. |
| Bounds/input rejection | Valid **16 tabs** saved/read exactly. **17 tabs**, serialized input above **512 KiB**, malformed UTF-16 and missing required projectPath rejected in production preload before any IPC or preferences-file access. These probes do not claim exhaustive native testing of every bound or race fixture. |
| Lock/unknown preservation | The module rejected an existing lock without changing it. The harness then removed only that exact test-owned, identity-checked lock. An unknown-version C record was read once, rejected and retained unchanged without repair/retry. |
| Original record after attacks | Ciphertext SHA-256 stayed `ead5f338d29a69497baa5d647d76fc54a85ef5acfb0cbcbc949109d6264a9aa2`; authorized owner read remained exact. |

The hostile child-frame probe deliberately enabled `nodeIntegrationInSubFrames`
only on a separate hidden sandboxed probe window, allowing the production preload
to attempt genuine child-frame IPC. Ordinary owner/foreign windows kept that
option false. This test does not verify production window defaults through a
packaged launch or alter any production guard.

There were **22 genuine IPC intents** across the two apps: ten resolved and twelve
rejected with generic host errors. Four malformed input probes additionally
rejected in preload without IPC. These are isolated integration observations,
not a full product score or a rerun of the previously reported 39 host fixtures.

No generated nonempty draft or unique tab/title/thread/session/model/effort value
was logged or persisted in plaintext evidence. Fixture generation is reproducible
from the frozen `fixture.cjs` algorithm and public synthetic nonce; recorded
snapshot/draft evidence contains byte counts and hashes. Host fixture paths are
intentionally recorded as ownership/authority evidence. Bounded scans searched
the entire then-existing run/profile corpus for generated drafts and unique raw
metadata sentinels plus the native roundtrip sentinel in UTF-8 and UTF-16LE:

| Scan | Files | Bytes | Plaintext hits / skipped files |
| --- | ---: | ---: | ---: |
| After save | 51 | 1,415,786 | 0 / 0 |
| After restart | 62 | 1,515,518 | 0 / 0 |
| Final runner scan | 65 | 1,532,795 | 0 / 0 |

The final evidence seal repeats the scan after completion/process-check output,
includes exact input/output file hashes and binds this report. These scans cover
the owned corpus and stated encodings, not OS-wide memory/swap/backups or every
possible transformed representation. The encrypted B copy and encrypted evidence
snapshots are retained intentionally; the unknown C record contains no preferences.

Limits were **30 seconds per app**, **40 seconds per phase**, **120 seconds overall**,
**64 KiB diagnostic output per child**, and bounded scans of at most **2,048 files /
128 MiB total / 16 MiB per file**. No deadline, output or scan limit fired. Both
apps destroyed all owned windows and removed handlers before
`windows-destroyed-ipc-removed-will-quit`. Both fixture servers closed and the
runner emitted `owned-app-processes-exited-loopback-servers-closed`. No forced
termination was needed. The additional
postrun-process-check.json (`runtime/verification/native-workspace-preferences-proof-20261013/run-0af90bc3-173d-44cf-b448-62cecf74a1d2/postrun-process-check.json`, local evidence, not committed)
at **17:13:36.307 UTC** found all seven recorded runner/app/renderer PIDs absent
and neither fixture port listening. No process was terminated by that check.
No preferences lock/stage remained; unknown fixture files were preserved.

Only this production **CJS closure** was hash-frozen. Original files were checked
before each app, inside each app before/after execution, and at runner completion.
Exact input copies are retained under `inputs/`; original production paths were
executed. `main.cjs` is a read-only session/wiring reference, not executed startup.

| CJS file | SHA-256 before and after |
| --- | --- |
| `workspace-preferences.cjs` | `66037adf77063de06f5f344230d572325495994d659f9611d7f1671aea64e9ed` |
| `preload.cjs` | `528e14c7a40b227edaeed6da7b9060915343f0a61823d61f8bedb953a33d6b4a` |
| `policy.cjs` | `ab21836f28fadef2e9aedefa1e830ea78c3ea5663d1c2163971b4f999e7a6787` |
| `main.cjs` (read only) | `41139f4641da7f7253d65c7b0a423597c5268560a898dcb6e21f86961d18f02e` |

`cjs-hashes.before.json`, `cjs-hashes.after.json`, `sidecar-input-hashes.json`,
`fixture-input-manifest.json`, phase/inspection reports and scans retain the
verification inputs and outputs. `evidence-seal.json` inventories their exact
SHA-256 hashes; `evidence-seal.sha256.txt` binds that manifest without a recursive
self-hash. Later parent changes do not become covered by this snapshot.

Runnable entry: `node runtime/verification/native-workspace-preferences-proof-20261013/run.mjs`.
Verification of the retained seal:
`node runtime/verification/native-workspace-preferences-proof-20261013/seal.mjs run-0af90bc3-173d-44cf-b448-62cecf74a1d2 --verify`.
The native run used a scoped normal shell execution approval for this sidecar.
No security settings, antivirus policy, product source, production guards, global
verification settings or user-host enablement were changed. There was no full
build, packaging, Git operation, product-main execution, credential/auth-file
read, provider/Studio/MCP connection, inference or installation. Edits and native
profile/evidence writes are confined to the assigned sidecar directory and this
report. Actual packaged application startup, user-facing hydration/autosave UX,
frontend model/effort authority reconciliation and daemon behavior remain for
the parent to verify separately.
