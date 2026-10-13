# Browser fixture regression repair

2026-10-13. Changes are limited to `tests/unit/desktop-verification-ui.test.ts`,
`tests/unit/workflow-browser.test.ts`, and this report. Test edits are frozen for
the parent's fresh full-source gate. No production change was required.

## Retained failures

The original full-unit report remains at
`runtime/verification/native-ready-regression-PauGqE/unit-browser-zpqAh7/stage.log`:
1349 tests, 1345 passed, 2 failed, 2 skipped; runner exit 1. Its SHA-256 is
`DC2B4844F8A59A987EFE50DAE0E9FE32AB9748AAC5C9DDF9BA0D10EEA82D3569`.
The adjacent `result.json` still records a failed stage, not full-product success.

The first focused repair attempt is also retained at
`runtime/verification/full-regression-fixtures-QtDd0L/focused-edge.log`:
16 tests, 14 passed, 2 failed, 0 skipped; exit 1. It demonstrated that the module
closure repair restored workflow bootstrap and exposed the remaining stale
Tools-menu interaction. Its SHA-256 is
`2666EECD0AA7B5F308AA37D681938F795299BFFCE53787730025961E55114E6A`.
Neither failed report was overwritten by the passing run.

## Corrections and cause

- **Desktop verification:** the fixture mounts only `startDesktopVerification`,
  leaving the real Settings dialog closed. The premium CSS also deliberately
  hides `#workspace-settings > summary` inside that dialog, so merely calling
  `showModal()` does not make the old outer-summary click valid. The fixture now
  verifies the drawer starts closed, explicitly calls the actual native HTML
  dialog's `showModal()`, and expands the outer details as fixture setup. It
  clicks the visible Code verification disclosure and still exercises genuine
  trusted Enter/Space, rejection of an untrusted programmatic click, the palette,
  945/390px layout, button dimensions, forced-colors focus, controller stop/resume,
  preserved draft whitespace, and absence of API/native traffic. Draft entry
  happens before the modal makes the background composer inert. WorkspaceShell
  remains unmounted; Electron/system file dialogs are not invoked.
- **Workflow bootstrap:** original compiled line 166 is the wait for
  `Owned fixture public transcript.`, not the later workflow confirmation status.
  `studio.js` statically imports `provider-setup.js`, but the fixture's resource
  copy list omitted it. The production loopback server already maps that module.
  Copying the freshly compiled module restores the real browser module closure.
  This was a fixture resource failure, not stale public confirmation copy or a
  production provenance defect. The transcript assertion, synthetic installed-CLI
  metadata seam, provenance validation and confirmation strings remain intact.
- **Workflow tool selection:** after bootstrap recovered, the first focused run
  reached the same-chat draft checks and then timed out clicking a tab inside the
  closed Tools menu. The fixture now clicks the real visible Tools summary before
  each selection and verifies the resulting tool context, retaining both draft
  and transcript assertions.

No assertion was removed, no guard or deadline was relaxed, and no skip was added.

## Focused validation

Final private output and proof directory:
`runtime/verification/full-regression-fixtures-EIRYuB/`.
`compile.json` uses the repository's `explicitProjectConfig` enumeration and
overrides only the output directory to `compiled/`. All 155 explicit source files
compiled successfully with the pinned compiler; `compile.log` is retained.
The parent's root `dist` was not overwritten by these commands.

Both complete fixture files ran with `--test-concurrency=1`, without a test-name
filter, against installed Microsoft Edge **155.0.4283.45** and the repository's
Playwright runtime. `focused-edge.log` records **16 passed, 0 failed, 0 skipped**,
exit **0**, in 29.327 seconds. Verification's screenshot is
`runtime/verification/full-regression-fixtures-EIRYuB/desktop-verification.png`.
Workflow's screenshot is
`runtime/verification/workflow-browser-6c555833-8cd9-4392-a80d-5374343b638a/workflow.png`.

The run used scoped approval for isolated Edge profiles, owned loopback fixture
traffic and disposable fixture stores/receipts. Workflow assertions verified no
installed CLI starts, provider probes, native lifecycle actions, Studio commands,
asset jobs, forbidden requests, failed resources, page errors or CSP violations.
Actual CLI/provider integration remains outside this synthetic fixture's claim.

Reproduction after generating fresh private output with `compile.json`:

```powershell
$env:ARCANE_UI_BROWSER_MODULE = (Resolve-Path node_modules/playwright-core/index.mjs).Path
$env:ARCANE_UI_BROWSER_EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:ARCANE_UI_BUILD_DIR = (Resolve-Path runtime/verification/full-regression-fixtures-EIRYuB/compiled).Path
$env:ARCANE_UI_SCREENSHOT = Join-Path (Resolve-Path runtime/verification/full-regression-fixtures-EIRYuB).Path 'desktop-verification.png'
node --test --test-concurrency=1 runtime/verification/full-regression-fixtures-EIRYuB/compiled/tests/unit/desktop-verification-ui.test.js runtime/verification/full-regression-fixtures-EIRYuB/compiled/tests/unit/workflow-browser.test.js
```

This is a focused fixture pass, not a replacement full-regression result. The
parent must now run the fresh full-source gate. The two existing official Luau
compiler skips are unchanged; the parent handles their runner environment with
`ARCANE_TEST_OFFICIAL_LUAU_COMPILER` and the existing approved compiler pin.
Live Studio fixture `99e1bbac` and camera/documentation work remain parent/other-agent
scope. No paid provider turn or native Studio operation was performed here.
