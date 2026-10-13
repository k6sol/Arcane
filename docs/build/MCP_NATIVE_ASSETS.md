# Native-session MCP asset adapter

The trusted constructor option is `assetAudience?: 'generic' | 'native-session'`.
Omission preserves generic behavior. `DaemonClient.fromEnvironment` accepts
an absent `ARCANE_ASSET_AUDIENCE` as generic, or the exact literal
`native-session`. Every other present value, including `generic`, empty
text, whitespace and case variants, is refused with `CONFIG_ASSET_AUDIENCE`.

The flag selects routes only. The existing bearer is sent unchanged. The
daemon resolves native scope and authorization from its private registry.
Tool JSON and HTTP bodies carry asset input, pagination or job IDs only;
strict tool schemas reject project, conversation, provider, thread/session,
actor, grant and audience assertions.

| Tool | Generic route | Native-session route |
| --- | --- | --- |
| assets_probe | POST /v1/assets/probe | POST /v1/assets/native/probe |
| assets_jobs | GET /v1/assets/jobs | GET /v1/assets/native/jobs |
| assets_start | POST /v1/assets/start | POST /v1/assets/native/start |
| assets_cancel | POST /v1/assets/cancel | POST /v1/assets/native/cancel |
| assets_manifest | GET /v1/assets/manifest | GET /v1/assets/native/manifest |

Native asset calls use these routes exclusively, including after denial,
redirect, timeout, invalid response or dropped acknowledgement. There is no
global fallback, automatic retry, automatic pagination or adoption of a
global/unassociated job. Other capabilities retain their existing paths.

## Native response contracts

History returns exactly
`{ projectId, projectPath, conversation, jobs, nextCursor, byteLimit }`.
The project ID is 64 lowercase hex characters; the project path is nonempty,
absolute, control-free and at most 4096 UTF-8 bytes. Conversation identity is
`{ provider: 'codex', threadId, sessionId: string | null }`.
Opaque IDs follow the host ASCII ID syntax and contain at most 256 characters.
Null session identity remains exact absence.

Jobs satisfy the existing complete AssetJobRecord schema, including normalized
requests and events belonging to that job. Pages have at most 64 jobs (and
no more than the requested limit, default 32), unique UUIDs, the literal
512-KiB byte limit and a raw serialized UTF-8 size of at most 512 KiB.
Raw native job/acknowledgement records are also bounded to 512 KiB before
existing schemas can strip unknown record fields.

Native pagination accepts the storage cursor `64hex:sequence`, with a positive
safe integer of at most 16 decimal digits. The hash is the storage scope digest
of `[projectId, provider, threadId, sessionId, 'asset-job']`. Returned cursors
and supplied after values must match the response scope, and a subsequent
cursor must advance. The daemon still checks cursor ownership and existence.
An empty hydrated page can retain a cursor because associated records may be
missing. Generic history keeps its existing UUID cursor and envelope.

Start returns
`{ projectId, projectPath, conversation, jobId: UUID | null, association: 'bound' | 'unknown', creation: 'created' | 'unknown', retry: false }`.
An optional job record is accepted only when its UUID equals jobId; it is
never required. An acknowledgement does not establish completed production
evidence.

Bound association requires created creation and a nonnull UUID. A null job ID
requires both creation and association to be unknown. A known ID can retain
unknown creation or association. Valid HTTP 202 acknowledgements, including
unknown outcomes, remain structured MCP results without being converted into
a completed job or a safe-to-retry outcome.

Malformed, oversized or dropped start acknowledgements use the existing
single-POST ambiguous result: state unknown, terminal false, ambiguous true,
a diagnostic operation ID and explicit inspection of assets_jobs in the same
native project/conversation scope. Native start ambiguity also carries
retry false. Inspection is explicit and cannot backfill an unknown association
or adopt a global job. Definitive daemon 4xx errors remain errors.

Probe and manifest retain their existing success schemas, as does successful
cancel. Cancel additionally accepts the post-admission HTTP 202 response
`{ jobId: UUID, state: 'unknown', retry: false }`. It verifies the requested
UUID and exposes ambiguous true, terminal false and same-scope inspection
guidance. Invalid or dropped native cancel responses retain the existing
ambiguous path with retry false. A possible cancellation is never represented
as a definitive rejection or automatically repeated.

## Permission and integration boundary

Native probe is an admitted metadata read, along with jobs and manifest.
Pending, unbound and retired credentials cannot probe; enforcement belongs
to the daemon. Start/cancel require explicit host asset permission and an
open admission window and advertise fixed mutation annotations.
These annotations and the routing flag grant no authority. Generic tool
descriptions, annotations, paths and result envelopes are unchanged.

The adapter establishes no originating-turn provenance. Captured project and
Codex conversation scope and host admission remain the authority boundary.
A static bearer, client flag, tool annotation or request ID does not attest
the native turn that originated a call.

This slice changes only apps/mcp/src/daemon-client.ts,
apps/mcp/src/asset-schemas.ts, apps/mcp/src/server.ts,
tests/unit/mcp-native-assets.test.ts and this document. The parent owns daemon
routes and registry integration; the other worker owns Codex client lifecycle
and launch environment delivery. The parent wires the full feature after all
slices land.

## Verification

tests/unit/mcp-native-assets.test.ts uses owned loopback HTTP responders and
official MCP SDK in-memory transports. It covers exact routes and bearer,
strict audience configuration, 202 created/unknown start and unknown cancel
acknowledgements, optional job records, contradictory/wrong/oversized schemas,
null/session/thread/project cursors, explicit pagination, authority-field
rejection, permission denial, no fallback/retry/adoption, existing record
checks, fixed annotations and generic compatibility. Existing generic MCP
HTTP/SDK asset fixtures can also run selectively.

Compile to a private output/configuration and run these source fixtures;
do not use the shared root compile/dist pipeline. These fixtures do not launch
or inspect installed Codex, Claude, Studio or Blender, change AV/ACL settings,
or perform Git operations. They do not establish installed-provider lifecycle,
runtime execution or full daemon registry wiring.
