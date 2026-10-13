# Plugin engine identity fence

`plugin/src/Transport.luau` now binds a connection to the exact `PlaceId`, `GameId` and full `Name` sent in the initial exchange payload. The pin is immutable and established before the yielding connect/pair HTTP request. An acknowledgement cannot supply or replace it, and the plugin does not recapture a later engine name. Names outside the daemon's 200-byte input bound are refused before exchange rather than truncated into a different identity.

The transport subscribes to `GetPropertyChangedSignal` for those three engine properties before the exchange. Any observed change latches the old exchange/session as blocked, including a change back to its original values. Direct current-value comparisons also guard against signals that have not yet been delivered. Identity-read failures refuse work. These checks run after every HTTP return, before polling, after a poll wait, before dispatch (including its cached-receipt path), and within every existing operation/mutation callback guard. A changed exchange acknowledgement is retained only as a blocked old session; no operation registry is created against the changed engine.

The private ScriptEditorService adapter checks identity before source reads and before/after `UpdateSourceAsync`. The return check closes the specific interval in which an accepted editor proposal could finish after an identity switch and otherwise be reread before the operation's outer guard. The editor callback keeps its existing exact source baseline and session/lease guards. Identity checks in that callback only inspect identity and latch transport state; they do not yield, send HTTP, mutate the scene or roll back source.

Blocking does not automatically disconnect, re-pair, retry a one-use exchange, delete an object, perform an inverse mutation or discard an applied command's receipt. An existing pending immutable receipt can still be delivered/retried to the **old** daemon/session using its original bearer. Its acknowledgement never clears the identity latch or resumes polling. A valid cached command cannot bypass the identity fence. The UI exposes reconciliation rather than connected/executing status and hides old write grants after an observed identity change. Only an explicit human disconnect/connect can retire that pairing and establish a new initial identity. Watchers are disconnected on session clear and plugin unload.

## Offline verification

On 2026-10-13, the existing official tools were used without downloading or invoking Studio:

```powershell
$env:ARCANE_LUAU_BIN = 'C:\Users\alexk\AppData\Local\Temp\arcane-luau-tools\luau.exe'
$env:ARCANE_LUAU_COMPILE = 'C:\Users\alexk\AppData\Local\Temp\arcane-luau-tools\luau-compile.exe'
node --test --test-timeout=60000 tests/plugin/*.test.mjs
```

All **16 tests passed, zero skipped**. The official compiler compiled production/fixture sources and the generated native `.lua` bundle. The real standalone Luau VM executed **372 logic checks** against explicit engine doubles, both as source modules and through the generated native module factories/Main. Added cases cover each identity field changing and reverting during both key/legacy exchange and poll waits; a queued mutation with a deferred identity signal; changes before and during a reinvoked editor callback; identity changing after an accepted editor proposal but before its async return; successful pending/cached receipt delivery without resumed work; unchanged identity success; and watcher unload cleanup. The editor-return fixtures also assert that no source reread occurs after the change. Package/runtime test scripts were not changed.

The parent owns the production artifact rebuild after its concurrent TS/unit gate, followed by stale-build verification and any authorized reinstall. This worker's tests generate and compile temporary genuine bundles from the changed production source; they do not update the installed plugin. The existing installed artifact's prior hash does not include this fix.

## Limits

This is a current-engine identity fence, not a new identity protocol or a proof of native installation. No HTTP schema, daemon, storage, MCP, UI source, production Operations implementation, TS tests, build scripts or task board were changed.

- The paired metadata on the daemon remains the initial exchange snapshot. It has no built-in Studio ID or installed artifact digest; the parent must still corroborate the exact disposable window, plugin lifetime, installed hash and pairing.
- Native property-signal scheduling and actual place loading/unload behavior remain unverified. A current mismatch is synchronously refused; change-and-return detection relies on the engine delivering the property-change signal. Two unpublished places with identical IDs/name and no observable signal cannot be distinguished by this tuple alone. The parent must not switch places during acceptance.
- An engine operation that already accepted a proposal before a switch may have applied it. The fence cannot undo an engine-internal write or claim atomic cancellation across a yielding engine call. Existing partial/unknown recovery reporting and immutable receipt delivery are preserved; no extra cleanup mutation is introduced. Non-yielding scene operations retain their existing guarded boundaries.
- If the daemon refuses or never acknowledges the old receipt, the plugin retains the pending receipt/block and uses existing bounded delivery backoff; it does not resume scene work. Explicit human session replacement/unload retains the pre-existing behavior of clearing plugin memory; inspect the daemon receipt/unknown outcome before doing so.
- No native Studio test, provider inference, plugin installation, account operation, upload or publication occurred in this change. Global native Undo and the acceptance runner's other documented limits remain unchanged.

The runner prerequisites and remaining native checks are in [PLUGIN_ACCEPTANCE_PLAN.md](PLUGIN_ACCEPTANCE_PLAN.md).
