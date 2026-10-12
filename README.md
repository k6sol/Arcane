# Arcane

An independent Roblox development platform: a desktop app, first-party Studio plugin, local MCP tools and Blender asset production.

**Current status: implemented local components with partial native verification; the full product is unfinished.** The repository contains a loopback daemon, SQLite Studio/work history, a browser workbench, a compact key-only Luau plugin, 24 fixed MCP tools, a native Studio read adapter, exact provider/model/effort preferences, an interactive native CLI handoff, and a personal-local native Codex conversation panel with human-controlled threads/turns, scoped approvals and durable action receipts. The Arcane plugin has been installed in the current development setup; its genuine native HTTP connection, safe writes, dirty-buffer conflicts and selective restore acceptance are deferred at the user's request to leave Studio testing for later. This is not a failed test or a pause of the full build. Both static templates and bounded custom multipart recipes now have real Blender generation/export/reopen evidence, including materials, collision/LOD roles and socket metadata. Artistic fidelity, animation and Roblox import remain unverified. Inference completion, real gameplay tests, Roblox asset imports remain open. A real Windows desktop host and deterministic executable packaging are now implemented; current runtime proof is recorded separately from full-product acceptance.

## Start here

| Document | Contents |
|---|---|
| [Full product plan](docs/PRODUCT_PLAN.md) | Complete desktop, plugin, agent, asset, test and commercial scope, with current implementation distinguished |
| [Technical specification](docs/TECHNICAL_SPEC.md) | Current transport/tool boundaries and the full target architecture |
| [Build roadmap](docs/BUILD_ROADMAP.md) | M0–M10 gates, current component evidence and remaining release work |
| [Product build](docs/build/PRODUCT_BUILD.md) | Current integration status, evidence classes, setup and acceptance path |
| [Feature catalog](docs/FEATURE_CATALOG.csv) | Full feature backlog and acceptance criteria; catalog status may lag worker implementation |
| [Curated skills](docs/SKILL_LIBRARY.md) | Source review, provenance and evaluation gates |
| [Original custom skills](docs/CUSTOM_SKILLS.md) | 50 experimental skills, 13 genre profiles and selective offline packing |
| [Subscription workflow](docs/SUBSCRIPTION_WORKFLOW.md) | Native-client tool use and separate conditional plan/API access modes |
| [Provider-native features](docs/PROVIDER_NATIVE_FEATURES.md) | Exact model/effort choices, supported handoff and unverified native feature execution |
| [Skill evaluation protocol](tests/skills/EVALUATION_GUIDE.md) | Behavior acceptance definitions; actual behavior approval remains pending |
| [Research](docs/RESEARCH.md) | Primary sources, inspected tool contracts and constraints |
| [Initial build brief](docs/BUILD_PROMPT.md) | Historical first-slice brief; current status is in Product build |

## Current implementation and evidence

| Component | What exists | What its evidence proves |
|---|---|---|
| Daemon / Studio store | Root/write grants, persistent hashed Arcane keys, session fencing, FIFO commands, immutable receipts, guarded restoration and restart reconciliation | Local SQLite/HTTP tests; synthetic plugin delivery is not native Studio transport |
| Studio plugin | Arcane toolbar/widget, masked API Key field, Connect/Disconnect, typed reads/edits, editor-baseline checks, deterministic Lua/XML artifacts; installed in this development setup | Packaging/compiler/Luau VM tests use engine/GUI doubles; installation alone does not prove native connection or writes |
| Browser workbench | Key issue/revoke, exact session/ref selection, command/receipt history, work graph and human review, scoped agent token, template assets/previews | Browser contract fixtures plus real-daemon/SQLite browser flows; synthetic asset previews are not Blender evidence |
| Arcane MCP | Official SDK stdio server; Studio, receipt, selected skill, work and fixed asset tools; project-local config templates | Actual SDK calls and spawned stdio tests, including daemon tests with a mock plugin/service |
| Native Studio adapter | Vetted installed StudioMCP executable, actual tool discovery, exact-ID read allowlist, human-only HTTP routes | Real native discovery/inventory and safe missing-target refusal; this surface provides no plugin write grants |
| Work coordination | Durable dependency graph, cooperative file scopes/leases, hashed evidence submissions and human acceptance | Store/HTTP/SDK/browser tests; creating a graph does not dispatch agents |
| Assets | Supervised Blender `hero-prop` and `environment-kit`, checkpoints, audits, BLEND/GLB/FBX, collision/LOD and two review PNGs | Native Blender 4.5.3 LTS outputs, export reimports, cancellation/failure and restart evidence; no Roblox import proof |
| Providers | Sanitized native metadata, exact preference saving, reviewed launch argv for Codex/Claude, human-only Codex conversation controller/UI | Metadata and launch-plan tests; requested settings have `applied: false`, with one separately authorized native Codex smoke turn completed; other provider feature coverage remains unverified |

Custom asset composition is active work. Reference-driven arbitrary modelling, images/design artifact return, upload/reimport, rig/animation conversion and full workflow automation remain required. The complete product definition in the plan and roadmap is unchanged by these starter components.

## Run from source

Requires Node 24+ and existing native clients/Blender for their respective paths. In PowerShell from this repository:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build:plugin
npm run test:plugin
node scripts/build-plugin.mjs --check
npm run test:release
npm run doctor
npm run start:arcane
```

`npm ci` is for preparing a checkout; use existing dependencies when already prepared. `npm test` builds TypeScript and runs unit/skill suites; plugin tests are separate. Plugin runtime/compiler checks explicitly skip without an already installed Luau toolchain configured as described in [plugin verification](docs/build/PLUGIN.md). Optional browser tests need the existing browser/module paths documented in [UI verification](docs/build/UI.md). Passing skipped or fixture checks does not close native acceptance gates.

The doctor checks local files, package-local dependencies and plugin source/artifact digests. Parent reported five focused release-fixture tests passed and the actual root doctor returned `readyToLaunch: true` for `local-runtime-files-and-dependencies` only. It does not verify Studio, provider inference, Blender runtime or full-product completion. `start:arcane` runs this preflight and supervises the source daemon; `start:product` remains the direct built-daemon entry.

Open the launcher's private `/studio#CONTROL_TOKEN` link. The product launcher defaults to loopback port 45871; `ARCANE_PORT` can choose another port, including 0 for a random port. The browser removes the fragment. Local state is under ignored `runtime/product`, `runtime/connection-lab` and `runtime/assets`. These source-run paths are not a packaged installer or release. Stop with Ctrl+C.

1. In the workbench, issue an **Arcane API key** with explicit roots; Workspace/read-only is the default. Copy it through the explicit key action.
2. Open the installed Arcane Studio plugin, paste the key into its single masked field and click **Connect**. No daemon URL or pairing code is entered in the plugin. The key encodes the loopback port; the daemon stores its hash and grants.
3. Accept a connected state only when a real session and heartbeat arrive. Select its exact session/client identity before browsing or reading source. A provider login or native Studio inventory does not establish this connection.
4. When the user resumes deferred Studio testing, enable writes only for an explicitly authorized disposable-place test and use fresh read baselines. Inspect the original command receipt after a timeout; do not automatically replay a mutation. Restore only an unchanged recorded after-state.
5. Revoke key access in the human panel when needed. A key remains valid until revoked; restart revokes old plugin sessions and daemon-lifetime agent tokens, requiring a fresh connection/token.

The dependency-free builder produces the preferred `plugin/build/ArcaneLocalBridge.lua` and XML alternatives. For a new development installation, review [plugin installation](docs/build/PLUGIN.md) and `npm run install:plugin`: the helper replaces only recognized Arcane artifacts, retains backups outside the active plugin folder and requires a Studio reload. Install exactly one Arcane artifact. This documentation refresh does not perform installation or change a place.

## Create/check an unsigned local source release

`npm run release:local` builds the TypeScript/plugin artifacts and writes a fresh manifest-hashed source directory under `runtime/releases/`. Check a returned directory with `node scripts/create-local-release.mjs --verify ABSOLUTE_RELEASE_DIRECTORY`. This checks integrity only. The directory excludes user runtime data, credentials, generated client settings and node_modules; a recipient needs Node 24+ and its own `npm ci` dependencies, then `npm run doctor` and `npm run start:arcane`.

Clean package boot verification is pending. This is an unsigned source-directory release, with no Electron package, native Windows installer, signing or dependency bundling. It does not establish full release completion.

## Connect a native coding client

Open the provider-metadata link printed by the same launcher, refresh the installed client metadata and explicitly save the desired provider/model/effort. Saving `codex / gpt-6.1-sol / ultra` requests that pair; it does not run a model, alter this chat or establish all-feature entitlement.

Use **Get scoped agent token** in the human workbench. In your own interactive terminal:

```powershell
$env:ARCANE_DAEMON_URL = 'http://127.0.0.1:45871' # use the launcher's actual origin
$env:ARCANE_LOCAL_TOKEN = '<scoped agent token from the workbench>'
npm run native:plan
npm run launch:native
```

Use the scoped agent token, not the browser control token, plugin API key or provider credential. The launch script rechecks native subscription metadata and passes explicit model/effort and local MCP configuration to the genuine interactive Codex/Claude CLI. The native client owns login, inference, approvals and its features. No completed native inference or end-to-end client task is recorded. Confirm actual runtime settings in that client; do not treat accepted flags as proof. Claude planning may create a project-local MCP config even in dry-run mode.

Alternatively, generate reviewable config templates with `node apps/mcp/scripts/generate-config.mjs --project C:\Users\alexk\OneDrive\Documents\GitHub\Arcane`. Existing output is not overwritten and home client settings are not edited. See [MCP setup](docs/build/MCP.md). **VS Code was only opened for this repository; the user cancelled VS Code MCP installation.** Do not report a connected VS Code client.

## Use and check assets

In the workbench Asset workshop, explicitly probe the installed runtime, choose `hero-prop` or `environment-kit`, set bounded dimensions/budgets and start one local job. Review its actual state, verified manifest, audit and authenticated hero/side previews. Cancel by the exact job ID. Unknown start/cancel outcomes require inspecting job history. Blender stages and artifacts are real only when recorded by the native worker.

[Asset evidence and limitations](docs/build/ASSETS.md) identifies the retained native acceptance run. These templates are static starter assets; Roblox scale, axes, materials, collision consumption and import/update mapping still need engine acceptance. An export file or render does not establish a Roblox-ready imported asset.

## Offline skill tools

```powershell
node scripts/skill-pack.mjs validate
node scripts/skill-pack.mjs search "combat hitbox"
node scripts/skill-pack.mjs pack --ids arcane-combat,arcane-remote-security --byte-budget 12000 --allow-experimental
node --test tests/skills/skill-pack.test.mjs tests/skills/evaluation-catalog.test.mjs
```

Default packing is approved-only; current entries are experimental. Explicit opt-in permits review/evaluation, never extra permissions or production approval. Selected files/references are hash-checked and byte-bounded; the helper does not count exact model tokens or prove quota savings. Parent integration owns registry/reference integrity refresh after this documentation change.

## Evidence and remaining release gates

- [Inspected tool metadata](docs/research/ropilot-tool-contracts.json) and [skill source review](docs/research/skill-sources.json): source/contract research, not runtime parity, installed third-party skills or behavior approval.
- [Provider metadata observation](docs/research/provider-connection-checks.json): dated sanitized CLI metadata and local checks; no inference. Its recorded hashes describe that earlier run.
- [Native Studio checks](docs/research/native-studio-checks.json): actual installed server discovery/inventory, missing-target refusal and separately labelled SDK/HTTP fixtures; no plugin mutation proof.
- [Plugin](docs/build/PLUGIN.md), [MCP](docs/build/MCP.md), [UI](docs/build/UI.md) and [assets](docs/build/ASSETS.md): scoped source/test reports with native limitations.
- [Full product build gates](docs/build/PRODUCT_BUILD.md): genuine plugin transport/write/dirty-buffer/restore is deferred by user; real tests, custom production/media, Roblox import/rigs, native feature/task acceptance, skills and clean packaged release remain open.

A CI workflow is authored for the workspace; this refresh does not establish a remote CI result. Hunted is one acceptance project, and no existing place is changed by this docs task. Source, manual edits and other plugins must remain recoverable.

## Repository and licence

Repository: private [k6sol/Arcane](https://github.com/k6sol/Arcane). Prior Git setup observations are historical and do not establish current synchronization or a push of this refresh. The existing [MIT licence](LICENSE) is retained; third-party components keep their own licence/notice obligations.


## First run and your own projects

For the Windows first-run bootstrap and fixed launcher, see [FIRST_RUN](docs/build/FIRST_RUN.md). No developer account or credentials are included. Each user connects their own supported native CLI login. To launch an existing game project with isolated local state, run npm run open:project -- followed by its quoted absolute directory; see [PROJECTS](docs/build/PROJECTS.md). Studio connection/testing remains a separate explicit step.

## Learning and native history

[Project learning](docs/build/LEARNING.md) and [native history](docs/build/NATIVE_HISTORY.md) include reviewed local project-memory routes and UI, plus bounded native-history foundations. Use Learn to enable project memory, review proposals and explicitly add approved notes to a draft. Native persistent-history rehydration and cross-provider synchronization are not yet integrated end to end. Learning is reviewed, opt-in local context and evidence, not model-weight training or automatic training-data upload. A read-only desktop connector check did read the existing genuine native Codex smoke conversation using its original ID, without a new model turn. Claude sync, sidebar registration and concurrent live history still require their own implementation and acceptance.

## Windows executable and repeatable delivery

See [WINDOWS](docs/build/WINDOWS.md). The desktop build contains Arcane.exe, its own Node runtime and production dependencies. Keep the complete directory together. It is an unsigned local development preview, not a finished signed commercial installer. File > Open project (Ctrl+O) selects a direct local folder; switching stops active jobs/connections after confirmation. Each project keeps isolated state and a stable listener port for its Studio key.

From a prepared developer checkout, `npm run release:desktop` compiles, runs unit/browser and offline checks, packages the branded executable and verifies the actual app in a disposable profile. It does not install dependencies, download browsers, run paid inference, connect Studio, publish, or automatically retry writes. Playwright uses the existing installed Edge; optional official Luau fixtures require explicit tooling described in [PLUGIN](docs/build/PLUGIN.md). Reports are retained under runtime/verification.
