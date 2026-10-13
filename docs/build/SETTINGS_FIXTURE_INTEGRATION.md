# Settings fixture integration

Frozen bounded sidecar, 2026-10-13. Contract: [SETTINGS_UI.md](SETTINGS_UI.md). Product HTML, CSS, JavaScript controllers and IDs were not edited by this sidecar.

The closed native `#settings-drawer` owns four actual sections: General (`#workspace-settings`), Connections (`#settings-connections`), Tools (`#settings-tools`) and Advanced (`#settings-advanced`). General is a section, with no outer `details` or `open` attribute. Native authority, issuance, exact roots, provenance and confirmations remain in Advanced. General's key selector and metadata now sit inside the optional `#settings-key-details`; its current key field remains visible.

Changed files, and only these source/document files:

- `tests/unit/desktop-verification-ui.test.ts`: explicitly selects Tools before expanding the verification group in the real modal; retains trusted Enter/Space, scripted-click rejection, palette, responsive layout, draft and zero-API assertions.
- `tests/unit/workflow-browser.test.ts`: copies `studio-key-settings.js` into the owned resource closure alongside the existing production modules.
- `tests/unit/studio-ui.test.ts`: expects the eight exact static browser dependencies, serves the new key module in HTTP fixtures, overrides the full private module closure for the daemon browser fixture, and uses production section navigation with the real modal. Connections/Tools transitions and focus restoration after group expansion are explicit. The native lifecycle fixture navigates to its actual diagnostics heading after restart. Existing credential, grant, origin, confirmation, stale-response, sanitization and closure assertions remain.
- `tests/unit/workspace-unified.test.ts`: models the dialog and four sections, verifies hidden-pane selection and the retained draft, and supplies the real secret-dismissal render elements for project projection without bypassing that controller. Its search fixture exposes the intended Tools pane while the modal stays closed.
- `tests/unit/workspace-navigation-ui.test.ts`: visits Tools through the real modal, closes it with opener focus restored, then tests global search against that selected pane. The old ten-item menu assumption becomes bounded named-tool assertions; existing keyboard focus, draft, responsive layout, palette and zero-API checks remain. Asset navigation verifies exactly one visible Tools pane in the modal.
- `docs/build/SETTINGS_FIXTURE_INTEGRATION.md`: this handoff and proof record.

Global workspace search currently indexes targets in the selected Settings pane. Fixtures therefore select their intended pane before search; they do not unhide every pane or replace the modal with inline settings. The workflow fixture copies ten modules: the entrypoint, its eight static dependencies and the fixed optional workflow module. The exact static dependency assertion includes `./studio-key-settings.js` without widening the allowed Node/daemon/store imports or dynamic imports.

## Proof counts

Latest per-file results, including the final focused rerun after fixture corrections:

| Permitted test file | Passed | Failed | Skipped | Real Edge tests passed |
| --- | ---: | ---: | ---: | ---: |
| `desktop-verification-ui.test.ts` | 15 | 0 | 0 | 1 |
| `workflow-browser.test.ts` | 1 | 0 | 0 | 1 |
| `studio-ui.test.ts` | 33 | 0 | 0 | 3 |
| `workspace-unified.test.ts` | 14 | 0 | 0 | 0 |
| `workspace-navigation-ui.test.ts` | 1 | 0 | 0 | 1 |
| **Total** | **64** | **0** | **0** | **6** |

Private explicit-source compilation passed with 158 sources. The final targeted recompile used three explicit test sources and their real imported modules, followed by **48/48 passing tests, zero failures and zero skips** for studio, unified workspace and workspace navigation. The other 16 permitted tests passed in the preceding private run against the frozen frontend. Shared root `dist` was not used or rebuilt.

Additional unchanged browser proofs: **4/4** workspace Settings modal tests and **2/2** confirmation-layer tests passed. These retain modal stacking, checked exact scope, changed-scope rejection, Cancel/Escape, backdrop/scroll behavior and focus restoration. Installed Edge was **155.0.4283.45**. The native HTTP/SDK fixture recorded **37 connections created, 37 closed and 19 targeted fixture reads**; the workflow fixture recorded **zero installed CLI starts and zero native actions**.

The parent-owned `studio-key-settings-ui.test.ts` was inspected without edits: **1/2** scenarios passed in the ancillary run. The issuance scenario timed out selecting the hidden `#settings-key-select` after returning to General. The parent has explicitly taken the update to expand `#settings-key-details` before `selectOption`. This is outside the permitted sidecar edits and is excluded from the 64-test owned total.

Private proof directory: `runtime/verification/settings-sidecar-b8a29644525a465ab86ddf5f4db156cf/final/`. It retains `compile-proof.json`, `compile-focused.json`, `compile-focused.log`, `focused-tests.tap`, `recheck-tests.tap`, `frozen-test-sources.json` and screenshots. The original `focused-tests.tap` contains superseded fixture failures; `recheck-tests.tap` records the final 48/48 rerun. Browser startup failed inside the filesystem sandbox; the actual Edge proofs ran with disposable profiles outside that launch restriction.

No paid inference, live Studio, installation, Git command or product-code edit was performed. The fixtures prove browser behavior with synthetic HTTP/SDK/native-bridge data; they do not prove the installed CLI or actual desktop credential vault. Tests and this note are frozen for the parent's global compilation.
