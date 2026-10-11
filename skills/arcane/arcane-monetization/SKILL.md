---
name: arcane-monetization
description: "Implement requested Roblox products, passes and paid benefits with verified receipts, clear value and current platform-rule checks."
license: MIT
---

# Purchases and monetization quality

## Keep monetization intentional
Identify the requested product, owner, intended entitlement and free-play experience. Use current official commerce guidance and actual catalog identifiers; never invent IDs or prices. Explain benefit, duration and purchase terms clearly. Do not add a store to unrelated feature work.

Distinguish passes/subscriptions from repeatable products and the different grant lifecycles. Process purchases server-side through the supported receipt path. Durable receipt/grant handling must survive repeat delivery and disconnect. A client success animation is presentation, not proof of entitlement.

Review restore/rejoin behavior, failed/pending purchases, refunded/revoked entitlements where supported and creator permissions. Check current requirements for paid random items or other restricted mechanics before implementing them; do not assume ordinary cosmetic sales authorize all forms of loot boxes.

## Verification
Use test purchases/fixtures under explicit safe scope. Repeat one receipt, interrupt a grant and reload an entitled player. Verify no duplicate reward and no falsely successful UI. Measure monetization impact on the core loop rather than optimizing pressure or claiming earnings.
