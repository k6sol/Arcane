# Composer model picker

Arcane opens with one conversation column. The compact Codex model/effort button in the composer opens a nonmodal popover using the existing black/red palette and typography. Its rows come exclusively from the validated live `snapshot.models` catalogue: reported display name, exact model value, and that model's reported efforts. There are no bundled model names, provider aliases, entitlement badges, or subscription-access claims.

## Selection authority

`codex-model`, `codex-effort`, and `codex-select` remain the settings fallback and the authoritative selection lifecycle. Choosing a popover row stages those controls. Changing models clears the staged effort, requiring an explicit choice; even a reported default effort is not automatically selected. The popover's apply button delegates to the existing guarded `codex-select` click/action. It never starts/resumes a thread, sends a turn, grants/revokes permissions, clears a draft, or creates a separate provider/model preference.

The composer label is derived from reported state, preferring a configured thread's selection. Staged values do not change it. An acknowledged action updates the label through validated returned state; rejected/unknown outcomes never fabricate an applied selection. Pending actions show an acknowledgement status. Native polling may also update a reported selection, without making a new request. A changed reported selection synchronizes the settings fallback, while ordinary identical polling preserves staged choices.

The existing fresh-state, single-flight, busy, connecting/closing, display-limited, uncertainty, and configured/idle thread guards also protect picker selection. Stale, unready, disconnected, unconfigured, and active/unknown-turn snapshots cannot select, including a scripted click on the settings fallback. Unknown acknowledgements retain request IDs and use the existing explicit reconciliation flow; there are no retries. Write/asset grants and exact conversation identity remain owned by the existing action lifecycle. Workflow draft provenance still requires re-review after an actual model/effort change.

## Keyboard and layout

Opening focuses search. Search matches all query words against real reported names/values; no result is an honest empty state. Arrow keys move between model rows, and native Enter/Space activates them. Selecting a model focuses the effort group. Effort arrows/Home/End stage its radio choice. The popover is outside the composer form, so search Enter cannot implicitly submit a conversation. IME and modified editing keys are left alone. Escape returns focus to the trigger; pointer/focus outside closes without stealing the destination's focus. Tab follows the nonmodal document order. A newly blocked native state closes the popover and returns focus to the composer if the trigger is disabled. Stop removes picker document/viewport listeners, and resume binds one new set.

The fixed popover chooses available space above/below the trigger and clamps width, position, and scrollable height to the visual viewport, including resize/scroll and the mobile keyboard. Long reported names remain plain text, wrap in rows, and truncate in the compact trigger. Existing reduced-motion and visible-focus rules remain available.

## Preview contract for workspace-shell

- `artifact-panel` is initially `hidden` and also has no visible layout when the stage lacks `preview-open`.
- `workspace-preview-toggle` is a button in the chat topline with `aria-controls="artifact-panel"` and initial `aria-expanded="false"`.
- `workspace-preview-close` is an accessible close button inside the preview toolbar.
- `workspace-stage.preview-open` enables two columns on desktop; narrow screens stack the preview below the conversation.

The workspace-shell owner binds those buttons, synchronizes `hidden`/`preview-open`/expanded state, and owns auto-opening from genuine asset-job/preview signals, including `workspace:assetactivity`. CodexChat does not emit preview activity from model selection, provider setup, welcome content, or empty placeholder previews.

## Provider setup contract for the parent controller

Settings expose `provider-setup-panel`, `provider-setup-provider` (only `codex`/`claude` option values), `provider-setup-status` (`role="status"`), `provider-setup-refresh`, `provider-setup-login`, `provider-setup-install`, and `provider-setup-launch`.

Conversation markup exposes initially hidden `provider-login-gate`, explanatory `provider-login-message`, choose buttons `provider-login-codex`/`provider-login-claude`, and initially hidden/disabled `provider-login-start`/`provider-login-refresh`. Setup action buttons initially remain disabled until the parent's real setup controller supplies status. Claude is labeled as a native terminal handoff; no inline Claude chat or native catalogue alias is implemented.

The picker offers `codex-picker-connect` and `codex-picker-claude`. Each closes the popover and dispatches the document event `workspace:providersetup` with exactly `{ provider: 'codex' }` or `{ provider: 'claude' }` as detail. Their `data-workspace-target="provider-setup-panel"` also permits ordinary shell navigation to the settings section. The parent `provider-setup.ts` owns handling the event, choosing the provider, status/login/install/launch, and gate semantics. Opening a picker with no native snapshot only offers honest setup/empty catalogue content; it does not connect automatically.

`CodexChat.providerConnectionStatus()` returns a detached presentation object or `null` before any validated state:

```ts
{ connected: boolean; ready: boolean; fresh: boolean;
  auth: 'subscription' | 'signed-out' | 'unsupported' | 'unknown' }
```

`subscribeProviderStateChange(listener)` returns an unsubscribe function. Notifications are synchronous, deduplicated by status value, and cover validated state changes, refresh failure/recovery, and stop. Subscriber exceptions cannot interrupt native actions. Missing snapshots/accounts report `unknown`, including when only `lastSnapshot` exists; refresh failure marks the retained observation stale. Neither method reads rendered labels, performs setup actions, grants permission, nor authorizes submission. Codex submit still uses its existing validated account/thread/snapshot guards. The parent decides when an explicitly observed signed-out/unavailable status warrants a login gate; unknown is not signed-out.

## Private verification

Compile using `explicitProjectConfig` from `scripts/compile-product.mjs` with a private `outDir` such as `runtime/composer-picker-proof-<id>/compiled`, and `typeRoots` pointing to the checkout's `node_modules/@types`. This enumerates real source files without writing root `dist` or interfering with another agent's build output.

`tests/unit/composer-model-picker.test.ts` covers the provider presentation API and exact markup without a browser. With `ARCANE_UI_BUILD_DIR` pointing to the private compiled tree, `ARCANE_UI_BROWSER_MODULE` pointing to the installed `playwright-core/index.mjs`, and `ARCANE_UI_BROWSER_EXE` pointing to a browser, its real-browser fixtures cover catalogue search/XSS, keyboard/focus/IME, staged-versus-ACK display, grant/draft/provenance preservation, rejection/uncertainty and busy guards, setup-only events, stop/resume, and viewport clamping at 390×844, 320×568, and 1440×640. Optional `ARCANE_UI_SCREENSHOT` is a private screenshot directory.

All fixtures are synthetic: no installed Codex/Claude CLI, authentication, Studio, AV, Git, or automatic provider discovery is used. Browser and HTTP tests require permission for the headless temporary browser profile and the loopback fixture server if the execution sandbox blocks them. Existing chat, asset-permission, history, and workspace regression fixtures are run separately against the same private output.

Verified on 2026-10-13 in `runtime/composer-picker-proof-y9LONq`: [147-file private compile](../../runtime/composer-picker-proof-y9LONq/compile.log) passed; [picker tests](../../runtime/composer-picker-proof-y9LONq/picker-tests.log) passed 7/7, including five real Edge fixture tests; [existing regressions](../../runtime/composer-picker-proof-y9LONq/regression-tests.log) passed 85 with five optional browser fixtures skipped. The three viewport screenshots in that private directory were visually inspected. Root `dist` was not used as output.
