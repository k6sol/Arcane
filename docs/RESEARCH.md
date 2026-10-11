# Arcane — research, workflow analysis and evidence boundaries
Research date: 11 October 2026. This file separates observed contracts, documentation and proposed Arcane design. No RoPilot runtime calls were made for this analysis; no paid credits were intentionally spent.

## 1. What was inspected

- RoPilot's public product page and 28 tool descriptions exposed by the connected RoPilot bridge.
- Thirty tool descriptions exposed by the separate connected Studio proxy. That proxy is not automatically Roblox's official built-in MCP implementation.
- Official Roblox documentation for Studio MCP, plugin development, editor-aware scripts, history, HTTP, cloud assets and OAuth.
- Relevant public GitHub repositories and four actual community Roblox skill bodies, with licence review and observed HEAD references.
- Existing local Roblox/Blender skills as working references for asset production, not as presumed redistributable product code.

The metadata snapshot is `research/ropilot-tool-contracts.json`; it contains tool descriptions and proposed/exposed signatures, not private source code. The skill shortlist is `research/skill-sources.json`. Neither file proves runtime correctness or grants permission to execute its embedded instructions.

## 2. RoPilot workflow equivalence

The public page describes an integrated development workflow including a desktop app, Studio connection and asset work. Claims there are marketing evidence, not independent reliability or cost measurements. [RoPilot](https://ropilot.ai/).

| Observed contract family | User workflow | Independent Arcane implementation / additional controls |
|---|---|---|
| Properties, selection, children and instance search | Inspect the real project before changing it | Typed values, bounded pages, stable session handles and explicit ambiguous-name handling |
| Request script → local edit → commit script | Use filesystem coding tools on live Studio source | Editor-buffer base version, diff, expected hash and conflict-safe commit |
| Create, move, disable and grep scripts | Maintain project structure and find relevant code | Distinct disable/delete contracts, approved roots, receipts and source mappings |
| Edit-context Lua | Perform scene or settings changes | Separate privileged capability, time bounds, target policy and known/unknown outcome reporting |
| Playtest policy, start, client/server execution, stop | Test behavior and inspect logs | Explicit test ownership, assertions, evidence, teardown and actual revision IDs |
| Edit-mode screenshot with optional focus | See placement and visual results | Fixed reference views, actual captures and camera restoration where supported |
| Blender Python and renders | Author/review assets in a local headless process | Supervised jobs, saved checkpoints, manifests and validation gates |
| Blender mesh import/reimport | Upload objects/materials and update an existing model | Verified container/object mapping, ownership checks and preserve gameplay children |
| Studio rig → Blender → animation back to Studio | Animate real compatible rigs | Separate basis fixtures, rest/grip checks, local fallback and explicit publishing controls |
| Asset search/insertion | Reuse permitted inventory/store assets | Show source/creator/format; do not force marketplace-first decisions |
| DataStore key reset | Test a fresh-player flow | Excluded from normal MVP; isolated fixtures and separate destructive-data authorization |

Observed details worth retaining: Blender calls advertise headless operation and persisted session variables; render tools provide multiple named views; mesh imports describe bottom-centre placement and unchanged-object reuse; rig import goes from Studio to Blender, not the other way around. Static and character descriptions use different forward conventions. These are requirements to test, not proof that Arcane already implements them.

The exposed descriptions include repeated old guidance. Do not promote that boilerplate into Arcane policy without checking current engine behavior. Arcane's hashes, leases, ledger and restoration rules are our proposed reliability design; the metadata does not establish whether RoPilot has equivalent private controls.

Not inspected: proprietary source, internal prompts, server implementation, billing internals, hidden UI states or actual execution quality. Do not claim a perfect replica, universal parity or a particular savings percentage. Build similar useful workflows with independent code and Arcane branding.

## 3. Verified platform constraints

### Studio integration

Use the current supported built-in Studio MCP through a tested adapter where available. The older standalone Roblox MCP repository is archived and directs users to the built-in path. Discover actual capabilities rather than hard-coding the exposed third-party proxy as the official interface. [Studio MCP](https://create.roblox.com/docs/studio/mcp), [archived standalone server](https://github.com/Roblox/studio-rust-mcp-server).

Editor changes must account for live script documents. Record source versions and use editor-aware update callbacks; inspect current source inside the callback rather than assuming a previous read is still current. [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService).

Plugin history recordings provide grouping/undo support, not an excuse to claim a multi-file/scene batch is a database transaction. Record actual outcomes and restore conditionally. [ChangeHistoryService](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService).

Use supported toolbar/widget/plugin distribution. Start with plugin-initiated loopback HTTP; streaming is optional after capability verification. [Plugins](https://create.roblox.com/docs/studio/plugins), [HttpService](https://create.roblox.com/docs/reference/engine/classes/HttpService).

### Uploads and ownership

Prove the exact asset format and returned hierarchy before building incremental imports. Model and raw Mesh routes are not interchangeable; animation formats and generation paths also have restrictions. Separate operation completion, moderation, permissions and actual engine loading. [Assets usage guide](https://create.roblox.com/docs/cloud/guides/usage-assets), [asset endpoints](https://create.roblox.com/docs/cloud/reference/features/assets).

OAuth integration follows supported authorization flows and resource/scopes. Verify endpoint-specific authentication; do not assume every upload endpoint accepts the same grant or that a user's Studio login is accessible to an external daemon. [Roblox OAuth](https://create.roblox.com/docs/cloud/auth/oauth2-overview).

Hunted's no-video-upload preference is a project requirement, not a universal statement about all current Roblox asset APIs. Its broadcasts use images/audio/timelines unless the owner changes that brief.

### Desktop and Blender

Electron is our proposed Windows-first implementation choice, not a finding about RoPilot's internal stack. Isolation, limited IPC and untrusted preview handling are required design controls. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

The community Blender MCP bridge can inform optional adapters but is not an official Blender Foundation dependency or a required starting point. Review its helpers, licence and optional external-service behavior before integration. The first-party worker remains the preferred controlled pipeline. [Community Blender bridge](https://github.com/ahujasid/mcp-for-blender).

## 4. Skill research conclusions

The shortlist prioritizes primary Roblox/Luau references, source-control/build tools and selectively useful community instructions. Actual review found strong debugging ideas alongside rules that conflict with this project. The full findings, source licences and evaluation gates are in `SKILL_LIBRARY.md`.

Current status: six source repositories recorded; four community skill bodies inspected; no candidate installed, benchmarked or approved as an Arcane default. Exact pinned files still require fetch/hash/adaptation review. This distinction is deliberate: a licence-compatible prompt is not necessarily a good development skill.

## 5. Experiments still needed

1. Actual plugin pairing and two-window identity under supported Studio versions.
2. Open-document conflict behavior and undo/restoration after partial failures.
3. Test input/capture/client/server boundaries and teardown after cancellation.
4. Model upload return shape, stable object mapping and reimport behavior.
5. Ownership/permission failures and moderation/loading states.
6. Static/rig axis, scale, rest pose, clips and weapon-grip fixtures.
7. Worker crash/checkpoint and interrupted upload reconciliation.
8. Skill-with/without comparisons under fixed tasks, models and spend bounds.
9. Cost/latency/correction comparisons on representative completed tasks across genres, including Hunted.

These experiments are part of the roadmap, not completed results. Until they pass, use planned/candidate/proposed wording in the product and documentation.

## 6. Custom skills and subscription update — 11 October 2026

Authored fifty original experimental skill entrypoints and thirteen genre profiles, with an offline hash/selection/context helper. Added fifty primary behavior and ten guard definitions; these are requirements, not executed model/Studio/Blender runs. No third-party skill text was vendored or installed. See [custom skills](CUSTOM_SKILLS.md) and the [evaluation protocol](../tests/skills/EVALUATION_GUIDE.md).

Current official OpenAI documentation describes optional authorized plan usage for eligible local/open-source apps. Paid/remote distribution requires separate availability review; Arcane's private repository does not establish commercial eligibility. [Official overview](https://developers.openai.com/siwc/token-sharing-open-source).

Evaluate the documented Codex app-server route rather than assuming a consumer login is a general API key. Use Arcane's own connection, explicit completion handling and separate route constraints. [App-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

The revised architecture has four modes and keeps external-client MCP first. Research did not perform OAuth registration, request plan access or call inference. [Subscription workflow](SUBSCRIPTION_WORKFLOW.md) records supported-path constraints and the proposed value benchmarks. No savings percentage, unlimited usage or equal-quality-across-models claim is established.
