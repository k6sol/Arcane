# Arcane — original Roblox production skills
Version 0.1.0 · 11 October 2026. Status: authored experimental skills and offline tooling; no skill is behavior-benchmarked or approved for production defaults yet.

## 1. What now exists

The repository contains sixty-two original, portable `SKILL.md` entrypoints (including seven genre kits), thirteen genre references, a machine-readable registry, evaluation definitions and an offline validation/selection tool. These are actual files, not just feature names. They are not a running Studio plugin or model service.

The entries are intentionally concise. Each changes task-specific decisions, names failure boundaries and requires meaningful evidence. No community pack was bulk installed or copied. The source shortlist remains separate research; the custom files use the repository's MIT licence.

## 2. Coverage

| Area | Original skill IDs (prefix `arcane-`) |
|---|---|
| Live context and edits | studio-context, safe-edits, studio-plugins, open-cloud |
| Luau and multiplayer | luau-architecture, networking, remote-security, cross-server |
| State and ownership | persistence, datastore-safety, rounds, inventory, trading |
| Mechanics | gameplay-systems, input-camera, physics, combat, npc, procedural-generation |
| Product design | game-design, economy, monetization, genre-adaptation, onboarding |
| Player experience | gameplay-feel, interface, accessibility, localization, social-moderation |
| World craft | level-design, art-direction, world-building, natural-scenes, architectural-features, photoreal |
| Asset production | blender-props, characters, avatars, materials, rig-animation, asset-optimization, asset-integration |
| Presentation | vfx, audio, cinematics |
| Verification and operations | debugging, playtest-qa, performance, quality-review, release, analytics, live-ops |
| Platform workflow | subscription-workflow, context-budget, project-director |
| Genre kits | obby-kit, tycoon-kit, simulator-kit, horror-kit, arena-kit, racing-kit, rpg-kit |

The genre kits are prescriptive whole-game blueprints: build order, tuning numbers, budgets and session-locked saves for one genre. Arcane's skill router loads a kit when the request names its genre or signature mechanics (for example "dropper", "checkpoint", "lap"), and the chat **Starters** name them directly. `interface` now builds ScreenGuis from a design system (tokens, UICorner/UIStroke/UIGradient components, scale layouts, hover/press tweens, contrast), and `vfx` gives exact ParticleEmitter presets (fire, smoke, sparks, magic, waterfall, dust, fireflies, leaves) with pooling budgets. `playtest-qa` includes the script check loop: apply the `luauAdvisories` from `script_update`, enable, run an approved playtest, read Studio Output since a cursor with `studio_output_read`, fix only your own scripts, at most three fixes.

The genre profiles cover horror/survival, obby/platformer, tycoon, collection/simulator, shooter, melee/RPG, cozy/social, racing, strategy, party, puzzle/educational, roleplay and adventure/exploration. These are selective design starting points, not preset games or performance guarantees.

Coverage grows in response to demonstrated tasks/failures. Sixty-two is the current authored count, not an assertion that every future engine feature is already handled. Avatar, policy, cloud and other changing requirements require current primary-source checks at use time.

## 3. What makes them useful

- **Concrete invariants:** open-editor conflicts, round epochs, authoritative outcomes, recoverable save/trade flows, camera/input cleanup and ownership-aware reimports.
- **Actual craft:** proportions before surface polish, readable attack windows, decisions with consequences, coherent visual references and feel tested at game scale.
- **Scope preservation:** fix a bug without gratuitous rewrites; do not add monetization, a framework or horror styling to unrelated work.
- **Truthful evidence:** renders, fixture tests, real client input, live engine appearance and player observations are distinct results.
- **Device awareness:** responsive controls, layouts, measured runtime budgets and accessibility—not assumed mobile quality from a desktop screenshot.
- **Efficient disclosure:** retrieve only relevant entrypoints and reference profiles. Current source is not replaced by stale summaries to save tokens.

An agent still needs a capable model, supported tools and a clear brief. A skill cannot guarantee fun, eliminate every exploit, make every generated asset publishable or put a game in Roblox's top 100.

## 4. Intended task routing

Examples:

- Repair a duplicated pickup: inventory + remote-security + debugging, with safe-edits for actual live writes.
- Improve an obby jump: input-camera + physics + gameplay-feel + the obby profile; persistence only if checkpoints affect saves.
- Build a cozy pet-care slice: game-design + genre-adaptation + interface + characters as relevant; no compulsory combat/horror stack.
- Create a racing vehicle: physics + input-camera + relevant prop/rig skills; test ownership transfer and reset as well as appearance.
- Build a tycoon economy: game-design + economy + persistence + networking; monetization only when requested.
- Build a model from a reference: blender-props + materials + asset-optimization + asset-integration, followed by actual engine review.

The implemented lexical search helper produces candidates, not a semantic verdict. The future task router should inspect intent, existing project state and required verification, then read selected skills. Keywords must not trigger every skill mentioning a shared word like "game".

## 5. Registry and trust

`skills/registry.json` records each ID, path, title, routing description, keywords, category, version, content hash, verification capabilities and explicit references. Entries are experimental with empty behavior-evaluation histories. Offline integrity checks never promote them to approved.

Verification capabilities describe what is needed to prove an implemented result, not a reason to refuse useful planning or filesystem inspection when Studio is unavailable. A skill has no authority to grant those capabilities.

Content hashing covers the entrypoint and declared references. Tooling checks containment against resolved real paths. Adding a local checksum does not make content safe: source changes still require review. Updating approved content must quarantine/review it, not silently recompute a trusted hash.

## 6. Offline tooling

From the repository root with a supported Node runtime:

```text
node scripts/skill-pack.mjs validate
node scripts/skill-pack.mjs list
node scripts/skill-pack.mjs search "combat hitbox"
node scripts/skill-pack.mjs pack --ids arcane-combat,arcane-remote-security --byte-budget 12000 --allow-experimental
node scripts/skill-pack.mjs pack --ids arcane-genre-adaptation --reference arcane-genre-adaptation:obby --byte-budget 7000 --allow-experimental
node --test tests/skills/skill-pack.test.mjs tests/skills/evaluation-catalog.test.mjs
```

Experimental content is not packed by default; explicit local review/testing can opt in with `--allow-experimental`. The flag does not change approval state or authorize Studio, model calls, installation or publishing. Nothing is written into Codex/Claude home configuration.

The byte budget includes headers, warning text and references. It is not an exact model-token budget. Oversized packs fail rather than silently truncating safety or verification requirements. References are explicit; selecting a genre does not automatically load every genre.

Observed offline checks on 11 October 2026: 31 passed, zero failed and one skipped because Windows denied the symlink/junction fixture. See the [dated evidence record](research/skill-tooling-checks.json) for tested file hashes, commands and limitations. Line-ending attributes preserve byte-exact hashes across normal Git checkouts.

## 7. Quality gates and evaluation

The evaluation catalogue defines fifty primary and ten guard tasks, fixture requirements and independent observable criteria. The behavior runner and runtime fixtures still need implementation. A worker receives the request/fixture, not the grading oracle. Definitions are not completed runs. Run a baseline and skill-assisted task against the same model/configuration/project revision, with authorized side effects and bounded spend.

Evaluate routing, correctness, scope preservation, recovery, craft, measured usage and player-critical usability. Include near-miss requests, adversarial inputs, interruptions and multiple genres. Acceptance tests must not merely search generated answers for desired headings or match sample code.

Promote only after actual relevant tests and a reviewed record. An art/fun claim needs real evidence and player review; metrics such as polygon counts and silence in Output cannot establish it. See `tests/skills/evaluations.json` and `tests/skills/EVALUATION_GUIDE.md`.

## 8. General platform, not a Hunted-only assistant

Hunted's specific art, broadcasts, lives and match flow remain project memory. Other projects use their own genre profile, style, input and economy constraints. A horror-oriented skill should not become a hidden global rule.

Add acceptance slices in several genres to the roadmap: obby controls/checkpoints, tycoon ownership/economy, cozy interaction/UI, racing physics/reset, combat/latency and puzzle state/retry. This catches narrow success on one project and exposes the difference between functional code and genuinely good play.

The subscription strategy is specified in [SUBSCRIPTION_WORKFLOW.md](SUBSCRIPTION_WORKFLOW.md). Its purpose is better completed work per allowance, not hidden API charges, limit evasion or claims of unlimited use.
