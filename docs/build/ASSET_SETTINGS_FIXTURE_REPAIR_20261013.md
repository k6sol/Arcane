# Asset settings fixture repair — 2026-10-13

Frozen at 2026-10-13T15:37:06Z. Owned edits are limited to this note, `tests/unit/asset-conversation-ui.test.ts` and `tests/unit/codex-asset-permission-ui.test.ts`. No production source, other worker's tests, shared `dist`, Git state, installations, paid CLI or live Studio operations were changed or used.

The frozen failure log is `runtime/verification/native-ready-regression-th0JsL/unit-browser-ApD2s4/stage.log`.

- Ten asset-conversation controller scenarios failed during `StudioWorkbench` construction, before their asset assertions ran. The first error is `StudioKeySettings.render` reading `select.options.length`. The owned DOM double now preserves created element tags, exposes options derived from the current children, represents a closed dialog, and explicitly provides no browser/native bridge. The real settings constructor and render remain in the test path.
- The Edge asset-permission fixture opened an inline dialog and expanded details but left the containing Advanced settings section hidden. It now serves the privately compiled real workspace shell, fills the existing conversation draft, opens the actual settings modal through the sidebar, selects Advanced, and expands Conversation connection through its summary. Modal and selected-pane assertions are explicit; the scripted-click rejection, trusted Enter/Space/click actions, retained draft, independent native write permission, and desktop/mobile bounds remain.

The existing native authority, exact project/provider/thread/session generations including A → B → A, late callbacks, unknown acknowledgements, single-flight/revoke behavior, no automatic job start, fixed envelopes, bearer and security assertions were retained. No production source bug was found in this bounded repair.

| Whole owned test file | Passed | Failed | Skipped | Real Edge passed |
| --- | ---: | ---: | ---: | ---: |
| `asset-conversation-ui.test.ts` | 18 | 0 | 0 | 0 |
| `codex-asset-permission-ui.test.ts` | 12 | 0 | 0 | 1 |
| **Total** | **30** | **0** | **0** | **1** |

Final fresh compilation and the whole-file run both exited **0**. The explicit compiler roots were the two owned tests and `workspace-shell.ts`; their actual imported closure contained **48 product/test sources**, plus installed dependency declarations. The final TAP records 30 passing tests, no cancellations, failures or skips, in 4416.8355 ms. Edge was **155.0.4283.45**.

Proof directory: `runtime/verification/asset-settings-fixture-repair-20261013-6b2a91/`.

- `compile.json`, `compile.log`, `compiled-source-list.txt`: private compiler configuration and actual source list.
- `emitted/`: private ESM output and source maps; shared root `dist` was not used.
- `owned-tests-final.tap`, `proof.json`: final whole-file result and machine-readable proof.
- `frozen-test-sources.json`, `frozen-sources/`: source hashes and byte-identical frozen test copies. Both current test hashes equal the compiler source-map contents.
- `asset-permission-final-desktop.png`, `asset-permission-final-mobile.png`: responsive browser evidence.
- `owned-tests-initial.tap`: superseded 29-pass/1-failure sandbox run; its browser failed during Edge process startup. `owned-tests.tap` is an earlier successful 30/30 run before the final profile fallback compatibility edit. Only `owned-tests-final.tap` is the final frozen result.

Final test SHA-256:

```text
asset-conversation-ui.test.ts
37c443273db8a34eec8552e981d6ab5bd0016fb3a8f10ab57bb329317524662c
codex-asset-permission-ui.test.ts
6e1309df2f025df40b96ccb16ad1b8ca2c95affa43e379b58bd9c52c025b8885
owned-tests-final.tap
4b74e50c1649713972132639d9f8d08b384f0676904d6592d1e8109b6a92d56c
```

The final browser run used a fresh explicit disposable profile at `C:\Users\alexk\AppData\Local\Temp\arcane-asset-settings-fixture-repair-20261013-6b2a91\edge-profile-final`. It ran outside the filesystem sandbox after Edge failed to start inside it. The fixture serves loopback HTML/CSS/modules and synthetic native state; it proves browser behavior without a real provider connection or asset execution.

Reproduction from the repository root, with installed pinned dependencies only:

```powershell
node node_modules/typescript/bin/tsc -p runtime/verification/asset-settings-fixture-repair-20261013-6b2a91/compile.json --listFiles
$env:ARCANE_UI_BUILD_DIR = Join-Path (Get-Location).Path 'runtime/verification/asset-settings-fixture-repair-20261013-6b2a91/emitted'
$env:ARCANE_ASSET_UI_BROWSER_EXE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:ARCANE_ASSET_UI_PROFILE_DIR = 'C:\Users\alexk\AppData\Local\Temp\arcane-asset-settings-fixture-repair-20261013-6b2a91\edge-profile-reproduction'
node --test --test-concurrency=1 --test-reporter=tap "$env:ARCANE_UI_BUILD_DIR/tests/unit/asset-conversation-ui.test.js" "$env:ARCANE_UI_BUILD_DIR/tests/unit/codex-asset-permission-ui.test.js"
```

`ARCANE_ASSET_UI_PROFILE_DIR` is an optional explicit profile override. Existing runners need no new environment variable: otherwise the fixture creates its own unique temporary profile. Browser execution still requires `ARCANE_ASSET_UI_BROWSER_EXE` and the existing explicit `ARCANE_UI_BUILD_DIR`. These three owned files are ready for the parent's frozen global compile.
