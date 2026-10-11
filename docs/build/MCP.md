# Arcane MCP implementation

Arcane exposes 24 fixed tools through the official `@modelcontextprotocol/sdk` **1.32.1** `McpServer` and `StdioServerTransport`. Dependencies are pinned by the parent workspace. Node 24 or later is required for the daemon's SQLite implementation. Standard output carries only SDK JSON-RPC messages; startup diagnostics use standard error, following the [official MCP stdio guidance](https://modelcontextprotocol.io/docs/develop/build-server).

`apps/mcp/src/main.ts` accepts `--project ABSOLUTE_PROJECT_DIRECTORY` and otherwise uses its current directory. Project selection locates the existing skill registry; Studio targeting always uses an exact paired session ID returned by `sessions`.

## Connection and credential boundary

The parent launcher generates distinct browser control, native agent and per-plugin bearers. Native clients set these process environment variables:

- `ARCANE_DAEMON_URL`: exactly `http://127.0.0.1:PORT`, with a port from 1 through 65535. Host aliases, credentials, paths, queries, fragments, TLS URLs and redirects are refused.
- `ARCANE_LOCAL_TOKEN`: the launcher-issued **agent bearer**, never the browser control bearer, plugin bearer or a provider credential. The variable name remains unchanged.

The human product panel can obtain the native bearer with `POST /v1/product/mcp-token`, using the browser control bearer and the exact local `Origin`. Its response contains the agent token, scope descriptions, `canReview: false`, and daemon-lifetime expiry. This is a human UI handoff, not an MCP tool. Keep the agent token in process memory/environment; daemon restart invalidates it.

The agent bearer can inspect Studio sessions and receipts, submit commands within existing pairing grants, restore immutable receipts, coordinate durable work and use fixed asset templates. It cannot issue Studio pairing grants, revoke Studio sessions, approve/reject work, or request another token handoff. Browser human review requires the exact local Origin. Native requests omit Origin; an Origin supplied by any client must still match exactly.

Generate project-local connection templates after the parent workspace build:

```powershell
node apps/mcp/scripts/generate-config.mjs --project C:\Users\alexk\OneDrive\Documents\GitHub\Arcane
```

The default destination is `apps/mcp/generated/claude.mcp.json` and `apps/mcp/generated/codex.mcp.toml`. These are templates for the user's chosen client, not installed settings. The Claude configuration uses `${ARCANE_DAEMON_URL}` and `${ARCANE_LOCAL_TOKEN}` environment references. The Codex fragment forwards those names with `env_vars`; it sets a 70-second tool timeout so the server's maximum 60-second operation wait can return a structured outcome first.

The generator never reads or writes provider credentials or home client settings, never serializes actual environment values, checks physical project containment including linked ancestors, and uses exclusive creation to avoid replacing settings. Re-running against existing files fails rather than overwriting them. `--output` must resolve within this project; `--node` must be an absolute executable path. Client-specific installation remains an explicit user action.

## Fixed Studio and skill tools

Every advertised input object rejects unknown fields. Tool annotations distinguish reads from writes and mark mutation calls as non-idempotent hints. The SDK bounds aggregate input elements to 2048; HTTP JSON responses are bounded to 1 MiB even when Content-Length is absent.

| Tool | Operation | Daemon method or local reader |
| --- | --- | --- |
| `sessions` | Read paired identities, grants and permissions | `GET /v1/studio/sessions` |
| `scene_children` | Read bounded children in an explicit root | `scene.children` |
| `scene_inspect` | Read allowlisted properties | `scene.inspect` |
| `scene_search` | Bounded name search in an explicit root | `scene.search` |
| `selection_read` | Read granted selection | `selection.read` |
| `script_read` | Read current editor source | `script.read` |
| `script_update` | Write with exact expected editor source | `script.update` |
| `scene_create` | Create an allowlisted class under an opaque parent | `scene.create` |
| `scene_update` | Write allowlisted properties with matching expected keys | `scene.update` |
| `receipt_status` | Read a recorded command and immutable receipt | `GET /v1/studio/commands/:id` |
| `receipt_restore` | Restore a succeeded receipt, guarded by its exact after-state | `POST /v1/studio/restore` |
| `skills_list` | Read eligible skill metadata | Existing integrity-checked local registry |
| `skills_get` | Read selected skills/references within a byte budget | Existing checksum-checked local packer |

All scene/script operations target exactly one `sessionId`. Opaque references must belong to that session and, when specified, the same root. Paths are display-only. Search/children results have at most 200 items; source strings have at most 100 KiB UTF-8. New scripts start disabled. Writes require the human's authorization, a writable pairing, and native edit mode; tools do not create those grants.

Studio command tools make exactly one POST with a fresh UUID `requestId`, then only bounded GET receipt polling. The daemon's idempotency contract uses that exact ID: identical payload reuse returns the original command; a conflicting payload is refused. The MCP client does not automatically resubmit or generate a replacement ID after an interruption. Restoration sends only `commandId` and `requestId`; the daemon constructs the inverse from its recorded receipt.

A Studio tool's `timeoutMs` is a total enqueue/polling wait from 100 through 60000 ms, default 30000. Timeout or caller cancellation ends waiting, not execution. An uncertain result preserves `requestId`, `commandId` when acknowledged, exact session, last *observed* state, `terminal: false`, `ambiguous: true`, and `wait` (`timeout`, `aborted` or `interrupted`). Last observed state can still be `queued` even if the daemon advanced further. Use `receipt_status` when the command ID is known. If the initial acknowledgement was lost, locate its request ID in that exact session's daemon history; never blindly repeat the operation.

Terminal failure/cancellation/reconciliation becomes an MCP error with the recorded command retained. `needs_reconciliation` also remains ambiguous. Definitive HTTP rejections are errors; connection loss or invalid acknowledgements after a POST are uncertain outcomes. Known errors/results redact the native bearer.

Skill content is approved-only by default. Explicit experimental opt-in exposes experimental content without approving it. Quarantined/deprecated content, checksum failures, escaping references and exceeded byte budgets are refused. Skill text grants no tool permissions.

## Durable work tools

| Tool | Endpoint | Behavior |
| --- | --- | --- |
| `work_runs` | `GET /v1/work/runs` | Read durable runs, task state and hashed evidence |
| `work_ready` | `GET /v1/work/ready?runId=...` | Read dependency-ready tasks, optionally within one exact run |
| `work_create` | `POST /v1/work/create` | Record an authorized graph with explicit file scopes and acceptance criteria |
| `work_claim` | `POST /v1/work/claim` | Claim a ready task and return its cooperative scope lease token |
| `work_progress` | `POST /v1/work/progress` | Record progress and extend the owned task lease |
| `work_submit` | `POST /v1/work/submit` | Submit local evidence; the task enters `needs_review` |

Graphs have 1–64 tasks, each with explicit dependencies and 1–20 safe relative file scopes. The daemon rejects cycles, missing dependencies, overlapping active write scopes and unsafe paths. Submission has 1–20 evidence paths/notes; the daemon verifies project containment and hashes files up to 16 MiB. MCP checks response task IDs and selected run IDs, and preserves only a valid claim response's lease token.

The workflow is `work_create` → `work_ready` → `work_claim` → `work_progress` → `work_submit` → human panel review. Creating a record does not launch an agent. A dependent task becomes ready only after its predecessor passes human review. **There is no MCP review/approval tool**, and the agent HTTP bearer also cannot call `/v1/work/review`. Scope leases are cooperative coordination, not an OS sandbox.

Work POSTs are sent once. They have no daemon request-id idempotency guarantee. An interrupted/timeout response reports diagnostic `operationId`, affected task ID or run title, unknown state and ambiguity; `operationId` is not sent to the daemon and cannot be used for replay. Inspect `work_runs` before acting. A lost claim acknowledgement cannot recover the lease token through these tools; wait for expiry or reconcile through the human panel.

## Fixed asset tools

| Tool | Endpoint | Behavior |
| --- | --- | --- |
| `assets_probe` | `POST /v1/assets/probe` with `{}` | Observe installed Blender/Python through fixed runtime probes |
| `assets_jobs` | `GET /v1/assets/jobs` | Read durable job records, stages, events and actual state |
| `assets_start` | `POST /v1/assets/start` with `AssetInput` | Start one authorized fixed-template local job |
| `assets_cancel` | `POST /v1/assets/cancel` with `{jobId}` | Cancel one exact job; preserve partial output |
| `assets_manifest` | `GET /v1/assets/manifest?jobId=...` | Read a daemon-validated manifest for one exact job |

`AssetInput` permits only `template`, `name`, `seed`, `sizeMeters`, `color`, `triangleBudget`, `renderResolution`, and `renderSamples`. Templates are `hero-prop` or `environment-kit`. Names are safe lowercase slugs of at most 48 characters, excluding reserved Windows device names. Seed is 0–2147483647; three size components are each 0.1–20 meters; three color channels are each 0–1; triangle budget is 100–50000; render resolution is 128–1024; samples are 4–64. Omitted options remain omitted in the POST and are normalized by the daemon. Job IDs must be exact lowercase UUIDs.

Inputs cannot select executable paths, Python/Luau scripts, worker/output roots, external imports, uploads or publication. Runtime/output configuration belongs to the parent host. The response schema matches the daemon's `AssetJobRecord`, preserving bounded events, normalized request, stage, timestamps, manifest availability and errors. Cancel and manifest responses must match the requested job; event IDs must match their job.

Start's HTTP 202 response is a job acknowledgement, not finished generation or verification. Call `assets_jobs` to inspect subsequent progress. Every asset POST is sent once, including probe and cancellation. A lost start acknowledgement returns `jobId: null`, the requested asset name, diagnostic `operationId`, unknown state, `terminal: false` and `ambiguous: true`. Inspect job history and its normalized requests before deciding what happened. Timeout/cancellation of an MCP wait does not promise that native generation stopped. Cancellation acknowledgement can also be ambiguous. Never automatically restart/re-cancel an interrupted operation.

Manifest schema checks include runtime capabilities, mesh/render/export measurements, artifact hashes and declared limitations. Artifact-byte verification belongs to the daemon pipeline. No MCP operation imports an asset into Studio or claims native Roblox scale/collision verification.

## Focused validation

The MCP worker compiles into its owned `.test-build` directory and runs only its owned test file:

```powershell
node node_modules/typescript/bin/tsc -p apps/mcp/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/mcp/tsconfig.json
node --test --test-reporter=tap --test-timeout=20000 apps/mcp/.test-build/tests/unit/mcp.test.js
```

`tests/unit/mcp.test.ts` uses real SDK Client/McpServer connections, an actual spawned stdio child, bounded loopback HTTP fixtures, the actual daemon Studio/work routes with SQLite stores, and the actual asset routes with an explicitly non-native service fixture. It verifies exact tool names/permissions; agent-vs-human token scope; pairing/current-source/update/restore and readonly refusals; exact request-id idempotency; durable lease/evidence/review gates; config output without secret persistence; safe fixed asset inputs; record identity; and cancellation, redirect, lost-ack, malformed-response and timeout behavior without mutation retries.

Temporary directories and compiled output remain inside `apps/mcp/`; fixture cleanup closes resources in reverse order before deleting SQLite files and attempts all releases. This coverage simulates the Studio plugin and asset service. Native Studio/Blender acceptance and the repository-wide suite remain parent-owned; these tests do not claim those runtime gates passed.
