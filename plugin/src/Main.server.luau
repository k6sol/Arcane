--!strict
-- Local plugin UI only. Secrets are transient input and transport memory.
local V = require(script.Validation)
local Transport = require(script.Transport)
local toolbar = plugin:CreateToolbar("Arcane")
local button = toolbar:CreateButton("ArcaneBridge", "Open Arcane", "", "Arcane")
button.ClickableWhenViewportHidden = true
local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 340, 280, 300)
local widget = plugin:CreateDockWidgetPluginGuiAsync("ArcaneLocalBridgeV1", info)
widget.Title = "Arcane"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

local colors = {
	body = Color3.fromRGB(35, 36, 39), header = Color3.fromRGB(27, 28, 31),
	input = Color3.fromRGB(28, 29, 32), divider = Color3.fromRGB(61, 63, 68),
	white = Color3.fromRGB(244, 245, 247), muted = Color3.fromRGB(158, 162, 170),
	orange = Color3.fromRGB(255, 133, 56), red = Color3.fromRGB(209, 61, 67),
	green = Color3.fromRGB(71, 203, 133), amber = Color3.fromRGB(225, 166, 68),
}
local panel = Instance.new("ScrollingFrame")
panel.Name = "ArcanePanel"
panel.Size = UDim2.fromScale(1, 1)
panel.BackgroundColor3 = colors.body
panel.BorderSizePixel = 0
panel.AutomaticCanvasSize = Enum.AutomaticSize.Y
panel.CanvasSize = UDim2.new()
panel.ScrollBarThickness = 3
panel.Parent = widget

local function frame(name: string, parent: Instance, position: UDim2, size: UDim2, color: Color3): Frame
	local item = Instance.new("Frame")
	item.Name, item.Position, item.Size = name, position, size
	item.BackgroundColor3 = color
	item.BorderSizePixel = 0
	item.Parent = parent
	return item
end
local function corner(parent: Instance, radius: number): ()
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
	item.Parent = parent
end
local function label(name: string, parent: Instance, text: string, position: UDim2, size: UDim2, textSize: number, color: Color3): TextLabel
	local item = Instance.new("TextLabel")
	item.Name, item.Position, item.Size = name, position, size
	item.BackgroundTransparency = 1
	item.Text, item.TextColor3 = text, color
	item.Font = Enum.Font.Gotham
	item.TextSize = textSize
	item.RichText = false
	item.TextXAlignment = Enum.TextXAlignment.Left
	item.TextYAlignment = Enum.TextYAlignment.Center
	item.Parent = parent
	return item
end

local header = frame("Header", panel, UDim2.new(), UDim2.new(1, 0, 0, 76), colors.header)
local mark = frame("ArcaneMark", header, UDim2.new(0, 19, 0, 22), UDim2.new(0, 29, 0, 30), colors.header)
mark.BackgroundTransparency = 1
local left = frame("WhiteStroke", mark, UDim2.new(0, 6, 0, 1), UDim2.new(0, 5, 0, 28), colors.white)
left.Rotation = 24
local right = frame("OrangeStroke", mark, UDim2.new(0, 18, 0, 1), UDim2.new(0, 5, 0, 28), colors.orange)
right.Rotation = -24
frame("Crossbar", mark, UDim2.new(0, 9, 0, 19), UDim2.new(0, 12, 0, 4), colors.white)
local brand = label("Brand", header, "Arcane", UDim2.new(0, 61, 0, 18), UDim2.new(1, -77, 0, 30), 23, colors.white)
brand.Font = Enum.Font.GothamBold
label("Subtitle", header, "STUDIO BRIDGE", UDim2.new(0, 62, 0, 46), UDim2.new(1, -78, 0, 16), 10, colors.muted)

local connectButton = Instance.new("TextButton")
connectButton.Name = "Connect"
connectButton.Position = UDim2.new(0, 16, 0, 95)
connectButton.Size = UDim2.new(1, -32, 0, 34)
connectButton.BackgroundColor3 = colors.red
connectButton.BorderSizePixel = 0
connectButton.Text, connectButton.TextColor3 = "Connect", colors.white
connectButton.Font = Enum.Font.GothamMedium
connectButton.TextSize = 14
connectButton.RichText = false
connectButton.Parent = panel
corner(connectButton, 6)

local dot = frame("ConnectionDot", panel, UDim2.new(0, 18, 0, 147), UDim2.new(0, 7, 0, 7), colors.muted)
corner(dot, 4)
local state = label("ConnectionStatus", panel, "Disconnected", UDim2.new(0, 33, 0, 138), UDim2.new(1, -49, 0, 24), 12, colors.muted)
frame("Divider", panel, UDim2.new(0, 16, 0, 172), UDim2.new(1, -32, 0, 1), colors.divider)
label("ApiKeyLabel", panel, "API Key", UDim2.new(0, 16, 0, 187), UDim2.new(1, -32, 0, 20), 13, colors.white)
local inputPanel = frame("KeyInput", panel, UDim2.new(0, 16, 0, 214), UDim2.new(1, -32, 0, 36), colors.input)
corner(inputPanel, 5)
local stroke = Instance.new("UIStroke")
stroke.Color, stroke.Thickness = colors.divider, 1
stroke.Parent = inputPanel

-- Roblox TextBox has no password mode. Hide native glyphs and overlay a fixed
-- mask; the raw input is cleared before queuing any connection exchange.
local keyInput = Instance.new("TextBox")
keyInput.Name = "ApiKey"
keyInput.Position = UDim2.new(0, 10, 0, 0)
keyInput.Size = UDim2.new(1, -20, 1, 0)
keyInput.BackgroundTransparency = 1
keyInput.Text = ""
keyInput.TextTransparency = 1
keyInput.MaxVisibleGraphemes = 0
keyInput.ClearTextOnFocus = false
keyInput.MultiLine = false
keyInput.RichText = false
keyInput.TextEditable = true
keyInput.TextSize = 13
keyInput.Font = Enum.Font.Code
keyInput.TextXAlignment = Enum.TextXAlignment.Left
keyInput.Parent = inputPanel
local mask = label("MaskedKey", inputPanel, "Enter your Arcane API key", UDim2.new(0, 10, 0, 0), UDim2.new(1, -20, 1, 0), 12, colors.muted)
mask.Active = false
mask.Selectable = false
mask.ZIndex = 2
local function refreshMask(): ()
	mask.Text = if keyInput.Text == "" then "Enter your Arcane API key" else "••••••••"
	mask.TextColor3 = if keyInput.Text == "" then colors.muted else colors.white
end
local function clearInput(): ()
	keyInput.Text = ""
	refreshMask()
end
local footer = frame("Footer", panel, UDim2.new(0, 16, 0, 260), UDim2.new(1, -32, 0, 0), colors.body)
footer.BackgroundTransparency = 1
footer.AutomaticSize = Enum.AutomaticSize.Y
local footerLayout = Instance.new("UIListLayout")
footerLayout.SortOrder = Enum.SortOrder.LayoutOrder
footerLayout.Padding = UDim.new(0, 8)
footerLayout.Parent = footer
local grants = label("Grants", footer, "", UDim2.new(), UDim2.new(1, 0, 0, 0), 11, colors.muted)
grants.LayoutOrder = 1
grants.AutomaticSize = Enum.AutomaticSize.Y
grants.TextWrapped = true
local details = label("Detail", footer, "Use a key issued in the Arcane workbench.", UDim2.new(), UDim2.new(1, 0, 0, 0), 12, colors.muted)
details.LayoutOrder = 2
details.AutomaticSize = Enum.AutomaticSize.Y
details.TextWrapped = true
details.TextYAlignment = Enum.TextYAlignment.Top

local hasSession, connecting = false, false
local transport = Transport.new(game, function(status: any)
	hasSession = status.sessionId ~= nil
	connecting = status.state == "connecting" or status.state == "pairing"
	local connected = hasSession and (status.state == "connected" or status.state == "executing")
	state.Text = if connected then "Connected" elseif connecting then "Connecting…"
		elseif status.state == "retrying" then "Connection unavailable" elseif status.state == "disconnecting" then "Disconnecting…"
		elseif status.state == "reconciliation" then "Review required" else "Disconnected"
	local color = if connected then colors.green elseif status.state == "retrying" or connecting then colors.amber else colors.muted
	state.TextColor3, dot.BackgroundColor3 = color, color
	connectButton.Text = if hasSession or connecting then "Disconnect" else "Connect"
	grants.Text = if hasSession then (if status.allowWrites then "Writes granted" else "Read only")
		.. " · " .. table.concat(status.allowedRoots, ", ") else ""
	details.Text = status.detail
	if status.state == "disconnected" then clearInput() end
end)
local connections: {RBXScriptConnection} = {}
table.insert(connections, button.Click:Connect(function() widget.Enabled = not widget.Enabled end))
table.insert(connections, widget:GetPropertyChangedSignal("Enabled"):Connect(function() button:SetActive(widget.Enabled) end))
table.insert(connections, keyInput:GetPropertyChangedSignal("Text"):Connect(refreshMask))
table.insert(connections, connectButton.Activated:Connect(function()
	local entered = keyInput.Text
	clearInput()
	if hasSession or connecting then transport:requestDisconnect()
	else
		local ok, err = pcall(function() transport:requestConnect(entered) end)
		if not ok then
			state.Text, state.TextColor3, dot.BackgroundColor3 = "Disconnected", colors.muted, colors.muted
			details.Text = V.safeError(err)
		end
	end
	entered = ""
end))
table.insert(connections, plugin.Unloading:Connect(function()
	clearInput()
	transport:stop()
	for _, connection in ipairs(connections) do connection:Disconnect() end
	widget:Destroy()
	toolbar:Destroy()
end))
transport:start()
