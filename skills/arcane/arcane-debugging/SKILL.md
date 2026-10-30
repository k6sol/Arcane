---
name: arcane-debugging
description: "Find and fix Roblox script, state, replication and lifecycle failures using exact source, discriminating observations and repeatable player-visible regressions."
license: MIT
---

# Diagnose the cause before changing the system

## Establish an exact reproducer
Capture expected versus observed behavior, the first relevant error/trace, current source and asset revision, execution side and the player actions that trigger it. Identify whether the failure is deterministic, timing-dependent or currently unobservable. Preserve essential conditions such as multiple players, respawn or a delayed response when reducing the case.

Trace the action across input, client request, server validation/state, replication and presentation. A missing HUD update may be a subscription or ownership bug rather than a reward failure. A stopped animation is not proof that the server cancelled its action. Inspect the actual owner and callers before rewriting a module.

## Choose observations that distinguish causes
Use a few testable hypotheses and the smallest observation that separates them: a state transition with generation/revision, handler count, authoritative balance, queue depth, current owner or elapsed boundary. Bound diagnostic volume, avoid player text/secrets and do not log entire profiles. Correlate callbacks without turning arbitrary log text into authority.

For races, write the schedule explicitly: operation starts, yields, owner changes, old callback resumes. Check whether registration happened before the first await/yield and whether cleanup waits for actual owned work. For replication, compare server truth and each client's view. For geometry/input/UI, inspect real hierarchy, transforms, focus and asset availability before adjusting unrelated constants.

## Patch narrowly and preserve the failure
Fix the earliest incorrect transition or ownership decision. Keep compatibility with existing callers/content and preserve the original error when later cleanup also fails. Cleanup should attempt all owned releases; a caught exception is not proof of successful teardown. Do not suppress errors, widen deadlines or alter the success condition just to make a test pass.

Use `arcane-safe-edits` for exact baselines and activation. Run the original reproducer and a regression that would fail under the old behavior, within `arcane-playtest-qa` and the host's actual repair allowance. Fix only the task's affected scripts; report unrelated Output errors without expanding scope. Stop a repair loop when the same attempt produces no new evidence.

## Deliver the result at its actual confidence
State the cause, changed behavior, regression exercised and remaining evidence gap. Include repeated use/respawn/cancellation when the defect involved lifecycle. Distinguish an inspected source fix, a controlled fixture and a real gameplay pass. Leave useful bounded diagnostics only when they support future operation; remove temporary probes that would become noise or expose data.
