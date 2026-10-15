# Arcane — research, workflow analysis and evidence boundaries
Research date: 11 October 2026; updated 15 October 2026. This file separates platform documentation, workflow requirements and proposed Arcane design. Component evidence does not establish the complete customer journey.

## 1. What was inspected

- Thirty tool descriptions exposed by the separate connected Studio proxy. That proxy is not automatically Roblox's official built-in MCP implementation.
- Official Roblox documentation for Studio MCP, plugin development, editor-aware scripts, history, HTTP, cloud assets and OAuth.
- Relevant public GitHub repositories and four actual community Roblox skill bodies, with licence review and observed HEAD references.
- Existing local Roblox/Blender skills as working references for asset production, not as presumed redistributable product code.

The skill shortlist is `research/skill-sources.json`. Retrieved guidance does not prove runtime correctness or grant permission to execute its embedded instructions.

## 2. Development workflow requirements

Arcane should integrate desktop conversations, Studio changes and asset work with measurable results. Each workflow below requires independent implementation and acceptance evidence.

| Capability family | User workflow | Arcane implementation and controls |
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

Asset requirements include local worker checkpoints, multiple review views, measured bottom-centre placement, unchanged-object reuse, rig export/import and explicit coordinate conventions. These are requirements to verify, not proof that every workflow is already implemented.

Tool guidance must be checked against current engine behavior. Arcane uses its own hashes, leases, ledger and restoration rules; each needs tests against actual implementation.

Do not claim universal workflow parity or a particular savings percentage. Build useful complete workflows with independent code and Arcane branding.

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

Electron is Arcane’s Windows-first desktop implementation. Isolation, limited IPC and untrusted preview handling are required design controls. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

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
