---
type: bug
project: Arcane
tags: [arcane, actions, ui]
---
# Action meter labels

The loaded customer app showed 0 / 500 while its accessible breakdown reported 500 actions remaining. The compact number counted usage, so zero could be mistaken for no allowance. The top pill and sidebar now show remaining actions with the visible word left. The usage bar still measures consumption, and the accessible sentence, tooltip and Plans breakdown keep the exact used/limit and UTC reset date. Over-limit usage displays zero left; no allowance, credit, admission or reset calculation changes.

Strict compilation covers660 sources. The existing21-case Plans suite passes with no skips/cancellations and frozen source/compiled hashes, including real Edge top/sidebar rendering and the local action-code route. This is newer source than the installedf8 package. It is not installed customer acceptance.

[[Bugs/Action Code Redemption]] ? [[Bugs/Zero Action Chat]] ? [[Operations/Next Session]]

## Balance against normal plan allowance

The customer clarified that the visible form must be available actions / normal plan allowance. A free account with1000 available actions must display1000 /500; bonus grants must not enlarge the displayed denominator. This supersedes the earlier remaining-only word left presentation in f348ead.

The local ledger now publishes planLimit:500 separately from its existing spendable limit. Grants still increase the spendable allowance and admission uses that full limit; no actions are removed or made unusable by the display change. The frontend preserves the two values and displays the remaining spendable balance against planLimit in both the top pill and sidebar. The bar represents available balance, capped visually at the normal allowance, while visible numbers and accessible text retain the full bonus balance above it. Usage history, carryover, grant deduplication, UTC reset and API credits remain separate.

Strict660 compilation and33 frozen Plans/CSS cases pass, with no skips/cancellations. A synthetic1000 /500 case retains1500 total spendable allowance with500 already used. Real Edge also redeems a bonus grant, renders its full available balance against /500 in both meters, and preserves the cap, accessible maximum and actual ledger total. The existing lost-reply redemption test still preserves exactly-once grants; its expected balance now includes the earlier fixture grant. Exact CSS palette contracts normalize Git CRLF line endings before their unchanged assertions. The original30-pass/3-failure receipt is retained. This source update is not yet installed in the customer's app.
