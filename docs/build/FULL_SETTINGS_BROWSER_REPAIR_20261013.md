# Full Settings browser fixture repair — frozen handoff, 2026-10-13

The three owned whole fixture files pass **65/65 tests, zero failures, zero
cancelled tests and zero skips** in installed Microsoft Edge **155.0.4283.45**.
Private compilation passes with **158 explicit current TypeScript sources**.
This focused repair does not replace the failed full-regression result.

## Scope and retained failure

Read `runtime/verification/native-ready-regression-th0JsL/unit-browser-ApD2s4/stage.log`.
It records hidden `#auto-refresh` clicks in chat, the hidden model fallback in
composer, and a diagnostics presentation assertion after lifecycle restart.
The `WORKFLOW_RECEIPT_STORAGE` HTTP failure remains parent-owned and untouched.
Other failures in that retained run are outside this sidecar's claim.

Authored edits are restricted to:

- `tests/unit/codex-chat-ui.test.ts`
- `tests/unit/composer-model-picker.test.ts`
- `tests/unit/studio-ui.test.ts`
- this document

Production source, frontend IDs, trust checks, security boundaries, native
connection counts and lifecycle timers were not edited. Shared root `dist` was
not rebuilt. No paid CLI, live Studio, installation or packaging was run. An
initial read-only `git status` was inadvertently included in discovery; no Git
mutation or subsequent Git command was performed.

## Fixture changes

Chat serves the existing `studio-key-settings.js` dependency. Its old helper
that restyled the dialog into inline, nonmodal content is replaced by the
production `workspace:settingsrequest` navigation. Actions select the actual
control's owning pane and ancestor details; actions on the conversation close
Settings through its real close button. The native confirmation remains the top
modal and clicks, keyboard input and checkbox actions still execute through Edge.

Composer serves `workspace-shell.js` and enables the production shell specifically
for its Settings fallback scenario. It opens `native-conversation-heading`,
checks the real modal, exactly one visible pane, Advanced visibility and target
focus, then verifies the applied picker display after closing Settings. The
separate isolated provider-event fixture retains its original boundary and
assertions.

Studio targets `#auto-refresh` directly before disabling live refresh, then
returns to the intended pane. Every diagnostics probe uses the semantic
`diagnostics-heading` target, including after pagehide/pageshow and delayed HTTP
responses. Existing modal, focus, denial, stale-read, safe-output and connection
closure checks remain.

At proof time the current checkout's HTML still places `#auto-refresh` in
Advanced. The repair derives its owning pane through production navigation and
does not hardcode that placement; it also supports the requested Tools relocation.
No production patch was needed or made.

## Passed counts and proof

| Whole fixture | Passed | Failed | Cancelled | Skipped | Edge scenarios |
| --- | ---: | ---: | ---: | ---: | ---: |
| `codex-chat-ui.test.ts` | 25 | 0 | 0 | 0 | 4 |
| `composer-model-picker.test.ts` | 7 | 0 | 0 | 0 | 5 |
| `studio-ui.test.ts` | 33 | 0 | 0 | 0 | 3 |
| **Total** | **65** | **0** | **0** | **0** | **12** |

Diagnostics records **37 fixture connections created, 37 closed, and 19 targeted
fixture reads**. The spawned Node protocol scenario retains exactly one
`thread/start`, one synthetic `turn/start`, one accept, one decline and one
interrupt; it checks read-only thread creation and scoped workspace-write turn
policy. These are synthetic HTTP/SDK/protocol proofs, with no installed-provider
inference or live Studio claim.

Proof directory:
`runtime/verification/full-settings-browser-repair-20261013-ad38165e/final/`.
Retained files include `compile.json`, `compile.log`, `compile-proof.json`,
`compiled-source-inventory.json`, `compiled-output-inventory.json`,
`compiled-output-comparison.json`, `fixture-contract-proof.json`,
`codex-chat-ui-edge.tap`, `composer-model-picker-edge.tap`, `studio-ui-edge.tap`,
`test-proof.json`, `frozen-sources.json` and `proof-inventory.json`.

The contract proof matches the retained fullrun source hashes and confirms
unchanged test names, options and timeouts. Assertion-call counts are chat
232 → 236, composer 91 → 97, and Studio 373 → 373. No assertion, deadline or skip
was removed or relaxed.

Chat and Studio passed in the initial private output. Final compilation includes
the corrected composer fixture and a concurrently changed, parent-owned asset
permission fixture. The emitted JavaScript comparison confirms chat, Studio and
every production module are byte-identical between those private outputs;
relative source-map paths change with the output directory. Composer passed
against the final private output. Each run used `--test-concurrency=1`, the TAP
reporter and a complete single fixture file, without a test-name filter.

Edge's disposable profile could not run inside the filesystem sandbox. The real
Edge runs used scoped launch approval. Superseded sandbox and intermediate
composer logs remain outside `final/`; they are not included in the passing total.

Focused reproduction against the retained final private output only. The parent
global gate must freshly enumerate current sources, compile and build them, then
run regression against that current build. Do not reuse this private emission or
treat cached output as the parent gate.

```powershell
$repair = Join-Path (Get-Location) 'runtime/verification/full-settings-browser-repair-20261013-ad38165e/final'
node node_modules/typescript/bin/tsc -p (Join-Path $repair 'compile.json')
$env:ARCANE_UI_BUILD_DIR = Join-Path $repair 'compiled'
$env:ARCANE_UI_BROWSER_MODULE = (Resolve-Path node_modules/playwright-core/index.mjs).Path
$env:ARCANE_UI_BROWSER_EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node --test --test-concurrency=1 --test-reporter=tap (Join-Path $env:ARCANE_UI_BUILD_DIR 'tests/unit/codex-chat-ui.test.js')
node --test --test-concurrency=1 --test-reporter=tap (Join-Path $env:ARCANE_UI_BUILD_DIR 'tests/unit/composer-model-picker.test.js')
node --test --test-concurrency=1 --test-reporter=tap (Join-Path $env:ARCANE_UI_BUILD_DIR 'tests/unit/studio-ui.test.js')
```

## Frozen parent handoff prompt

> The three owned browser fixtures and this handoff are frozen. The explicit
> 158-source private compile passed; complete per-file real Edge checks passed
> 25 + 7 + 33 = 65 tests, with zero failures, cancellations or skips. Consume the
> current files directly and verify `final/frozen-sources.json` and the retained
> TAP/proof records. Preserve frontend IDs, the native Settings/confirmation
> modal, trust/security assertions, original timeouts, lifecycle timers and native
> counts (37 created/37 closed/19 targeted reads). Parent reports observational
> real-ACL and whole assistance checks passed 3/3 with no guard or deadline
> changes, and isolated native calls took approximately 0.8–1.4 seconds. These
> observations are separate from the 65 owned passes. The fullrun 503 has not
> yet been reproduced; do not claim the storage failure or native integration
> fixed. Studio native reconnect awaits human action. After integrating current
> files, freshly enumerate all global sources, compile/build them and run the
> full regression against that current build. Do not reuse this private emission
> or interpret this focused pass as a successful fullrun. Report an actual
> production defect before patching production source.

Finalization changes only this handoff and its frozen proof metadata. The three
test files, their passed counts and retained TAP logs remain frozen unchanged.
