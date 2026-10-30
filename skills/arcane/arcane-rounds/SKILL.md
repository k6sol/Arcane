---
name: arcane-rounds
description: "Build Roblox round, team, objective and elimination flows that survive simultaneous completion, late joins and disconnects."
license: MIT
---

# Rounds that remain coherent after the first win

Use rounds when the game has a genuine shared start, contest and result. Decide whether the mode is cooperative, score-based, elimination, timed survival or objective play; do not bolt a generic deathmatch timer onto another loop. Connect lobby/readiness, instructions, loading, play, results and return so players always know what happens next.

## One transition owner

Specify states, valid triggers, entry/exit actions, eligibility and timeout policy before spreading timers across scripts. Give every round an epoch and every result a once-only award key. A timeout and final objective may arrive together: only one transition commits the result. Old hit, respawn, delayed effect, vote and load callbacks must not mutate the new round. Cancellation cleans its owned resources without destroying persistent lobby or player-authored state.

Freeze the eligible roster at the appropriate boundary. Define late joins, departures, teams, spectators, downed versus eliminated players and an empty surviving team. Voting needs a bounded current option set, one effective vote per eligible player, a tie rule and a no-vote fallback. A failed map load returns to a truthful waiting/error state instead of teleporting players into missing geometry. Avoid silently changing public minimum-player rules merely to make a single-client test pass.

## Make the cycle worth repeating

Keep map/mode definitions separate from the round controller: spawn candidates, objectives, bounds, allowed equipment and cleanup handles. Different rounds should produce different tactical or cooperative situations, not merely recolor the same floor. Scale the map/mode roster to the complete-game brief, while allowing one specific round repair to stay narrow. Validate every selectable definition so a good first map does not hide broken later content.

Spawn into fair, reachable positions with the correct loadout and camera. Announce phase, objective and remaining time through one replicated presentation model; timer display interpolates the server deadline rather than granting outcomes. Add concise countdown cues, objective feedback, elimination/spectator controls and a results explanation including ties. Animation/audio/VFX from the previous phase stop before the next countdown. Results offer an intentional replay/leave path instead of trapping eliminated players with nothing to do.

## Settlement and repeated-play checks

The server owns score, eligibility and awards. Requested saves use the project's genuine profile/receipt system; an in-memory awarded flag is not durable duplicate protection across a crash. Do not add purchases or progression to a purely competitive round without a reason.

Exercise one-player behavior as designed, a full lobby, simultaneous last events, no survivors, a leader leaving, a late join during loading and disconnect during results. Run repeated rounds including different maps and a failed load. Assert one result/award, correct team/life counts, no old callbacks and bounded map, connection and effect inventories after teardown. Use `arcane-playtest-qa` for authorized finite runs; a human approval request or one local participant does not prove multiplayer fairness, cleanup or a full match cycle. Preserve exact evidence and report the missing cases.
