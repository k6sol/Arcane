---
name: arcane-trading
description: "Design Roblox trading and gifting with explicit consent, ownership, durable recovery and no false multi-record atomicity claims."
license: MIT
---

# Transfers that preserve ownership through interruption

Use trading or gifting only when it serves the requested game and the project can support durable recovery. Define eligible item types, binding rules, currencies, fees and any current platform restrictions. A local swap animation is not a transaction. Do not ship a cosmetic success path while ownership can duplicate or disappear after reconnect.

## A versioned agreement

Specify participants and states: offered, revised, confirmed, committing, completed, cancelled and recovery-required as appropriate. Every offer has a version; changing an item, quantity or fee invalidates both prior confirmations. The server resolves actual item instances, owners and balances from current records. Clients provide intent, not trusted inventory snapshots or prices. Show both sides' exact items, quantities and consequences in a readable confirmation UI.

Reserve eligible items against simultaneous use, sale, deletion and another trade. Check participant identity/session, ownership, tradability, capacity, finite amounts and current consent before commit. Cancellation must release only this operation's reservations. A disconnect or expired invite cannot be treated as agreement. Gift acceptance/overflow policy must be explicit; do not silently discard a recipient's full-inventory delivery.

## Durable intent and reconciliation

A transfer spanning player records needs a durable transaction identity, immutable agreement and recoverable phases. Separate DataStore saves are not a multi-key atomic transaction. Decide which record is authoritative for intent, how each participant applies once, how replay is detected and how a crash resumes or compensates. Read actual current persistence capabilities before choosing the protocol; if safe transfer is unavailable, keep the feature disabled with a truthful reason.

Do not declare completion before the chosen durable criterion. Unknown persistence must retain the transaction/reservations for reconciliation rather than automatically retrying a new transfer. Recovery uses the same original identity and agreement, never an edited client's fresh offer. Keep necessary audit facts and distinguish pending reconciliation from terminal refusal. Coordinate with `arcane-inventory` and `arcane-datastore-safety`; session locks, item claims and trade ownership cannot be independent contradictory flags.

## Usable consent and feedback

Make participant identity, rarity/variant, bound status and any fee clear without relying on color alone. Reset the visual confirmation state immediately after an offer edit. Pending/failed/unknown outcomes need explicit wording and a read-status/help route; do not show a green success animation while awaiting commit. Sound and effects celebrate only the actual completed transfer. Prevent repeated prompts or pressure, and keep keyboard/controller/touch navigation safe from accidental confirmation.

## Acceptance

In isolated test profiles, interrupt at every durable phase and reopen the same transaction. Exercise edited offers after confirmation, concurrent trades/use, duplicate packets, invalid/NaN quantities, full inventory, disconnect and unavailable storage. Assert every original item has exactly one intended owner after recovery, no duplicate currency grant and no hidden loss. Check UI and actual inventories on both sides. A happy-path swap, single-player fixture or source review is not proof of crash-safe multiplayer trading; report the missing evidence and keep unsafe admission closed.
