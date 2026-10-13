# Native asset LAB wiring proof

`tests/unit/native-asset-lab.test.ts` exercises the actual `createConnectionLab`
listener, its internally created Codex service and native asset registry, SQLite
Studio/work/action/conversation stores, source MCP server, official MCP SDK and
native asset HTTP routes. It does not assemble a second route/registry harness.

The only added application seam is trusted/test-only
`Options.codexConnect?: CodexServiceOptions['connect']`. It supplies the owned
service's client factory. Existing `codexService` injection takes precedence.
Neither factory options nor registry credentials are accepted from HTTP or
returned in public state; production retains its existing native connection path.

The labelled `fakeCodexHostClient` consumes `hooks.finalCredential()` into the
fixture closure. Its configured thread snapshot reports
`mcpIsolation: 'arcane-only-verified'` and subscription authentication. The fixture
holds the thread ACK and separately calls `hooks.dispatched()` before holding the
turn ACK. `fakeAssetService` creates only synthetic job records and invokes the
real admission callbacks. These are explicit provider/runtime doubles, not
installed-native attestation, provider-origin attribution or originating-turn
proof. The native key is never exported from the fixture.

The proof verifies:

- Configured provider metadata alone does not seal the native key. The human
  thread action remains pending in the actual SQLite journal until ACK; afterward
  the journal is acknowledged, the durable native binding exists and assets seal.
- Asset start/cancel require an explicit human grant and an active dispatch
  window. An open window alone cannot grant permission. The source native-mode
  SDK creates an asset while the turn ACK is withheld and lists only the original
  sealed chat, even when the fake provider's displayed chat changes. The binding
  survives closing and reopening the conversation store; global jobs stay out.
- The sealed key retains inherited Studio/work reads, including SDK sessions,
  work runs/ready tasks and command receipts. Existing paired root and Studio
  write-grant checks still refuse unauthorized commands before enqueueing.
- The key cannot use global asset routes or human Codex grants, Studio pairing,
  session revocation, key listing/issuance/revocation, work review or MCP-token
  handoff. Native asset routes reject any Origin; inherited routes reject a forged
  Origin. Human/generic bearers cannot select the native asset audience.
- Disconnect retires both native asset access and inherited Core access. A real
  partially sent Core work mutation is denied after retirement during body
  reading, leaving the work store unchanged. Disconnect and LAB shutdown fence
  authority before the provider double's close callback.
- Existing injected Codex services remain usable and bypass `codexConnect`.

Validation uses a private scoped TypeScript configuration with explicit test
entry points and a temporary output directory. Root `dist`, compiler scripts and
UI files are not changed. The compiler's Node type roots must explicitly point to
the workspace dependencies when its configuration lives under the system temp
directory. The typed AssetService double includes the current required
`outputRoot`.

Private validation on 2026-10-13: scoped compilation passed; all six new LAB tests
passed. The combined run of `native-asset-lab`, `native-asset-authority`,
`native-asset-integration`, `mcp-native-assets`, `studio-store`, `studio-http` and
`codex-http` passed 76 of 77 tests. Output is retained under
`C:/Users/alexk/AppData/Local/Temp/arcane-native-asset-lab-check-phQbSU/out`.

The remaining existing `studio-http` test exposes a parent wiring/API mismatch:
`studioRoutes` now accepts a request-based agent-token resolver, but the human
`/v1/product/mcp-token` response still serializes the resolver itself as `token`.
JSON omits that function, so the expected generic agent token is absent. The
resolver needs to be evaluated for the human request while preserving the native
key's human-only denial. `studio-routes.ts` is outside this patch's permitted write
scope and is left for the parent; the failed regression is not suppressed.

Installed Codex, provider auth/config/discovery, actual asset generation, Blender,
Studio engine execution and installed-plugin checks remain deferred. Studio edit
mode is enforced by the existing engine/plugin layer, outside this HTTP/SQLite
proof; no new permission bypass or engine verification claim is introduced.
