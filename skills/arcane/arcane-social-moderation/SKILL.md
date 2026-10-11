---
name: arcane-social-moderation
description: "Build Roblox parties, social interactions and user-content features with platform filtering, permissions, privacy and abuse controls."
license: MIT
---

# Social systems and player safety

## Identify the interaction and risk
Distinguish invitations, friends/party state, chat, user-authored names/media and public sharing. Use current supported platform safety/filtering APIs and policy guidance; do not bypass filtering or assume one user's filtered result is safe for all recipients.

Define invitation expiry, blocks, private/public visibility and server-owned membership. Bound spam, forged identity and unauthorized changes. Sensitive actions need explicit eligibility; a client cannot impersonate the party owner.

Design report/feedback paths and clear failure states. Keep moderation evidence narrowly scoped and avoid storing unnecessary personal content. Do not add private messaging or public user-content uploads when the task only asks for a local emote.

## Verification
Exercise blocked/removed players, expired invites, duplicate accepts, disconnect and hostile content/payloads in safe fixtures. Confirm filtered presentation and role checks. Accessibility and useful social play matter; broad punitive heuristics are not a replacement for platform safeguards and meaningful counterplay.
