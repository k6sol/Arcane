---
name: arcane-analytics
description: "Instrument and interpret Roblox gameplay funnels, progression and reliability with versioned event contracts, valid denominators, privacy limits and actual play observations."
license: MIT
---

# Measure a gameplay question that can change a decision

## Start with a falsifiable hypothesis
Choose a specific problem: players cannot discover an interaction, a challenge spikes in difficulty, rewards arrive too slowly, a menu blocks action, or a technical failure ends sessions. Define the decision a measurement will inform. Do not add telemetry simply to count everything or declare a game successful.

Map the relevant flow from eligibility through attempt, consequence and return/retry. Define event names/version, emitting owner, trigger, allowed fields, stable content/release IDs, denominator and deduplication. Distinguish a displayed button, an input attempt, server acceptance and a completed durable reward. Client events describe presentation/intent, not authoritative value grants.

## Keep data meaningful and bounded
Use finite categories and bounded payloads. Avoid raw player text, secrets, unnecessary identifiers and high-cardinality values such as arbitrary positions or error strings. Verify supported platform analytics capabilities and applicable policy before implementation; an inaccessible dashboard or endpoint remains an evidence gap.

Define missing/late events, buffering limits, sampling and retry behavior. Do not let analytics failure block gameplay or turn a retry into duplicate progression. For a funnel, count distinct eligible units consistently and explain exclusions. Coordinate state transitions with instrumentation so an interrupted attempt is not mislabeled completed.

## Interpret with the game in view
Segment only where useful: release/config/content version, relevant device/input, new/returning cohort or difficulty. Check sample size, session censoring, bots/test traffic, concurrent changes and survivorship. A lower failure rate can reflect easier or less interesting content; observed correlation does not establish motivation or causation.

Pair metrics with actual play observation, UI readability, content quality and qualitative feedback. For experiments, state assignment, exposure and decision criteria before reading results; do not retroactively select a winning metric. Reliability counters and gameplay satisfaction answer different questions.

## Acceptance is a verified event path
Run a known authorized fixture flow and verify event order, counts, eligibility and deduplication in the available sink. Exercise repeated input, denied action, disconnect, late delivery and unavailable telemetry. Confirm the actual production configuration does not include test data or private fields. Report what the data supports, uncertainty and the next design action. Installing telemetry proves neither player retention, revenue nor a top-chart game.
