# UI controller kit (motion, responsive grid, HUD build)

Static UI comes from `scene_build`; these modules only animate and bind it. Create each with `scene_create` (ModuleScript in `ReplicatedStorage.UI`, LocalScript in `StarterPlayer.StarterPlayerScripts`), `script_update`, then `script_read` + `script_set_enabled`.

## ReplicatedStorage.UI.Motion (ModuleScript)
```lua
--!strict
local TweenService = game:GetService("TweenService")
local Motion = { reduced = false } -- the Reduced Motion setting writes this
local HOVER = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local PRESS = TweenInfo.new(0.08, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local RELEASE = TweenInfo.new(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local OPEN = TweenInfo.new(0.18, Enum.EasingStyle.Quart, Enum.EasingDirection.Out)
local CLOSE = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

local function tween(target: Instance, info: TweenInfo, goal: { [string]: any }): Tween
	local t = TweenService:Create(target, info, goal)
	t:Play()
	return t
end
local function isPointer(input: InputObject): boolean
	return input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch
end

-- Hover, press and gamepad focus for a built button with a UIScale child (optional UIStroke "Focus", Enabled false).
function Motion.button(button: GuiButton): () -> ()
	local scale = button:FindFirstChildOfClass("UIScale")
	assert(scale, button:GetFullName() .. " needs a UIScale child in its build")
	local focus = button:FindFirstChild("Focus")
	local base = button.BackgroundColor3
	local lit = base:Lerp(Color3.new(1, 1, 1), 0.08)
	local hovered = false
	local connections = {
		button.MouseEnter:Connect(function()
			hovered = true
			tween(button, HOVER, { BackgroundColor3 = lit })
			if not Motion.reduced then tween(scale, HOVER, { Scale = 1.04 }) end
		end),
		button.MouseLeave:Connect(function()
			hovered = false
			tween(button, HOVER, { BackgroundColor3 = base })
			tween(scale, HOVER, { Scale = 1 })
		end),
		button.InputBegan:Connect(function(input)
			if isPointer(input) and button.Active then tween(scale, PRESS, { Scale = 0.96 }) end
		end),
		button.InputEnded:Connect(function(input)
			if isPointer(input) then tween(scale, RELEASE, { Scale = if hovered and not Motion.reduced then 1.04 else 1 }) end
		end),
		button.SelectionGained:Connect(function() if focus and focus:IsA("UIStroke") then focus.Enabled = true end end),
		button.SelectionLost:Connect(function() if focus and focus:IsA("UIStroke") then focus.Enabled = false end end),
	}
	return function() for _, c in connections do c:Disconnect() end end
end

-- Panels are CanvasGroups with a UIScale child: scale 0.92 -> 1 plus fade.
function Motion.open(panel: CanvasGroup)
	local scale = panel:FindFirstChildOfClass("UIScale")
	panel.Visible, panel.GroupTransparency = true, 1
	if scale and not Motion.reduced then scale.Scale = 0.92; tween(scale, OPEN, { Scale = 1 }) end
	tween(panel, OPEN, { GroupTransparency = 0 })
end
function Motion.close(panel: CanvasGroup)
	local scale = panel:FindFirstChildOfClass("UIScale")
	if scale and not Motion.reduced then tween(scale, CLOSE, { Scale = 0.92 }) end
	tween(panel, CLOSE, { GroupTransparency = 1 }).Completed:Once(function(state)
		if state == Enum.PlaybackState.Completed then panel.Visible = false end -- a reopen cancels this tween
	end)
end

-- Square cells that fill the container width; at most 4 columns under 600 px.
function Motion.fitGrid(grid: UIGridLayout, columns: number): () -> ()
	local container = grid.Parent :: GuiObject
	local function fit()
		local width = if container:IsA("ScrollingFrame") then container.AbsoluteWindowSize.X else container.AbsoluteSize.X
		local count = if width < 600 then math.min(4, columns) else columns
		local pad = grid.CellPadding.X.Offset
		local cell = math.max(44, math.floor((width - pad * (count - 1)) / count))
		grid.CellSize = UDim2.fromOffset(cell, cell)
	end
	fit()
	local c = container:GetPropertyChangedSignal("AbsoluteSize"):Connect(fit)
	return function() c:Disconnect() end
end

return Motion
```

## StarterPlayerScripts.UIController (LocalScript)
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage:WaitForChild("UI"):WaitForChild("Motion"))
local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local function wire(screen: Instance)
	for _, item in screen:GetDescendants() do
		if item:IsA("GuiButton") and item:FindFirstChildOfClass("UIScale") then Motion.button(item) end
	end
end
for _, name in { "MainMenu", "HUD", "Shop" } do
	task.spawn(function() wire(playerGui:WaitForChild(name)) end)
end
```
Screens use ResetOnSpawn false, so wiring once is enough. Screen modules (`bind(screenGui)`) add Activated handlers and data binding on top.

## HUD build (bottom-left bars, top-right currency)
```json
{"name": "HUD", "container": "ScreenGui", "screen": {"DisplayOrder": 0},
 "items": [
  {"key": "Bars", "name": "Bars", "className": "Frame", "ui": {"AnchorPoint": [0, 1], "Position": [0.02, 0, 0.96, 0], "Size": [0.24, 0, 0.075, 0], "BackgroundTransparency": 1}},
  {"in": "Bars", "name": "Bounds", "className": "UISizeConstraint", "ui": {"MinSize": [220, 48], "MaxSize": [360, 72]}},
  {"in": "Bars", "name": "List", "className": "UIListLayout", "ui": {"Padding": 6, "SortOrder": "LayoutOrder"}},
  {"in": "Bars", "key": "Health", "name": "HealthBar", "className": "Frame", "ui": {"Size": [1, 0, 0.6, -3], "BackgroundColor3": "#242b3a", "BackgroundTransparency": 0.2, "BorderSizePixel": 0, "LayoutOrder": 1}},
  {"in": "Health", "name": "Corner", "className": "UICorner", "ui": {"CornerRadius": [0.5, 0]}},
  {"in": "Health", "key": "HealthFill", "name": "Fill", "className": "Frame", "ui": {"Size": [1, 0, 1, 0], "BackgroundColor3": "#d93a40", "BorderSizePixel": 0}},
  {"in": "HealthFill", "name": "Corner", "className": "UICorner", "ui": {"CornerRadius": [0.5, 0]}},
  {"in": "Health", "key": "Value", "name": "Value", "className": "TextLabel", "ui": {"Size": [1, -12, 1, 0], "Position": [0, 6, 0, 0], "BackgroundTransparency": 1, "Text": "100 / 100",
    "TextXAlignment": "Right", "TextColor3": "#f2f4f8", "TextSize": 16, "FontFace": {"family": "BuilderSans", "weight": "Bold"}, "ZIndex": 2}},
  {"in": "Value", "name": "Outline", "className": "UIStroke", "ui": {"ApplyStrokeMode": "Contextual", "Thickness": 1.5, "Color": "#000000", "Transparency": 0.4}},
  {"in": "Bars", "key": "Stamina", "name": "StaminaBar", "className": "Frame", "ui": {"Size": [1, 0, 0.4, -3], "BackgroundColor3": "#242b3a", "BackgroundTransparency": 0.2, "BorderSizePixel": 0, "LayoutOrder": 2}},
  {"in": "Stamina", "name": "Corner", "className": "UICorner", "ui": {"CornerRadius": [0.5, 0]}},
  {"in": "Stamina", "key": "StaminaFill", "name": "Fill", "className": "Frame", "ui": {"Size": [1, 0, 1, 0], "BackgroundColor3": "#3ccf7a", "BorderSizePixel": 0}},
  {"in": "StaminaFill", "name": "Corner", "className": "UICorner", "ui": {"CornerRadius": [0.5, 0]}},
  {"key": "Coins", "name": "Coins", "className": "Frame", "ui": {"AnchorPoint": [1, 0], "Position": [0.98, 0, 0.03, 0], "Size": [0.14, 0, 0.06, 0], "BackgroundColor3": "#1a1f2b", "BackgroundTransparency": 0.15, "BorderSizePixel": 0}},
  {"in": "Coins", "name": "Bounds", "className": "UISizeConstraint", "ui": {"MinSize": [120, 44], "MaxSize": [220, 60]}},
  {"in": "Coins", "name": "Corner", "className": "UICorner", "ui": {"CornerRadius": [0.5, 0]}},
  {"in": "Coins", "name": "Stroke", "className": "UIStroke", "ui": {"Color": "#2f3747", "Thickness": 1.5, "Transparency": 0.2, "ApplyStrokeMode": "Border"}},
  {"in": "Coins", "name": "Amount", "className": "TextLabel", "ui": {"Size": [1, -24, 1, 0], "Position": [0, 12, 0, 0], "BackgroundTransparency": 1, "Text": "0",
    "TextXAlignment": "Right", "TextColor3": "#ffc845", "TextSize": 22, "FontFace": {"family": "BuilderSans", "weight": "Bold"}}}]}
```
Bind HealthBar.Fill Size X to `Humanoid.Health / MaxHealth` (rebind on CharacterAdded) and Coins.Amount to the leaderstats value; tween both 0.2 s. Add the shop and menu from the recipes reference with the same tokens.
