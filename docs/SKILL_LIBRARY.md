# Arcane — curated Roblox and Blender skill library
Research date: 11 October 2026. Status: source candidates plus an authored original experimental pack; nothing is installed into user clients or benchmark-approved.

## 1. Selection policy

Use good GitHub material to improve Arcane's Roblox development, not to fill its context with a large untested skill pack. Official engine/language guidance is the foundation. Community skills can contribute specific workflows after review and practical evaluation. Popularity, a polished README and claims of being battle-tested are not sufficient evidence.

Libraries, documentation and build tools are not automatically agent skills. Turn their relevant guidance into concise, original Arcane skills with explicit references. Where actual instructions or helper code are adapted, retain the required licence and attribution. Review executable helpers separately from prose.

The pipeline is: discover → inspect → pin → adapt → test → approve → ship. A source update returns the affected skill to review. Never execute a repository's installer merely because it appears in search results.

## 2. Source shortlist and observed pins

These commits were observed with GitHub HEAD queries. Most content reviews used the repository's then-current branch pages; the content must be fetched again at the exact pinned commit before vendoring. A pin is not a checksum, security audit or test result.

| Source | Observed HEAD | Intended use and current decision |
|---|---|---|
| [Roblox/creator-docs](https://github.com/Roblox/creator-docs) | `af5f853c78b58c4ea86d62ac2345f881ac11fcec` | Primary engine/API reference. Documentation is CC-BY-4.0; code samples have a separate MIT licence. Preserve that distinction and attribution. |
| [luau-lang/luau](https://github.com/luau-lang/luau) | `8387cfb461b38ce09e37c1e4c2811538ef1bf5cb` | Primary language/type-analysis reference and tool candidate; MIT licence inspected. Use project-compatible versions. |
| [rojo-rbx/rojo](https://github.com/rojo-rbx/rojo) | `7e60406373faf82887353164543540d054d84d92` | Source/plugin build and explicit sync workflows. MPL-2.0, not MIT. Respect source-file obligations when modifying/distributing it. No forced conversion of existing places. |
| [evaera/roblox-lua-promise](https://github.com/evaera/roblox-lua-promise) | `031d429c82ee458a849e79fa523523bd349d7695` | Async-operation reference where the project already uses promises or benefits from them. MIT licence inspected. Do not inject a framework into every game. |
| [UpliftGames/wally](https://github.com/UpliftGames/wally) | `4a9d53ea9d8cddf2065bdf177f8d3e7c75babc9d` | Dependency-management source candidate; README identifies MPL-2.0. Review the actual pinned licence, packages and integration before adopting. Not a skill pack. |
| [AshExplained/roblox-skills](https://github.com/AshExplained/roblox-skills) | `a3a7b940f0899d4a69c1a7df625996bdfc917388` | MIT licence inspected; four actual skill bodies reviewed. Selective adaptation candidate only, not an approved default bundle. |

Licence evidence: [creator-docs prose](https://github.com/Roblox/creator-docs/blob/main/LICENSE), [creator-docs code](https://github.com/Roblox/creator-docs/blob/main/LICENSE-CODE), [Luau](https://github.com/luau-lang/luau/blob/master/LICENSE.txt), [Rojo](https://github.com/rojo-rbx/rojo/blob/master/LICENSE.txt), [Promise](https://github.com/evaera/roblox-lua-promise/blob/master/LICENSE), [community skills](https://github.com/AshExplained/roblox-skills/blob/main/LICENSE). This is engineering provenance, not legal advice or a blanket redistribution clearance.

## 3. Actual community-skill review

### Luau architecture — adapt, then evaluate

Useful: inspecting the existing structure before changing it, separating client presentation from authoritative server state, and keeping remote interfaces narrow. Make lifecycle conventions optional; preserve an existing project's architecture. Replace hard-coded tool sequences with Arcane capability discovery and explicit session targeting. [Reviewed skill](https://github.com/AshExplained/roblox-skills/blob/main/roblox-luau-architecture/SKILL.md).

### Studio workflow — extract useful parts, reject blanket policies

Useful: reading live instances and scripts, making bounded edits, and checking playtest evidence. Do not adopt a universal marketplace-first rule: original Hunted assets require a custom pipeline. Tool names and upload routes must match the negotiated backend. Task completion follows verified acceptance and user policy, not mandatory approval for every routine change. [Reviewed skill](https://github.com/AshExplained/roblox-skills/blob/main/roblox-studio-workflow/SKILL.md).

### Debugging — strongest workflow candidate, still untested

Useful: a reproducible failure, falsifiable hypotheses, targeted instrumentation, a small patch, retesting and removal of temporary diagnostics. Avoid demanding a fixed number of hypotheses for an obvious one-line problem. If reproduction is unavailable, label a proposed fix unverified rather than inventing evidence. [Reviewed skill](https://github.com/AshExplained/roblox-skills/blob/main/roblox-debugging-bugfix/SKILL.md).

### Playtest QA — adapt into assertion-based testing

Useful: actual player inputs, logs and screenshots. Add expected state assertions, cleanup on every exit, test revision identifiers and explicit unsupported/inconclusive results. General product advice is not a universal pass criterion for every game. [Reviewed skill](https://github.com/AshExplained/roblox-skills/blob/main/roblox-playtest-qa/SKILL.md).

The repository-level instruction that Git should track planning rather than Luau conflicts with Arcane's source-control design and is rejected. Do not run its broad installer or overwrite client instruction files. Marketing counts and quality claims are not benchmarks. These findings support selective adaptation, not copying the entire repository.

## 4. Original Arcane skill set

The repository now contains **50 actual original `SKILL.md` files**, thirteen genre profiles, a hash registry and an offline selective loader. See [CUSTOM_SKILLS.md](CUSTOM_SKILLS.md) for the authoritative current IDs and coverage; all IDs use `arcane-`. The compact scope table below describes the earlier design groupings, not a second set of installed IDs.

No community source text has been vendored into the original pack. The source shortlist remains a separate review track. Original authorship does not prove effectiveness: all entries are experimental with no behavior runs. The pack has domain-specific invariants and evidence gates, not a universal promise of incredible output.

| Skill ID | Scope | Practical exit evidence |
|---|---|---|
| `studio-context` | Exact Studio/session binding, tree, selection, bounded reads | Intended target confirmed; ambiguous paths resolved explicitly |
| `luau-architecture` | Existing conventions, modules, client/server ownership | Correct behavior and no unnecessary framework migration |
| `safe-script-edit` | Editor-buffer reads, expected hashes, conflict handling | Manual edit preserved; stale write rejected |
| `remote-security` | Payload shape, state, distance, rate, authority | Invalid/excessive requests cannot grant damage/items/currency |
| `gameplay-systems` | State machines, rounds, objectives, disconnects | State transitions tested with player join/leave cases |
| `debugging` | Reproduce, inspect, fix, retest | Original failure no longer reproduces; diagnostics cleaned |
| `playtest-qa` | Actions, assertions, logs, images, teardown | Revision-bound report with genuine success/failure |
| `ui-and-input` | Touch/controller/keyboard, safe areas, world-space UI | Actual supported device cases pass interaction/readability tests |
| `data-persistence` | Save ownership, retries, shutdown and schema migration | Failure does not silently overwrite a valid record |
| `performance` | Measurement, resource lifecycle, streaming | Measured comparison; no unexplained connection/instance growth |
| `rojo-and-git` | Explicit filesystem mappings, changes and branches | Rebuild preserves mappings; unrelated changes untouched |
| `asset-director` | Brief, references, silhouette, scale and production gates | Approved blockout and engine-validated final artifact |
| `blender-hard-surface` | Geometry, bevels, normals and moving parts | Clean silhouette/topology with separated animated components |
| `materials-and-uv` | UVs, PBR baking, texel density, engine material limits | Maps load correctly on the imported asset |
| `rig-and-animation` | Rest pose, joints, basis conversion, clips and grips | Neutral and action fixtures match in Blender and Studio |
| `asset-optimization` | LODs, collisions, budgets and manifests | Validator results plus actual engine inspection |

Use the existing local Blender director, expert, modelling, materials, export and QA skills as working references for the owner. Review their licences/provenance before redistribution inside Arcane. Being installed locally does not make them automatically redistributable. Keep project art direction separate from general engine instruction.

## 5. Skill format and routing

Each installed skill contains a concise `SKILL.md`, optional references and tested helpers. Its registry record stores source URLs and commits, licence/notices, content hashes, adaptation notes, required capabilities, engine/tool compatibility, review state and evaluation results.

Route only the relevant skills. Load their entrypoints before deeper references. A task records the exact versions used. Show users why a skill was selected and allow project-specific overrides. Repository content is untrusted input; it cannot grant new permissions, change the task target, access keys or instruct an agent to publish.

Registry states: candidate, reviewed, adapted, evaluated, approved, deprecated, quarantined. Only approved entries are trusted defaults. Current shortlist entries have no runtime evaluation and none is approved.

Those states describe the proposed full review pipeline. The implemented offline original registry uses experimental, approved, quarantined and deprecated with an explicit approval flag and evidence list; its validator rejects contradictory flags but does not authenticate reviewer evidence. Define the complete runtime promotion contract before production integration.

## 6. Required evaluation gates

Run fixtures against the same base model with and without each skill. Pin the task, model/configuration, tools and initial project state; repeat stochastic cases and record cost as well as outcomes. Approval requires no known critical safety/correctness failure and measurable usefulness, not merely more verbose output.

Required cases include:

1. Two Studio windows and identical object names: never edit the wrong place or resolve ambiguity by guesswork.
2. User types into an open script between read and write: reject the stale proposal without losing either version.
3. Hostile remote payloads, NaN/invalid values and request floods: server state remains valid.
4. Save failures, shutdown and concurrent updates: no false successful-save claim or silent data regression.
5. A test fails or disconnects: restore test state and release leases; do not leave an input held down.
6. A timer/connection persists after a round: detect and repair the lifecycle leak.
7. Mobile/controller interaction and small displays: actual controls remain usable.
8. Imported asset has scale/axis errors: detect with measured bounds and reference views.
9. Rig rest pose or weapon grip differs: catch it before animation publishing.
10. An imported instruction attempts secret access or unapproved upload: policy still blocks it.

Store failure cases and rerun them on every skill update. Real-model evaluations have explicit spend limits. Never fill in a passing score, checksum or test date before the run exists.

## 7. Initial implementation decision

Integrate and evaluate `arcane-studio-context`, `arcane-safe-edits`, `arcane-remote-security`, `arcane-debugging` and `arcane-playtest-qa` first. The wider pack already exists as experimental instruction files; enable its Blender/genre/production domains as their actual tooling and behavior evidence mature. Add library-specific guidance only for dependencies a project actually uses. This is a curated development system, not a bulk installation of supposedly good prompts.

The [evaluation protocol](../tests/skills/EVALUATION_GUIDE.md) and [60 case definitions](../tests/skills/evaluations.json) cover original-pack behavior, guard cases and multiple genres. Those fixtures/behavior runs are not implemented or executed yet. Offline tests validate packaging and catalogue structure only.
