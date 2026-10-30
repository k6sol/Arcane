---
type: bug
project: Arcane
tags: [arcane, chat, verification]
---
# Chat tool heartbeat

Goal: [[Delivery/G01 Release Baseline]]. Related: [[Bugs/Normal Task Handoff]].

Windows run 41008428591, job 123908546162, failed the existing handoff/workbench credential parity test. Its first viewport request returned `BINDING_CHANGED` and the next returned `STALE_PROOF`; the exact equality assertion correctly refused that comparison. All other cases in that shard passed. The fixture initially polled once but expected a successful connected viewport after a sequence of real requests, without enabling its existing heartbeat option.

Enable that existing owned poll heartbeat only for this positive parity case, matching the preceding positive MCP viewport case. Preserve all three original cases, the complete route/body inventory, strict cross-token status/error equality, final viewport 200, original timeouts and production guard order/expiry limits. No alternate accepted-error list or artificial proof timestamp is added.

- [x] Identify the actual failure and source mismatch; review the exact one-line correction.
- [ ] Verify the corrected case and full hosted inventory on the exact published revision.
- [ ] Record any further real failure without rerunning blindly or weakening the comparison.

The source is consistent with crossing proof expiry during sequential requests; the log alone does not prove the exact historical predicate timing. This controlled in-memory peer is not a native Studio test or customer acceptance.

[[Operations/Current State]] · [[Operations/Evidence Ledger]]
