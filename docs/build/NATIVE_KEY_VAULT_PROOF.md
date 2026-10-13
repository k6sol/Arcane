# Native Windows Studio key vault proof — 2026-10-13

**PASS: actual installed Electron 44.7.0, native Windows safeStorage encryption,
production vault/preload IPC, and recovery across separate Electron processes.**
The final run completed at **2026-10-13 15:27:29.957 UTC**, in **10,569 ms**.
It is an isolated native integration proof; it does not verify the full packaged
Arcane application or Settings UI.

The authoritative evidence directory is
`runtime/verification/native-vault-proof-20261013/run-8094a260-4709-4cea-a584-8993a99bb163/`.
[runner.json](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/verification/native-vault-proof-20261013/run-8094a260-4709-4cea-a584-8993a99bb163/runner.json)
records `passed: true`, three successful process exits, unchanged source hashes,
plaintext scan results, and the final terminal acknowledgement.

The runner launched the existing
`C:\Users\alexk\OneDrive\Documents\GitHub\Arcane\node_modules\electron\dist\electron.exe`;
its SHA-256 was
`2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8`.
Every child independently reported Electron `44.7.0`, Chromium `152.0.7977.130`,
Node `24.21.0`, platform `win32`, and native encryption available.
The production factory received Electron's actual `safeStorage` object directly.
There was no crypto implementation, AES test double, or plaintext fallback in the
sidecar. The Windows native encryption described in `STUDIO_KEY_VAULT.md` was
exercised by real `encryptString` and `decryptString` operations.

The fresh owned root was
`C:\Users\alexk\AppData\Local\Temp\arcane-native-vault-proof-0cfzWY`.
Its `profile`, `project-a`, `project-b`, temporary files, and per-project runtime
state were created for this proof. The fixed fixture was an owned HTTP listener
at `http://127.0.0.1:49173`; an occupied port fails instead of rotating identity.
All three app processes reused that listener identity and the same owned profile.
The synthetic UUID/key were constructed by the harness. The key used the Arcane
local-key format and the fixture port; no real user's key was loaded, and no
daemon-issued credential, API authentication, or Studio write grant was claimed.

Normal owner windows were hidden `BrowserWindow` instances with `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`, and
`nodeIntegrationInSubFrames: false`. Their actual main frames loaded the fixture's
canonical `/studio` URL. They used the unchanged production `preload.cjs`, whose
frozen `studioKeys` bridge was verified in the renderer; renderer `require` and
`process` were absent and localStorage was empty. Harness-only
`WebFrameMain.executeJavaScript` called that bridge in owned isolated windows.
These were explicit test intents, not human Settings interactions or UI automation.

The production `createStudioKeyVault` registered handlers on genuine Electron
`ipcMain`. A transparent registration observer recorded the actual sender,
`senderFrame`, main-frame equality, result, and file-access counts; it forwarded
the real event and arguments unchanged to the production handler. Filesystem
observers forwarded real operations and recorded paths/operation names only.
No fake IPC event, direct handler invocation, or renderer-side vault implementation
was used for the proof assertions.

| Actual assertion | Result and evidence |
| --- | --- |
| Remember through production preload and IPC | PASS. `remember.json`, PID **19752**, exit **0**, four real IPC intents. |
| Ciphertext cache, no plaintext key or ID in envelope | PASS. `remember.envelope-inspection.json`: exact `version,ciphertext` envelope, **406 bytes**, **280 ciphertext bytes**; explicit native decryption matched the synthetic key and encrypted project binding. The state directory contained only the cache, with no leftover stage/lock. |
| List returns only IDs | PASS. Exact reply `{available:true,items:[{keyId}]}`; no key, project, path, or extra item fields. |
| Explicit reveal matches | PASS. Renderer compared the returned key with the synthetic value and returned only a boolean to the harness. |
| Restart app and factory readback | PASS. `restart-reveal-forget.json`, PID **42792**, exit **0**, 26 real IPC intents. The new app loaded the persisted cache; a further fresh factory recovered it. Factory construction, IPC install, and renderer load recorded **zero vault accesses** before explicit test calls. |
| Cross-project rejection | PASS. Project B's own cache listed empty and could not reveal A's ID. Copying A's real native ciphertext to B caused list/reveal rejection. B paired with A's state root also rejected. |
| Epoch changes during an intent | PASS. The harness changed the owned session epoch after the production handler entered its async boundary; reveal rejected before any vault file access. |
| Foreign window/frame rejection | PASS. A second window with production preload attempted all four intents; each rejected before a vault read. A real child frame of an otherwise authorized owner also attempted all four intents and rejected before a read. The actual event had the same owner but `senderFrame !== mainFrame`. |
| Rejections preserve A's ciphertext | PASS. SHA-256 remained identical across project, epoch, foreign-window, and subframe attacks; the authorized owner still revealed afterward. |
| Forget makes the current cache unrecoverable | PASS. Forget resolved, list became empty, and reveal rejected. Explicit native decryption of the **210-byte** current envelope yielded `items:[]`, with neither key nor ID. A fresh factory still could not reveal; forget was idempotent. |
| Another app restart after forget | PASS. `restart-after-forget.json`, PID **12876**, exit **0**, two real IPC intents. List remained empty and reveal rejected; native decryption still found no key. |

The child-frame probe deliberately enabled `nodeIntegrationInSubFrames: true` on
a separate hidden hostile-probe window so the **production preload** could issue
real child-frame IPC. That window retained explicit sandbox/context isolation and
disabled ordinary Node integration. Its child URL was the canonical fixture root
`http://127.0.0.1:49173/`, verified as accepted by production navigation policy.
Thus a disallowed URL did not explain its rejection. This probe setting is not a
claim about the production window's defaults or the full production navigation
fences.

Bounded file scans after each app exit searched every regular file under the fresh
Temp root and then-existing run evidence for the complete synthetic key and its
64-hex suffix in UTF-8 and UTF-16LE. `remember.plaintext-scan.json` inspected
**44 files / 1,248,491 bytes**, `forget.plaintext-scan.json` inspected
**52 files / 1,326,743 bytes**, and `final.plaintext-scan.json` inspected
**59 files / 1,353,190 bytes**. All had **zero hits**; there were no skipped unreadable
files. Scans reject links/special files and impose file/count/total-byte limits.
These observations concern the owned proof files and these encodings; they are
not an OS-wide disk, memory, swap, crash-dump, or external-backup erasure audit.
The retained `remember.envelope.json` is intentionally a **synthetic encrypted
pre-forget evidence snapshot**, not the current cache. Forget does not erase such
backups or revoke daemon credentials.

The harness imposed a **25-second app deadline**, **35-second phase deadline**,
**150-second overall deadline**, and **64 KiB child diagnostic limit**. No deadline
or output limit fired in the final run. There were no detached launches. All owned
windows were destroyed, the vault IPC handlers removed, and each app emitted
`windows-destroyed-ipc-removed-will-quit` before its recorded exit. The runner
closed all fixture connections and awaited server close, then emitted
`all-owned-app-processes-closed-loopback-server-closed`. An additional
`postrun-process-check.json` at **15:28:17.890 UTC** found none of the eight recorded
runner, Electron-main, or renderer PIDs still running. It inspected only those
recorded PIDs, not a live user's app.

The source closure is the **original snapshot actually exercised**. Before/after
SHA-256 values were equal throughout this native run; parent regression changes
afterward are separate work and are not covered by this proof.

| File read for the closure | SHA-256 |
| --- | --- |
| `apps/desktop/electron/studio-key-vault.cjs` | `a137f7841dea2e114fe4f15fb7693f3d14b1920e44edc62fae5db0de7af40437` |
| `apps/desktop/electron/preload.cjs` | `17c65b71396a0389017444eed12cd728cca1874f96baf2201442310e043b0e7a` |
| `apps/desktop/electron/main.cjs` | `d5f4edbbf448713dd49d76905ae116a6a3765a4031ad23a8ffba8116863ad515` |
| `apps/desktop/electron/policy.cjs` | `ab21836f28fadef2e9aedefa1e830ea78c3ea5663d1c2163971b4f999e7a6787` |
| `docs/build/STUDIO_KEY_VAULT.md` | `a0c343d6532787fbb090a04dfb8b9c6053cc0d28bbd1e2b737bdcb6528c3f9d0` |

`source-hashes.before.json`, `source-hashes.after.json`, and `harness-hashes.json`
retain the full closure. The sidecar's runnable entry is
`runtime/verification/native-vault-proof-20261013/run.mjs`; it is run with
`node runtime/verification/native-vault-proof-20261013/run.mjs` from the repository.
Native launches used the normal reviewed shell sandbox-exception path after
initial pre-entry launch failures. No antivirus, execution-policy, or OS security
settings were changed. Earlier failed runs retain their own `runner.json` and
logs under the same owned prefix; they are not passing evidence. The earlier
successful `run-ae92f409-9ef5-4d30-8119-5e8caabe9163` is supplemental; the run above
adds a policy-accepted child-frame URL and recorded harness hashes.

`main.cjs` was read to reproduce its trusted session tuple and window preferences,
and was hashed, **but its full startup was not executed**. The harness supplied its
own session, projects, and loopback HTML fixture. It executed the actual production
vault, policy, preload, and Electron IPC/crypto. It did not boot the real daemon,
package/rebuild Arcane, verify packaged EXE recovery or frontend Settings controls,
connect Studio, issue/revoke a real grant, run a paid CLI/provider, install anything,
read credential files, or operate the live user's application. The parent's full
regression and later fixture/workflow repairs retain their own outcome.

This sidecar changed only its `runtime/verification/native-vault-*` files and this
report, plus explicitly owned fresh Temp proof/diagnostic state. It changed no
apps/packages/tests/scripts/skills or production source. Runtime evidence remains
local under the repository's existing ignored `runtime/` directory; preserve that
directory and the synthetic Temp root when reviewing this report.
