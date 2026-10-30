---
name: arcane-interface
description: "Build a coherent responsive Roblox GUI that exposes the real game loop, binds to authoritative state and works across loading, interaction, error, touch and controller states."
license: MIT
---

# GUI that lets players complete the loop

## Define information and actions
Read the existing GUI and art direction. For a full game, inventory the screens the actual loop needs: entry/onboarding, readable HUD/objective, interaction/menu, feedback/results and relevant settings. Add inventory, shop or progression only when the design uses them. A focused button or layout fix stays focused.

For every view define its data owner, primary action, open/close route and states: loading, ready, empty, pending, accepted, denied and failure/recovery as applicable. A polished static panel with unwired buttons is not a complete interface. UI requests actions; the server validates eligibility and returns authoritative state. Do not optimistically grant rewards, currency or purchases.

## Build the tree and a style system
Use the actual scene.gui capability. Build static ScreenGui structure directly with scene_build under the granted StarterGui ref, or scene_create for a small addition; do not hide the static design in a construction script. Repeated buttons/cards/slots can use declared prototypes; runtime collections clone a built template. Use ui values in the current schema, not invented HTML/CSS or unsupported properties.

Choose project-specific palette roles, typography, spacing, corner/stroke treatment and motion. Preserve a coherent existing theme; a horror terminal, playful party game and historical RPG need not share a default dark dashboard. A practical starting spacing scale is 4/8/12/16/24, at most two font families, one clear primary action and restrained transitions. User/project-owned images or expressly authorized resources only; an unprovided icon can use a legible text label or constructed shape instead of an invented asset ID.

Use the tool's UDim2 [xScale,xOffset,yScale,yOffset] and UDim [scale,offset] forms. Use scale/anchors for placement and deliberate offsets for padding/minimum dimensions. Apply min/max and aspect constraints only where they preserve function; locking every text panel to one ratio can break translation. Use list/grid layouts and scrolling/virtualized or bounded lists as appropriate, not manually positioned hundreds of entries. Respect safe areas, core controls and phone orientation. Keep primary touch targets at least 44px in the target layout with separation, then check actual device scaling.

The declared [recipes](references/recipes.md) and [controller](references/controller.md) references provide concrete screen builds and controller patterns. Request only the needed reference through skills_get; preserve current capabilities and review boundaries when adapting it.

## Bind behavior and lifecycle
Keep behavior in a LocalScript/controller and shared presentation modules, using the supported create/update/read/enable review flow. A screen module should own its bindings and expose open/close/destroy or equivalent. Use bounded waits and handle respawn/replacement; ignore responses belonging to a closed or replaced view. Cancel tweens and disconnect handlers so repeated opens do not multiply activations.

Use one input-neutral activation path, deliberate controller focus and a clear back/cancel route. Represent disabled/pending states in both visuals and behavior. Add short hover/press/transition feedback where appropriate, and make reduced-motion settings effective. Colour alone cannot convey state; preserve meaningful labels, error reasons and readable numeric/progress feedback.

## Acceptance
Use actual supported human-approved playtest_request scenarios and playtest_status observations for click/GUI/text/layout assertions where available. An Edit viewport does not show a ScreenGui; a SurfaceGui mock-up can preview a component but cannot prove the PlayerGui works. Captures illustrate appearance and do not replace attested action/state checks; report unsupported capture evidence honestly.

Exercise the complete intended action, rejection, empty/loading/error state, back/close, repeated open and respawn. Inspect long names/translations, text scale, phone/controller navigation, safe-area overlap and focus restoration. Confirm one activation causes one accepted request and real state updates the HUD/results. Measure relevant layout bounds, target sizes, contrast and list cost. State what was played versus inspected or still a placeholder.
