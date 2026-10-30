---
type: bug
project: Arcane
tags: [arcane, import, lifetimes]
---
# Studio packet poll fairness

The retained Windows large-PBR failure occurred at packet 122. Its actual poll processing, receipt handling and next enqueue consumed about 6.55 seconds of the original 6-second freshness proof. This establishes the expired proof; it does not distinguish every underlying database, CPU or host-scheduling cost.

After each original packet is successfully queued and its original deadline is established, the controller gives pending plugin I/O one event-loop turn before the unchanged receipt boundary. Queue-before-poll pacing remains: an intermediate empty poll would enter the real plugin's 2-second idle branch. All actor/review/target/deadline/freshness checks still execute after the yield. No heartbeat is invented and no failed packet is replayed.

- [x] Pass 57 related staging/MCP/diagnostic cases, including genuine poll refresh at expiry, no-poll refusal/cancellation and queued-turn actor retirement.
- [x] Retain the original fractional 12.5 ms wait and all earlier pacing cases.
- [x] Pass the unchanged 20 MiB PBR stage/seal/reconstruction/recovery case through actual production boundaries.
- [x] Complete a 141-packet full-map pacing case with zero intermediate idle polls.
- [ ] Pass fresh hosted verification of the exact candidate.
- [ ] Verify the intended updated-app/Studio import and actual material appearance separately.

The proof remains 6,000 ms, packet deadline 10,000 ms and total deadline 120,000 ms. Local fixtures use actual controller/store/policy code with explicitly controlled plugin/engine peers. They are not native Studio, upload, Asset Manager registration or customer acceptance.

Related: [[Delivery/G06 Connected Import]], [[Delivery/G04 Task Lifetimes]], [[Bugs/Native Connection Inventory]].
