# Arcane — technical specification
Version 1.2 · 11 October 2026
All APIs below are proposed Arcane contracts. Discover and test upstream APIs before implementing their adapters.

Implemented subset: original skill registry/offline tools plus a TypeScript provider protocol/core/metadata-adapter workspace, loopback connection-lab daemon and responsive web panel. These are not the proposed Studio tool API, task engine, plugin, Electron package or inference adapters. Current executable boundaries and native-feature gates are in [Provider-native features](PROVIDER_NATIVE_FEATURES.md); the architecture below remains the intended product.

## 1. Components and boundaries

| Component | Recommended implementation | Responsibility |
|---|---|---|
| Desktop | Electron, React, TypeScript | Workspace UI, previews, changes and diagnostics |
| Local daemon | TypeScript on a supported Node runtime | Tools, sessions, jobs, credentials and persistence |
| MCP server | Compatible pinned TypeScript MCP SDK | External-client tools and artifact references |
| Studio plugin | Luau, built with Rojo; optional reviewed bundling | Pairing, selections, typed scene/script edits, task status |
| Studio MCP adapter | Local client to Roblox's built-in stdio server | Upstream execution, playtesting, input and captures |
| Blender worker | Python/bpy, supervised Blender process | Asset production, render, validation, export and rig conversion |
| Local persistence | SQLite plus content-addressed files | Chats, jobs, changes, manifests and evidence |
| Optional cloud | TypeScript API, PostgreSQL, object storage | Accounts, inference, entitlements, sync and teams |
| Later cloud queue | Durable queue with worker leases | Hosted work that cannot run in the request process |

Electron is recommended to reduce language/toolchain friction for a solo builder. Keep it replaceable through daemon APIs. Add cloud infrastructure after the local workflow works. Pin tested dependency versions when implementing; this plan intentionally does not invent version numbers.

The renderer never invokes arbitrary shell commands or accesses provider keys. A narrow preload API validates IPC inputs and sender origins. Render Markdown and third-party previews as untrusted content. Electron recommends isolation, restricted navigation and IPC validation. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

## 2. Intended repository layout

    apps/
      desktop/           Electron main/preload and React interface
      daemon/            Local HTTP/IPC service and tool scheduler
      cloud/             Optional hosted service, introduced later
    packages/
      protocol/          TS schemas, generated Luau types, fixtures
      core/              Jobs, policies, leases, errors and task engine
      studio-adapter/    Built-in MCP client and capability discovery
      model-adapters/    Provider-neutral messages/tools/usage
      storage/           SQLite repositories and migrations
      asset-pipeline/    Manifests, exports, uploads and mappings
      skill-registry/    Routing, provenance, pinning and eval results
      ui/                Shared app components and design tokens
    plugin/
      default.project.json
      src/
        Main.server.luau
        Bridge/
        Commands/
        UI/
        State/
        Tests/
    workers/
      blender/
        runner.py
        operations/
        validators/
        exporters/
    skills/
      arcane/            Original or explicitly adapted skills
      registry.json      Current original-pack metadata, hashes and review states
      sources.lock.json  Source commits, licences and review state
    tests/
      contract/
      integration/
      fixtures/
      e2e/
      evaluations/
      skills/            Current offline tests and behavior-case definitions
    docs/
    scripts/             Build/release/diagnostic helpers
    third_party/         Licence/attribution notices only as needed

Keep local user data outside the source checkout by default. A per-project .arcane manifest can record portable settings; logs, tokens, large artifacts and caches are ignored by Git. Existing Rojo projects retain their layout. Rojo is the intended plugin/source build tool, not a substitute for conflict-aware live Studio editing. [Rojo documentation](https://rojo.space/docs/v7/).

## 3. Startup and session binding

1. Desktop finds or starts one daemon for the current user.
2. Daemon opens/migrates its local database and reconciles interrupted jobs.
3. Discover Studio MCP instances and plugin connections independently.
4. Bind a project to exact instance/session/place/universe identity.
5. Negotiate plugin protocol version and runtime capabilities.
6. Expose only supported tools to the task and external MCP client.
7. Create a task scope and a writer/test lease when needed.

Published place identity and temporary session identity are separate fields. A second window of the same place has its own session. Reopening a place replaces the session token and invalidates old handles.

Roblox's built-in MCP documents local stdio, targeted Studio calls and the relevant tool families. Treat this as a supported adapter, with capability discovery at runtime. [Studio MCP](https://create.roblox.com/docs/studio/mcp).

## 4. Local plugin transport

Use plugin-initiated HTTP to a daemon bound to loopback for the first version. The plugin is not a listening HTTP server. Do not assume a persistent WebSocket exists in every Studio version. Later streaming is an optional negotiated capability.

Proposed routes:
- POST /v1/pair/start: desktop creates a short-lived pairing challenge.
- POST /v1/pair/complete: plugin submits challenge, identity and capabilities.
- POST /v1/sessions/:id/heartbeat: liveness, selection summary and revisions.
- POST /v1/sessions/:id/poll: retrieve queued commands after last acknowledged sequence.
- POST /v1/sessions/:id/results: bounded result batch.
- GET /v1/sessions/:id/artifacts/:artifactId: scoped, bounded command input; no arbitrary filesystem lookup.
- POST /v1/sessions/:id/revoke: disconnect/revoke.
- GET /v1/health: non-sensitive daemon status only.

Begin with a configurable short poll/long-poll implementation tested against actual HttpService limits. Maintain one in-flight poll per session, exponential reconnect backoff and a result queue. Poll completion is not command completion.

The desktop presents a pairing code; the plugin user enters it. The code expires, has limited attempts and grants a narrow session token. Validate request origin/host, token, body size and session identity. Do not treat local network location alone as authorization. The token may need session persistence through plugin reload; never store provider or cloud secrets in plugin settings.

Native plugin HTTP is subject to Studio permissions. Detect a denied permission and show instructions; do not modify user security settings automatically. [HttpService](https://create.roblox.com/docs/reference/engine/classes/HttpService).

### Command envelope

    {
      "protocolVersion": 1,
      "commandId": "uuid",
      "taskId": "uuid",
      "projectId": "uuid",
      "sessionId": "uuid",
      "studioId": "upstream-id",
      "sequence": 24,
      "issuedAt": "ISO-8601",
      "expiresAt": "ISO-8601",
      "method": "script.apply_patch",
      "params": {
        "instanceId": "session-object-id",
        "expectedRevision": 8,
        "expectedSourceHash": "sha256",
        "patchArtifactId": "uuid"
      },
      "permissionGrantId": "uuid",
      "lease": {"resourceId": "studio-session-id", "fencingToken": 12},
      "idempotencyKey": "uuid",
      "limits": {"timeoutMs": 10000, "maxResultBytes": 262144}
    }

### Result envelope

    {
      "commandId": "uuid",
      "state": "succeeded",
      "beforeRevision": 8,
      "afterRevision": 9,
      "beforeHash": "sha256",
      "afterHash": "sha256",
      "result": {"changedInstanceIds": ["id"]},
      "artifactIds": ["uuid"],
      "warnings": [],
      "error": null,
      "startedAt": "ISO-8601",
      "finishedAt": "ISO-8601"
    }

The daemon calculates content hashes and validates actual source equality at commit. Do not require an undocumented Studio SHA API. A plugin command can compare its expected source with editor source or use a reviewed hash implementation.

For a source change, the command's scoped artifact contains the exact baseline and proposed complete text or revision-bound patch. The plugin validates its inputs and performs the final content comparison inside the editor update callback. Artifact IDs are opaque; authenticated retrieval is limited to the session/task grant, MIME type and declared byte limits. They are not paths supplied by the model. Internal command methods and external MCP tool names may differ, but their mapping is explicit and contract-tested.

Mutations carry the current writer lease's fencing token. The plugin rejects a token older than the active lease epoch; a disconnected/replaced worker cannot regain write access by replaying an old approved command.

Lease changes are acknowledged by the plugin before dispatching a new owner's writes. Validate command expiry, session epoch and authorized method/root again at execution. Sequence numbers support delivery ordering but are not an authorization mechanism. Reload begins a new epoch and requires reconciliation of outstanding commands.

A duplicate command ID returns the recorded result if the outcome is known. If a crash leaves execution uncertain, return NEEDS_RECONCILIATION. Do not infer that the command did not run merely because the caller timed out.

## 5. Plugin modules

| Module | Functions |
|---|---|
| Bootstrap | Toolbar, dock widget, registration, unload cleanup |
| PairingService | Challenge, token, revoke and version negotiation |
| Transport | HTTP requests, poll, heartbeat, reconnect and queued results |
| CommandRegistry | Method allowlist, schemas, scope checks and dispatch |
| InstanceRegistry | Session IDs, references, deletion/rename detection |
| SelectionService | Selected IDs, context summaries and temporary highlight |
| Serializer | Supported Roblox value codecs and result bounds |
| ScriptService | Editor-aware reads, source comparison and patch application |
| SceneService | Typed create/update/clone/move/tag operations |
| ChangeService | Recordings, snapshots and task restoration |
| CaptureService | Delegation and camera/selection restoration |
| TestStatusService | Owned test lease, progress and cleanup status |
| AssetService | Manifest preview, insertion, stable mappings and permissions |
| PluginUI | Connection, task, change, asset and diagnostic views |

Normal typed commands are implemented in the plugin. Raw edit/client/server Luau uses the verified upstream adapter where supported. Do not implement a plugin command that evaluates arbitrary downloaded strings by weakening game security.

## 6. Instance and value representation

InstanceRef contains sessionId, opaque instanceId, service root, pathSegments, className and optional source/scene revision. It is resolved against a live registry. Paths are arrays of segments, not split-on-dot strings. Duplicate-name matches return AMBIGUOUS_INSTANCE with candidates.

Typed values include Vector2/3, Color3, UDim/UDim2, CFrame, Rect, EnumItem, number ranges/sequences, booleans, strings and InstanceRef. Use tagged JSON objects. CFrame serialization includes a declared matrix/order convention. Non-finite numbers and oversized strings are rejected.

Inspect readable properties from a reviewed API schema and capability allowlist. Some properties throw or require privileges. Return unsupported/unreadable fields explicitly. Do not walk every descendant or property on each heartbeat.

References are session scoped by default. Persistent asset mappings may add Arcane-owned metadata with user consent and collision handling. Renames and reparenting update indexes; deleted objects invalidate their references.

## 7. Tool API

Every tool checks project/session scope, permissions, capability availability and budget before execution.

| Tool | Essential input | Essential output |
|---|---|---|
| studio.list | optional project filter | sessions and capabilities |
| studio.bind | explicit session/place identity | binding and revision |
| studio.state | binding | Edit/Client/Server availability, play owner |
| scene.search | root, name/class filters, cursor, depth | refs and next cursor |
| scene.inspect | ref, requested fields | typed properties/attributes/children |
| scene.plan | typed operation list, expected revisions | diff manifest and validation |
| scene.apply | current manifest, grant, lease | actual changes and restoration data |
| scene.restore | task change set, expected post-state | restored/conflicted operations |
| script.read | ref, line range | editor source slice and revision |
| script.search | pattern, roots, result limit | matches and exact source refs |
| script.checkout | ref | local artifact, source hash and baseline |
| script.diff | checkout/local artifact | current proposed changes |
| script.commit | checkout, expected source, grant | reread hash or conflict |
| script.create/move/disable | typed target/config | updated refs and warnings |
| luau.execute | context, code artifact, timeout | structured result/logs/error |
| capture.viewport | target or camera, view/size | image artifact and restore result |
| test.begin | scenario, binding, policy | owned test session |
| test.input | step list and client target | input trace and supported-step status |
| test.assert | allowlisted assertion definition | expected/observed result |
| test.end | owned test ID | logs, cleanup and report |
| asset.search | source scope/type/query/creator | bounded inventory/store results |
| asset.insert | ID/type, destination, policy | insertion mapping and script review |
| asset.upload | validated manifest, creator, approval | job and operation IDs |
| asset.import | completed upload, placement/mapping | inserted/updated instances |
| blender.run | source/job, Python artifact, limits | checkpoint, output and audit |
| blender.render | objects, cameras, quality | preview/contact sheet artifacts |
| blender.validate/export | source, target profile | measurements and export manifest |
| rig.export | live rig ref and rig family | joint/rest mapping and Blender input |
| animation.bake | mapped rig, clips and settings | sequences/exports and mapping |
| animation.preview/publish | clip, target rig/creator | playback evidence or upload job |
| job.status/cancel | job ID | current phase, known effects |
| skill.search/read | task topic or pinned ID | relevant instructions and provenance |
| git.status/diff/branch/commit | approved repo and operation | repository result and conflicts |

A production-data reset tool is separate, restricted to explicit environment/key approval and absent from the basic tool list. No hidden fallback to a paid external backend is permitted.

## 8. Script change algorithm

Checkout captures authoritative editor content, source revision, instance identity and a local file. Parse/validate the proposed patch and check scope.

At apply:
1. Obtain the place writer lease.
2. Re-read editor source; compare to the exact checkout baseline.
3. If mismatched, return STALE_SOURCE and a three-way comparison.
4. Use ScriptEditorService.UpdateSourceAsync with a callback that rechecks its old content. Keep the callback deterministic and without side effects.
5. Snapshot before/after source and reread after completion.
6. Release the lease and publish the actual result.

Patch application uses exact matches/ranges bound to a source revision. The Studio editor and another plugin are outside Arcane's writer lease; the in-callback comparison is still necessary. If an adapter cannot guarantee this property, document its weaker semantics and use review/manual resolution.

Restoration compares current content with the recorded after-content before applying before-content. A multi-file batch may partially apply because upstream systems are not a distributed transaction. Record each operation and provide recovery, not a false “all-or-nothing” claim.

## 9. Persistence model

Local database entities:
- projects: root path, bindings, creator context, policy and settings revision.
- studio_sessions: connection, identity, capabilities and heartbeat.
- chats/messages: conversation, attachments, model and imported provenance.
- tasks/task_nodes: scope, criteria, budgets, dependency graph and state.
- jobs/attempts/events: command, phase, status, external operation and timing.
- tool_calls: validated request, result references, backend and usage.
- permission_grants: scope, expiry, allowed actions and revocation.
- leases: resource, owner, expiry and fencing token.
- checkouts/change_sets/change_operations: baseline, desired and actual state.
- artifacts: MIME, local path, hash, size, provenance and retention.
- assets/asset_revisions/import_mappings: object IDs, exported hashes, creator and Roblox IDs.
- test_scenarios/test_runs/assertions: fixture, revisions, results and evidence.
- skill_sources/skill_versions/evaluations: pins, licence, changes and validation.
- usage_records: reported/estimated costs and settlement.
- sync_outbox: explicit opted-in cloud events.

Use schema migrations, write-ahead logging where suitable, backups and content hashes. Artifacts are files with database metadata, not enormous base64 rows. Secrets are references to a credential store. Define deletion behaviour so deleting a chat does not accidentally remove a shared source asset.

Cloud storage adds organizations, members, identities, entitlements, invoices, payments, hosted usage ledger and controlled artifact access. Tenant checks apply at every API and object-store access.

## 10. Jobs, concurrency and recovery

Task states: queued, inspecting, planning, waiting_for_review, executing, verifying, completed, failed, paused, cancelling, cancelled.

Job states: queued, running, waiting_for_user, waiting_for_external, succeeded, failed, cancelling, cancelled, needs_reconciliation.

Events are append-only with monotonic per-job sequence numbers. Subscribers resume from cursors. Results distinguish execution success from verification success.

Use one writer lease and one playtest lease per Studio session/place binding. Lease fencing prevents a resumed old worker from applying changes after losing ownership. Manual changes are caught through revision/content checks.

Blender workers receive isolated work directories and checkpoints. Limit parallel renders based on actual memory/GPU availability. Retry read operations with bounded backoff. Mutations retry only with idempotency/reconciliation. Handle app/daemon/plugin restarts through persisted state.

Suggested initial budgets are configurable: 30-second simple tools, 10-minute heavy Blender steps, bounded payloads and two automatic repair attempts. These are product defaults to tune, not upstream limits or promises.

## 11. Asset manifests and upload pipeline

Manifest fields: asset UUID/version, source hash, Blender/exporter version, creator type/id, unit/axis conventions, object stable IDs, materials/textures, pivots, moving parts, sockets, collision data, optional LODs, clip definitions, source licence and import policy.

Static flow:
1. Validate/bake/export GLB or a verified supported alternative.
2. Compute geometry/material/export hashes.
3. Resolve previously uploaded resources for the same creator context.
4. Build upload plan and any required publishing approval.
5. Start supported asset creation operation and persist its ID immediately.
6. Poll boundedly, respect retry hints, and separate processing/moderation/load state.
7. Insert the resulting model/package in the correct place.
8. Map objects to stable IDs, preserve separately owned gameplay children.
9. Validate bounding box, camera orientation, materials and interaction anchors in Studio.

A model upload may return a package/model container, not individual raw mesh upload IDs. The first PoC must prove object mapping and update semantics for that actual format. Where a single-object export/upload is needed for incremental changes, preserve the same logical object mapping. Cross-user asset reuse is constrained by ownership/permissions; a global content hash alone is insufficient.

Don't hand-edit Roblox model/animation binaries and assume they will upload. Produce supported files using a verified tool path. The official guide distinguishes Model, Mesh and Animation restrictions. [Assets guide](https://create.roblox.com/docs/cloud/guides/usage-assets).

## 12. Rig and animation conversion

Serialize rig family, parts/bones, parent order, joints, C0/C1, rest transforms, attachments and intended root. Convert using an explicit basis matrix; test handedness, rotations, negative scales and units. Use separate fixtures for static models, Motor6D rigs and skinned meshes.

Construct pose bones against known rest frames. Bake clip frame ranges at declared frame rate. Preserve loop/priority and markers only when the chosen path supports them. An unsupported marker is a reported export error or documented separate gameplay mapping.

Validate a neutral pose, single-joint rotations, a root translation, weapon grip and a short attack on each supported rig family. Animations stored locally must remain usable when publishing fails. Publishing status and runtime permission status are separate.

## 13. Skill system

Each skill has an ID, concise routing description, source commit, licence, checksum, supported capabilities, review status and eval suite. Load the entrypoint first and references only as needed. Cache pinned versions and preserve the version used in task history.

GitHub sources are researched and reviewed; a repository README is not permission to execute its installer or override project instructions. Imported skills cannot grant additional tools or network access. Script helpers have a separate execution review.

See SKILL_LIBRARY.md for curated candidates and rejection rules. A single auto-updating universal skill is not adequate for a commercial platform.

### Authored offline subset and runtime contract

The current original pack has 50 experimental entries and 13 genre profiles, with actual SHA-256 hashes over entrypoints and declared references. Its helper validates the deliberately narrow frontmatter format, metadata identity, resolved-path containment, regular-file size and selected content integrity. It offers lexical candidates and explicit 1–8-skill packing with a UTF-8 byte cap. It is not a general YAML parser, hostile-filesystem sandbox, semantic router or token counter.

Default loading is approved-only; all current entries remain experimental. Opt-in enables local evaluation, never permission elevation. No client configuration is touched. Integrity refresh refuses approved entries; the future release system must verify reviewer/run provenance, not merely accept an editable passing-result field.

The runtime registry must record exact loaded versions/hashes, references, task selection reasons, compatibility range and evidence. Cache by content/revision, but re-read source for mutations. Keep verification requirements distinct from planning availability. Unsupported Studio/Blender capability permits useful planning but prevents claiming that execution was verified.

Reuse the offline helper's fixtures and behavior definitions when implementing `skill.search/read`; do not re-create a parallel untested loader or feed the whole pack into every turn. See [custom skills](CUSTOM_SKILLS.md) and [evaluation protocol](../tests/skills/EVALUATION_GUIDE.md). The behavior runner and fixtures are still future work.

### Subscription-aware adapters

Represent access mode independently of provider/model: external client, conditional supported plan, personal API and managed API. Capabilities, credentials, usage source and fallback permission belong to the connection record. Never merge plan entitlement with managed billing or report missing quota as zero.

External MCP requires no Arcane inference credentials. A direct-plan adapter must pass current eligibility/security/request-contract tests using Arcane's own authorized connection. Evaluate Codex app-server as a local harness candidate with versioned RPC lifecycle and actual completion/error handling. It is not permission to read another app's auth storage. [Official app-server route](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

Route-specific unsupported parameters/tools/media fail before inference. Checkpoint and reconcile on cancellation, rate limits and token renewal; no unapproved API fallback. The detailed constraints and reviewed sources live in [subscription workflow](SUBSCRIPTION_WORKFLOW.md), not duplicated provider assumptions in generic task code.

## 14. Hosted inference and billing implementation

Provider-neutral events include text deltas, tool proposals, tool results, usage and completion/error. Validate complete tool arguments before dispatch. Never run partial streamed arguments. Disconnection recovery resumes or records the known provider operation rather than automatically sending a second chargeable request.

For managed mode, reserve spend under a task limit, call the provider, record reported usage, settle the reservation and reconcile unknown outcomes. The ledger is append-only with unique settlement IDs. Pricing configuration is versioned by provider/model/effective date.

Payment webhooks verify signatures and store provider event IDs. Entitlement updates are idempotent. Refund/credit events are separate entries. Do not run paid model calls directly from the renderer or store managed provider keys in the desktop binary.

## 15. Build, release and verification

Build TS contracts and Luau plugin types from one reviewed schema definition. Contract tests exercise serialization, duplicate commands, disconnects, ambiguity, stale scripts, failed recordings and target switching.

Use real Studio integration fixtures for plugin pairing, script open-buffer changes, partial scene batches, actual input, test cleanup and model insertion. Use Blender fixtures for exit codes, crash recovery, geometry validation and transforms. Provider mocks cover runtime logic; real-model evals are separately budgeted.

Ship signed app updates, plugin version compatibility, rollback-compatible local migrations where possible and a tested repair path. Do not make auto-update success depend on uploading customer source.

Trace tools/jobs with IDs and structured timings. Metrics use backend/capability names; source, prompts and credentials are redacted from default operational logs. A reproducible support bundle reports exactly what the user chose to share.

