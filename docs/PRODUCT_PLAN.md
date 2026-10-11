# Arcane — full product plan
Version 1.3 · 12 October 2026 · Owner: k6sol
Status: full platform in development, with implemented local daemon/SQLite stores, compact key-only plugin, browser workbench, fixed MCP tools, native Studio read adapter, cooperative work graph, provider preferences/native CLI handoff and two verified Blender templates. The plugin is installed in the current development setup; genuine native transport, writes, dirty-buffer conflicts and restoration are deferred acceptance gates at the user's request to leave Studio testing for later. This is not failure or a pause of the full build. General custom asset composition is being built and is not complete. No completed inference or packaged desktop release is claimed. See [current product build](build/PRODUCT_BUILD.md) and [provider-native features](PROVIDER_NATIVE_FEATURES.md).

### Current implementation and full scope

The source-run workbench is a plain TypeScript browser panel served by the local daemon, not the planned Electron/React desktop shell. doctor/start:arcane/release:local/test:release now provide preflight, supervised source startup and unsigned directory integrity checks. Five release-fixture tests passed and root doctor reported local files/dependencies ready; clean package boot remains pending. No Electron/native Windows installer, signing or dependency bundling exists. Studio commands have exact session/ref grants, bounded typed methods, immutable receipts and restart reconciliation. SDK/Luau fixtures and real-daemon/browser tests prove their own boundaries; they do not certify the installed native plugin. Native Studio discovery/read-only access is a separate backend and grants no writable plugin session.

The durable work queue records dependencies, cooperative file-scope leases, hashed submissions and human decisions. It neither launches agents nor runs an automatic reasoning/repair loop. The native launcher passes the selected provider/model/effort and MCP config to a genuine interactive client; model entitlement, applied settings, native feature availability and completed inference remain separate facts. VS Code was opened for the repo, but its MCP installation was cancelled by the user.

Blender has real native evidence for the static `hero-prop` and `environment-kit` templates, including checkpoints, renders, audited exports, cancellation and restart history. Custom composition, arbitrary reference-driven modelling, images/design return, Roblox upload/import/reimport, rigs and animation acceptance remain required work.

Every journey and feature below remains in the full product scope. Component verification and interim alpha/beta boundaries do not redefine full-product completion. [README setup](../README.md) gives the current source-run path; [build evidence](build/PRODUCT_BUILD.md) distinguishes fixture, browser, native metadata/read and native asset proofs.

## 1. Product definition and scope

Arcane is a desktop development platform with a Roblox Studio plugin. A developer can ask it to change an existing Roblox game, review code and scene changes, create assets in Blender, run playtests, and inspect evidence of the result. It also exposes its tools through MCP so an existing coding client can use the same platform.

The first customer is the owner, but Arcane must support excellent Roblox games beyond Hunted: obbies, tycoons, simulators, racing, combat, puzzles, cozy/social experiences and more. Hunted is one demanding acceptance project, not a hidden global template. The first release works locally on Windows with an external MCP client; integrated chat and optional commercial services follow reliable tools/plugin foundations.

Build an independent implementation of the useful RoPilot workflows documented in the accompanying analysis. Its public product describes a desktop app, Studio plugin, code generation, playtesting, Blender modelling, animations and previews. The inspected MCP contracts give more specific workflow requirements, but private implementation details remain unknown. [RoPilot product](https://ropilot.ai/).

Success means a user can repeatedly inspect, change, test and restore a real project without losing manual work. A generated model must survive import and look correct in the engine. A successful task must include observable results, not just a confident chat response.

### Explicit product decisions

- Windows first. Add macOS after the plugin, worker and installer pass the same acceptance suite there. Linux may later support server/Blender workers, but native Studio support must follow Roblox's actual supported platforms.
- Desktop app plus a first-party Luau plugin, both branded Arcane.
- Local daemon owns jobs, tools, files and recovery; the app is a client of it.
- Integrate Roblox's current built-in Studio MCP where it supplies privileged execution, screenshots and input. The Arcane plugin supplies pairing, selections, scene editing, changes and status. Every capability declares its actual backend.
- Local SQLite history and manifests. Optional cloud services use separate storage later.
- Model and effort are explicitly configurable without silent downgrade. Preserve richer native workflows (including images/design) through real supported adapters or clearly labelled native handoffs rather than reducing every provider to text chat. External native clients, conditional supported direct plan access, personal API keys and Arcane-managed inference have distinct authentication, capabilities and usage responsibilities.
- The existing MIT repository licence remains. Review dependency and redistribution licences before shipping bundled components.
- Publishing and production data operations have their own explicit controls. Normal development can run under a user-selected session policy.

## 2. Complete user journeys

### First installation

The completed installation journey must install Arcane, select the existing project folder, detect Git and Studio, install one Arcane plugin using supported Studio mechanisms, and open its panel. The human workbench issues an Arcane API key with explicit allowed roots and write permission. The compact Studio panel has one masked API Key field and Connect/Disconnect; the key encodes the local port, so no URL or pairing-code input is required. Both sides show the exact connected session and returned grants. The user chooses an external native client or configures an eligible supported plan/API connection. The full connection test must read the selected instance and capture a supported viewport screenshot.

Today this journey starts from the checkout with `npm run doctor` and `npm run start:arcane` (or the direct `npm run start:product`), the private printed workbench link and the development plugin artifact. Persistent key issuance/revocation, config generation and interactive CLI handoff exist. A clean package boot/install remains pending; actual installed-plugin connect/read acceptance is deferred by the user. Legacy one-use pairing remains a compatibility/test contract, not the default user path.

A published place and an unsaved local place are both valid projects. Unsaved places use a session identity; never merge them into another place merely because names match. Existing scripts stay where they are. A failed setup screen identifies the failing component and offers a concrete repair action.

### Existing-game change

The user selects a door in Studio and asks, “Make this open when a nearby player holds E.” Arcane reads the selected model, scripts, remotes and nearby project conventions. It presents the proposed changes or applies them under the chosen policy, tests the actual prompt interaction, and returns the changed paths, evidence and remaining issues. The user can restore the task's changes without undoing subsequent unrelated work.

### Asset production

The user attaches a reference and asks for a shiv. Arcane records dimensions, intended platform, silhouette, materials and moving components; uses the installed Blender skill pipeline; creates a blockout; renders review views; iterates; validates topology and UVs; exports; uploads through the supported route; and places the asset into the selected Studio project. Later edits update the same asset mapping rather than producing a second unrelated model.

### Integrated debugging

The user sends an Output error. Arcane links it to the live script version, finds the related module and calling code, proposes a targeted fix, tests the failing scenario and records whether the error recurred. It reports unsupported tests or inconclusive outcomes honestly.

### External-client mode

Codex, Claude or another compatible client connects to Arcane's MCP server. Arcane supplies the same tools, scope checks, change history and artifact previews. The external client supplies reasoning. Arcane must not claim that connecting MCP grants an arbitrary third-party app access to a user's model subscription.

## 3. Desktop application

### Workspace layout

A left sidebar contains projects and chats. The main area shows the conversation and task timeline. A right panel switches among source, changes, Studio evidence, asset preview and tests. A lower drawer contains logs and jobs. The connection strip always shows the targeted Studio instance, Git branch, active model mode and job state.

Users can collapse panels, resize them, search commands and use keyboard shortcuts. Status has text and icons, not colour alone. Long tasks show the current phase and elapsed time; percentage bars are used only when measured work provides a denominator.

### Projects and sessions

Create, open, rename, archive and reopen local projects. Bind each project to a folder, expected place/universe identifiers, creator ownership context and approved scene roots. Support multiple open Studio windows and explicit target switching; changing targets invalidates old mutation approvals.

Chats support titles, search, pinning, archive, export and branching conversation history. A branched conversation does not imply a branched Studio place. Show that distinction. Reopening a chat restores its stored history and rechecks the live project before further edits.

A project home lists recent tasks, pending conflicts, import jobs and last verified test results. It distinguishes an old successful test from a test of the current source revision.

### Prompt composer

Support text, images, source files and supported audio/video references. Attachments have a displayed size, provenance and context policy. Resolve project/instance/script mentions through actual indexed objects rather than guessing paths.

Modes are Explain, Plan, Build, Fix, Test and Model. Explain and Plan default to read access. Build and Fix can edit within approved scope. Test follows the project auto-playtest setting. Model creates an asset brief before executing Blender.

Allow users to steer a running task, queue a follow-up, pause at a safe boundary, cancel and resume. A cancellation screen states what already changed and which external operations are still in progress. Cancellation cannot pretend to undo a finished upload.

### Chat and task cards

Stream ordinary text, action summaries and artifact cards. Show “Read script,” “Applied patch,” “Rendered model” and “Test failed” as actual job events. Do not fabricate private model reasoning; display useful plans and decisions.

Each change card opens a diff. Each asset card opens the preview, source file, audit and import mapping. Each test card opens steps, assertions, logs and screenshots. A result distinguishes implemented, verified and still pending items.

### Editor and change review

Use a real source/diff editor with Luau syntax, search, line navigation and diagnostics. Changes are grouped by task with per-file and whole-task review. Scene changes show old/new properties, created instances and moved objects, with a viewport comparison when available.

Support accepting or rejecting selected independent changes. If changes depend on each other, show the dependency and prevent an invalid partial apply. “Accept all” operates only on the displayed, current proposal.

### Asset viewer

Use an interactive GLB preview with orbit, pan, zoom, front/side/top views, wireframe, material modes, lighting presets and dimensions. Animation previews have play/pause, scrub, speed, loop and selected clip controls. Show validation counts and Roblox import status beside the model.

Browser preview and Studio appearance are separate evidence. Display source units and target units explicitly.

### Settings and diagnostics

Settings cover target selection, models, spend limits, automation policy, Blender executable, render budgets, storage retention, telemetry and external-client configuration. A diagnostic page tests daemon health, plugin pairing, Studio MCP, credentials without revealing them, Blender compatibility, writable paths and available import routes.

The app provides actionable errors: wrong place, plugin disconnected, stale source, expired authorization, model quota, unsupported asset type, render timeout and moderation pending.

## 4. Roblox Studio plugin

The plugin is a native dockable Studio panel built in Luau. The implemented compact Arcane panel supplies the toolbar, masked API Key field, red Connect/Disconnect button, actual connection status and returned grants. It must remain usable at narrow widths and across Studio themes. Selected context, task progress, changes, assets, tests and settings remain full-product views to build without complicating the key-only connection form.

### Connection and pairing

Connect only to the intended loopback daemon using a human-issued Arcane key with explicit service-root/write grants. Its canonical format is `arcane_local_v1_<port>_<64 lowercase hex characters>`. The plugin derives only `http://127.0.0.1:PORT`, exchanges the key at `POST /v1/plugin/connect`, clears its input, and retains only the returned session bearer in memory. The compact connection form exposes no separate URL, pairing code, credits or quota controls. Green status requires a confirmed session.

Arcane keys persist hashed in the daemon until human revocation; revoking a key revokes its associated sessions. Disconnect revokes the session. Daemon restart invalidates old sessions and requires a fresh connection; it does not recover a raw key from history. Reconnection and Open Arcane affordances remain part of the broader journey where supported, without an automatic uncertain-connect retry.

The plugin stores neither the raw Arcane key nor provider/cloud credentials in settings or saved DataModel properties. Full target/project identity and visible edit access remain requirements. Legacy pairing is compatibility-only. Native widget/HTTP behavior, engine-followed redirects, editor concurrency and undo/restore must pass actual Studio acceptance when the user resumes deferred testing.

### Selection context

Read current Studio selection, supported properties, attributes, tags and child summaries. “Send selection” attaches stable instance references to the task. Show a warning if the selected object has since been deleted or changed.

An optional selection highlight lets the user see which model Arcane is inspecting. Restore selection and camera after temporary inspection unless the user requests a permanent focus.

### Hierarchy and properties

Search by class, name, path and selected root, with paginated results. Property values use typed serialization for Roblox types. Unsupported properties are omitted with a reason, not silently converted into invalid strings.

Typed editing commands create supported instances, change properties/attributes/tags, clone, parent, rename and move models. Batch commands validate all planned inputs before mutation. Geometry edits use supported APIs and predictable pivots.

### Scripts and editor integration

Use editor-aware source access and updates so an open script buffer is respected. Display the current source hash, proposed diff and conflict resolution. A concurrent user edit rejects a stale patch rather than overwriting it. Roblox documents ScriptEditorService APIs for this purpose. [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService).

Create Script, LocalScript, ModuleScript and Folder with explicit parent and intended execution context. Move/rename operations check affected paths and report potentially broken references. Disabling a script and deleting a folder are separate commands.

### Change recording and restoration

Wrap supported scene mutations in Studio change recordings, and close recordings on success, failure and plugin unload. Keep task snapshots in the daemon for selective restoration. Handle an existing recording rather than opening nested recordings blindly. Roblox provides these plugin recording APIs through ChangeHistoryService. [ChangeHistoryService](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService).

Global Studio Undo can affect other work; never equate it with a selective task rollback. Restoring a task checks current values against the task's post-change values. If they differ, require a conflict decision rather than discarding newer edits.

### Task status and stop

The panel shows current task, worker, phase, last successful action and connection heartbeat. Stop prevents new commands and requests cancellation of active work. Disconnect revokes the plugin session. A small persistent status badge makes active agent access visible.

### Tests, logs and input

Use built-in Studio MCP for supported play control, client/server execution, viewport capture and input simulation. The plugin displays test progress, log summaries and cleanup state. Do not assume a normal plugin can evaluate arbitrary downloaded Luau or access all privileged input APIs.

If a standalone plugin test adapter is later built, use narrowly scoped, versioned test scripts and validate its capabilities separately. Temporary test helpers are tagged, accounted for and removed; they must not become a production remote execution endpoint.

### Assets and animation handoff

The plugin previews import manifests, creator/ownership context, target parent and placement. It inserts completed uploaded assets through the supported route and resolves stable object mappings. It displays pending moderation, failed load and permission errors.

Animation handoff saves local sequences when available, opens the correct rig, and provides preview/publish controls. Imported rigs are tested for joint mapping and rest pose before use.

### Distribution and compatibility

Develop through a local plugin build. Ship a clearly versioned Creator Store plugin and provide installation/update instructions. The app and plugin negotiate protocol versions and feature flags. A mismatch can allow read access while disabling incompatible edits. Publishing a plugin follows Roblox's supported Studio flow. [Studio plugins](https://create.roblox.com/docs/studio/plugins).

## 5. Studio tool coverage

The following are independent feature requirements. Implement only through backends proven to support them.

| Tool family | Required behaviour | Result and verification |
|---|---|---|
| Session | list instances, select target, read play state, inspect capabilities | Exact session/place identity and supported contexts |
| Explorer | children, descendants, selection, name/class/path queries | Paginated typed results with bounded depth |
| Properties | read/write supported values, tags and attributes | Old/new values and reread confirmation |
| Scripts | read ranges, grep, local checkout, diff, conflict-aware commit | Source hashes and changed-file list |
| Lifecycle | create, clone, rename, move, disable, scoped delete | Change manifest and restoration data |
| Scene | transforms, anchors, collision groups, constraints and assemblies | Bounds, placement checks and viewport evidence |
| Execution | supported edit/client/server Luau | Context, duration, returned values and errors |
| Camera | focus, explicit position, standard views, restore | Capture and saved original camera |
| Input | keyboard, pointer, scroll, text and navigation | Step trace and observable player/UI response |
| Testing | start, assertions, capture, log retrieval, stop | Evidence bundle and cleanup result |
| Assets | inventory/store search, insertion and permissions | Source asset ID, creator and resulting instance |
| Uploads | supported local files, operation tracking and creator context | Final asset IDs or pending/failed states |
| Animation | rig export, sequence import, preview and publish | Mapping, clip metadata and engine playback |
| Project data | controlled test fixtures and optional test data reset | Explicit environment and audit trail |

Use instance identity internally. Human-readable dotted paths are display/search aids and can be ambiguous when names include dots or duplicate siblings. Never mutate the first ambiguous match.

## 6. Agent runtime and model integration

### Four model access modes

External-client mode exposes Arcane MCP to an existing client; reasoning and usage remain with that client. Conditional direct-plan mode uses an eligible provider-supported authorization path. Personal-key mode calls supported provider APIs from the local daemon with protected keys. Managed mode calls an Arcane backend with provider keys, usage limits and billing. Changing mode may change cost or capability and must be explicit.

Provider adapters declare tools, image support, streaming, context limits and reported usage. Select model IDs from configured provider capabilities; do not hard-code marketing names from the competitor site. Store model/version and settings with the task.

A consumer subscription does not automatically provide generic API access. Official OpenAI documentation now describes eligible local/open-source plan usage; commercial availability needs separate review. This is a conditional candidate, not an implemented login. [Official overview](https://developers.openai.com/siwc/token-sharing-open-source). See [subscription workflow](SUBSCRIPTION_WORKFLOW.md) for constraints and the external-client baseline.

### Task engine

Current coordination is a durable cooperative work graph with readiness, leases, evidence submission and human review. A worker is started separately by the user/authorized coordinator; `work_create` and `work_ready` do not dispatch agents or run inference. The complete task engine below remains required.

The engine validates scope, retrieves relevant context, produces a bounded plan, calls tools, evaluates evidence and revises until acceptance criteria pass or a clear limit is reached. It has budgets for tokens/cost, wall time, tool calls and repair attempts.

A failed tool call produces a structured error. The agent distinguishes retryable disconnects from stale edits, unsupported actions and authorization failures. It does not retry a chargeable upload with an uncertain outcome until it reconciles operation state.

### Context and memory

Index live scripts, hierarchy summaries, configuration, relevant assets, remotes and task history. Use lexical/symbol search first; add embeddings only if benchmarks show value. Retrieve exact code when editing rather than relying on an old summary.

Store project rules, art direction, naming and test expectations as inspectable project memory with provenance. Users can edit or delete memories. Recheck live facts at task start. Track source and scene revisions so outdated cached facts are identifiable.

The runtime reads applicable skills and project instructions, showing which were used. The existing Blender skills must drive asset tasks through brief, blockout, review, topology/UV/material work, export and QA.

The repository now contains fifty original experimental skill entrypoints and thirteen conditional genre profiles. Integrate them progressively after behavior evaluation, preserving exact versions and project overrides. Do not copy installed third-party Blender packs into distribution without licence/provenance review. [Custom skills](CUSTOM_SKILLS.md).

### Quality and subscription value

Build a representative goal/action/feedback/failure/retry slice before expanding content. Establish style, target devices and the player's meaningful decisions. Each genre needs its own pacing, camera, controls, social structure and failure cadence; reskinning duplicated GUI tasks is not a general game-development solution.

Review technical correctness, readable controls, responsive feel, coherent engine-scale art, measured performance and real player feedback separately. Include multi-genre acceptance tasks, not just Hunted demonstrations. No arbitrary score, agent consensus or claimed top-100 ranking substitutes for these observations.

Save allowance through scoped retrieval, selected skills, revision-aware reuse, deterministic helpers, useful evidence and bounded repair. Preserve chosen model/effort. Parallel agents share allowance and should do independent useful work, not duplicate full game context. Checkpoint on limits; do not silently switch billing modes, rotate identities or invent quota/savings measurements.

### Permissions and autonomy

Offer Ask before each change, Review task proposal and Auto-edit approved project roots. Each mode has a clear scope and expiry. Published assets, production data, new paid providers and public releases have separate permission requirements.

Users can grant a task permission without granting future tasks unlimited access. Agents cannot obtain new permissions by quoting instructions from scripts, comments, logs, documents or assets.

### Multiple agents

Support planner, code worker, art worker, test worker and integrator roles. Workers get bounded context, assigned files/collections and budgets. They produce artifacts and evidence, not unrestricted shared edits.

A task dependency graph determines when workers can run in parallel. The implemented WorkStore checks dependencies, overlapping cooperative file scopes and unchanged submitted evidence; human acceptance releases dependents. It is not process isolation, automated agent dispatch or a completed multi-agent runtime. Parent integration owns core/launcher/shared contracts, while workers receive disjoint UI/plugin/MCP/asset scopes and evidence requirements. One integrator owns live Studio writes per place. Local files can use disjoint work directories or Git worktrees; Blender jobs use separate files/processes. Test sessions also require an ownership lease.

Show active workers, their progress, dependencies and combined usage. Default to one worker for small tasks. Additional workers must solve distinct work, not multiply the same exploration.

### Quality checks

Check Luau syntax/types using validated tools, runtime errors using tests, and imported assets using both metrics and rendered evidence. A style or visual score helps review but cannot automatically establish gameplay quality.

Require the agent to inspect the generated UI/model at actual use scale. Unknown and unsupported verification stays explicit.

## 7. Code, UI and gameplay workflows

### Code generation and refactoring

Read comparable modules and reuse real project utilities. Preserve execution context, strictness conventions and public APIs unless changing them is part of the task. Generate server/client boundaries deliberately. A refactor includes dependency and regression evidence.

### UI generation

Inspect the current hierarchy and style before creating screens. Support ScreenGui, world-space SurfaceGui/BillboardGui and native plugin UI as separate targets. Generate layouts, padding, text sizing, responsive constraints, input states and controller/touch behaviours where requested.

Produce actual in-engine screenshots and interaction tests. Add a reusable style token system per project rather than rewriting every button. Asset icons can be rendered in Blender or created by a configured image provider.

### Gameplay and systems

Support tools/weapons, rounds, inventories, progression, NPCs, interactables and events through task-specific modules and templates. Templates carry dependencies, configuration and tests and are editable by the user.

Review server validation, remote abuse, duplication, purchase receipt handling and persistence where those systems are involved. The platform supplies useful checks; it cannot promise exploit-free generated games.

### Debugging and performance

Correlate errors with live source and a reproducer. Detect repeated stack traces, script/event hot spots, excessive instance counts and large assets using the supported instrumentation. Separate static estimates from measured client/server performance.

Attach device/test configuration to frame rate and latency reports. Run profiling on representative scenes. Do not describe a desktop playtest as evidence of mobile performance.

### Git workflow

Show current branch, staged/unstaged changes, local commits and remote status. Create task branches and worktrees when the task benefits from them. Allow commit creation, push and pull request workflows under the chosen project policy.

GitHub Desktop and Arcane share the same repository. Manual edits are normal. Git changes must not overwrite dirty user files. Pull/merge operations detect conflicts and stop for a concrete resolution plan.

## 8. Blender and 3D asset production

### Worker setup and supervision

The current installed-runtime worker generates two fixed static templates with checkpoints, topology/UV/export audits and hashed previews. Native evidence covers Blender 4.5.3 LTS generation, GLB/FBX reimport, cancellation and failure/restart paths. It proves neither arbitrary custom production nor Roblox import. Custom composition is active implementation work and remains unaccepted; the reference, rig, animation, materials and engine workflows below remain in scope.

Detect a supported installed Blender. Offer a verified optional download later, with source, licence and size visible. Pin tested Blender/exporter versions in the project manifest. Run headless jobs in isolated directories with factory startup, explicit exit-on-Python-error handling, stdout/stderr and a final structured result.

Checkpoint the source file at stage boundaries. Killing a worker leaves the last valid checkpoint recoverable. Python is executable code; a timeout and a directory convention are not a complete security sandbox.

### Reference-driven modelling

Accept multiple references, dimensions and style briefs. Record camera, silhouette, scale, materials and important proportions. Build primary/secondary forms before small detail. Review multiview renders against references and fix geometry before polishing textures.

Apply the installed blender-director and scenario-blender-expert skills plus relevant modelling, UV, materials, rigging, export and QA skills. Keep skill names/versions and produced evidence in the job record.

### Geometry features

Provide modelling primitives, bevels, booleans, arrays, symmetry, curves, mechanical pieces, procedural nodes and modular assembly. Preserve separate moving parts and stable names. Support a raw bpy tool for expert tasks within the execution policy.

Validation reports triangles, material slots, UV coverage, degenerate faces, loose geometry, normals, transforms and bounds. Set configurable mobile/desktop budgets per asset; do not mistake a product guideline for a Roblox engine limit.

### Materials and textures

Support PBR base colour, normal, roughness, metalness and supported alpha handling. Bake unsupported procedural materials before export. Preview lighting consistently so metal and normal maps can be compared across revisions.

Offer texture atlases, trim sheets, material variants and skin sets. Variants should reuse compatible geometry and mapping. Protect author-supplied textures from being replaced without an explicit revision.

### Collision and LOD

Generate simple collision proxies separately from render detail. Preview collision/clearance in Studio. Generate LOD files where useful and verify the actual Roblox consumption path; merely naming a file LOD1 does not enable engine switching.

Provide bounds and articulation/interaction anchors for gameplay. A shiv's grip, blade and break joint are separate authoring data.

### Rigs and animation

Support Studio-to-Blender R6/R15/custom Motor6D mapping in stages. Capture C0/C1, names, rest pose and root conventions. Skinned meshes need a separate bone/weight validation path.

Provide block/spline/polish stages, animation curves, clip definitions, loops, priorities and intended gameplay markers. Separate animation motion from gameplay hit detection. Validate marker preservation through the chosen export route.

Preview clips in the app and on the actual Roblox rig. Weapon grip, root motion, feet contact and loop discontinuities are explicit tests. Keep a local sequence/export on failed publishing.

### Renders and icons

Produce transparent item icons, turntables, multiview contact sheets and animation previews. Store camera/light presets to keep a skin collection consistent. Check icon readability at actual hotbar size.

The preview renderer supports selectable quality budgets. Render only changed previews where possible. The UI can show a progressive thumbnail while a full render finishes.

### Import and reimport

Record a manifest mapping source objects and exported hashes to Roblox models, parts and asset IDs. Placement supports origin, bottom centre, custom anchor, selected attachment and explicit CFrame. Convert axes, scale and pivots through tested adapters.

Use supported Open Cloud model upload or Studio import routes and track asynchronous operations. Custom model files are uploaded through the documented Model path; the Mesh endpoint is not a generic arbitrary-FBX uploader. Type support and quotas are checked against current documentation at implementation time. [Assets usage guide](https://create.roblox.com/docs/cloud/guides/usage-assets).

Reuse unchanged geometry/textures. Update existing scene instances without losing user-authored scripts, attachments or constraints unless the manifest explicitly owns them. Define how removed source objects are reviewed rather than silently deleting scene objects.

## 9. Other assets and reusable content

### Images

Reference-image storage, configured image generation, editing, thumbnails, decals, UI atlases and upload manifests. Show source and generated versions side by side. Retain dimensions, transparency and ownership metadata. Image generation can be optional and separately billed.

### Audio

Import supported audio, preview playback, normalize levels, trim/pad and assemble approved mixes. Optional voice generation has its own provider, spend controls and voice-rights configuration. Preserve synchronization cues and source references.

Batch uploads have resumable per-file status, duplicate detection, target ownership and permission records. A moderated or inaccessible asset is not reported as ready for gameplay.

### Video and broadcasts

Provide local reference/video preview and storyboard tools. For Hunted-style TV content, support image sequences/sprites, UI timings and synchronized Roblox audio as a reusable package; the project's no-video-upload requirement remains a project rule even if the platform later supports video for other users.

### Content library

Search local assets, owned Roblox inventory and approved marketplace sources. Preview licence/source, script contents and expected costs before insertion. Quarantine imported scripts until reviewed. “Verified creator” is a useful filter, not proof that a model is safe.

Templates include games/systems/UI/props but must declare dependencies, capabilities, licences and versions. A later template marketplace includes moderation, updates and clear creator ownership.

## 10. Testing and self-repair

### Test definition

A saved scenario has a purpose, fixture, initial state, input steps, assertions, timeouts and cleanup. Assertions target visible UI, attributes, server state, inventory, positions or expected logs. State injection is labelled as a fixture/unit technique, not human input.

### Execution

Start only a session owned by the task, select the correct client/server context, perform supported inputs, capture evidence and collect errors. Always attempt cleanup and report a failed stop. Tests should not modify production player data.

### Multiplayer and devices

Add a separate multi-client capability gate. Run client isolation, late join, disconnect, replication, simultaneous input and server-authority tests. Bots do not substitute for real clients.

Add device profiles and touch/controller checks using supported tooling. Test viewport layouts, touch targets and input prompts. Simulated resolutions do not prove device performance.

### Visual regression

Record stable cameras, lighting, viewport size and reference screenshots. Compare screenshots with configurable tolerances and mask expected animation changes. A diff is evidence to inspect, not an automatic verdict on art quality.

### Repair loop

When a test fails, preserve the first failure, identify a likely cause, patch and rerun the same reproducer. Cap repairs and repeated identical errors. A changed fixture must be reported; moving the success criterion to hide a bug is unacceptable.

### Reports and reusable suites

Create a report with tested source/asset revisions, environments, steps, assertion results, logs and screenshots. Save test suites per feature. A green badge expires when dependencies change.

## 11. Accounts, cloud platform and collaboration

Local mode can work without an Arcane cloud account. Cloud accounts add managed models, paid entitlements, sync and teams. User identity and Roblox resource authorization are separate connections.

Use supported OAuth for Roblox cloud actions; request only required resources/scopes and allow revocation. Desktop/public clients use the appropriate PKCE flow. Endpoint-specific API-key/OAuth support must be checked instead of assuming every Roblox operation accepts the same token. [Roblox OAuth overview](https://create.roblox.com/docs/cloud/auth/oauth2-overview).

Teams have owner, administrator, developer and reviewer roles; permissions are additionally scoped per project. Invitations, removals, audit logs and spending limits are explicit features. A removed member loses live tool access.

Conversation synchronization is opt-in. Do not automatically upload an entire game/source tree with a chat. Cloud artifacts use access-controlled storage and retention settings. A disconnected local machine cannot execute Studio jobs; the cloud queues them until a capable paired machine is available.

Shared changes use branch/proposal review. Team Create introduces another source of live edits; hashes and plugin signals still protect against collisions. Do not advertise complete Team Create parity before testing.

## 12. Payments, quotas and operating tools

### Charging models

Local external-client tools can remain free/open-source, with paid convenience features or managed services. Personal-key mode bills inference through the provider and can charge a clearly disclosed Arcane product fee. Managed mode can offer a subscription with usage allowance and additional usage, provided costs and limits are explicit.

Avoid vague action credits hiding expensive work. Show provider/model, token usage where available, rendered job duration, optional asset-provider fees and platform fee. Unknown external-client usage is shown as unavailable, not zero.

### Usage controls

Task and monthly limits, soft alerts, hard stops before starting additional chargeable work, and estimates versus settled cost. A request already sent to a provider may still incur cost after cancellation. Track that exposure.

### Billing backend

Use a payment provider, verified webhooks, idempotent credit/entitlement changes, an append-only usage ledger and reconciliation. Webhook events can arrive duplicated or out of order. Hosted inference reservations and final charges need a defined settlement state machine.

Trial abuse controls should limit costs without uploading unnecessary source. Avoid selling unlimited expensive inference before measuring actual use.

### Operator console

Manage accounts, entitlements, provider outages, model availability, failed jobs, refunds/credits, support and feature flags. Access to customer source is separate, logged and restricted to explicit support consent.

Track activation, successful tasks, repair rate, task abandonment, latency, usage costs and retention. Product telemetry defaults to operational metadata; source/prompt/image collection needs its own policy and consent.

## 13. Reliability, trust and support

Local job history survives app restart. Completed commands are not replayed as new actions after a crash. Interrupted actions reconcile state before retry. Files are written atomically where supported, and old checkpoints remain until the next one is verified.

Credentials live in OS storage locally or a managed secret service in cloud mode. The renderer cannot read keys. Sanitize Markdown and remote previews. Verify IPC senders and signed desktop updates. Electron's guidance informs the app boundaries. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

Export/delete user projects and chats, define retention, publish clear model-provider data routing, and support revoking connections. A public beta needs a privacy policy, terms, support contact, licence inventory and current distribution review.

Support bundles redact tokens and avoid source by default. A user can inspect a bundle before sharing it. Recovery documentation covers lost pairing, wrong target, stale scripts, failed import, paused moderation, worker crash and local database restoration.

## 14. RoPilot workflow equivalence checklist

The inspected contracts cover source checkout/commit, script search and lifecycle, hierarchy queries, edit execution, play policy/start/client/server/stop, viewport screenshots, Blender Python/render/static import, rig export and animation return, plus asset search/insertion and data reset.

Arcane must match useful behaviour through these acceptance tests:
1. Checkout a live script to a local file, edit, commit, reread and safely restore.
2. Inspect selected scene objects, make a bounded edit and capture repeatable views.
3. Exercise actual client input, assert server outcome and stop the owned test.
4. Generate a Blender asset, review it, import it and perform changed-only reimport.
5. Export a rig into Blender, animate it and verify the returned clip in Roblox.

RoPilot's advertised per-tool billing is not Arcane's pricing design. Its documented animation publishing default does not set Arcane's default. Its repeated engine guidance is not copied blindly. Independent correctness tests and measured results determine parity.

## 15. Release definition

A usable first release includes the desktop shell, real Arcane plugin, key-based connection and grants, project/target binding, MCP tools, script inspection/editing with conflicts and restoration, real playtest evidence, local history, external-client connection and diagnostic recovery. This interim release is not the full product definition of done.

An art release adds reference-driven Blender production, preview, validated upload/import, incremental updates, rig/animation workflows and consistent icon renders.

A commercial release adds integrated API chat, managed inference, accounts, payments, teams, support and distribution. Later expansion includes template marketplaces, cloud workers and additional platforms.

All required desktop, agent, code/UI/gameplay, custom asset/media, import/rig/animation, testing, collaboration, billing and reliability features in this plan remain tracked. Starter templates, handoff controls or reviewed worker components cannot substitute for their acceptance. See TECHNICAL_SPEC.md for protocols/data, BUILD_ROADMAP.md for build order and acceptance gates, FEATURE_CATALOG.csv for the implementation checklist, and build/PRODUCT_BUILD.md for current evidence. BUILD_PROMPT.md remains the historical first development brief.

