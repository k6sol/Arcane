---
type: bug
project: Arcane
tags: [arcane, actions, ui]
---
# Action meter labels

The loaded customer app showed 0 / 500 while its accessible breakdown reported 500 actions remaining. The compact number counted usage, so zero could be mistaken for no allowance. The top pill and sidebar now show remaining actions with the visible word left. The usage bar still measures consumption, and the accessible sentence, tooltip and Plans breakdown keep the exact used/limit and UTC reset date. Over-limit usage displays zero left; no allowance, credit, admission or reset calculation changes.

Strict compilation covers660 sources. The existing21-case Plans suite passes with no skips/cancellations and frozen source/compiled hashes, including real Edge top/sidebar rendering and the local action-code route. This is newer source than the installedf8 package. It is not installed customer acceptance.

[[Bugs/Action Code Redemption]] ? [[Bugs/Zero Action Chat]] ? [[Operations/Next Session]]
