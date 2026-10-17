---
name: arcane-interface
description: "Build modern, responsive Roblox ScreenGui interfaces from a design system: tokens, UICorner/UIStroke/UIGradient components, scale layouts, typography, hover/press tweens, accessible contrast and clean LocalScript modules."
license: MIT
---

# Game UI design system

## Rules first
- Arcane cannot create GuiObjects directly. UI is built at runtime by code:
  - `ReplicatedStorage.UI`: ModuleScripts `Theme` (tokens), `Components` (factories), and one module per screen exporting `mount(playerGui) -> { open, close, destroy }`.
  - `StarterPlayer.StarterPlayerScripts.UIController`: the one LocalScript that requires and mounts screens.
  - Create them with `scene_create`, write source with `script_update`. The LocalScript starts disabled; after writing, `script_read` + `script_set_enabled`.
- Verify with `playtest_request` scenarios: `click-gui`, `assert-gui` (Visible), `assert-text`, `assert-gui-layout`. Give every testable object a stable name path: `PlayerGui.<Screen>.Root.<Name>`.
- UI never owns state. Buttons request actions through remotes; the server validates (`arcane-remote-security`). Show pending, accepted and denied states.
- Inspect any existing UI first and keep its style; these tokens are the default when none exists.
- Full screen recipes (main menu, HUD bars, shop, inventory grid, notifications, loading, settings): `skills_get` with ids ["arcane-interface"], references ["arcane-interface:recipes"], allowExperimental true ([recipes](references/recipes.md)).

## ScreenGui and layout
- ScreenGui: ResetOnSpawn false, ZIndexBehavior Sibling, IgnoreGuiInset true only for full-bleed backgrounds. Interactive content stays inside safe areas (ScreenInsets CoreUISafeInsets, the default).
- Containers: Scale sizes and positions with AnchorPoint (centre panel: AnchorPoint 0.5,0.5 at 0.5,0.5). Offset only for padding, stroke and corner radius.
- Every panel: UIAspectRatioConstraint for its shape + UISizeConstraint (e.g. Min 320x240, Max 760x560) so it neither overflows phones nor balloons on 4K.
- Layouts: UIListLayout (Padding 8-12 px, SortOrder LayoutOrder) for stacks; UIGridLayout for grids, with CellSize recomputed from the container's AbsoluteSize: `cell = floor((width - pad * (cols - 1)) / cols)`.
- ScrollingFrame: AutomaticCanvasSize Y, CanvasSize 0, ScrollBarThickness 6, ScrollingDirection Y.
- UIScale is for motion (press/pop) and a user "UI size" setting (0.85 / 1 / 1.15), not for layout.

## Tokens (dark default)
| Token | Value | Use |
|---|---|---|
| bg / overlay | 12151c, or Black at BackgroundTransparency 0.45 | screen dim |
| surface / surface2 | 1a1f2b / 242b3a | panels / cards |
| stroke | 2f3747 | UIStroke 1.5 px, Transparency 0.2 |
| text / muted / disabled | f2f4f8 / a9b1c2 / 8b93a5 | 15:1 / 7.6:1 / 5.3:1 on surface |
| primary | 2563eb, white text (5.2:1) | main action |
| accent | ffc845, text 1b1300 (11.9:1) | currency, rewards |
| danger / success | d93a40 white text / 3ccf7a text 0b1a10 | health, errors / confirm |
Radius: panel 12, button 10, pill UDim.new(0.5, 0). UIPadding: panel 16 px, card 10 px. One subtle UIGradient on panels (Rotation 90, surface to 10% darker).

## Typography
- Body: `Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Medium)`; numbers and timers Bold.
- Display (titles only), pick one by genre: Montserrat Bold (default), FredokaOne or LuckiestGuy (playful), Michroma or Oswald (sci-fi, military), Merriweather or GrenzeGotisch (fantasy), Creepster or SpecialElite (horror), PressStart2P (retro). Max two families.
- Sizes at 1080p: title 48-64, heading 32, body 20-24, caption 16; never below 14 px on a phone.
- TextScaled true only inside fixed-proportion labels, always with UITextSizeConstraint (title Max 64 Min 24, body Max 24 Min 14). Body text: TextWrapped; names: TextTruncate AtEnd.
- Text over the 3D world: UIStroke ApplyStrokeMode Contextual, Thickness 1.5-2, Black at Transparency 0.4.

## Components and motion
- Button: TextButton, AutoButtonColor false, height at least 44 px (UISizeConstraint MinSize 44,44), UICorner 10, child UIScale. Wire `Activated` (works for mouse, touch, gamepad).
  - Hover: background 8% lighter, UIScale 1.04, TweenInfo 0.12 s Quad Out.
  - Press: UIScale 0.96 in 0.08 s; release back in 0.12 s Back Out.
  - Disabled: BackgroundTransparency 0.5, text disabled colour, Active false.
  - Gamepad focus: UIStroke 2 px accent; set `GuiService.SelectedObject` to the first button when a menu opens.
- Panel open: UIScale 0.92 to 1 plus fade in 0.18 s Quart Out; close 0.12 s Quad In; never over 0.3 s. Fade with CanvasGroup GroupTransparency (at most 4 open at once). Respect a Reduced Motion setting by skipping scale tweens.
- Progress bar: pill track (surface2) + fill Frame with Size X Scale = ratio, tweened 0.2 s; a lighter "chip" bar follows after 0.4 s.
- Never convey state by colour alone: pair it with an icon or text. Contrast at least 4.5:1 for text and 3:1 for bars and icons. Full rules: `arcane-accessibility`.

## Code structure
- `Theme` returns frozen tables (`table.freeze`) of colours, fonts, radii and tween infos. `Components` exports `panel`, `button`, `label`, `bar` and `icon` factories taking a props table and returning the instance. Screens compose components and never hard-code colours.
- Each screen owns its connections in a cleanup list and disconnects them in `destroy` (pattern: `arcane-luau-architecture`).
- Screens listen to server state (attributes, leaderstats, remotes) and re-render. Ignore stale responses after a screen closes.
