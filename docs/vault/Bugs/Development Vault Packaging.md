---
type: bug
project: Arcane
tags: [arcane, packaging, knowledge]
---
# Development vault packaging

Status: source-only exclusion prepared for hosted validation.
Related goals: [[Delivery/G01 Release Baseline]], [[Delivery/G10 Customer Release]].

The knowledge-vault addition introduced Markdown paths containing spaces under `docs/vault`. The existing source-release and Windows package path policies reject such paths. Once all six component lanes passed, [run 40984179721](https://github.com/k6sol/Arcane/actions/runs/40984179721/job/123838456259) failed in the package phase with `WINDOWS_PACKAGER_FAILED`; no executable smoke was performed.

The development vault is useful to developers through Git and Obsidian, not required by the desktop runtime. Exclude only `docs/vault` before source collection and reject it from release-manifest admission. Preserve existing path validation, bounds, secret checks and shipped product documentation/skills.

- [x] Inspect actual saved failure receipt and deterministic path-policy conflict.
- [x] Author narrow collector/manifest exclusion and an actual source-release regression.
- [ ] Hosted regression verifies spaced vault notes stay in source, ordinary docs/skills ship, and a rehashed manifest cannot reintroduce the vault.
- [ ] Exact corrected revision passes actual packaged startup.

The Obsidian sync still projects `docs/vault` from Git normally. No note is deleted and no installed application is changed by this packaging correction.
