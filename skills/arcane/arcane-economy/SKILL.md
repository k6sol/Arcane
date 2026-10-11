---
name: arcane-economy
description: "Design fair Roblox progression, currencies and rewards with a measurable loop, bounded grants and recovery from duplication."
license: MIT
---

# Progression and economy design

## Start with the player loop
Define meaningful choices, sources/sinks, intended progression duration and why rewards matter. Use a small explicit tuning model with assumptions rather than claiming an optimal economy. Preserve the user's target audience and genre; progression is optional, not a requirement for every game.

Separate catalog prices/rewards from persistent balances and temporary bonuses. Server-side grants have clear eligibility and duplicate prevention. Trading or multi-record operations need a recoverable protocol; do not claim a cross-key database transaction.

Model extreme accumulation, idle time, new-player versus veteran access and event bonuses. Check for strategies that dominate all decisions or make content inaccessible without purchases. Avoid inflation fixes that secretly devalue existing player work.

## Verification
Run deterministic progression simulations for ordinary and extreme behaviors, then compare actual playtest pacing. Validate malformed/duplicate reward requests and migration of old balances. Treat a spreadsheet result as a hypothesis; tune from play evidence and aggregate analytics. Do not promise retention or revenue before representative players have tested the loop.
