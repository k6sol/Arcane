---
name: arcane-analytics
description: "Design privacy-conscious Roblox funnels and event measurements that distinguish gameplay problems from unsupported retention claims."
license: MIT
---

# Analytics and play hypotheses

## Measure a question, not everything
Start with a specific hypothesis about onboarding, decisions, failure, replay or progression. Define event names, eligibility, denominator, deduplication and schema version. Separate observed behavior from inferred player motivation.

Collect only useful permitted data. Avoid player text, secrets and unnecessarily identifying information. Verify current platform analytics capabilities and applicable policies before using a service. A metric inaccessible to this project remains unknown rather than fabricated.

Segment by relevant version/device/cohort and account for small sample sizes, incomplete sessions and concurrent changes. Do not compare unrelated time windows as causal proof. Pair quantitative evidence with actual play observations.

## Verification
Run a fixture flow with known events and verify counts/order in the available tools. Check repeated input, retries and missing/late events. Record limitations and whether the hypothesis gained support. No top-100, revenue or retention guarantee follows from installing telemetry.
