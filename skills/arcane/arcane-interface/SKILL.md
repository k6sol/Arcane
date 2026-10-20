---
name: arcane-interface
description: "Build modern, responsive Roblox ScreenGui interfaces from a design system: tokens, UICorner/UIStroke/UIGradient components, scale layouts, typography, hover/press tweens, accessible contrast and clean LocalScript modules."
license: MIT
---

# Game UI design system

## Rules first
- Build the GUI tree directly with `scene_build` (plugin capability `scene.gui`). Never write a script that constructs static UI.
  - Screen: `container: "ScreenGui"`, parent = the StarterGui root ref from `scene_children`, `screen` props. Items: a GUI className + `ui`, `in` = parent item key. One screen = one atomic build (one undo step, one receipt).
  - Repeated components (button, card, slot) are `prototypes` `{ui: [root, UICorner, UIStroke, ...]}` stamped by items with `use` + `ui` overrides (Text, LayoutOrder).
  - World UI: BillboardGui (part/Attachment) and SurfaceGui (part) items in a Model build.
  - Values: UDim2 `[xScale,xOffset,yScale,yOffset]`, UDim `[scale,offset]` or px, FontFace a built-in family. One-line Text; wrap with TextWrapped. Image only a user-given or found `rbxassetid://`; no icon id: use a glyph label or a UICorner shape.
- Behaviour only in code: LocalScript `StarterPlayer.StarterPlayerScripts.UIController` + ModuleScripts in `ReplicatedStorage.UI` (`scene_create`, `script_update`, then `script_read` + `script_set_enabled`). It finds the tree (`PlayerGui:WaitForChild("<Screen>")`), wires events, tweens, data. Runtime lists clone a hidden built template (Visible false).
- Verify: `studio_viewport_capture` cannot show a ScreenGui in Edit mode. Use `playtest_request` `click-gui`, `assert-gui` (Visible), `assert-text`, `assert-gui-layout`; for a look, stamp a component on a temporary SurfaceGui part facing the camera, capture, `receipt_restore`. Paths: `PlayerGui.<Screen>.Root.<Name>`.
- UI never owns state: buttons request via remotes, the server validates (`arcane-remote-security`); show pending, accepted, denied.
- Keep an existing UI's style; these tokens are the default. Screen recipes and shop card: `skills_get` ids ["arcane-interface"], references ["arcane-interface:recipes"], allowExperimental true ([recipes](references/recipes.md)); tween Motion module, UIController and a HUD build: `arcane-interface:controller` ([controller](references/controller.md)).

## Layout: phone to 4K
- ScreenGui: ResetOnSpawn false, ZIndexBehavior Sibling, ScreenInsets CoreUISafeInsets (default: clear of notch and Roblox top bar). Full-bleed art goes in its own ScreenGui with IgnoreGuiInset true + ScreenInsets None; buttons never.
- DisplayOrder: HUD 0, menus 10, modals 20, toasts 30, loading 100.
- Size and Position in Scale, AnchorPoint matching the edge (centre 0.5,0.5; bottom-left 0,1). Offset only for padding, stroke, radius, gaps.
- Every panel: UIAspectRatioConstraint for its shape + UISizeConstraint (e.g. Min 320x240, Max 760x560). Edge margins 2-3% of the screen.
- Touch: keep HUD out of the top-left (Roblox menu) and bottom-right (jump button); thumb actions bottom-centre or right-middle.
- Stacks: UIListLayout (Padding 8-12 px, SortOrder LayoutOrder). Toolbars: FillDirection Horizontal, HorizontalFlex SpaceBetween, UIFlexItem FlexMode Fill on the item that stretches. Chip rows: Wraps true.
- Grids: UIGridLayout, CellSize recomputed from AbsoluteSize `cell = floor((width - pad * (cols - 1)) / cols)`; 4 columns under 600 px wide.
- ScrollingFrame: AutomaticCanvasSize Y, CanvasSize 0, ScrollBarThickness 6, ScrollingDirection Y.
- UIScale is for motion and a "UI size" setting (0.85 / 1 / 1.15), not layout.

## Tokens (dark default)
| Token | Value | Use |
|---|---|---|
| overlay | Black, BackgroundTransparency 0.45 | modal dim |
| surface / surface2 | 1a1f2b / 242b3a | panels / cards |
| stroke | 2f3747 | UIStroke 1.5 px, Transparency 0.2 |
| text / muted / disabled | f2f4f8 / a9b1c2 / 8b93a5 | 15:1 / 7.6:1 / 5.3:1 on surface |
| primary | 2563eb, white text (5.2:1) | main action |
| accent | ffc845, text 1b1300 (11.9:1) | currency, rewards |
| danger / success | d93a40 white text / 3ccf7a text 0b1a10 | health, errors / confirm |
Spacing 4/8/12/16/24 px only. Radius: panel 12, button 10, pill UDim 0.5,0. UIPadding: panel 16, card 10. BorderSizePixel 0. One UIGradient per panel (Rotation 90, ffffff to c8c8c8: it multiplies). Shadow: a Black Frame behind, offset 0,4 px, Transparency 0.6, same corner.

## Typography
- Body: BuilderSans Medium (`FontFace: {family: "BuilderSans", weight: "Medium"}`); numbers, timers, buttons Bold.
- Display (titles only), one per game: Montserrat Bold (default), FredokaOne or LuckiestGuy (playful), Michroma or Oswald (sci-fi, military), Merriweather or GrenzeGotisch (fantasy), Creepster or SpecialElite (horror), PressStart2P (retro). Max two families; no legacy SourceSans.
- Sizes at 1080p: title 48-64, heading 32, body 20-24, caption 16; never below 14 px on a phone.
- TextScaled only in fixed-proportion labels, always with UITextSizeConstraint (title Max 64 Min 24, body Max 24 Min 14). Body: TextWrapped; names: TextTruncate AtEnd.
- Text over the 3D world: UIStroke ApplyStrokeMode Contextual, Thickness 1.5-2, Black, Transparency 0.4.

## Components and motion
- Button: TextButton, AutoButtonColor false, at least 44 px tall (UISizeConstraint MinSize 44,44), UICorner 10, child UIScale. Wire `Activated` (mouse, touch, gamepad).
  - Hover: background 8% lighter, UIScale 1.04, 0.12 s Quad Out. Press: 0.96 in 0.08 s; release 0.12 s Back Out.
  - Disabled: BackgroundTransparency 0.5, disabled text, Active false. Gamepad focus: UIStroke 2 px accent; `GuiService.SelectedObject` = first button on open.
- Panel open: UIScale 0.92 to 1 + fade 0.18 s Quart Out; close 0.12 s Quad In; never over 0.3 s. Fade via CanvasGroup GroupTransparency (at most 4 open). Reduced Motion skips scale tweens.
- Progress bar: pill track (surface2) + fill with Size X Scale = ratio, tweened 0.2 s; a lighter chip bar follows after 0.4 s.
- State never by colour alone: add icon or text. Contrast 4.5:1 for text, 3:1 for bars and icons (`arcane-accessibility`).

## Code structure
- Static look lives in the build. `Theme` returns frozen tables (`table.freeze`) of state colours and TweenInfos. Each screen module exports `bind(screenGui) -> { open, close, destroy }`, looks elements up by name, owns a cleanup list (`arcane-luau-architecture`), re-renders from server state and ignores stale responses after close.

## First-try check
No default grey Frames or borders; every text has FontFace; nothing touches a screen edge; buttons 44 px+; one primary action per screen; one radius and spacing scale; `assert-gui-layout` on every primary control (inside the safe area, at least 44x44); suggest a phone check in the Studio Device Emulator.
