---
type: checkpoint
project: Arcane
tags: [arcane]
---
# Current state

Recorded 29 October 2026. Revalidate before acting.

| Area | Observed evidence | Boundary |
|---|---|---|
| Remote main and validation ref | Both `7e52f67546fb5409c41dd9f2bc9376fc33c15e9c` | Shared working checkout differs; do not overwrite its work |
| Signature | GitHub reports verified SSH signature | Distribution signing is a separate deliverable |
| Hosted checks | Runs 40621420963 and 40618732969 succeeded | Component/packaged smoke is not customer acceptance |
| Latest full run | Six component lanes and packaged desktop startup passed | Native Studio/customer workflow remains unverified |
| Draft improvements | Adoption lifetime and deliberate-close error identity drafts exist locally | Compare against current main before reusing |
| Installed app/plugin | Not inspected during vault setup | Never infer installed version from remote main |

Current development goal: [[Delivery/G01 Release Baseline]]. Next work: [[Operations/Next Session]]. Evidence: [[Operations/Evidence Ledger]].

The full product objective remains a production-grade chat-first development platform, including automatic chat permissions, connected assets, modular plugin, task/playtest loop and packaged customer acceptance. The vault setup does not narrow that scope.
