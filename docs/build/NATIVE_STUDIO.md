# Official Studio MCP read adapter

Arcane's native adapter in `packages/studio-adapter` connects to Roblox's built-in Studio MCP server with `@modelcontextprotocol/sdk` **1.32.1**. Its public entry point is `connectNativeStudio`. This package exposes reads and runtime discovery. The parent owns daemon/UI integration, root dependencies, protocol, plugin installation, and the disposable Studio fixture.

Primary reference: [Roblox Studio MCP documentation](https://create.roblox.com/docs/studio/mcp), checked 2026-10-11. The server speaks stdio; obtain each exact Studio instance ID from `list_roblox_studios`. Documentation counts are not capability evidence: this adapter actually calls SDK `listTools`, including bounded pagination.

## Installation discovery and process boundary

On Windows, discovery reads at most 16 KiB of `%LOCALAPPDATA%\Roblox\mcp.bat` **as text**. It extracts the installed `if exist` target without executing the batch file, its registry fallback, or its contents. It accepts only an absolute `Roblox\Versions\version-<16 hex digits>\StudioMCP.exe` below that local installation. Relative paths, outside executables, alternate data streams, network paths, symbolic links and redirected installation paths are refused. Discovery checks an ordinary bounded PE file, verifies a valid Authenticode signature from Roblox Corporation, and records SHA-256.

The signature check uses the fixed absolute Windows PowerShell executable, `execFile`, `shell: false`, `windowsHide: true`, a fixed encoded script, a path supplied as data, a 5-second deadline, and 16 KiB output. It does not execute caller-generated script. There is no arbitrary executable/argument/environment override. A missing/stale batch target fails with `STUDIO_EXECUTABLE`; the adapter does not search PATH, execute the batch fallback, or silently choose another installation. Non-Windows discovery is presently unsupported.

The official SDK stdio transport launches that vetted executable with no arguments, `shell: false`, `windowsHide: true` on Windows, ignored stderr, the vetted installation directory as cwd, and a 512 KiB wire buffer. The SDK's restricted default environment contains operating-system variables; Arcane does not copy provider credentials, read provider configuration, or pass the parent's entire environment. Executable vetting trusts the local Windows installation and code-signing chain; it is not an OS sandbox.

## Read capabilities and exact targeting

| API/tool | Required target | Additional arguments |
| --- | --- | --- |
| `session.listStudios()` → `list_roblox_studios` | Global inventory exception | None |
| `get_studio_state` | Exact `studio_id` | None |
| `search_game_tree` | Exact `studio_id` | Explicit `datamodel_type`: Edit, Client or Server; optional path/type/keywords, depth 1–10, head limit 1–200 |
| `inspect_instance` | Exact `studio_id` | Explicit path |
| `script_read` | Exact `studio_id` | Existing target_file; whole-file read or ordered inclusive range of at most 500 lines |
| `script_search` | Exact `studio_id` | Nonempty keywords |
| `script_grep` | Exact `studio_id` | Nonempty query |
| `get_console_output` | Exact `studio_id` | None |

Every targeted read requires its own explicit ID. The adapter refreshes `list_roblox_studios` immediately before dispatch, requires an exact ID match, and forwards that same ID unchanged. A missing ID yields `STUDIO_NOT_FOUND`; it never selects the first Studio, reuses an active window, or substitutes another place. The inventory operation itself has no ID in this installed server's actual schema.

The fixed read allowlist is enforced before requests, alongside strict per-method input validation and runtime JSON Schema validation. Tool annotations are an additional conservative check, never authority to expand the allowlist. Runtime tool removal/schema changes disable that capability. `notifications/tools/list_changed` invalidates the discovered inventory, which is refreshed before further operations. Raw evaluation, edits, play controls, simulated inputs, autonomous Studio subagents, asset generation/insertion/upload, screenshots, documentation HTTP tools and unrecognized tools cannot be called through this adapter. The SDK client and transport are private; there is no raw-call escape hatch in the public API.

Native results retain their official MCP format and are untrusted data. Native dot paths can be ambiguous for duplicate names. Native inspection returns Roblox's readable properties; the native API does not provide plugin root grants, opaque instance references, editor-baseline guarantees, pairing leases or mutation receipts. Parent integration must keep this native read surface distinct from the plugin methods in `BRIDGE_CONTRACT.md`, and must not label a native connection as a paired writable plugin session. Read Studio state before requesting a datamodel, and let a rejected/unavailable datamodel fail without changing play state.

## Limits and lifecycle

Default request deadline: 10 seconds; caller maximum: 15 seconds. Both the SDK timeout/max-total-timeout and a deadline covering transport startup are installed; progress cannot extend the deadline. Argument JSON is at most 256 KiB, result/wire JSON at most 512 KiB, and a script-read response including its envelope at most 100 KiB. Search strings and paths have smaller local bounds.

One adapter operation may be in flight. It refuses overlap rather than queueing hidden work. Default budget is 64 client requests, maximum 256; handshake, every tool-inventory page, every Studio inventory and every targeted read consume budget. Tool inventory is limited to 128 tools across four pages and 256 KiB combined inventory JSON; Studio inventory to 64 unique identities. A targeted read needs budget for both its fresh inventory and its read before either starts.

Timeout/transport failure/excessive response closes the connection and returns a bounded generic error with no raw stderr. Calls are never retried automatically. `close()` is idempotent and uses SDK 1.32.1's EOF → 2-second grace → SIGTERM → 2-second grace → SIGKILL lifecycle. Always await it in `finally`. Source-size or bad-input refusals can be corrected with a smaller explicit read.

```ts
import { connectNativeStudio } from './packages/studio-adapter/src/index.js';

const session = await connectNativeStudio({ timeoutMs: 10_000, maxRequests: 32 });
try {
  const inventory = await session.listStudios();
  // Display inventory; caller explicitly supplies exactId. Never derive it from inventory[0].
  const result = await session.read('get_studio_state', { studio_id: exactId });
  const capabilityMetadata = session.metadata(); // Genuine schemas, version, provenance and connection state.
} finally {
  await session.close();
}
```

## Verification and saved evidence

`tests/unit/native-studio.test.ts` uses an official SDK Server/Client pair over **in-memory fixtures**. It tests allowlist denial (even misleading read annotations), exact IDs across two fixture windows, stale/malformed inventories, runtime schemas/list changes, pagination, numeric/source bounds, request budgets, hanging startup/request deadlines, response size, error redaction and closure. Fixture metadata explicitly reports `evidenceKind: fixture` and `transport: in-memory-fixture`; it does not prove Roblox runtime behavior or plugin behavior.

Scoped build/test commands, from the repository root:

```powershell
node node_modules/typescript/bin/tsc -p packages/studio-adapter/tsconfig.check.json
node --test packages/studio-adapter/.test-output/tests/unit/native-studio.test.js
```

These outputs stay in the adapter package's ignored `.test-output` directory. Root `npm run build` also includes the sources and test through the parent's existing TypeScript configuration. No root dependencies or lockfile were edited by this worker.

Capture genuine native runtime evidence with no place writes:

```powershell
node packages/studio-adapter/.test-output/packages/studio-adapter/src/check.js
node packages/studio-adapter/.test-output/packages/studio-adapter/src/check.js --studio-id EXACT_ID
```

The command prints JSON; saving it requires the host's normal write approval. It performs initialization, actual `listTools`, actual Studio inventory, and optionally one explicitly targeted `get_studio_state`. It never chooses a target from the inventory. Saved observation text is bounded/redacted; source, properties, attributes, logs, stderr and provider credentials are excluded. Capability schemas omit prose descriptions/examples. Runtime capture labels fixture validation as not run by that capture, so a fixture pass is never presented as a live pass.

The checked-in `docs/research/native-studio-checks.json` records the actual installed executable signature/hash, runtime tool schemas, sanitized Studio inventory/target result and awaited close. Its separate `fixtureValidation` section records the unit-test command/result. The Hunted ID supplied for read-only checking is `43b622a3-4265-42da-92fd-c9980c3022a3`; a current inventory omission must be recorded as a refusal. This worker has no permission to mutate Hunted. The parent owns all plugin/disposable-baseplate runtime testing, which this evidence does not claim.

## Parent HTTP integration handoff

The package exports `connectNativeStudio`, `NativeStudioError`, `NATIVE_STUDIO_READ_METHODS`, `NATIVE_STUDIO_LIMITS` and the per-method argument types. The returned session exposes only `metadata()`, `listStudios()`, `read(method, args)` and lifecycle methods. Call `connectNativeStudio` for an explicit native connection and retain that session until disconnect, shutdown or a connection failure; there is no automatic reconnection or target selection.

| Parent action | Adapter call | Result |
| --- | --- | --- |
| Connect native read adapter | `await connectNativeStudio({ timeoutMs, maxRequests })` | Vetted process plus actual capability discovery |
| Inspect native capabilities/status | `session.metadata()` | Observed schemas/provenance and current connected flag; does not issue another native request |
| Refresh native Studio choices | `await session.listStudios()` | Exact current native IDs and names; no default selection |
| Dispatch an explicitly targeted read | `await session.read(method, args)` | Strict allowlist/runtime validation, fresh inventory match, official MCP result |
| Disconnect/shutdown | `await session.close()` | Idempotent bounded process shutdown |

Apply the bridge's loopback/control-bearer/Origin rules in the parent-owned HTTP routes. Bound HTTP JSON before passing it to the adapter; the adapter also bounds its own arguments, runtime schema inventory and results. Reject arbitrary executable, environment, transport, play or write fields. Preserve `studio_id` as a native instance ID, separately from plugin `sessionId` and opaque refs. A plugin grant does not create native write capability.

For parent error responses, `STUDIO_READ_ONLY`/`STUDIO_ARGUMENTS` are caller errors; `STUDIO_NOT_FOUND` is unavailable exact selection; `STUDIO_BUSY` is overlap; `STUDIO_REQUEST_LIMIT` requires another explicit connection; `STUDIO_TIMEOUT`/`STUDIO_REQUEST_FAILED` require explicit reconnect. Forward the bounded error code/message, without adding raw transport errors or stderr. Do not fall back from a missing native target to Place1, from a failed plugin read to an unrestricted native read, or from a native refusal to raw Luau.

The saved runtime observation retains its capture timestamp and original request-limit metadata. Later fixture validation records review of current bounds separately. Parent testing of an explicitly created `Arcane-Disposable*.rbxlx` is a separate runtime proof; inventory presence alone does not grant permission to modify it or Place1.

## Separate human-only native HTTP routes

`apps/daemon/src/native-routes.ts` exports `nativeRoutes()`, returning the parent's requested async `(request, response, url, controlToken, origin) => boolean` handler. It handles only `/v1/native` and its namespace. Other routes return `false`, preserving the parent's existing router. This worker does not mount it in the shared server or add MCP tools.

Parent mounting example, inside its existing loopback request callback:

```ts
const native = nativeRoutes(); // Once per daemon; production default is the real vetted adapter.

// After the parent's common URL/host setup, before other private route fallthrough:
if (await native(request, response, url, token, origin)) return;
// token is the HUMAN launcher control bearer. Never pass agentToken here.
```

| Endpoint | Request | Behavior |
| --- | --- | --- |
| `GET /v1/native/capabilities` | Human control bearer; no query/body | Fresh real `connectNativeStudio`, actual runtime metadata, actual `listStudios`, awaited close; only native provenance/capabilities and native inventory returned |
| `POST /v1/native/read` | Human control bearer; JSON `{method,args}` | Strict envelope plus fixed adapter read allowlist; exact `args.studio_id` required; session refreshes inventory before dispatch; official result returned only for this explicit request; awaited close |

The route accepts only the supplied human control token, with one unambiguous Authorization header and constant-time comparison. The model/agent bearer is not an accepted audience. Any supplied Origin must exactly equal the parent's local panel origin. Browser POSTs identified by browser fetch headers or a browser user agent require that exact Origin. Native human CLI POSTs may omit Origin with the correct control bearer; Node fetch's `Sec-Fetch-Mode` alone does not classify it as a browser. The configured origin, request host, URL origin and remote peer must all be the expected literal loopback endpoint.

POST input is capped at **32 KiB UTF-8** for both Content-Length and chunked uploads, with an **8-second absolute body deadline**. Only unencoded application/json is accepted. Invalid JSON/UTF-8, unknown envelope fields, unexpected per-method fields, missing targets, out-of-range limits, writes/evaluation/play/inputs, schema/executable/environment/transport overrides and native-query parameters fail before a child connection starts. Rejected uploads may discard at most 64 KiB without buffering for at most 200ms to deliver a small error response before closing the HTTP socket.

Production connections use a 5-second SDK request timeout and 16-request budget, in addition to the adapter's existing executable-signature, pagination, byte and close bounds. Every successful connection closes in `finally`, including inventory/read errors. Client disconnects close an owned session; a connection that resolves after a disconnect is immediately closed before further work. No request is automatically retried or redirected to another target.

A module-wide gate covers native capability probes and reads across all route factories. While a native request is in flight, another authenticated native request returns **409 BUSY**, with native read-only/busy metadata and no queued connection. The gate remains held through cleanup. Namespace, authentication and Origin failures cannot clear someone else's gate.

Successful response native metadata identifies the built-in MCP surface, actual live/fixture provenance, explicit-read requirement and observed availability. `metadata.connected` is false because the per-request connection has already closed. Capability GET performs no scene/script/source/log read and chooses no default target. Source/log/inspection results are available only through a human-authenticated explicit POST with its exact target. Parent UI should keep read controls disabled until the human selects that target and deliberately requests the read. This native surface does not confer plugin pairing, root grants or write permission, and never falls back from plugin commands.

Responses are no-store JSON with a 512 KiB total HTTP envelope limit. Known errors use bounded constant messages; process/connector exceptions and stderr are not returned. The exact human bearer is redacted from any untrusted result text. An official MCP tool error remains HTTP 502 with `STUDIO_TOOL_ERROR` and its bounded MCP result, rather than a false success.

`nativeRoutes({ connect: fixtureConnector })` is a code-level unit-test seam, never request input. The no-option production factory always calls the real adapter. `tests/unit/native-http.test.ts` exercises a real loopback HTTP server and injected official SDK Server/Client in-memory fixtures. Its fixture provenance stays visible; these tests do not prove live Studio or disposable-place behavior.

Scoped HTTP/adapter compilation and fixture verification with the installed TypeScript compiler:

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --rootDir . --outDir packages/studio-adapter/.test-output --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node tests/unit/native-http.test.ts tests/unit/native-studio.test.ts
node --test packages/studio-adapter/.test-output/tests/unit/native-http.test.js packages/studio-adapter/.test-output/tests/unit/native-studio.test.js
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The existing live capability/inventory proof remains separate from HTTP fixture validation. No additional live Studio or user-place calls are required to verify this route module; the parent can test its explicit disposable fixture after mounting the handler.

Final verification: 16 HTTP fixtures plus 18 adapter fixtures passed (34/34), and repository TypeScript checking passed. A fresh isolated loopback controller using the production default connector returned an actual SDK-backed capability GET with native live provenance, 30 discovered tools, native inventory and an already closed connection. It made no targeted reads or mutations and did not restart the parent server. See nativeHttpRuntime in docs/research/native-studio-checks.json for timestamp, executable fingerprint, actual schemas/inventory and controller hash; this evidence is separate from fixtures and the parent UI lifecycle.
