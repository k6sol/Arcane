# UI recipes (use with the arcane-interface tokens and components)

All sizes are Scale unless marked px. Each screen is one ModuleScript in ReplicatedStorage.UI with a `Root` Frame, mounted by the UIController LocalScript.

## Main menu
- ScreenGui `MainMenu`, IgnoreGuiInset true. Background: full-screen Frame bg colour (or a blurred camera shot behind a Black overlay at 0.45) plus a vertical UIGradient to 20% darker at the bottom.
- `Root`: left column at Position 0.08, 0.5, AnchorPoint 0, 0.5, Size 0.32 x 0.6, UISizeConstraint Max 460x520.
- Title label: display font, UITextSizeConstraint Max 72 Min 28, game name only.
- Buttons in a UIListLayout (Padding 12 px): `PlayButton` (primary, 1.2x height), `ShopButton`, `SettingsButton`, `CreditsButton`. No Quit button: players leave through the Roblox menu.
- Play: tween Root out (0.2 s), then hide the ScreenGui and enable gameplay HUD. Gamepad: SelectedObject = PlayButton.
- Test: click `PlayButton`, assert `MainMenu.Root` Visible false and `HUD.Root` Visible true.

## HUD with health and stamina
- ScreenGui `HUD`, `Root` full size with BackgroundTransparency 1.
- Bars group: bottom-left, Position 0.02, 0.96, AnchorPoint 0, 1, Size 0.24 x 0.075, UISizeConstraint Min 220x48, Max 360x72; UIListLayout vertical, Padding 6 px.
- `HealthBar`: pill track surface2 at Transparency 0.2; fill danger d93a40; chip bar f2f4f8 at Transparency 0.5; value label "85 / 100" right-aligned in BuilderSans Bold 16-18 px with Contextual stroke.
- `StaminaBar`: 60% of health bar height, fill 3ccf7a; hides (fade 0.3 s) after 2 s at full.
- Bind health to `Humanoid.HealthChanged`; rebind on `CharacterAdded`. Stamina is replicated from the server as a player attribute, never computed for authority on the client.
- Low health (< 25%): pulse fill brightness 0.6 s loop plus a heart icon; not colour alone.
- Currency top-right: accent icon + Bold number, bound to `leaderstats` value `.Changed`; animate +N delta text upward 0.6 s.

## Shop
- Centre panel 0.6 x 0.7, UIAspectRatioConstraint 1.5, UISizeConstraint Max 960x640. Header: title, balance (accent), close `X` button 44 px.
- Left: category tabs (UIListLayout vertical). Right: ScrollingFrame item grid, 3-4 columns.
- Item card (surface2, radius 10, padding 10): icon 1:1, name (TextTruncate), price row (accent icon + number), button Buy/Owned/Equip.
- Buy flow: button shows "..." and disables; `RemoteFunction` returns `{ ok, reason, balance }`; on deny show reason in a toast. Price comes from server definitions; the client sends only the item id.
- Robux products: `MarketplaceService:PromptProductPurchase`; grant only in server `ProcessReceipt` with idempotent receipts (`arcane-monetization`, `arcane-datastore-safety`).

## Inventory grid
- Panel like the shop. ScrollingFrame with UIGridLayout, 5 columns desktop, 4 on width under 600 px; CellPadding 8 px; cells recomputed from AbsoluteSize.
- Slot: surface2, radius 8, icon centred at 70%, stack count bottom-right (Bold 14 px), rarity as a 2 px UIStroke colour plus a rarity label in the tooltip.
- Selected slot: UIStroke 2 px accent + UIScale 1.05. Details pane shows name, description and Equip/Drop.
- Render from the server inventory snapshot; equip requests go through a validated remote (`arcane-inventory`).

## Notifications (toasts)
- ScreenGui `Notifications`, top-centre container Position 0.5, 0.04, AnchorPoint 0.5, 0, width 0.32, UISizeConstraint Max 480; UIListLayout vertical, Padding 8 px; AutomaticSize Y.
- Toast: surface, radius 10, 4 px left colour strip (success / danger / accent), icon + text (TextWrapped, AutomaticSize Y).
- In: slide 12 px down + fade 0.18 s. Stay 3 s (5 s for errors). Out: fade 0.15 s, then Destroy. Max 3 visible; queue the rest.
- One module API: `notify(kind, text)`; the server sends notifications through one RemoteEvent with fixed kinds.

## Loading screen
- Arcane roots exclude ReplicatedFirst, so build it in the UIController and show it first. For a true first-frame loader, tell the user to move that LocalScript into ReplicatedFirst.
- Full-bleed bg, centred logo or title, progress bar 0.3 x 0.012 (pill), tip text below in muted 18 px rotating every 4 s.
- Progress from `ContentProvider:PreloadAsync` over the UI icons and key assets (count done / total). Minimum display 1.5 s, maximum 15 s, then fade out 0.4 s and remove.

## Settings panel
- Centre panel 0.45 x 0.65, UISizeConstraint Max 640x600. Rows (height 48 px): label left, control right.
- Controls: toggle (pill 44x24 px, knob tween 0.12 s), slider (track + knob, 0-100 with step 5), segmented choice (UI size 0.85 / 1 / 1.15).
- Settings: Music volume, SFX volume, Reduced motion, Depth of field, UI size, Show damage numbers.
- Apply instantly on the client; persist through a validated remote that stores only a whitelisted, clamped settings table.
