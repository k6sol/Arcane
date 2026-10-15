# Managed product build

Status: active development · 15 October 2026. The [full product plan](../PRODUCT_PLAN.md) remains the scope of work.

## Delivery gates (not marketing claims)

1. Secure durable local Studio bridge, actual plugin artifact, native MCP client, functional browser panel; failure/restart/recovery tests.
2. Verify against a disposable Studio place without modifying Hunted. Real engine receipts required for native-runtime claims.
3. Native CLI workflows connected to MCP with explicit model/effort and honest feature availability; no third-party subscription credential proxy.
4. Supervised Blender/asset production with manifests, validation, preview, recoverable scene changes.
5. Runnable installer/launcher, documentation, full regression, user acceptance path and security review.

Broad optional hosted/cloud/enterprise backlog is separate from the complete local developer product. No full-product completion until required local gates actually pass. No fabricated success for unavailable integrations.

## Current implementation and evidence

| ID | Implemented scope | Evidence and remaining gate |
|---|---|---|
| CORE-01 | Durable local bridge, exact command ownership, typed operations and recovery fences | HTTP/SQLite/SDK and Luau fixtures; native Studio conflict, replay and restoration acceptance remains required |
| PLUGIN-01 | Modular XML artifact, installer and loaded-source hierarchy identity | Deterministic build/integrity/VM checks; actual Studio loading and compatibility remain unverified |
| UI-01 | Electron shell, local workbench, projects/chats, approvals and previews | Real browser and packaged startup checks; complete customer journey and accessibility/performance acceptance remain required |
| MCP-01 | Bundled SDK entrypoint, fixed tools and progressive guidance | Actual packaged Node/entrypoint discovery of 29 tools, guidance and clean shutdown; no provider inference or Studio calls in that check |
| CHAT-01 | Managed Codex task permissions, retained ownership, PNG references, reported models/token usage, account quota observations and bounded repair | Client/HTTP/store/process and real Edge fixtures; [quota metadata and refresh](../provider-usage-limits.md) preserve account ownership and explicit model selection. Installed provider authentication/inference acceptance and Claude in-app parity remain open |
| TEST-01 | Owned Play lifecycle, temporary edits, source-bound scenarios, capture review and task settlement | Production Client program executed in standalone Luau through synthetic SDK/service fixtures; native gameplay, server authority, multiplayer and devices remain open |
| ASSET-01 | Supervised Blender jobs, bounded composition, previews and typed import delivery contracts | Recorded native template evidence and scoped worker/import fixtures; reference-driven production, advanced assets and actual Studio delivery remain required |
| RELEASE-01 | Portable Windows bundle with pinned runtimes, dependencies and local diagnostics | 30 executable checks with scoped reports; installer/update, application signing and clean-machine customer acceptance remain required |

The cooperative work graph records dependencies, leases and reviews; an Arcane-hosted agent dispatcher remains work to complete. Optional cloud accounts, teams, shared assets, billing and operator tooling remain tracked in the full plan.

Current implementation details and receipts are recorded in [chat task permissions](CHAT_TASK_PERMISSIONS_20261015.md), [PNG references](../chat-reference-images.md), [gameplay scenarios](../studio-gameplay-scenarios.md) and [packaged verification](PACKAGED_MCP_VERIFICATION_20261015.md). Keep native engine behavior, synthetic fixtures, real browser rendering, Blender runtime evidence and packaged startup distinct. Unknown effects retain reconciliation fences; completed commands are not silently dispatched again.

The latest player-attribute component was verified with 233 focused runtime/MCP/panel/service cases, 37 final panel cases and ten real Edge browser checks. Its portable Windows source snapshot is `afc5a90799f32735ee844c1a0d4353daf5a3fc76`; all 30 executable checks passed. These results leave the full native customer acceptance gate open.
