---
type: feature
project: Arcane
tags: [arcane, billing, verification]
---
# Subscription action admission

Production Codex and Claude subscription requests now require a durable action debit before model dispatch. Exhaustion returns a readable refusal; no new model turn starts. The original request identity deduplicates admission, including after ledger reload. Corrupt usage or an unavailable admission service refuses further work rather than granting an allowance. Accepted attempts retain their debit if later work fails; this change does not implement refunds.

API-credit requests use the separate gateway path and do not enter subscription admission. Production no longer counts completed turns or Studio changes a second time. Navigation, account access and credit redemption remain available. The current allowance is 500 per UTC month in the existing local workspace ledger, including historical usage. It is not an account-wide hosted entitlement and does not establish purchased plan support.

Strict compilation covers 660 product sources. The frozen focused selection passes 94 cases with no skips/cancellations, covering last-slot admission, reload/deduplication, corruption refusal, authenticated HTTP admission, Codex refusal before native turn dispatch, and Claude refusal before credentials/model startup. The complete desktop host, installer and shortcut selection passes 63 cases. Initial sandbox attempts could not spawn the test children; the authorized runs completed. A subsequent source edit only corrected ledger documentation.

The original Windows release failure in both the shortcut and credit commits used unavailable Get-FileHash in the child PowerShell environment. Shortcut hashing now uses .NET directly; native COM fixtures pass. The earlier diagnostics failure now awaits its actual report callback under a bounded test deadline, preserving cause/report checks. The credit commit's unit failure is different: an authorization fixture POST timed out. Its cause remains open; passing the focused quota checks does not resolve it.

Review also found Claude steering could write new guidance without admission. It now admits that message separately and rechecks the active turn after the asynchronous decision. Exhaustion leaves the original reply running without writing or recording the refused guidance. A fresh strict660 compilation and all47 Claude host cases pass with frozen inputs after this change.

These changes are not yet installed in the customer desktop. Actual customer exhaustion, API-credit inference and the complete packaged task loop remain unverified.

[[Bugs/API Credit Codes]] · [[Operations/Current State]] · [[Delivery/G09 Accounts and Billing]]
