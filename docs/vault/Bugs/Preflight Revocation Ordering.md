---
type: bug
project: Arcane
tags: [arcane, permissions, chat, verification]
---
# Preflight revocation ordering

Original candidate4ed Windows unit job125014122741 reports `unknown` where the preflight-revocation case expected `rejected`. Its peer held preflight for only200ms. Seeing the inventory request in the wire log did not guarantee that the response was still held when the real human HTTP/journal revocation arrived. The historical failure alone does not prove the exact dispatch ordering because its wire fixture was not retained.

The peer now holds preflight behind an explicit test gate until revocation is acknowledged. The test witnesses zero turn/start frames while the gate is still held, releases it and requires rejection with zero dispatch and no regrant. The asset-revocation schedule uses the same explicit gate. A second controlled schedule withholds the turn acknowledgement after a witnessed turn/start frame: revocation must retain an unknown Send, clear write permission and reject a later Send without emitting another frame. An unknown dispatched request is not relabelled rejected to satisfy the first case.

The actual production session, HTTP route and journal participate; only the Node JSONL peer is a controlled provider double. Strict660-source compilation succeeds and all28 focused human-Send/permission cases pass with frozen inputs and zero skips/cancellations. Production permission behavior, request timeouts, test deadlines and safety assertions remain unchanged. No CLI inference, customer profile or Studio operation occurs. The original failed run is retained; a fresh exact-source release gate is required before delivery.

Original candidate7d Windows unit2 [job125020061194](https://github.com/k6sol/Arcane/actions/runs/41363957277/job/125020061194) now succeeds. Its actual log explicitly records both the preflight-rejection and witnessed-dispatch-unknown cases passing. The shard summary is 2,990 tests, 2,932 passes, zero failures/cancellations and58 skips; skipped cases are not acceptance evidence. The other release gates and packaged/customer acceptance remain separate.
