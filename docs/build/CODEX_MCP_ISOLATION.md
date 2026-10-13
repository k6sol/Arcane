# Embedded native Codex: bounded MCP isolation preflight

`CodexSession` verifies the current native thread's MCP inventory during Arcane-only thread setup and again immediately before **every** `turn/start`. A previous successful setup check is insufficient. The `native-config` path retains its existing thread/turn behavior and performs no automatic inventory checks.

The wire request uses only the checkpointed stable bindings in `packages/codex-client/.protocol/v2/ListMcpServerStatusParams.ts`, `ListMcpServerStatusResponse.ts`, `McpServerStatus.ts`, `McpServerConnectionStatus.ts` and `McpServerStatusDetail.ts`:

```json
{"method":"mcpServerStatus/list","params":{"cursor":null,"limit":32,"detail":"toolsAndAuthOnly","threadId":"<exact current native thread ID>"}}
```

Every page keeps that exact thread ID. There is no connection-wide fallback, tool invocation, login, inference retry or reconnect. The installed CLI is not probed to discover or regenerate fields.

## Bounds and acceptance

Inventory is capped at eight pages, 32 rows per page, 64 distinct server names and 2,048 tool names in total. Server/plugin/tool names are bounded to 256 UTF-8 bytes and cursors to 1,024 bytes. Repeated cursors, duplicate servers (including across pages), excessive inventories, invalid shapes and unknown runtime statuses fail closed. Existing transport frame/output/queue limits and each request's original deadline remain in force.

Arcane-only responses must explicitly include pagination and isolation metadata. Tools must be an object of object-valued entries; tool descriptions, endpoints, authentication material and raw discovery errors are not published. A single non-plugin `arcane` row must be connected with successful tool discovery. Every other server must report `disabled`. Null, missing or unknown runtime state is insufficient. The exported predicate independently refuses malformed/duplicate rows rather than relying exclusively on the parser.

## Lifecycle fence and grants

The asynchronous turn preflight reserves one local slot **before its first await**. Concurrent turn starts, model/effort selection (including same-pair actions), write grants, interrupts and history/thread starts cannot bypass it. It does not create a native turn operation, clear the previous exact turn ID, or set a starting/unknown turn status.

Readiness, subscription metadata, account-read generation, thread identity, selected pair and lifecycle state are checked before and after each inventory await and once more before dispatch. Account reads or account notifications during the check invalidate the original intent even when subsequent subscription metadata looks unchanged. Initial setup also rechecks its account generation and thread lifecycle before marking the thread configured. Foreign-thread notifications and approvals cannot bind an unsent turn.

Human revocation remains available while inventory is pending. It revokes the grant immediately and cancels that pending turn intent; a later metadata response cannot restore the grant. Grants cannot be added while the preflight is pending. Successful checking preserves only an already explicit exact-thread grant; the sandbox remains read-only unless that grant exists, with the existing workspace-only/network-disabled write policy unchanged.

Metadata failure, newly enabled inherited servers, connection loss or a stale preflight invalidate verified isolation and configured state, revoke grants and clear stale approvals. The client refuses the turn and closes the connection. Recovery remains an explicit host/human lifecycle action.

## Durable operation semantics

A failed preflight sends no `turn/start` and records no fabricated turn attempt. Its thrown `CodexClientError.dispatched` is **false**, including when the metadata RPC itself was dispatched, timed out or disconnected. The host uses this field when recording action uncertainty. Previously acknowledged operations and exact native thread/session/turn IDs remain intact.

Thread setup has already sent `thread/start` or `thread/resume`; an observed thread whose isolation cannot be confirmed remains an unknown setup operation with its exact native IDs preserved. Once an actual `turn/start` is sent, the existing dispatched/unknown acknowledgement semantics continue to apply. Neither case is replayed automatically.

## Fixture validation and deferred gates

`tests/unit/codex-mcp-isolation.test.ts` explicitly spawns `process.execPath` with an inline synthetic Node JSONL peer. File-controlled gates exercise concurrent lifecycle actions without timer-dependent races. Temporary audit/gate files are owned by the test and contain synthetic protocol data only.

The suite covers initial and resumed thread checks, every-turn pagination, inherited-server changes after a completed turn, shape/count/cursor failures, no-dispatch/no-replay failures, exact thread scope, concurrent starts/selection/grants/interrupts, account changes and pending account reads, revocation/disconnect during inventory, stale approvals, same-thread lifecycle changes and genuine lost turn acknowledgements. `native-config` compatibility is checked separately.

Compile the scoped tests into a fresh temporary output directory with the repository's compiler options, explicit Node type roots and ESM package metadata. Run the generated test with `node --test --test-concurrency=1`. Do not overwrite shared root `dist` during a parallel parent regression.

Validation on 2026-10-13: the isolated TypeScript compile passed; the new spawned-Node isolation suite passed **47/47**; the existing spawned-Node Codex client suite passed **101/102**, with the sole failure described below. Request deadlines were not widened. No installed CLI or Studio validation was performed.

One older assertion at `tests/unit/codex-client.test.ts:899`, in **same-thread model switch is local, revokes grants and sends the exact pair only on the next human turn**, expects one MCP inventory after setup plus a turn. Its expectation must become two (setup plus per-turn check). That existing file is outside this slice's write scope.

Installed Codex/Claude turns, authentication/configuration/token-file inspection and Studio testing remain **DEFERRED**. These fixtures establish bounded adapter behavior; they do not establish installed native execution or completed product acceptance.

Parent integration follow-up: the current root compile passed with131explicit sources and the combined native-client, isolation and asset UI fixture suite passed167/167 with no skips. The former one-vs-two inventory assertion now requires both exact-thread checks. These remain spawned-Node fixtures; installed native acceptance is still deferred.
