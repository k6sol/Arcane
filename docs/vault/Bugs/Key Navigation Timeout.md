---
type: bug
project: Arcane
tags: [arcane, verification, settings]
---
# Key navigation timeout

Status: concrete Windows browser failure retained; cause and correction still under investigation.
Related goals: [[Delivery/G01 Release Baseline]], [[Delivery/G02 Reliable Chat]].

The first complete run on `9a69619` passed all seven jobs. Subsequent main runs exposed a separate failure before key assertions: the owned synthetic browser page did not finish its full production navigation within the existing twenty-second bound. This is distinct from [[Bugs/Model Review Observation]] and the original asset instruction/reference companions.

- [Run 40991896581](https://github.com/k6sol/Arcane/actions/runs/40991896581/job/123856033922): rejected-copy case; DOM content loaded but full load had outstanding module/font/CSS reads.
- [Run 40992195635](https://github.com/k6sol/Arcane/actions/runs/40992195635/job/123856998631): generate/regenerate case; module graph still pending before DOM content loaded.

Both runs passed all unit lanes and the Linux release lane. Their packaged job was skipped because Windows release failed. Actual diagnostic snapshots show pending same-origin GETs without reported request failures. They do not identify the server, disk, interception or browser scheduling cause by themselves.

- [x] Preserve both actual failed logs and exact bounded navigation diagnostics.
- [ ] Establish the responsible loading or fixture lifetime before editing.
- [ ] Verify a faithful correction with the complete page/module graph and every original key/privacy assertion.
- [ ] Complete current Windows release and packaged checks.

Do not raise deadlines, change the load criterion, suppress modules/startup or declare the problem solved by an unrelated passing fixture. No authenticated customer or real key-storage failure is inferred from synthetic navigation evidence.
