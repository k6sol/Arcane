---
name: arcane-economy
description: "Design fair Roblox progression, currencies and rewards with a measurable loop, bounded grants and recovery from duplication."
license: MIT
---

# An economy with reasons to earn and spend

Begin with the player's real loop and choices, not a currency list. State the role of each source, sink and unlock. Progression is optional: a puzzle, social space or competitive mode may be better without XP or rebirth. For a complete progression game, connect the first useful reward, near-term purchase, later specialization and the content those choices open.

## Tune from a small explicit model

Keep catalog prices/rewards separate from balances, temporary bonuses and entitlement state. Sketch time-to-afford using expected activity rate, travel time, failure, capacity and spending alternatives. Include the cost of returning to sell or repeating an encounter; a currency-per-second formula alone misses actual play. Mark assumptions and starting numbers as hypotheses, not optimal pacing or promised retention.

Give competing purchases situational value: capacity reduces return trips, speed changes handling risk, a tool opens a new interaction, cosmetics serve expression. Later locations should alter activities or constraints, not just multiply rewards and health. Check new-player/veteran access, idle income, event bonuses, compounding multipliers, maximum levels and whether a dominant strategy erases every other decision. Bound integer/number ranges and make overflow/refusal visible instead of wrapping values or granting infinity.

## Keep outcomes accountable

The server derives grants and prices from known definitions and verified game events. Each reward has clear eligibility and duplicate prevention; clients cannot submit trusted amounts or claim a completed objective. Choose a durable claim/grant criterion when saves are requested, including an interrupted award and reconnect. A session flag alone does not settle a persistent reward after restart. Failed profile loading must not authorize spending defaults or overwrite real balances.

Trading and gifts need `arcane-trading` recovery; separate record saves are not a multi-key transaction. Rebirth/prestige must show exactly what resets and survives, serialize simultaneous requests, and complete once. Do not treat temporary UI animation or a successful remote response as proof that persistence committed. Existing player value should survive migrations and tuning changes under an explicit policy rather than hidden devaluation.

## Communicate costs and test the actual loop

Show balance, price, prerequisites, meaningful benefit and unavailable/insufficient-funds state before confirmation. Use concise reward feedback and item/progression previews; avoid fake scarcity, confusing currencies or pressure to purchase. Monetization is a separate requested decision (`arcane-monetization`); free play must remain coherent without it.

Use deterministic progression calculations to compare ordinary, efficient and extreme behaviors, then validate representative routes in actual play. Measure time until the first informed purchase, later bottlenecks and whether players understand what changed. Exercise duplicate/forged grants, negative/NaN values, concurrent purchases, insufficient funds, reset failure and interrupted save/reload in isolated profiles. Compare the final server balance, owned upgrade, GUI and world effect. Report simulated versus observed pacing separately; a spreadsheet and a larger number on the HUD do not establish fun, fairness, revenue or retention.
