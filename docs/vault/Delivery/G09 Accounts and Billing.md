---
type: goal
project: Arcane
tags: [arcane]
---
# Finish secure accounts, administration and billing

Status: **Queued**. Priority and original scope: Finish secure accounts, administration and billing — P1 public-launch gate, queued.

Deliver: minimal email registration, supported Google/Apple login where configured, optional two-step verification, secure session handling, administration restricted to the configured owner account, and payment/entitlement flows backed by server-side authorization.

Done when: provider callbacks, email verification, MFA/recovery, admin isolation, checkout/webhook validation, duplicate events, cancellation and entitlement changes pass real sandbox checks. Secrets stay outside source and chat. Domain/provider/hosting configuration is an explicit dependency; no claim of impossible absolute security. This goal does not need to delay usable local development without commercial services.

Depends on: 1 and 8; external service configuration. Owner: identity/billing integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

No whole-goal completion evidence recorded yet. Add actual revision/run/artifact links and distinguish controlled tests from customer/native proof.

## Next action

Resolve listed dependencies, then reproduce the missing outcome before editing.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
