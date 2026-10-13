# Native diagnostics Settings race investigation — 2026-10-13

**Root cause established and the minimal guard applied after the user released the freeze.** A queued Settings dialog close event reached a newly reopened modal after shell lifecycle cleanup/rebinding. The semantic selector and initial focus contract worked; the production close listener invalidated that navigation. `workspace-shell.ts` now ignores close notifications while the dialog is currently open. The deterministic production-controller regression and unchanged complete native-diagnostics test pass in real Edge. This is focused fix verification; no new global gate, packaging or restart was run.

## Current onboarding drawer fixture repair — Gip8Wd handoff

After the newer UI integration, the terminal canonical run `runtime/verification/native-ready-regression-Gip8Wd/unit-browser-ZYvh5h/stage.log` recorded three drawer-fixture failures. Mobile and short-viewport scenarios clicked the now-hidden welcome-card connection button. The Tools scenario expected the removed toolbar switcher. Those are obsolete fixture assumptions; no production bug or production edit was required.

The only authored source change for this repair is `tests/unit/workspace-settings-drawer.test.ts`. The mobile/short-viewport tests now use the actual visible button named **Conversation settings**, require its uniqueness/visibility, verify the exact Advanced pane and target focus, and retain real close/backdrop opener restoration. The tool test now selects the actual sidebar **Blender** and **Roblox Studio** controls. It verifies exact tool inventory, selected context, controller state, pressed-state array, label, tool-change event sequence, closed Settings during context selection, unchanged draft and zero backend/native/form actions. It then verifies exact Settings pane and focus for each section/target: Blender in Tools, Studio sessions in Connections, diagnostics and conversation settings in Advanced.

The queued-close regression body is unchanged byte for byte after newline normalization. Both lifecycle cleanup/rebinding and ordinary close/reopen still require the genuinely queued trusted event to preserve the new modal/focus/callback state; genuine current closure still dismisses the secret witness, restores the opener and consumes return-focus state. All five 60-second test deadlines and skip predicates remain unchanged. Exact pane assertions were added to the shared focus helper; nothing is forcibly shown or refocused after failure. Unexpected fixture fetches now throw while remaining counted.

The final **whole file** passed **5/5 in installed Edge 155.0.4283.45**, with **zero failures, cancellations and skips**, no test-name filter and no automatic retries. This used a private explicit **two-source production-controller closure** (the real current `WorkspaceShell` plus this fixture), compiled with the installed TypeScript compiler and Node v24.21.0. The canonical failed-run inventory contains **168** sources; this scoped compile is not a replacement global compilation. Current HTML, CSS and the brand asset were frozen privately and served from that snapshot. The compiled production shell is byte-identical to the readonly canonical `dist` shell. No shared `dist` write, provider inference, native controller stub or Studio operation occurred.

Evidence is under `runtime/verification/native-diagnostics-focus-investigation-20261013/drawer-repair-Gip8Wd/final/`:

- `compile.json`, `compile.log`, `compile-result.json`, `frozen-inputs.json`, private `sources/`, `compiled/` and `public/`.
- `whole-file-edge.tap` and `whole-file-edge-result.json` for the complete five-test run.
- `frozen-proof.json` for the frozen source hash, unchanged strong regression/deadlines, actual-source/asset stability, production emission match and both close-event witnesses.

The initial private run and emission remain at the parent repair directory. That run passed 4/5; its strict pane assertion exposed an initially outdated expectation that `session-heading` lived in Tools. The final test expects its actual current Connections pane, retaining the exact pane assertion. This was a fixture correction, not a relaxed condition or repeated run until green.

**Drawer source frozen; ownership released.** The parent owns the other four fixture repairs and the next fresh canonical gate. The earlier 158-source proof remains historical and does not cover this newer UI. No native-diagnostics rerun, global regression, packaging or restart was performed for this fixture-only repair.

## Applied fix and focused verification

Authored production/test changes are limited to `apps/desktop/src/workspace-shell.ts` and `tests/unit/workspace-settings-drawer.test.ts`, plus this report and the owned evidence directory. The source edit is exactly the proposed close-listener guard. The Settings fixture adds a navigation/dismissal callback witness and a cleanup/rebind callback, and one new test; its four existing test bodies, names, assertions, options and 60-second deadlines stay unchanged. `tests/unit/studio-ui.test.ts` and its emitted JavaScript are byte-identical to the retained frozen diagnostic fixture, including all **373** assertions and the original native test's **90-second** deadline.

The new Edge regression exercises two schedules with the production `WorkspaceShell`: lifecycle cleanup/rebinding and ordinary external close/reopen. It performs each close/reopen in one browser task, then observes the browser's genuinely queued, trusted close event after the production listener. Both schedules require the new modal to stay open, one pane to remain visible, `diagnostics-heading` to retain focus and the navigation callback/current-opening secret witness to remain untouched.

It then closes the current modal genuinely. To prove shell return-focus handling rather than just the browser's automatic restoration, the test moves focus to the composer while the close notification is queued. The controller must dismiss the secret witness, invoke navigation exactly once and restore the current opener (`sidebar-toggle`). A subsequent notification cannot reuse the consumed return-focus state. The secret is a fixture sentinel for the shell's dismissal callback; no real credential or native authority is supplied.

The negative control ran the new regression against the unguarded production controller and failed for the actual stale-close effect: modal closed, target hidden, focus moved, navigation called and the current-opening callback secret cleared. An intermediate guarded run passed all four existing Settings tests and preserved the reopened modal, but the new test's initial search-field opener invoked navigation when focus was restored. The final fixture uses a normal shell button as opener, keeping the strict callback-count assertion. Both intermediate failure logs remain retained; neither is counted as passing validation.

The final private build freshly enumerated and compiled **158 current TypeScript sources** with Node **v24.21.0**. Compilation passed with no input changes during compile. Shared root `dist` was not rebuilt. After-run checks establish that the only canonical TypeScript source deltas are the two owned files, all final compile inputs remain current, and `workspace-shell.js` is the sole changed production browser module.

| Focused check | Passed | Failed | Skipped | Cancelled | Evidence under `runtime/verification/native-diagnostics-focus-investigation-20261013/fix/` |
| --- | ---: | ---: | ---: | ---: | --- |
| Complete Settings drawer file, real Edge | 5 | 0 | 0 | 0 | `final-settings.tap` |
| Complete native-diagnostics browser test, real HTTP routes + SDK fixtures, real Edge | 1 | 0 | 0 | 0 | `final-native-diagnostics.tap` |
| Workspace shell unit file | 16 | 0 | 0 | 0 | `guarded-shell.tap` |

The native test passed in **9901.6399 ms**, recording exactly **37 connections created, 37 closed and 19 targeted reads**. It retains explicit-target, agent denial, closure, stale reads, late switches, receipt authority and safe-output checks. Native connections use in-memory SDK fixture transports; no live Studio or paid CLI/model turn is claimed. The shell unit file ran against an earlier guarded private emission; `fix-proof.json` verifies its production shell module is byte-identical to the final emission.

Final handoff evidence includes `fix/final-compile.json`, `fix/final-source-inventory.json`, `fix/final-compile.log`, `fix/final-compile-result.json`, the TAP files and corresponding result JSONs, and `fix/fix-proof.json` with the two event witnesses and source/emission comparisons. `fix/pre-guard-regression.tap` records the negative control. The historical investigation below and `root-cause.json` preserve the original frozen stage and its no-edit state.

Commands used for the focused final checks:

```powershell
& 'C:/Program Files/nodejs/node.exe' runtime/verification/native-diagnostics-focus-investigation-20261013/fix/compile.mjs final
& 'C:/Program Files/nodejs/node.exe' runtime/verification/native-diagnostics-focus-investigation-20261013/fix/test.mjs final settings
& 'C:/Program Files/nodejs/node.exe' runtime/verification/native-diagnostics-focus-investigation-20261013/fix/test.mjs final native-diagnostics
```

The retained run helper uses exclusive output files and performs no automatic retries; these commands are a record of the completed checks, not a request to overwrite their logs. An intentional later run needs a fresh owned output directory. The parent's new global validation and plugin Main/Mock/package work remain outside this sidecar; do not substitute these private emissions for that gate.

After this proof completed, the user reported additional provider setup, HTML/CSS, chat-tab and session/type work in progress. The completed result remains scoped to its pinned **158-source** private compilation and the earlier UI state. All 158 exact source bodies have been preserved from that compilation's inline source maps and checked against its input hashes at `fix/pinned-provenance/sources/`; `fix/pinned-provenance/manifest.json` pins the completed emission, proof logs and original frozen static asset copy. No current worker source is read to reconstruct those bodies. No additional shared compile or Edge run was performed. Canonical verification of the new features waits for the parent's next complete build. Any later isolated race check must serve the preserved private source/asset closure, and must retain that narrower claim.

## Current fullrun evidence

The completed **unit-browser stage footer**, independently of any still-running global stages, is retained at `runtime/verification/native-diagnostics-focus-investigation-20261013/current-fullrun-native-footer.txt`. It identifies `native-ready-regression-thayYa/unit-browser-SAL77n/stage.log`'s **8908.809 ms** diagnostics failure:

- `dist/tests/unit/studio-ui.test.js:1414` is `dialog.matches(':modal') === true`, returning false. This is source `tests/unit/studio-ui.test.ts:746`, before the helper's target-focus assertion.
- Its caller is compiled line 1330 / source line 711: `probeAgain()` after the first held-read pagehide/pageshow sequence. Stale-read dismissal, empty target, disabled read, empty provenance and `created === closed` assertions precede this call.
- The boolean failure is a modal-closure failure. Calling it an active-focus assertion failure is inaccurate. Earlier investigation commentary inferred Advanced visibility from the previous footer too strongly; that old footer alone establishes a boolean helper failure, not which boolean without its matching old emission.

The earlier `th0JsL` footer and the original current-stage snapshot are also retained under this investigation directory. The later current-stage copy contains the finished unit-browser footer. The previous **65/65** proof in `docs/build/FULL_SETTINGS_BROWSER_REPAIR_20261013.md` remains a focused proof; it does not establish absence of a scheduling race or replace the global gate.

## One isolated failing reproduction

The investigation took private frozen copies of current sources, static browser assets and the existing explicit current Node build. All **158** source hashes matched the fresh fullrun input inventory before the run. No compiler or shared build was executed. `snapshot.json`, `instrumentation-contract.json` and `root-cause.json` retain source/build provenance and the after-run hash checks.

The single real Edge whole-native-diagnostics fixture run used Node **v24.21.0**, `C:/Program Files/nodejs/node.exe`, installed Edge **155.0.4283.45**, an owned disposable profile and a private temporary fixture directory. Its native routes used the existing linked in-memory SDK transports and fixture callbacks. All **373** assertions and every test declaration, option and timeout stayed intact. The only private fixture changes were static/temporary paths, phase logging and read-only event/focus observations. Browser production modules stayed byte-identical to the copied build.

The after-run check confirms all 158 source inputs remain unchanged. All five individually frozen source/static files also remain unchanged. The six checked browser modules (`studio`, `workspace-shell`, `codex-chat`, `provider-setup`, `desktop-verification`, `studio-key-settings`) match both the current shared emission and the prior 65/65 proof byte for byte. This evidence rules out changed versions of those modules as the reason the earlier private proof passed.

`whole-fixture-observed.tap` records **one failure**, at **11050.9851 ms**, with no automatic retries. It reaches the third lifecycle sequence, where an old HTTP capability response is held after its fixture controller has closed, and fails while reopening Settings before the newer request. The different failing lifecycle phase is consistent with the same event-order race. The reproduction does not reach the final 37-created/37-closed/19-targeted-read completion diagnostic, so those counts are not claimed for it. The original completion assertions are still present.

The decisive events are directly observable in Edge:

| Observation | Event time within this document | TAP line | State |
| --- | ---: | ---: | --- |
| Synthetic pagehide | 7101.5 ms | 581 | Settings is open and modal |
| Persisted pageshow | 7103.7 ms | 582 | Settings has closed during cleanup |
| Reopen request completed | 7131.3 ms | 592 | Open, modal, one Advanced pane; `diagnostics-heading` visible and focused |
| Browser-generated queued close event | 7153.1 ms | 602 | The newly opened modal is **still open**, visible and correctly focused at event capture |
| Dialog `open` attribute removed again | 7156.7 ms | 604 | Settings becomes closed and nonmodal; target hidden |
| Focus leaves heading | 7158.6 ms | 606 | Active element becomes BODY |

See `race-events.json` and the complete TAP log for exact event values. Observer `close:after` is a microtask queued by a capture listener; it is not a guarantee that every later event listener has finished. The subsequent `open` attribute removal and focus loss are the actual closure evidence.

The first two lifecycle sequences in the same failing run show the other ordering: the queued close event arrives while Settings is already closed, before the helper reopens it, and navigation succeeds. This supplies the timing comparison without repeating runs until green.

## Code path that explains the trace

`apps/desktop/src/studio.ts:1639` calls `workspaceShell.cleanup()` on pagehide; line 1640 starts a new shell on persisted pageshow. `WorkspaceShell.cleanup()` first calls `closeSettings(false)` and then removes listeners. `closeSettings()` removes the dialog's open state with `drawer.close()`.

`apps/desktop/src/workspace-shell.ts:166` stores a new return-focus element when a subsequent Settings request reopens the modal. The newly rebound close listener at line **231** currently executes:

```ts
this.onNavigate?.();
if (this.settingsReturnFocus) this.closeSettings();
```

It does not distinguish a close notification queued by the previous opening from closure of the current opening. The trace shows that older browser-generated event arriving after reopening. The new return-focus state exists, so this listener calls `closeSettings()` on the current open modal. That removes `open`, queues another close event and eventually loses heading focus. The target's ancestor details stayed open, its pane remained Advanced, and navigation had already successfully focused the correct heading; changing the selector or forcing focus would conceal the defect.

The held HTTP response and SDK callbacks make the lifecycle race observable; they do not explain away the close listener's behavior. The production shell defect is demonstrated in the synthetic lifecycle fixture. An actual browser back/forward-cache trip or live Studio reproduction was **not** performed and is not claimed.

## Initial recommendation, now applied and focused-verified

Add an open-state guard at the start of the Settings close listener:

```ts
this.listen(drawer, 'close', () => {
  if (drawer.open) return;
  this.onNavigate?.();
  if (this.settingsReturnFocus) this.closeSettings();
});
```

The initial proposal is retained at `runtime/verification/native-diagnostics-focus-investigation-20261013/recommended-workspace-shell.patch`; the equivalent guard is now applied in the source. A close notification delivered while the dialog is currently open belongs to an earlier closure and must not close that opening or consume its return-focus state. A genuine current closure has `drawer.open === false` and retains the existing dismissal/return-focus behavior. The current explicit close button, cancel/Escape, backdrop and cleanup paths remain eligible to close Settings and dismiss secrets.

Do not add fixture sleeps, wider deadlines, forced focus, repeated opening until visible or weaker modal/focus assertions. Waiting for the earlier close event before reopening would avoid this schedule in the fixture while leaving the production behavior intact; it is not the recommended fix. No authority, denial, stale-read, receipt identity, connection or closure check needs changing.

The user subsequently released the freeze and authorized this source fix and focused verification. The controlled lifecycle and ordinary close/reopen regressions, genuine close cleanup/return-focus, existing explicit close/Escape/backdrop tests and complete unchanged 37/37/19 native fixture now pass as recorded above. The user explicitly reserved full regression, packaging and restart for the parent; none was run here.

## Initial frozen investigation scope and retained artifacts

During the initial frozen investigation, authored writes were restricted to this report and `runtime/verification/native-diagnostics-focus-investigation-20261013/`. No production/test edit, paid CLI/model turn, live Studio interaction, Git command, installation or packaging occurred in that stage. A sandbox attempt failed at local fixture `fetch` before Edge launched; `sandbox-fetch-blocked.tap` records it. The one subsequent scoped approved run was the failing reproduction above. The later authorized source/test edits and their focused results are documented separately at the start of this report.

Primary retained evidence: `snapshot.json`, `instrumentation-contract.json`, `root-cause.json`, `race-events.json`, `whole-fixture-observed.tap`, `whole-fixture-observed-result.json`, both retained fullrun logs and `recommended-workspace-shell.patch`. `prepare.mjs`, `observe.js`, `run.mjs` and `analyze.mjs` record the private instrumentation and extraction. The cached private emission is investigation evidence only and must not replace a fresh current-build global gate.
