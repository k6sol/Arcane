# Plugin API key recovery

A wellformed Arcane local key is saved when the user clicks Connect or Reconnect,
before the exchange completes. Only a current live ACK turns the button green.
Loading a saved key, typing, opening the widget, and idle worker cycles never
connect automatically.

On `/v1/plugin/connect`, HTTP 401 or 403 means `KEY_REJECTED`. The current exchange
reports `failed`; Main shows a red **Failed** button and **Enter a new API key**.
The rejected saved value is removed by writing an empty string to the owned
`Arcane.LocalApiKey.v1` setting. Cached connected history becomes false if it was
previously true. Session, operation, receipt, and identity observer state is
cleared. The rejected key is never retried automatically.

A malformed explicit replacement also clears the owned key setting and raw
input, shows the same failure guidance, and internally requests disconnect to
fence older queued or live work. The existing worker performs any required old
session revocation. There is no Disconnect control in the UI.

Typing a replacement resets Failed to Connect and displays only the fixed mask.
Clicking saves the validated replacement and queues its exchange on the existing
single worker. Its ACK establishes the new session and turns the button green.
An older exchange's rejection cannot erase a newer queued or saved key, change
its generation, or overwrite its status. Text typed while an exchange is pending
is preserved when that exchange returns, including when it rejects the old key.

Network exceptions, timeouts, and HTTP 500 leave the exchange outcome unknown.
They report disconnected, retain the saved key, and require another explicit
click; they do not show key-rejected guidance or retry the exchange automatically.
HTTP 401/403 on an established session's poll still means `REVOKED`: the session
bearer is cleared, the button stays red Reconnect, and the human key is retained.
These paths remain distinct from connect-route rejection.

Only the two owned settings are accessed. Provider credentials, unrelated session
settings, and grants are untouched. Unload clears in-memory secrets and bindings
without writing settings or sending HTTP. A rejected key stays deleted; a valid
replacement remains saved.

## Focused regression checks

`tests/plugin/runtime.test.mjs` executes unchanged source Main and modules with
standalone import doubles, and separately executes a fresh `renderPlugin` Lua
bundle. Both use the real Luau VM with explicit GUI, settings, HTTP, and scheduler
doubles. Cases cover entered and saved wellformed keys rejected by 401/403,
malformed replacements during cold, queued, and live states, explicit replacement
ACKs on one worker, absence of automatic retry, unknown network outcomes, unchanged
poll revocation, and genuinely suspended old HTTP responses returning after newer
clicks or typing. `plugin/fixtures/Logic.spec.luau` also checks transport error
classification, intent fencing, secret removal, and explicit recovery directly.

Run with the pinned tools:

```powershell
$env:ARCANE_LUAU_BIN = 'C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau.exe'
$env:ARCANE_LUAU_COMPILE = 'C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau-compile.exe'
node --test --test-concurrency=1 tests/plugin/runtime.test.mjs tests/plugin/package.test.mjs
node scripts/build-plugin.mjs --check
```

Run the final generated-artifact check after the parent builds current production
sources. These checks use temporary harness files and do not install or reload a
native plugin, launch Studio, or perform a paid turn. The VM doubles do not certify
native Studio behavior; native reload and validation remain the parent's step.
