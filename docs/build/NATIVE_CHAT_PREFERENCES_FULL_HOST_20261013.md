# Native chat preferences full-host follow-up — 2026-10-13

**Current result: PASS for actual default-main chat preference recovery.** After
the user authorized short-lived visible owned test windows, the unchanged host,
production frontend/controller/preload and real DPAPI completed the two-process
proof below. The earlier hidden-only preflight is retained separately as history;
it is not acceptance evidence. Packaged EXE, keyboard, model and Studio acceptance
remain outside this proof.

**Earlier preflight disposition, superseded: BLOCKED, not passed.** The frozen default-mode
`main.cjs` explicitly shows its BrowserWindow on `ready-to-show`. The requested
hidden-only full startup cannot be completed without suppressing that production
callback, replacing its `show()` behavior or changing constructor options. Those
interventions were not made. The smoke-only path keeps the window hidden but
constructs preferences with `enabled: !smoke`; its 25 smoke checks cannot prove
encrypted draft recovery. No actual default-main/frontend/controller recovery
claim is made by this follow-up.

The concrete conflict is in the unchanged
[main.cjs](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/apps/desktop/electron/main.cjs:155):

```js
window.once('ready-to-show', () => {
  firstReadyMs = performance.now() - started;
  if (!smoke) window.show();
});
```

`makeWindow()` starts with `show:false` but does not set
`paintWhenInitiallyHidden:false`. The installed Electron 44.7.0 declarations
document that option as a constructor setting which prevents `ready-to-show`.
They document `show()` as showing/focusing the window and the BrowserWindow
`show` event as a notification with a zero-argument listener, not a cancellable
before-show event. Hiding in response would occur after the show request; it would
not establish that the window remained hidden. No default-mode hidden option is
accepted by the host's argument parser. This is a conflict in the requested
execution scope, not an observed preferences/controller defect.

The owned-profile bootstrap itself is feasible. A bounded, **windows-free native
preflight passed** in two fresh installed Electron processes, using genuine
Electron `appData` and `userData` APIs and the actual production path policy.
It deliberately did **not** require `main.cjs`, start a product daemon, construct
the preferences factory, load the frontend or issue renderer intents. Its
cross-process ciphertext is a synthetic DPAPI sentinel, not a native preferences
record. `acceptancePassed:false` is explicit in the runner, every phase report
and completion record.

The evidence directory is
`runtime/verification/native-chat-preferences-full-host-20261013/run-51040b27-d155-4ec5-934b-ef8b7a9884ff/`.
[runner.json](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/verification/native-chat-preferences-full-host-20261013/run-51040b27-d155-4ec5-934b-ef8b7a9884ff/runner.json),
[acceptance-limitation.json](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/verification/native-chat-preferences-full-host-20261013/run-51040b27-d155-4ec5-934b-ef8b7a9884ff/acceptance-limitation.json)
and `completion.json` retain the distinction. The run finished at
**2026-10-13 19:35:05.405 UTC**, in **1,061 ms**, with no error, timeout or forced
termination.

| Native preflight observation | Result |
| --- | --- |
| Installed runtime | Electron **44.7.0**, Chromium **152.0.7977.130**, Node **24.21.0**, Windows. Existing executable SHA-256 `2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8`. |
| Genuine profile APIs | `appData=<run>/fixture/Roaming`, `userData=sessionData=<run>/fixture/Roaming/Arcane`, set before production policy inspection. `prepareUserDirectory` accepted the direct owned paths without any guard change. |
| Actual single-instance ownership | Each process acquired and released the real Electron lock for the owned profile. |
| Actual DPAPI | PID **27624** encrypted and decrypted a generated sentinel with the real Electron safeStorage object. PID **31076** decrypted the retained **95-byte** ciphertext exactly in a fresh process. No encryption or IPC double. |
| Hidden-only compliance | **Zero BrowserWindows created**, zero frontend loads, zero renderer intents. |
| Native process cleanup | Both app exits **0** and emitted `windows-free-preflight-will-quit-lock-released`. A later check found recorded PIDs **27624, 31076, 49592** absent. |
| Daemon cleanup | No daemon was started; actual production daemon termination is **unverified**, not claimed from the preflight. |
| Plaintext scan | **47 files / 1,129,740 bytes**, zero synthetic sentinel hits and zero skipped files, UTF-8 and UTF-16LE. No chat draft or daemon token was generated, so this is not an actual full-host draft/token leakage test. |

All profile/session/temp/log/crash paths and environment home/AppData/PATH values
were redirected into this new owned fixture. The native processes did not inspect
the inherited application profile or provider installation locations. The
installed executable and repository modules were read only. No CLI discovery,
provider status/login, inference, live Studio connection, installation, Git,
privilege/OS-policy/AV change or shared build occurred. Production `getSession`,
IPC registration and preferences factories were neither replaced nor invoked.
The controller's metadata-only `workspace:providerpreference` event was inspected
in the actual compiled frontend, but was not dispatched because the full frontend
was not loaded. No `isTrusted` fabrication or lifecycle-control click was used.

Source/emission inputs were copied and hash-checked before and after the native
preflight: all Electron CJS modules, existing compiled desktop JavaScript, the
actual HTML, relevant controller TypeScript, and the product daemon entry/server.
The frozen main hash matches the coordinator's `a39a7114…` gate snapshot.

| Inspected input | SHA-256 before and after |
| --- | --- |
| `apps/desktop/electron/main.cjs` | `a39a7114cb993916c38f92bed3b7459ec2187a688ae7e13996391c70b7136ad9` |
| `apps/desktop/electron/workspace-preferences.cjs` | `66037adf77063de06f5f344230d572325495994d659f9611d7f1671aea64e9ed` |
| `apps/desktop/electron/preload.cjs` | `528e14c7a40b227edaeed6da7b9060915343f0a61823d61f8bedb953a33d6b4a` |
| `dist/apps/desktop/src/chat-tabs.js` | `6caf5de42dc9d8da7807e5ee40f88edf5756613973cbf2d212e005fcca43be8c` |
| `dist/apps/desktop/src/studio.js` | `94f505d4ef1553f361e753101eafd462948b88680a84ecbda4465f45418f3276` |

Exact copies and complete lists are in `inputs/`, `source-hashes.before.json`
and `source-hashes.after.json`. `evidence-seal.json` binds the then-existing
preflight inputs/outputs and this report; its detached SHA-256 is in
`evidence-seal.sha256.txt`. The final seal scan includes completion/process-check
output. Scans reject links/special/hardlinked files and impose limits of
2,048 files, 128 MiB total and 16 MiB per file. Execution limits are 15 seconds per
app, 20 seconds per phase, 60 seconds overall and 32 KiB diagnostics per child.

The earlier
[native factory/preload DPAPI proof](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/docs/build/NATIVE_WORKSPACE_PREFERENCES_PROOF_20261013.md)
remains retained and unchanged. Its **69-file evidence seal reverified successfully**
during this follow-up. That proof covers exact native preferences save/read,
restart/port-change recovery and scope/frame rejection for its original CJS
snapshot; it does not become full-host UI acceptance for the later frozen gate.

The following acceptance requirements remain **unverified**: actual unchanged
default-main startup, actual controller/UI draft and independent open-tab
recovery, restored provider presentation in the real UI, actual host-selected
project tuple through the real daemon, profile draft/token leakage after that
startup, and true product-daemon termination. Packaged EXE, model and Studio
acceptance are also not claimed.

The coordinator's reported **1,415/1,415** canonical unit result and the separate
offline fixture follow-up are outside this sidecar. No unit suite or offline stage
was repeated, and no existing dist, node_modules, production, test or script file
was modified. Writes are confined to this new runtime directory and this report.
Runnable preflight:
`node runtime/verification/native-chat-preferences-full-host-20261013/run.mjs`.
This is a limitation/preflight artifact, not a command which runs the full host.

## Actual default-main recovery proof after visible-window authorization

**PASS: actual unchanged default-mode `main.cjs` startup, actual production
frontend and local chat controller, real production preload/preferences, Windows
DPAPI and exact UI/native preference recovery across two fresh Electron apps.**
The passing run finished at **2026-10-13 19:50:35.544 UTC**, in **17,301 ms**.
This proves the stated app-preview presentation/persistence behavior. It does not
verify a separately packaged Arcane EXE or genuine keyboard input.

Authoritative evidence:
`runtime/verification/native-chat-preferences-full-host-20261013/actual-98f84cc1-3fbd-40dd-ba44-6707af55d347/`.
[Actual runner.json](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/verification/native-chat-preferences-full-host-20261013/actual-98f84cc1-3fbd-40dd-ba44-6707af55d347/runner.json)
and `completion.json` record `passed:true` and `actualFullHostAcceptance:true`.
The separate `save.json` and `restart-read.json` retain UI/native comparisons,
owned project identity, observed HTTP methods/paths and actual daemon exits.

The installed Electron executable and version are the same **44.7.0** runtime
identified above. The bootstrap set genuine `appData`, `userData`, `sessionData`,
temp/log/crash paths before requiring the original production `main.cjs`, with no
arguments and no smoke flag. Production main then prepared its real profile,
acquired its own single-instance lock, selected its default owned project,
started the real frozen `dist/apps/daemon/src/product-main.js`, installed its own
session/IPC/factories and loaded the real `/studio` HTML and compiled frontend.

The fresh short fixture is
`C:\Users\alexk\AppData\Local\Temp\ArcFH-ICjbUZ`.
Its genuine profile is `<fixture>/Roaming/Arcane` and the host-selected project is
`<profile>/projects/Untitled`. Project ID is
`2235ba24493aca2b600c8e1893406a2168fd4b87d6cb9dfcc4153f7f5649aba4`;
the state directory is exactly `<profile>/runtime/projects/<project ID>`.
Both fresh apps used this same canonical project/profile/state tuple. The actual
main persisted and reused its listener at **127.0.0.1:53163**. This full-host run
does not claim a port change; that separate native-factory property remains in
the earlier proof.

Both real windows reached the host's normal show event and were visible. The
harness did not replace/intercept `show`, remove listeners, modify constructor
options, move, minimize or hide them. Sandbox/context isolation remained enabled
and ordinary Node integration disabled. Main, policy, factories, IPC handlers and
`getSession` were unmodified. A transparent native `child_process.spawn` observer
forwarded real arguments/environment/results unchanged and observed the actual
daemon's private handoff and exit. It did not provide a spawn/session/IPC/factory
double. The only native child spawned in each app was the real product daemon.

Harness-owned `webContents.executeJavaScript` issued local presentation intents:
textarea assignment plus ordinary untrusted `input` events, the actual New chat
and local tab buttons, and the documented metadata-only
`workspace:providerpreference` event with `{provider:'claude'}`. It never fabricated
`isTrusted`, submitted the composer, clicked provider/native lifecycle controls,
signed in, discovered a CLI, installed software or connected live Studio/MCP.
The two open tabs are **independent unsent local drafts**, not resumed native
threads. Only the real controller saved the native snapshot; the harness issued
no direct native save and did not seed a preferences file.

| Actual full-host assertion | Result |
| --- | --- |
| First default app | PID **23644**, actual product daemon PID **43444**, normal show observed, six scoped assertions passed, both exits **0**. |
| Fresh restart app | PID **27948**, new actual daemon PID **40424**, normal show observed, six scoped assertions passed, both exits **0**. |
| Open tabs and active selection | Two restored local IDs exactly matched the first app: `b50d564c-bfeb-4933-9838-b7fc0e87ae47` and `28ec30e3-c8da-4244-9afe-0627dbaccf9d`. The second remained selected immediately after hydration. |
| Actual UI draft recovery | The initially restored active composer matched draft two. Switching both real local tabs recovered their separate texts exactly by string and UTF-8 comparison. The composer element remained stable. Draft byte lengths **146** and **173** include leading/trailing spaces, tabs, LF, astral emoji, combining accent, CJK and Arabic. |
| Provider presentation | Claude selection was set only by the documented presentation event in the first app; the real provider control restored Claude in the fresh app without another provider event from the harness. |
| Matching native preferences | Genuine frozen preload `read()` returned exact `available,preferences` fields and `available:true`. The project, both local IDs/drafts, active ID and provider matched the real UI. Each tab retained `title:'Draft'`, `provider:'codex'`, null thread/session/model/effort, `tool:'all'`, `previewOpen:false`. These are local presentation values, not model/provider authority. |
| Real DPAPI | Electron's actual native `safeStorage` was available. Explicit inspection decrypted the real controller-written ciphertext and verified the sealed canonical project binding and drafts. Outer envelope only `version,ciphertext`: **1,430 bytes**, **1,050 ciphertext bytes**. Decrypted snapshot SHA-256 was identical across apps: `99a7d987a7dc9f1a02471488ede2e660ff88e464d59526a83dd1523a479cd3a1`. |
| Native activity stayed empty | Actual `/v1/codex/state` reported `snapshot:null`, zero actions and the owned canonical project. Actual product state reported the matching project ID and **zero Studio sessions**. Every observed HTTP request was GET; no mutation request or provider CLI child was observed. |
| Browser fallback | No `arcane.chat-tabs` localStorage keys were present. The native file and fresh-process actual-controller hydration supplied recovery. |
| Ordinary shutdown | Harness called genuine `app.quit()`. The unchanged main's ordinary `before-quit`/`stopDaemon` path shut down the real daemon; both real daemon exit codes were **0**. No taskkill, signal, forced exit, window destruction or OS input was used by the harness. |

The native file may receive fresh DPAPI ciphertext during controller hydration;
comparison uses the exact decrypted snapshot and local IDs, not an assumption
that randomized ciphertext bytes stay identical. Draft contents and launcher
tokens were compared in memory and never written into diagnostic reports.
The real daemon handoff token from each app was passed to the owned runner through
private memory-only process IPC solely for leakage scanning. Only token hashes,
draft hashes/lengths and booleans were persisted. No source URL fragment or bearer
header was logged.

Post-exit bounded scans searched all owned evidence and all files in the fresh
Temp fixture for **both complete synthetic UI drafts and each of the two observed
actual main/daemon launcher tokens**, in UTF-8 and UTF-16LE:

| Actual scan | Files | Bytes | Hits / skipped |
| --- | ---: | ---: | ---: |
| After first app exit | 980 | 12,015,300 | 0 / 0 |
| After fresh restart exit | 986 | 12,385,437 | 0 / 0 |
| Final runner scan | 989 | 12,876,523 | 0 / 0 |

These include the native encrypted preferences, actual profile files, databases,
inputs and diagnostic outputs. They are observations for the stated corpus,
values and encodings, not an OS-wide memory/swap/backups audit or a claim about
unobserved credentials. The owned Temp fixture and encrypted envelope snapshots
are retained for review. Bounds were 45 seconds per app, 65 seconds per phase,
150 seconds overall, 64 KiB diagnostics per child, and at most 4,096 scanned files /
256 MiB total / 32 MiB per file. No deadline/output/scan limit fired in the passing
run.

The independent
[actual postrun-process-check.json](C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/verification/native-chat-preferences-full-host-20261013/actual-98f84cc1-3fbd-40dd-ba44-6707af55d347/postrun-process-check.json)
at **19:51:39.324 UTC** found all seven recorded runner/app/renderer/daemon PIDs
absent, the owned listener closed, and no daemon descriptor or preferences
lock/stage remaining. It inspected only those owned identities and terminated
nothing. Native profile locks were released by ordinary app exit.

All existing emitted JavaScript under `dist`, Electron CJS, actual public frontend
assets and relevant controller TypeScript were copied/read as frozen inputs and
hash-checked before/after the actual run. They remained unchanged, including
main SHA-256 `a39a7114cb993916c38f92bed3b7459ec2187a688ae7e13996391c70b7136ad9`.
No shared compilation, dist/node_modules/source/test/script write, unit rerun,
offline gate rerun, Git or security-policy change occurred. The sidecar scripts
and reports are under the assigned new runtime path; native runtime state is only
in the new explicitly owned short Temp fixture.

One earlier actual attempt remains **failed evidence** at
`actual-3b02de7e-33d7-466c-b02f-31a5b3b4da4b/`. Its deeply nested repository-local
profile recorded Chromium's Windows error **0xCE: filename or extension too long**;
the product daemon exited **1** before frontend startup. The exact daemon failure
was not exposed by production's ignored daemon stderr, so its cause is not claimed
more specifically. Its app took the ordinary quit path on the bounded deadline
and all recorded PIDs were later absent. Nothing was repaired or replaced in that
profile. The successful attempt used a new short direct fixture; it did not weaken
the path policy or change production. The windows-free preflight also remains
separate non-acceptance evidence. Its original report bytes are retained as
`inputs/preflight-report-beforeappend.md` in the actual proof because this report
was subsequently appended.

The optional workflow GET returned **503** in the observed frontend request log;
workflow acceptance was not part of this test. No model, native-thread resume,
Studio/MCP or installation acceptance is claimed. Actual local chat preferences
and UI recovery passed despite that separately scoped endpoint result.

Runnable actual proof:
`node runtime/verification/native-chat-preferences-full-host-20261013/full-host.mjs`.
`full-host-seal.json` hashes the exact frozen inputs, actual outputs, retained
profile files and this appended report. `full-host-seal.sha256.txt` binds that
manifest. The report's initial blocked state is superseded by this actual passing
proof after visible-window authorization; the preflight itself remains preflight.
