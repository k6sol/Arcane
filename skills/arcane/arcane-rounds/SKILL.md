---
name: arcane-rounds
description: "Build Roblox round, team, objective and elimination flows that survive simultaneous completion, late joins and disconnects."
license: MIT
---

# Rounds and lifecycle state machines

## Make transitions explicit
Specify states, entry/exit actions, valid triggers, winners/ties and timeout behavior before implementing scattered timers. Each round has an epoch; callbacks from an older round cannot affect the next one. Define the authoritative transition owner and reject duplicate completion.

Choose player joining/leaving/rejoining rules consistent with the game. Keep elimination, temporary downed state and spectator state distinct where they exist. A random seed or event scheduler can vary play without obscuring debugging.

Own and clean connections, scheduled tasks, temporary instances and replicated UI state at phase exit. A reset should restore a known baseline, not assume every previous player survived. Do not award completion twice because a timeout and final objective arrive together.

## Verification
Exercise one-player start, full lobby, simultaneous final events, no eligible survivors, disconnect during results and repeated rounds. Assertions should cover exactly one result/award, correct remaining lives/teams and no old callbacks.
