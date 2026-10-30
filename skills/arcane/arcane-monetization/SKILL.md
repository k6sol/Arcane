---
name: arcane-monetization
description: "Implement requested Roblox products, passes and paid benefits with verified receipts, clear value and current platform-rule checks."
license: MIT
---

# Requested purchases with truthful value and grants

Identify the requested product/pass/subscription, actual creator/owner, intended benefit, duration and free-play experience. Monetization is not a default addition to another feature or a substitute for interesting content. Never invent catalog identifiers, prices, ownership or permissions. Verify current official commerce and policy requirements before implementing restricted or changing mechanics; this skill does not establish legal/platform approval.

## Match the entitlement lifecycle

Separate persistent passes/entitlements, repeatable developer-product grants and recurring benefits. Select the platform-supported server receipt/ownership path for that actual type. A purchase prompt closing or a client success callback is not proof of payment or entitlement. Paid random items require their own current policy/eligibility/odds review; ordinary cosmetic sales do not authorize them automatically.

Define grant identity, eligibility, quantity, duplicate prevention and durable commit before wiring a shop button. Repeat receipt delivery, delayed player arrival, disconnect and storage failure must recover through the same original transaction. Do not acknowledge a durable grant before it is actually committed. Coordinate with existing purchase dispatch so a new feature does not overwrite another ProcessReceipt handler. A comment saying 'record receipt first' is an unimplemented prerequisite, not idempotence.

Requested persistence needs session-safe profiles, bounded retries and explicit unknown outcomes (`arcane-datastore-safety`). A failed load must not create a default balance and consume a paid grant into it. Define rejoin/restore, entitlement expiry or revocation where supported, and what happens if a benefit's content is temporarily unavailable. Do not create a replacement purchase or silently replay consumption to recover an uncertain response.

## A shop that explains the actual game value

Show the exact benefit, price from real platform/catalog data, duration and unavailable/already-owned state before prompting. Distinguish cosmetic variants from gameplay advantages and recurring from permanent value. Keep decline and return-to-play easy. Avoid fake urgency, concealed recurring terms or pressure on inexperienced players. The free loop must remain coherent; do not intentionally break core controls or recovery to sell relief.

Connect the actual grant to inventory/world/progression and to UI. A purchased vehicle must be selectable and usable; an upgrade description must match server effects. Play celebration audio/VFX only for verified grants, and use actual authorized media. Pending/failed receipts retain truthful messaging and a support/status path rather than a false success toast. Respect device focus and readable layouts so purchase and cancel controls cannot be confused.

## Acceptance

Use explicit safe test-purchase scope and isolated profiles. Replay one receipt, interrupt before/after commit, reconnect an entitled player, fail a load, and request an unavailable product. Compare the durable receipt/entitlement, server-owned benefit, GUI and actual use. Keep test receipts separate from real commerce evidence. Evaluate how the benefit changes the free loop through representative play; do not promise revenue, retention, policy compliance or production purchase reliability from a fixture or a shop screenshot.
