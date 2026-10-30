---
name: arcane-arena-kit
description: "Prescriptive round-based arena/PvP genre kit: lobby, intermission, map vote, rounds, win conditions and weapon basics with server-authoritative hit validation, plus stats saves, build order, balancing, budgets and playtest plan."
license: MIT
---

# Arena play: fair encounters inside a complete match cycle

Choose the actual mode: free-for-all, teams, elimination, cooperative waves or a specific objective. Define why movement, position and equipment matter. A full arena game needs a usable lobby, clear rules, fair starts, purposeful content variety, results and replay; one weapon in an empty box is the first combat slice. Do not turn a narrow score or spawn repair into an unrequested mode expansion.

Read [patterns](references/patterns.md) (`arcane-arena-kit:patterns`) for retained round/vote/weapon fragments. They contain integration placeholders, not a complete secure shooter. Coordinate `arcane-rounds`, `arcane-combat`, `arcane-networking`, `arcane-remote-security`, `arcane-interface`, `arcane-vfx`, `arcane-audio` and requested saves.

## Match and roster contract

Separate RoundService epochs, eligible roster/teams, map lifecycle, objective/score, equipment and awards. Validate vote options and eligibility; define no votes, ties, failed loads, leavers and late joins. Elimination spectators differ from temporary downed or respawning players. Countdown, spawn protection, result award and return-to-lobby happen once. Expired hit/respawn/map callbacks cannot affect a new round. Do not quietly change public minimum-player rules to make single-client automation appear like a real match.

Map definitions contain stable IDs, spawns, bounds, objective locations and mode compatibility. Create distinct sightline, elevation, flank, cover and objective situations appropriate to the requested roster, not cosmetic copies. Study reachable spawns from both teams and likely movement paths; distance alone does not prevent spawn traps. Stage initial blockout combat before dressing complete maps. Original art and readable silhouettes support tactical information without clutter or misleading collision; no Toolbox unless requested.

## Trustworthy combat and useful equipment

Clients request action and may predict cosmetics. The server validates actor/equipped item, live phase, ammo/resources, rate, finite origin/direction, target/team rules and plausible reach/occlusion. Bounded action identities prevent duplicate outcomes. Latency compensation needs measured limits and actual history/query code; a placeholder named raycastAgainstHistory is not an implemented rewind system. Never move real characters to perform a historical query.

Weapons should have different useful roles and costs, readable reload/recovery and fair counterplay. Actual rig/animation, muzzle/contact/impact effects, positional sound and hit confirmation must agree with authoritative outcomes. Avoid turning every hit into shake/bloom. Define assists, simultaneous kills, friendly fire and once-only score. Persistent unlocks/stats use requested safe profiles and award identities; a display leaderboard is not the authoritative result journal.

## Presentation and acceptance

Provide mode/map information, phase/time/objective, team/score, relevant ammo/resources and legible results/requeue. Spectators need a useful honest view and a path back. Settings/device input, death/respawn focus and reduced-effect readability matter as much as a crosshair. Use real authorized media IDs and expose missing content rather than celebrating placeholders.

Inspect/build with actual scoped scene/script tools, review disabled code and request separate human-approved finite tests. Follow playtest status through cleanup. Exercise lobby -> vote/load -> combat/objective -> result -> next round; wrong-phase actions, impossible fire, duplicate last hits, ties, leavers and failed map loading must be tested too. Play every delivered map under intended occupancy and measure query/history/effect/part costs. Single-client vote/text checks do not prove multi-client hit fairness or spawn balance; keep those acceptance gaps explicit and never weaken combat or phase rules merely to pass an available scenario.

## Tool integration

Use scene_build for distinct objective/cover/spawn layouts and the real scoreboard/menu hierarchy. Bind map loading and cleanup to the round epoch, and validate hits on the server. Test late joins, reset and stale damage across map transitions.

Use script_update for complete disabled source and script_set_enabled only through its exact syntax/review gate. Follow the `arcane-playtest-qa` script check loop: playtest_request, playtest_status and playtest_cancel retain the actual host repair/cleanup allowance. Existing requested saves use arcane-datastore-safety and the project's single writer; keep session lock, UpdateAsync and failure handling intact. Load this kit's declared patterns only when needed; its fragments are not a finished game.
