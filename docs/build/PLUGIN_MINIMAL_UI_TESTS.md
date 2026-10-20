# Minimal plugin UI fixture tests

This is the historical October 13 fixture report. Current saved-key recovery and
underscore-key migration are documented in [PLUGIN_KEY_RECOVERY.md](PLUGIN_KEY_RECOVERY.md).

2026-10-13. Tests are finalized and frozen against Parent's minimal Main patch.
Owned edits are limited to `plugin/fixtures/MockPlugin.luau`,
`tests/plugin/runtime.test.mjs`, `tests/plugin/package.test.mjs`, and this report.
Main, Transport, MockEngine, Logic.spec and installed/generated plugin artifacts
were not edited by this worker.

## Explicitly authorized local settings

The old blanket ban on `GetSetting`/`SetSetting` is replaced by an exact namespace
check for the user's requested local-key and last-connection storage:

| Setting | Allowed value | Trigger |
| --- | --- | --- |
| `Arcane.LocalApiKey.v1` | String accepted by `Validation.keyOrigin` | Explicit Connect/Reconnect click |
| `Arcane.LastConnection.v1` | Exactly `{connected: boolean}` | Current live response or connection/scope failure |

Runtime assertions check every recorded read and write. Seeded unrelated provider
credentials, session tokens and grants must remain unread and unchanged. Package
checks permit settings calls only in Main and only through these two bindings;
dynamic/aliased settings access, other persistence services, publishing, arbitrary
evaluation and asset insertion remain forbidden.

`MockPlugin` exposes `fixture.settingNames`, `fixture.pluginSettings`,
`fixture.getCalls` (key names), and `fixture.setCalls` (`{key, value}` records).
Returned/stored values and recorded writes are independently deep-copied.
`getSettingError`/`setSettingError` inject global faults;
`getSettingFaults[name]`/`setSettingFaults[name]` inject per-key faults. Calls are
recorded even when the operation throws; failed writes preserve previous values.

## Behavior covered

- Cold mount and saved reload with either cached status: exactly one transport
  worker, only two owned reads, no request, probe, automatic connect or write.
  A saved valid key shows a fixed mask while the raw TextBox remains empty.
  Cached true never turns the restarted button green.
- Explicit first Connect and later Reconnect: key validation and local save precede
  the exchange, raw input clears, and green requires the actual current transport
  ACK. Clicking while live queues `requestConnect` in the same worker, revokes the
  old session and exchanges again. A newer intent clears a superseded queued key.
- Malformed provider-shaped, table, boolean, uppercase, out-of-range and
  whitespace-suffixed keys; malformed primitive/nonboolean/credential-bearing
  connection records. These cannot prefill, connect, probe or save credentials.
- Per-key read faults and failed writes: exceptions do not broaden storage or
  expose their credential-shaped text. A current valid intent can still connect
  or reconnect through the same worker, even when local persistence fails.
- Failed initial exchange, poll failure, and sticky PlaceId/GameId/Name changes
  during an otherwise valid ACK. Failures persist only connected false, remove
  green, retain the own local key, and do not automatically repeat key exchanges
  or poll a blocked identity. A later current poll ACK can restore live green.
- Native glyph masking, fixed overlay, no public/logged secret or unsubmitted user
  text, and unload clearing raw TextBox/transport memory without erasing saved
  settings or making a request. UI and signal cleanup still execute.
- Exactly one TextBox and one Connect/Reconnect TextButton; header height 48,
  key entry Y=54, button Y=100, compact floating bounds, and no old dot, divider,
  subtitle, footer, grant panel, or white/orange replacement mark. An independent
  SVG path parser compares all three logo polygons and opacity with the actual
  `studio.html` mark. Runtime checks inspect native red Frame scanlines and bounds.

The generated original bundle is officially compiled before execution. A fixture
wrapper records the real transport constructed by unchanged Main; production
exchange, worker, status and identity methods still execute against the explicit
engine/HTTP doubles. The constructor is restored before the unchanged core suite.
Factory caching, undeclared-import rejection and bundle/source equivalence checks
remain covered.

## Result and reproduction

Both complete test files passed with the existing official Luau tools:
**42 passed, 0 failed, 0 skipped**, exit **0**, Node duration **2.041 seconds**.
The unchanged core fixture reported **372 checks** in both standalone and native
bundle executions. No compiler/runtime was installed and no deadline was relaxed.

Retained proof:
`runtime/verification/plugin-minimal-ui-tests-e73c6f0479f4457daf17758cb351f620/fixture-tests.log`.
The adjacent `result.json` records source/tool hashes and the limited fixture scope.
Parent Main SHA-256 at this gate:
`07dc6b0beb7c8da0bfc811f7d26e98093813863173218d01c748b5791d3ad3f1`.
Official compiler SHA-256:
`74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8`.

```powershell
$env:ARCANE_LUAU_BIN = 'C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau.exe'
$env:ARCANE_LUAU_COMPILE = 'C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau-compile.exe'
node --test --test-concurrency=1 tests/plugin/runtime.test.mjs tests/plugin/package.test.mjs
```

Package artifacts and harnesses were rendered only into owned disposable temporary
directories. This result covers standalone VM/package fixtures, not native Studio
rendering or a real daemon handshake. No live Studio operation, plugin install,
provider turn or connection of live fixture `99e1bbac` was performed here.
