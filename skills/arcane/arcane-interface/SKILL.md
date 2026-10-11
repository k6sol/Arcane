---
name: arcane-interface
description: "Create or improve Roblox HUDs, menus and world-space interfaces with consistent hierarchy, feedback and real in-engine usability."
license: MIT
---

# Game UI and interaction design

## Design for the actual use
Inspect the existing screens, visual tokens, device requirements and player decisions. Choose screen-space or physical/world-space interaction based on the game—not a universal preference for one. Preserve the user's style and mechanics.

Define hierarchy, navigation, empty/loading/error states and input focus before decoration. Use constraints, padding and typography with tested scale. Make critical state readable without colour alone; keep icons grounded in real equipped items or clear established meanings.

Separate UI rendering from authoritative inventory/economy state. A click requests an action and shows pending/accepted/denied feedback. Prevent stale responses from reopening closed screens or duplicating interactions.

## Verification
Capture actual in-engine views, test each button/state and inspect small screens, controller focus and touch targets where supported. Check text clipping, contrast, safe areas and transition interruption. A mockup is a design artifact, not implemented UI. Avoid replacing an existing coherent screen wholesale to fix one alignment bug.
