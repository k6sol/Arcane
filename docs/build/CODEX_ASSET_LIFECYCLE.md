# Private native asset lifecycle hooks

`ConnectOptions.nativeAssetHooks` is a trusted host-code option. Supply an exact
frozen plain object (or null-prototype object) with four own data callbacks:

```ts
const nativeAssetHooks = Object.freeze({
  finalCredential(): string { return host.acquireFreshNativeSessionBearer(); },
  dispatched({ connectionId, threadId, operationId }): void {
    host.openLocalAssetIntent({ connectionId, threadId, operationId });
  },
  ended({ connectionId, threadId, operationId }): void {
    host.endLocalAssetIntent({ connectionId, threadId, operationId });
  },
  retired(): void { host.retireNativeSessionAssets(); },
});
```

The example's `host` methods describe parent-owned integration; this client adds
no registry, asset service, HTTP or lab behavior. Omitting hooks performs no asset
actions and retains the previous native-config and generic Arcane launch behavior.
Hooks require `arcaneMcp`. Hooks, credentials, audience and private operation IDs
are never accepted as thread/turn/history input or added to native RPC parameters.
Hooks do not appear in snapshots or events.

The factory first validates the trusted Arcane launch profile. Discovery receives
only the secret-free disabled Arcane launch. After discovery verifies disabled,
non-plugin Arcane and safe inherited-server overrides, the factory awaits discovery
close. It then calls `finalCredential()` exactly once and rebuilds the final profile
through the same trusted path, bundle and loopback-URL validator. The returned
64-hex bearer must differ from the original generic bearer. Callback failure,
invalid credential or final initialization failure retires the host authority.
Invalid options/profile paths fail before discovery or credential acquisition.

Only the final child receives `ARCANE_ASSET_AUDIENCE=native-session`. Its fixed
Arcane `env_vars` contains exactly `ARCANE_DAEMON_URL`, `ARCANE_LOCAL_TOKEN` and
`ARCANE_ASSET_AUDIENCE`. Credentials remain in the final child environment and
never in argv. Discovery and the separate history helper receive neither bearer,
audience nor hooks. The validated profile values are captured before discovery;
host callback mutation cannot change the final paths or URL. Each history read
receives a fresh copy of the immutable secret-free helper template.

The existing human, native account, exact thread/model/effort and per-turn Arcane
isolation gates run before dispatch. The client reserves the existing native
`turn/start` operation UUID before writing. The transport invokes `onDispatched`
only for `turn/start`, after `#write` succeeds and its pending entry is marked
dispatched. The frozen callback scope carries the actual connection, thread and
operation IDs. This permits a local asset window before a native turn ACK or ID.
A dispatch callback exception stops the transport with dispatched `UNKNOWN`;
the preserved operation is uncertain and cannot be replayed as not-sent.

`ended` synchronously fences the current local intent on a scoped terminal
notification, terminal ACK without a notification, interrupt fence, definite
rejection or not-sent failure. Terminal-before-ACK and late ACK cannot reopen it.
The client clears its intent before calling host code, so reentrant cleanup is
idempotent. `retired` runs once, synchronously before cleanup awaits, on close,
disconnect, account transition/read failure, isolation failure, uncertain ACK or
bounded operation-history exhaustion. Retirement also ends any open intent and
prevents subsequent dispatch on that hooked session. Native operations and their
observed IDs remain available for explicit reconciliation. Cleanup continues if
an `ended` or `retired` callback throws; host callbacks must themselves fail closed.

These hooks attest **LOCAL dispatched intent only**. Same-session provider-origin
per-turn attribution remains unproven: a bearer or hook scope does not establish
which provider-origin tool call belongs to a turn. Host integration must preserve
that limitation. Lifecycle handling uses direct private state and callbacks;
bounded public event-ring polling is not an authority mechanism.

`tests/unit/codex-asset-lifecycle.test.ts` copies the emitted client modules verbatim
into private temporary trees and reuses the existing discovery authority source
peer. Synthetic Node/process-boundary fixtures cover credential order, env/argv,
helper secrecy, pre-ACK tool windows, terminal/interrupt fences, write/preflight
failures, account/revoke/close retirement, uncertainty/no replay, operation limits
and no-hooks compatibility. They do not run installed Codex/Claude, inference,
Studio, provider auth/config reads or shared-root compilation. Compile the exact
client source and fixture peers into a private output directory to run this suite.
