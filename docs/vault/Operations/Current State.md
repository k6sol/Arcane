---
type: checkpoint
project: Arcane
tags: [arcane]
---
# Current state

Recorded 30 October 2026. Revalidate before acting. Source baseline for this work is `ee7534cf05253ef2a2b857b4347ee9dba4979e58`; read remote main for subsequent publication.

| Area | Observed evidence | Boundary |
|---|---|---|
| Source baseline | Main `ee7534c`; validation ref `7e52f67` when inspected | Shared working checkout differs; do not overwrite its work |
| Signature | GitHub reports verified SSH signature | Distribution signing is a separate deliverable |
| Earlier green baseline | Runs 40621420963 and 40618732969 succeeded on `7e52f67` | Component/packaged smoke is not customer acceptance |
| Latest baseline run | Run 40975403615 failed: one Windows converted-import test cancelled at its 30-second outer timeout | See [[Bugs/Converted Import Timeout]]; correction requires new hosted verification |
| Implementation work | Adoption lifetime and deliberate-close provenance drafts are being finished against current source | Not yet published or verified |
| Active desktop | Installed 20 October; version 0.1.0, Electron 44.7.0; directory manifest SHA-256 `66f74350b49f1049db1c58941f56876fb1d527a0acb3f7bbcc05260904421818` | Manifest has no Git revision; no launch or update performed |
| Installed plugin file | SHA-256 `9b950f506f2975ebcfe8fcce6c2a42ce011c9e1d2764110216e279657fdfec28`, 429197 bytes | File inspection does not prove it is loaded in Studio |

Current development goals: [[Delivery/G01 Release Baseline]] and concrete lifetime fixes under [[Delivery/G04 Task Lifetimes]]. Next work: [[Operations/Next Session]]. Evidence: [[Operations/Evidence Ledger]].

The full product objective remains a production-grade chat-first development platform, including automatic chat permissions, connected assets, modular plugin, task/playtest loop and packaged customer acceptance. The vault setup does not narrow that scope.
