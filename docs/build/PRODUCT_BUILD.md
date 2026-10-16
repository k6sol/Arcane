# Managed product build

Status: active development · 16 October 2026. The [full product plan](../PRODUCT_PLAN.md) remains the scope of work.

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
| MCP-01 | Bundled SDK entrypoint, fixed tools and progressive guidance | Actual packaged Node/entrypoint discovery of 30 tools, guidance and that MCP process's shutdown; no provider inference or Studio calls in that check |
| CHAT-01 | Managed Codex task permissions, retained ownership, PNG references, reported models/token usage, account quota observations and bounded repair | Client/HTTP/store/process and real Edge fixtures; [quota metadata and refresh](../provider-usage-limits.md) preserve account ownership and explicit model selection. Installed provider authentication/inference acceptance and Claude in-app parity remain open |
| TEST-01 | Owned Play lifecycle, temporary edits, source-bound scenarios, capture review and task settlement | Production Client program executed in standalone Luau through synthetic SDK/service fixtures; native gameplay, server authority, multiplayer and devices remain open |
| ASSET-01 | Supervised Blender jobs, durable stage reservations, human interrupted-worker checks, reversible retained history, bounded composition, previews and typed import delivery contracts | [Worker supervision](../asset-worker-supervision.md), [recovery](../asset-worker-recovery.md), [history retention](../asset-history-retention.md), recorded native template evidence and scoped service/browser/import fixtures; reference-driven production, advanced assets and actual Studio delivery remain required |
| RELEASE-01 | Portable Windows bundle with pinned runtimes, dependencies and local diagnostics | 30 executable checks with scoped reports; installer/update, application signing and clean-machine customer acceptance remain required |
| STARTUP-01 | Retained asset history separated from bounded metadata validation; fixed-code private startup diagnostics | Filesystem, launcher and actual disposable-daemon IPC checks; [startup recovery boundaries](../startup-recovery.md) preserve saved ports and newer state. Packaged failure dialogs retain separate acceptance |

The cooperative work graph records dependencies, leases and reviews; an Arcane-hosted agent dispatcher remains work to complete. Optional cloud accounts, teams, shared assets, billing and operator tooling remain tracked in the full plan.

The [asset history service and storage pins](../asset-history-retention.md) connect bounded automatic archival, scoped archived UUID lookup, reversible restoration and explicit human rebuild/confirmation to the desktop. Owned filesystem, service, HTTP/MCP and Edge verification preserve original evidence and unresolved-work fences. Installed engine delivery and the complete customer journey remain separate gates.

The [native proposal-worker component](../native-proposal-workers.md) provides fresh account-matched read-only sessions, parent ownership at the dispatch boundary, effective MCP isolation and bounded completed proposal text. [Task-scoped proposal review](../task-proposals.md) persists and displays those attempts without applying their text. [Managed parent turns](../managed-parent-turns.md) provide a separate bounded continuation capability. The [plan journal](../task-plan-journal.md) and [bounded runner](../task-plan-runner.md) persist reservations, derive fan-in commitments and enforce acknowledgement, terminal and no-replay transitions. The coordinator and native service now bind those updates to original-task evidence, gate agent access to the active final parent, and expose bounded status plus exact evidence navigation in the desktop. Real SQLite/SDK/HTTP and owned Edge boot fixtures cover these paths. Installed inference, native Windows descendant containment and complete customer acceptance remain required. Executable startup/shutdown receipts without active native workers do not establish those workers' cleanup.

The signed source snapshot `0e60fe791c579d2e9e1a4ef046bfc549e74c2642` built a portable Windows bundle with 336 strictly compiled sources. All 30 actual executable checks passed, including bundled MCP discovery, guidance and shutdown; 21 compiled product files were byte-compared to that isolated source build and the workspace screenshot was reviewed. Manifest SHA-256: `83af0dfd827f16cb1e29cba564c7bed7deaafc0883a50971c842bb7fd93e7a11`. The executable is unsigned, has no installer, and this check performs no installed inference or Studio operations. Later journal and runner changes are excluded from that package evidence.

Current implementation details and receipts are recorded in [chat task permissions](CHAT_TASK_PERMISSIONS_20261015.md), [PNG references](../chat-reference-images.md), [gameplay scenarios](../studio-gameplay-scenarios.md) and [packaged verification](PACKAGED_MCP_VERIFICATION_20261015.md). Keep native engine behavior, synthetic fixtures, real browser rendering, Blender runtime evidence and packaged startup distinct. Unknown effects retain reconciliation fences; completed commands are not silently dispatched again.

The latest player-attribute component was verified with 233 focused runtime/MCP/panel/service cases, 37 final panel cases and ten real Edge browser checks. Its portable Windows source snapshot is `afc5a90799f32735ee844c1a0d4353daf5a3fc76`; all 30 executable checks passed. These results leave the full native customer acceptance gate open.

Bounded [script-content discovery](../script-content-search.md) now searches current editor text in one granted root or observed subtree and returns genuine refs, measured line/byte columns, bounded excerpts and explicit incomplete-result metadata. Search results require a fresh source read before editing. Standalone Luau, SDK/HTTP/SQLite and actual Edge checks cover this component. A clean package from source `5f5cf69f8f736d43ac09926b018c698718a1eb5a` passed all 30 executable checks and discovered 30 MCP tools; its manifest SHA-256 is `2456733f66c111914c2899db29200b9c54e8c9990afa8c8e567acec1720063ff`. Native Studio and the full customer journey retain separate acceptance requirements.
