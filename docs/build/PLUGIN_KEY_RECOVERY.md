# Plugin API key recovery

A wellformed Arcane local key is saved when the user clicks Connect or Reconnect,
before the exchange completes. Only a current live ACK turns the button green.
A valid saved key resumes automatically through the existing single worker.
Recovery first authenticates a read-only status request for this exact key,
endpoint and plugin lifetime. Only an absent or lost session permits a fresh
exchange. No old bearer, command, receipt or grant is restored. Typing a
replacement fences recovery, and opening the widget does not start a new pairing.

## Durable local settings

The current owned settings are `Arcane_LocalApiKey_v2` and
`Arcane_LastConnection_v2`. Underscore names avoid the characters that
[Roblox warns can corrupt plugin settings](https://create.roblox.com/docs/reference/engine/classes/Plugin#SetSetting).
The previous dotted names are read only for migration; they are never written.
A current valid value takes precedence. An empty current key records deliberate
removal, so a legacy key cannot return after Replace or rejection.

Settings calls can silently fail when Studio windows share a plugin. Startup
retries missing or failed reads a bounded number of times on the existing worker.
Saves are read back and compared with the intended value; unconfirmed saves get
bounded retries. A newer edit or an unload retires pending work. Failed persistence
shows fixed amber guidance without exposing the key or native error text.

On `/v1/plugin/connect`, HTTP 401 or 403 means `KEY_REJECTED`. The current exchange
reports `failed`; Main shows a red **Failed** button and **Enter a new API key**.
The rejected saved value is removed by writing an empty string to the owned
`Arcane_LocalApiKey_v2` setting. Cached connected history becomes false if it was
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
They retain the saved key and use bounded status-first recovery; they never
blindly repeat an uncertain exchange or show key-rejected guidance.
HTTP 401/403 on an established session's poll still means `REVOKED`: the session
bearer is cleared, the button stays red Reconnect, and the human key is retained.
These paths remain distinct from connect-route rejection.

Only the two current owned settings and their two read-only migration names are
accessed. Provider credentials, unrelated session settings, and grants are
untouched. Unload retires pending storage work and clears in-memory secrets and
bindings without sending HTTP. A rejected key stays deleted; a valid replacement
remains saved.

## Focused regression checks

`tests/plugin/runtime.test.mjs` executes unchanged source Main and modules with
standalone import doubles, and separately executes a fresh `renderPlugin` Lua
bundle. Both use the real Luau VM with explicit GUI, settings, HTTP, and scheduler
doubles. Cases cover entered and saved wellformed keys rejected by 401/403,
malformed replacements during cold, queued, and live states, explicit replacement
ACKs on one worker, status-first recovery, unknown network outcomes, unchanged
poll revocation, migration, silent storage failures, deletion tombstones and
genuinely suspended old HTTP responses returning after newer clicks or typing.
`plugin/fixtures/Logic.spec.luau` also checks transport error
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
