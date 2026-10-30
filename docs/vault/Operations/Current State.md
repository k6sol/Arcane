---
type: checkpoint
project: Arcane
tags: [arcane]
---
# Current state

Recorded 30 October 2026. Revalidate before acting. Source baseline for this work is `ee7534cf05253ef2a2b857b4347ee9dba4979e58`; read remote main for subsequent publication.

| Area | Observed evidence | Boundary |
|---|---|---|
| Source baseline | Main `98ae294`; validation branch includes adoption `6bab6cc` and cancellation `7ecbdc2` | Re-read refs for subsequent publication; shared working checkout differs |
| Signature | GitHub reports verified SSH signature | Distribution signing is a separate deliverable |
| Earlier green baseline | Runs 40621420963 and 40618732969 succeeded on `7e52f67` | Component/packaged smoke is not customer acceptance |
| Main verification | Strengthened observation case passed on Windows in run 40983762974; another Windows task test cancelled | Full main run failed; see [[Bugs/Converted Import Timeout]] for distinct evidence |
| Implementation work | Adoption and cancellation provenance are on validation; [[Bugs/Final Asset Save]] is prepared next | Exact candidate hosted checks remain pending; not an installed-app update |
| Delivery implementation | [[Bugs/Portable Desktop Delivery]] retains the already-tested app directory and same-run provenance | Source-reviewed; hosted artifact and actual installation are not yet verified |
| Package blocker | Adoption passed all six component lanes, then packaging rejected developer vault filenames | Exclusion commit `0766e43` keeps this material in Git/Obsidian without loosening path rules |
| Active desktop | Installed 20 October; version 0.1.0, Electron 44.7.0; directory manifest SHA-256 `66f74350b49f1049db1c58941f56876fb1d527a0acb3f7bbcc05260904421818` | Manifest has no Git revision; no launch or update performed |
| Installed plugin file | SHA-256 `9b950f506f2975ebcfe8fcce6c2a42ce011c9e1d2764110216e279657fdfec28`, 429197 bytes | File inspection does not prove it is loaded in Studio |

Current development goals: [[Delivery/G01 Release Baseline]] and concrete lifetime fixes under [[Delivery/G04 Task Lifetimes]]. Next work: [[Operations/Next Session]]. Evidence: [[Operations/Evidence Ledger]].

The full product objective remains a production-grade chat-first development platform, including automatic chat permissions, connected assets, modular plugin, task/playtest loop and packaged customer acceptance. The vault setup does not narrow that scope.
