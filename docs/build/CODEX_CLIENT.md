# Personal local Codex client

The new host adapter is `packages/codex-client/src/index.ts`. The parent owns HTTP authentication, human UI controls, persistence and integration. The original full local-product gates in [PRODUCT_BUILD.md](PRODUCT_BUILD.md) remain active. Protocol fixtures and model metadata do not close those gates.

## Sources and wire compatibility

Read the current official [app-server documentation](https://learn.chatgpt.com/docs/app-server) first: JSONL stdio, initialization, stable API opt-out, account metadata, model pagination, thread/turn lifecycle and scoped server approvals. The installed CLI also generated stable bindings without `--experimental`. The parent checkpointed those in `packages/codex-client/.protocol`.

The installed CLI is **0.162.0-alpha.17.2**. Its schema uses **on-request** and **read-only** for thread settings, **readOnly** / **workspaceWrite** for turn sandbox objects, and **user** for the approval reviewer. These installed wire forms take precedence over conflicting example casing. Stable API opt-out does not make the alpha binary a production release.

The native CLI owns authentication. The factory accepts only `personal-local` / `open-source-local`; commercial/hosted values fail before spawning. The host remains responsible for eligibility and distribution. [Official plan-usage integration context](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

## Sidecar contract: event cursors and host-only Arcane MCP

`SessionEventValue` is the existing event union without a cursor. `SessionEvent = SessionEventValue & { seq: number }` preserves every existing field and adds a positive, monotonically increasing per-connection sequence. `Snapshot.lastEventSeq` is the highest assigned sequence, including dropped events. Sequences start at 1 for each fresh connection and never reset on turns or ring eviction. Deduplicate by `(connectionId, seq)`; never by text or itemId. Snapshot copies cannot alter counters. Byte/count eviction and oversized events increment `droppedEvents`; missing sequences and the high-water mark expose gaps, including trailing drops.

The optional factory field is **`arcaneMcp?: ArcaneMcpLaunchProfile`**, available only to trusted host code:

```ts
interface ArcaneMcpLaunchProfile {
  nodeExecutable: string;
  serverEntry: string;
  projectRoot: string;
  daemonUrl: string;
  agentToken: string;
}

const session = await connectCodexClient({
  command: installedAbsoluteCodexExecutable,
  cwd: approvedAbsoluteWorkspace,
  use: 'personal-local',
  arcaneMcp: {
    nodeExecutable: process.execPath,
    serverEntry: trustedBundledArcaneMcpEntry,
    projectRoot: approvedAbsoluteProjectRoot,
    daemonUrl: 'http://127.0.0.1:PORT',
    agentToken: hostIssuedScopedAgentBearer,
  },
});
```

All five fields are required and exact; unknown fields fail. Paths must be absolute, existing and free of control characters. Node must be a direct regular `node`/`node.exe` resolving to the host's `process.execPath`. The server must be the direct regular `main.js` at the **same compiled bundle's `apps/mcp/src/main.js`** (derived from the client module's location), not another main.js or wrapper. The project root must be an existing directory. The daemon URL must be exactly `http://127.0.0.1:PORT`, port 1–65535, without userinfo/path/query/fragment or alternate host. The scoped agent bearer must be exactly 64 hexadecimal characters and is preserved byte-for-byte. A profile is rejected if that bearer would appear in a launch path or argv value.

Profile launch uses fixed process-local `-c` overrides: clear the inherited `mcp_servers.arcane` table, then set its `command`, fixed `args = [serverEntry, "--project", projectRoot]` and `env_vars = ["ARCANE_DAEMON_URL", "ARCANE_LOCAL_TOKEN"]`. Values are encoded as TOML-compatible strings/arrays. The bearer appears only in the spawned CLI's environment under `ARCANE_LOCAL_TOKEN`. It is absent from argv, public session/snapshot metadata, diagnostic messages and configuration files. No caller environment, custom argv or generic config is accepted. Omitting the profile keeps the existing launch unchanged.

The official [stdio MCP fields](https://learn.chatgpt.com/docs/extend/mcp) define command/args and allowlisted environment forwarding; [CLI configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic) supports process-local overrides. This is internal product configuration for the one spawned client, with no home/project configuration writes or IDE installation.

Parent code supplies this profile from trusted installation paths and its own scoped-agent-token issuance. Never pass profile fields through from browser/MCP input or log the profile/child environment. This supplies a daemon bearer; existing Arcane daemon/tool authorization and Studio grants remain independent. Native model/effort selection, human raw-diff approvals, sandbox rules and generation fences still apply. Native profile/tool execution is not established by the protocol fixtures.

## Parent integration contract

```ts
import { connectCodexClient } from '../../packages/codex-client/src/index.js';

const session = await connectCodexClient({
  command: installedAbsoluteCodexExecutable,
  cwd: approvedAbsoluteWorkspace,
  use: 'personal-local',
});

// Derive the human selectors from session.snapshot().models.
session.selectModel({ initiatedBy: 'human', model: exactModel, effort: exactEffort });
const thread = await session.startThread({ initiatedBy: 'human' });
// On a new connection after deliberate human recovery:
// await session.resumeThread({ initiatedBy: 'human', threadId: savedExactThreadId });

// Only after an explicit human grant for this thread:
// session.grantThreadWrites({ initiatedBy: 'human', threadId: thread.threadId });

await session.startTurn({
  initiatedBy: 'human', threadId: thread.threadId, text: humanEnteredText,
});

// Always await session.close() during shutdown.
```

This example describes future human actions. No real thread or turn was run during this worker task.

| API | Contract |
| --- | --- |
| `connectCodexClient({command,cwd,use,limits?,arcaneMcp?})` | Canonical absolute native executable/workspace, one persistent child, initialize, sanitized account, bounded catalogue |
| `snapshot()` | Defensive copy of metadata, approvals, operations and bounded events; no RPC |
| `readAccount()` | Only `account/read` with `refreshToken: false`; auth classification, recognized plan or null, provider-auth requirement |
| `listModels()` | Visible paginated native catalogue; reject duplicates, repeated cursors and caps |
| `selectModel({initiatedBy,model,effort})` | Exact reported model string and effort; no alias, picker-ID, default or fallback substitution |
| `startThread({initiatedBy})` | One human thread lifecycle per connection; explicit model/OpenAI provider/cwd/read-only/human review |
| `resumeThread({initiatedBy,threadId})` | Exact saved ID with the same safe overrides; no path/history resume |
| `grantThreadWrites({initiatedBy,threadId})` | In-memory grant for this exact configured thread; no automatic approval |
| `revokeThreadWrites({initiatedBy,threadId})` | Remove grant, cancel prompts, disconnect active work because its already sent sandbox cannot be downgraded locally |
| `startTurn({initiatedBy,threadId,text})` | Text-only input; explicit selected model/effort/cwd/human reviewer and sandbox |
| `interruptTurn({initiatedBy,threadId,turnId})` | Fence approvals before writing, clear grant, interrupt exact turn; terminal event confirms completion |
| `respondApproval({...scope,decision})` | Human action plus exact handle/connectionId/threadId/turnId; single accept/decline/cancel only |
| `close()` | Idempotent disconnect, pending rejection, approval invalidation and owned-child cleanup |

Arguments use exact envelopes. Human markers are host-code assertions, not authentication: derive them from actual authenticated human actions. Never authorize execution merely because an HTTP body says `initiatedBy: human`. Agents/MCP tools must not receive lifecycle, write-grant or approval controls.

The public factory has no injected spawner, custom argv, caller environment, transport URL, generic methods or generic config. Its only MCP option is the fixed host-code launch profile above. Internal constructor/transport modules are fixture seams and must not be exposed by parent routes. Tests spawn a real Node executable with synthetic data and label provenance `spawned-node-fixture`.

## Execution policy

The factory resolves the existing absolute `codex` / `codex.exe` and canonical workspace, then spawns base argv `app-server --listen stdio://` plus only the fixed overrides when the host MCP profile is supplied with `shell: false`, piped stdio and `windowsHide: true`. A fixed OS environment allowlist includes process/home/temp necessities. Caller environments, API keys, endpoint overrides, `CODEX_HOME` and auth-file overrides are excluded.

The adapter never opens credential files, copies OAuth tokens, logs in/out, asks for token refresh, changes config, consumes quota resets, supplies API billing credentials, or retries through another provider. Unsupported accounts prevent starts. Auth changes revoke grants; switching away from ChatGPT during active work disconnects the client.

Thread acknowledgement must confirm exact model, OpenAI provider, canonical cwd, on-request policy, human reviewer and readOnly sandbox with network disabled. Mismatches preserve IDs and fail closed. Stable thread creation has no dedicated effort field. The selected effort is sent explicitly on every `turn/start`; the saved pair and acknowledgement do not establish completed inference, applied-effort telemetry, entitlement or quota.

Writes require an explicit human grant for the exact thread. Subsequent turns use `workspaceWrite` with only its workspace writable, network disabled and temporary-directory allowances excluded. Grants do not survive reconnect or interruption. Granting writes never automatically answers an existing prompt.

## Manual approvals and review data

Command/file-change requests remain pending for the human. Each gets an opaque handle scoped to connection/thread/turn. Numeric and string server IDs are distinct; ID reuse fails closed. Expiry, out-of-scope requests and interruption cancel. Disconnection drops callbacks without writing to dead stdio. Server-request resolution, item completion, replaced file proposals and terminal turn notifications invalidate handles.

Accept requires a live thread write grant. Commands need an absolute cwd matching the workspace. File changes require a complete bounded preview from the matching item, with every path/move target lexically inside the workspace. `Approval.changes` contains path, kind, movePath and diff for human review; constructing it reads no source files. Missing, oversized or outside-workspace previews are decline/cancel only. Native sandbox behavior remains a live acceptance gate.

Network/extra permissions, session-root grants and remote environments cannot accept. The client never sends acceptForSession or policy amendments. Other server methods—including external auth refresh, attestation, dynamic tools, permission requests, elicitation, user-input tools and legacy approvals—receive a fixed unsupported error. They need a separately reviewed adapter before support can expand.

Render commands, reasons and diffs as untrusted plain text. Do not log approval content. Parent controls must keep exact approval scopes and separate deliberate thread grants from deliberate callback answers.

## Bounds

Host `limits` may only reduce positive integer defaults in `CODEX_LIMITS`.

| Bound | Default |
| --- | --- |
| JSONL frame / frame storage | 1 MiB / one fixed buffer; fatal UTF-8 decode after complete line |
| Pending RPC / stdin queue | 16 / 2 MiB |
| Request / approval deadline | 15 seconds / 60 seconds |
| Total output / discarded stderr | 256 MiB / 1 MiB per connection |
| Event ring | 256 events, 1 MiB serialized payload; drops/eviction counted in droppedEvents |
| Pending approvals / remembered server IDs | 16 / 4096 per connection |
| File preview cache | 16 items, 1 MiB; 32 changes/item, 64 KiB/diff |
| Retained operations | 128 per connection; unknown identities are never silently evicted |
| Catalogue | 16 pages, 100 entries/page, 512 visible models, 16 efforts/model |
| Human turn text | 128 KiB UTF-8 |

Malformed frames/responses, unsafe settings, limits, request timeouts and disconnects fail closed. Remote errors expose fixed messages and numeric codes, never raw provider text/stderr. Only selected lifecycle, item-summary and agent-message events are retained; auth/config/unknown payloads and raw reasoning are discarded.

## Unknown outcomes and recovery

Operations retain local operation ID, request ID, method, observed thread/turn IDs and pending/acknowledged/rejected/not-sent/unknown state. A lost acknowledgement after dispatch is **unknown**, including when notifications already supplied an ID. Without acknowledgement or notifications, the ID remains null. Interrupt acknowledgement confirms the request, while `turn/completed` supplies the terminal outcome.

There is no automatic reconnect, retry, replacement thread or input replay. The parent should persist sanitized operation/thread snapshots before replacing a connection. Recovery requires deliberate human connection/resume by the saved exact thread ID and inspection of returned active-turn metadata. Missing active-turn IDs remain unknown and block another start; use the native human client to inspect unresolved state. Never resend the old text as recovery.

One connection owns one thread. The event ring is not a durable transcript; the parent owns persistence/UI updates and gap handling. Lifetime caps require deliberate disconnect/reconciliation. If operation capacity is exhausted during interruption, the adapter disconnects and leaves the native outcome unknown.

## Verification

Final sidecar component result: **67/67 passing, zero skipped**, comprising the original 53 tests plus 14 event/profile checks. Repository TypeScript checking also passed. Fixture startup has a bounded five-second allowance; shorter lost-ack action deadlines remain separate and production timeouts are unchanged.

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --rootDir . --outDir packages/codex-client/.test-output --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node tests/unit/codex-client.test.ts
node --test packages/codex-client/.test-output/tests/unit/codex-client.test.js
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Fixture peers are real spawned Node processes. Synthetic receipts are written and removed only under `packages/codex-client/.test-output/fixtures`. Tests cover interleaved IDs, one-byte UTF-8 splits, scoped approval accept/reject/cancel/expiry/disconnect, settings, bounded frames/events/queues/requests/catalogues/previews, malformed responses and unknown lost acknowledgements without replay.

[Native metadata evidence](../../packages/codex-client/evidence/native-metadata.json) is historical and separate: its recorded source fingerprints predate this event/MCP-profile sidecar. The installed CLI initialized, reported sanitized ChatGPT subscription status and seven visible model/effort entries. Only initialize, account/read(refreshToken:false), and model/list requests were made. No real thread, turn, inference, write, approval acceptance, login or configuration change was run. Model entitlement remains unverified.

[Sidecar verification evidence](../../packages/codex-client/evidence/sidecar-verification.json) records the current 67-test result, current source hashes, unchanged package metadata and read-only catalogue adapter, and the public contract. [Prior component evidence](../../packages/codex-client/evidence/verification.json) preserves the earlier 53-test run. This sidecar turn ran spawned Node fixtures only: no additional installed Codex connection, actual Arcane MCP launch, inference or Studio action. Native profile/tool acceptance remains with the parent under future authorization.

Remaining parent work: actual native feature/MCP/asset acceptance, explicitly authorized live inference/thread/turn/approval verification, complete native feature coverage, full release and user acceptance. Human-only HTTP routes, UI selection/diff review and durable unknown-outcome receipts now exist and have fixture evidence below. This adapter is ready for that integration review; the feature and full product are not claimed complete.

## Human workflow and security review integration

The daemon exposes GET /v1/codex/state and POST /v1/codex/action only to its human bearer. POST requires exact local Origin; Host, queries, content type/encoding and UTF-8 body limits are checked before native work. The browser cannot supply executable, cwd, environment or provider configuration. Every action carries a UUID request ID; repeats with the same parsed intent return the prior receipt, and a different intent under the same ID is refused. SQLite stores only intent hashes and sanitized identity/status metadata, not prompt text or native credentials. Pending crash rows become unknown on restart, with no automatic native reconnect or prompt replay.

The host retains independent safety controls while an ordinary action waits for acknowledgement. Capacity exhaustion fences and closes the owned native connection before refusing new work; previous receipt identities remain intact. Pre-dispatch refusals cannot borrow an unrelated unknown operation or rewrite their requested thread/turn scope. An early starting-turn revoke stops the client even before any native turn ID is reported. Known prior-turn approvals cannot adopt the ID of a new pending turn. Malformed success acknowledgements are dispatched protocol failures and leave unknown outcomes plus a disconnected client, not safe-to-retry idle state. Genuine outbound failures remain not-sent.

Current reviewed security run: 93/93 passing, zero skipped (81 spawned-Node native protocol fixtures and 12 actual human HTTP/SQLite fixtures). Source fingerprints and limitations are recorded in docs/research/codex-workflow-checks.json. This newer evidence supersedes old source fingerprints for these changes, not the historical native metadata observation. Edge UI evidence is documented in UI.md. Installed-CLI inference, actual native MCP connection/tool calls, native sandbox/process-tree cancellation and Studio acceptance are still separate open gates. A configured profile is not a verified connection, and an acknowledgement is not turn completion.

## Actual native one-turn acceptance

On 12 October 2026, the human explicitly authorized one small native test using the existing CLI subscription and exact reported gpt-6.1-sol / ultra pair in a disposable project. Native metadata/catalogue, actual read-only thread configuration, a completed real model turn and exactly one Arcane MCP work_runs round trip succeeded. The final public response contained ARCANE_SMOKE_OK runs=0. The matching native MCP item completed and the isolated daemon recorded one GET /v1/work/runs. No Studio/Hunted operation, terminal approval, workspace grant, provider token read/copy or home configuration write was performed.

The native preflight exposed a genuine isolation limitation: clearing root MCP/plugin tables did not remove all inherited server metadata. Child-only disabled entries and per-plugin settings were verified against the actual thread runtime before inference: Arcane connected with only work_runs; every other reported server was disabled. The installed CLI treats quoted dotted-key components literally, so simple safe server/plugin keys were passed unquoted. Unsupported key characters abort the test. These test-specific isolation overrides are not yet the general embedded-controller policy; inherited tools and native sandbox/MCP permission boundaries remain required product hardening.

Evidence: docs/research/native-codex-smoke-checks.json includes exact thread/turn IDs, completed MCP item, reported model catalogue, runtime server states, actual daemon request and source fingerprints. scripts/check-native-codex-smoke.mjs is manual-only and now refuses to replay a consumed one-turn approval. It is never included in ordinary npm test. This verifies one personal-local read-only native workflow, not writes/approvals, image/design, all models, complete native features, all child-process cleanup or Studio/import/game quality.
