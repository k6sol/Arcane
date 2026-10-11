# Managed product build

Status: active. Owner: parent integration agent. User explicitly requested continued work and parallel agents.

## Delivery gates (not marketing claims)

1. Secure durable local Studio bridge, actual plugin artifact, native MCP client, functional browser panel; failure/restart/recovery tests.
2. Verify against a disposable Studio place without modifying Hunted. Real engine receipts required for native-runtime claims.
3. Native CLI workflows connected to MCP with explicit model/effort and honest feature availability; no third-party subscription credential proxy.
4. Supervised Blender/asset production with manifests, validation, preview, recoverable scene changes.
5. Runnable installer/launcher, documentation, full regression, user acceptance path and security review.

Broad optional hosted/cloud/enterprise backlog is separate from the complete local developer product. No full-product completion until required local gates actually pass. No fabricated success for unavailable integrations.

## Work board

| ID | Scope | Owner | State | Acceptance |
|---|---|---|---|---|
| CORE-01 | Shared bridge contract + SQLite + HTTP + integration | parent | in progress | Loopback security, persistence, idempotency, exact scope, recovery tests |
| PLUGIN-01 | Plugin transport/widget/typed operations/package | plugin worker | ready | Build artifact + source tests, later native fixture |
| UI-01 | Genuine local product/Studio panel | UI worker | ready | Pair/read/write/receipt paths without fake data |
| MCP-01 | SDK stdio tools + local connection config | MCP worker | ready | Actual SDK client integration and timeouts |
| ASSET-01 | Supervised Blender pipeline | asset worker | ready | Local runtime probe + verified manifest/exports |

Agents get disjoint write scopes. Parent owns shared dependencies and protocol, reviews before acceptance, records evidence. A worker completion is not a product completion. Unknown mutation outcomes are reconciled, never silently retried.
