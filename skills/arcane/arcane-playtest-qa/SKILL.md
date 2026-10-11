---
name: arcane-playtest-qa
description: "Define and run Roblox feature/playflow tests using real inputs, state assertions, logs, captures and guaranteed teardown."
license: MIT
---

# Assertion-based gameplay QA

## Define observable acceptance
A scenario records fixture, initial state, inputs, expected outcomes, deadline and teardown. Tie its result to exact source/assets and relevant device/client configuration. Use a copy or disposable fixture when setup is destructive.

Own the test session before starting or stopping it. Run input on the intended client and authority checks on the server. Teleporting a character or injecting state is fixture setup, not evidence that an ordinary player could complete the interaction.

Collect useful captures, logs and expected/observed values. Verify interactions beyond the ideal happy path: rejection, repeated input, interruption and cleanup where relevant. Unsupported capture/multiplayer/device tooling stays explicitly unsupported.

## Cleanup and reporting
Release held input, temporary state and owned leases even when an assertion or transport fails. Report failed teardown. Preserve first failure and avoid silently adjusting the fixture or criteria.

## Verification
A passing report requires actual step evidence, not absence of Output errors. New dependent revisions invalidate old pass claims. Real-player fun/usability sessions supplement automated correctness tests; neither replaces the other.
