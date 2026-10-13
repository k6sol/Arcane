# Simplified setup and typing — 13 October 2026

Current development preview:
`C:/Users/alexk/OneDrive/Documents/GitHub/Arcane/runtime/windows/arcane-win32-x64-cW8IBK/Arcane.exe`

The whole folder is required. Unsigned Windows x64 directory build; not an
installer or a claim that the original full-product catalogue is complete.
The normal app was opened for the user, PID 13668, title Arcane – Untitled.

## Changes

- Step 1: Sign in with ChatGPT through the native Codex browser OAuth flow;
  Claude retains its honestly labelled native login handoff. Fresh subscription
  observations, not saved presentation preferences, enable the next step.
- Step 2: Generate API key. No permission selector. The key grants all seven
  currently supported service roots and scene/script editing in edit mode.
- Regenerate atomically revokes every previous active key and its sessions in
  this project's daemon. No implicit retry after an unknown outcome. Existing
  command reconciliation, project identity and human/agent authority stay intact.
- The desktop stores its own key with Windows protected encryption. Replacing
  it atomically reduces the vault to the replacement key. Copy calls the native
  desktop clipboard with an exact stored key ID; it accepts no arbitrary text.
- The plugin retains and displays the editable key across reload. Editing
  immediately fences old pairing activity. Connected is green only after a real
  acknowledgement; saved/disconnected keys show red Reconnect. Rejected keys
  show Failed and invite a replacement. Native input remains a standard TextBox.
- Plugin default size 260 × 200; minimum height 185; bottom padding 18.
- Compact reported-model menu with selected checks and expandable reasoning.
  Choices remain catalogue-derived; no invented entitlements or effort levels.
- Input handling avoids full chat/tab/model renders per keystroke. Draft saves
  coalesce; switching tabs/projects and lifecycle boundaries flush immediately.

## Observed verification, not inferred completion

Actual current packaged EXE: **27/27 checks passed**. Evidence:
`runtime/verification/windows-executable-KaRjO1/verification.json`.
Includes owned daemon startup, real renderer, isolation, local draft switching,
bounded parent-loss cleanup and unchanged bundle integrity. It deliberately
does not authenticate a provider, run a model, pair Studio or save smoke prefs.

Focused coordinator model/provider/performance/browser checks: **50/50**,
zero skipped. Native clipboard/key-vault host fixtures: **38/38**.
Plugin official-Luau/engine-double/package checks: **107/107**.
Separate worker key HTTP/browser tests: **38/38** across targeted runs;
provider browser contract tests **21/21**. These overlap other focused suites;
do not add them as a unique full-suite count. Real native OAuth completion and
Studio pairing/edit/restore remain independent acceptance gates.

Synthetic Chromium profiling, three runs, 120 inputs, 16 tabs, 256 saved threads:
preference writes 120 → 2; full snapshot reads 120 → 6; median input-handler p95
10.3 ms → 0.1 ms. These establish fixture hot-path improvements, **not native
EXE paint latency**. Cold animation-frame results were noisy and worse; native
persistence/compositing remain unmeasured. Sources:
`runtime/chat-tabs-perf-1791922195305/baseline-realview.json` and
`runtime/chat-tabs-perf-1791922195305/after-realview.json`.

The fresh full invocation at `runtime/verification/key-performance-full-rO9FJh`
finished: 1458 unit/browser tests, 1456 passed and two stale presentation
assertions failed; **491/491** offline/release/plugin tests passed, no skips.
The two assertions expected the superseded visible key-details disclosure.
Both were updated for the explicitly requested single-key interface and passed
against the same production modules in a private emit, **2/2** across three
viewports. All 587 pinned inputs were checked: only this reviewed test source
changed; production, existing emissions and every other fixture were unchanged.
Explicit combined acceptance is sealed at
`runtime/verification/frontend-key-repair-P5D18L/combined-verification.json`.
It reuses the 1456 unchanged passes plus the two repaired passes, and is **not**
a new full-suite invocation. Original failed logs remain intact. Individual
security/test deadlines were unchanged. Root `dist` still contains the prior
fixture emission; compile afresh before another packaging invocation.

Failed first browser sandbox/profile run and stale-emission packaging attempt
are retained. The latter refused a changing test source instead of silently
shipping it. Workers were closed, all 173 sources compiled afresh, and the
final package plus actual EXE verification then succeeded. No protection,
credential-file, paid-inference, publishing or Hunted operation was performed.

Installed plugin:
`C:/Users/alexk/AppData/Local/Roblox/Plugins/ArcaneLocalBridge.lua`
SHA256 `38e2fd7b2c8bd057572774baf744345fd57034fa9c4605fd8d5365f2e8de5463`.
Studio must reload it normally; no Hunted window was reloaded by the agent.

Official native login contract:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
