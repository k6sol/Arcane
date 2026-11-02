---
type: bug
project: Arcane
tags: [arcane, actions, plans]
---
# Action code redemption

The customer changed the requirement: reusable code `test` adds1,000 Arcane actions, not API credits. Actions admit personal Codex/Claude subscription requests; API credits remain separate model API usage. Existing credit balances and historical credit grants are not rewritten.

The local Plans form now calls the human-token/same-origin action redemption route. The same actual action ledger used before model dispatch durably records each deliberate grant. The original request ID deduplicates a lost-reply retry, including after restart and ledger compaction. A new deliberate redemption can reuse the code. Extra amounts and wrong tokens/origins are rejected. Unused grant actions carry across monthly resets, while the local free allowance still resets to500 each UTC month. Ledger corruption refuses grants/admission. This remains workspace-local accounting, not a claim of hosted account-wide enforcement.

The hosted authenticated gateway now grants action-pack units and leaves credits unchanged. Its old credit redemption endpoint no longer grants this code. Hosted bridge replies explicitly identify the action unit. The current local form does not depend on a configured hosted credit service.

Strict660 compilation, all20 frozen Plans/ledger cases (including the real Edge form), three authenticated gateway grant cases, gateway type checking and the encrypted hosted-bridge case pass. The browser test commits a real local grant, loses the first reply, then retries the same ID and verifies no duplicate before deliberately redeeming again. Storage tests cover exhaustion recovery, restart, carryover and compaction. No customer app update or model request has been run for this source work.

Related requirement now in progress: messages must remain sendable at zero actions. Save the user message and produce an Arcane-local reply with plan reset and Plans/credits options, without allocating a model turn or spending API credits. This UX is not completed by the grant change above. The customer also wants the empty Saved playtest reports section removed from ordinary chat; retain meaningful access when reports exist.

[[Bugs/Subscription Action Admission]] ? [[Operations/Next Session]]
