---
name: arcane-live-ops
description: "Plan and implement Roblox seasonal events, feature flags and balance changes with compatibility, expiry and recovery."
license: MIT
---

# Live operations and events

## Keep the base game dependable
Define event start/end, timezone, eligibility, rewards and behavior for servers that span a configuration change. Prefer versioned server-owned configuration and explicit flags over editing live scripts ad hoc.

Check old/new data and asset compatibility. Bound rewards and make claims/replay safe. Define how unfinished event progress and expiring items are handled; disclose this to players. Do not use arbitrary time pressure as a substitute for meaningful content.

Roll out to an authorized test or limited cohort when feasible. Include disabled/service-failure fallback and a kill switch for genuinely risky changes. Automatic expiry must not delete permanent purchases or player work unexpectedly.

## Verification
Test boundaries around start/end, long-running servers, rejoin, duplicated claims and rollback. Capture exact config revision with reports. Separate planning an event from authorization to schedule or publish it. Use measured outcomes to tune the next update rather than declaring every event a retention boost.
