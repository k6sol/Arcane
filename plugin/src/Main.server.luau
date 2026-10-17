--!strict
-- Only the user's Arcane local key is remembered in Studio plugin settings.
-- Provider credentials and session bearers are never saved.
local V = require(script.Validation)
local Transport = require(script.Transport)
local Sha256 = require(script.Sha256)
local Diagnostics = require(script.Diagnostics)
-- Identity covers the actual loaded hierarchy, independent of XML serialization.
local ARTIFACT_MODULES = table.freeze({"Types", "Validation", "Registry", "Properties", "Operations", "Transport", "TestProof", "Sha256", "AssetMesh", "Sha256Stream", "AssetTransfer", "AssetMaterials", "AssetUpload", "Diagnostics", "AssetPlacement"})
local function loadedArtifactHash(): string?
	if typeof(script) ~= "Instance" or not script:IsA("Script") then return nil end
	local ok, value = pcall(function(): string
		if script.Name ~= "ArcaneLocalBridge" then error("Unexpected plugin root.", 0) end
		local children = script:GetChildren()
		if #children ~= #ARTIFACT_MODULES then error("Unexpected plugin hierarchy.", 0) end
		local modules: {[string]: any} = {}
		for _, child in ipairs(children) do
			if not child:IsA("ModuleScript") or modules[child.Name] ~= nil or #child:GetChildren() ~= 0 then error("Unexpected plugin module.", 0) end
			modules[child.Name] = child
		end
		local function digest(source: string): string
			if string.sub(source, 1, 3) == utf8.char(0xFEFF) then source = string.sub(source, 4) end
			source = string.gsub(string.gsub(source, "\r\n", "\n"), "\r", "\n")
			if string.sub(source, -1) ~= "\n" then source ..= "\n" end
			if #source > 199999 then error("Plugin source exceeds its bound.", 0) end
			return Sha256(source)
		end
		local identities = {"ArcaneLocalBridge\0" .. digest(script.Source)}
		for _, name in ipairs(ARTIFACT_MODULES) do
			local child = modules[name]
			if child == nil then error("Missing plugin module.", 0) end
			table.insert(identities, name .. "\0" .. digest(child.Source))
		end
		return Sha256("arcane-plugin-source-v1\n" .. table.concat(identities, "\n") .. "\n")
	end)
	return if ok then value else nil
end
local artifactHash = loadedArtifactHash()
local KEY_SETTING = "Arcane.LocalApiKey.v1"
local STATE_SETTING = "Arcane.LastConnection.v1"
local savedKey: string? = nil
local lastKnownConnected = false
-- Legacy connected=false records describe transient health, not user intent.
-- Only an explicit opt-out in this existing owned record suppresses startup.
local autoConnect = true
local storedOptOut = false
local storageFailed = false
local keyRead, previousKey = pcall(function() return plugin:GetSetting(KEY_SETTING) end)
if keyRead and type(previousKey) == "string" then
	local valid = pcall(function() V.keyOrigin(previousKey) end)
	if valid then savedKey = previousKey end
end
previousKey = nil
local stateRead, previousState = pcall(function() return plugin:GetSetting(STATE_SETTING) end)
if stateRead and type(previousState) == "table" and getmetatable(previousState) == nil then
	local count = 0
	for _ in pairs(previousState) do count += 1 end
	if (count == 1 or (count == 2 and type(previousState.autoConnect) == "boolean"))
		and type(previousState.connected) == "boolean" then
		lastKnownConnected = previousState.connected
		autoConnect = previousState.autoConnect ~= false
		storedOptOut = not autoConnect
	end
end
previousState = nil
local toolbar = plugin:CreateToolbar("Arcane")
local button = toolbar:CreateButton("ArcaneBridge", "Open Arcane", "", "Arcane")
button.ClickableWhenViewportHidden = true
-- A new stable widget identity migrates the old docked layout once. Studio
-- owns floating-window placement; opening the UI never connects a place.
local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, true, 260, 184, 230, 176)
local widget = plugin:CreateDockWidgetPluginGuiAsync("ArcaneLocalBridgeFloatingV3", info)
widget.Title = "Arcane"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

local colors = {
	body = Color3.fromRGB(20, 20, 22), header = Color3.fromRGB(20, 20, 22),
	input = Color3.fromRGB(27, 27, 30), divider = Color3.fromRGB(52, 52, 58),
	white = Color3.fromRGB(245, 245, 245), muted = Color3.fromRGB(147, 147, 154),
	red = Color3.fromRGB(255, 51, 64),
	green = Color3.fromRGB(71, 203, 133), amber = Color3.fromRGB(225, 166, 68),
}
local panel = Instance.new("Frame")
panel.Name = "ArcanePanel"
panel.Size = UDim2.fromScale(1, 1)
panel.BackgroundColor3 = colors.body
panel.BorderSizePixel = 0
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

-- Center the visible logo-to-button bounds (8..134) at every widget height.
-- All 152px of content, including bottom padding, fit the 176px minimum.
local content = frame("Content", panel, UDim2.new(0, 0, 0.5, -71), UDim2.new(1, 0, 0, 152), colors.body)
content.BackgroundTransparency = 1
local panelPadding = Instance.new("UIPadding")
panelPadding.PaddingBottom = UDim.new(0, 18)
panelPadding.Parent = content
local header = frame("Header", content, UDim2.new(), UDim2.new(1, 0, 0, 48), colors.header)
local mark = frame("ArcaneMark", header, UDim2.new(0, 14, 0, 8), UDim2.new(0, 32, 0, 32), colors.header)
mark.BackgroundTransparency = 1
-- Exact polygons from the desktop's 64x64 SVG, as bounded native scanlines.
-- No upload, remote logo, or white/orange substitute.
local function polygon(name: string, points: {{number}}, transparency: number): ()
	for row = 0, 63 do
		local scan, crossings = row + 0.5, {}
		for index, a in ipairs(points) do
			local b = points[index % #points + 1]
			if (a[2] <= scan and b[2] > scan) or (b[2] <= scan and a[2] > scan) then
				table.insert(crossings, a[1] + (scan - a[2]) * (b[1] - a[1]) / (b[2] - a[2]))
			end
		end
		table.sort(crossings)
		for index = 1, #crossings - 1, 2 do
			local left, right = crossings[index], crossings[index + 1]
			local strip = frame(name .. tostring(row), mark, UDim2.new(left / 64, 0, row / 64, 0), UDim2.new((right - left) / 64, 0, 1 / 64, 0), colors.red)
			strip.BackgroundTransparency = transparency
		end
	end
end
polygon("LogoLegs", {{32,4},{4,57},{17,57},{32,28},{47,57},{60,57}}, 0)
polygon("LogoCrossbar", {{27,40},{46,53},{40,40}}, 0)
polygon("LogoFacet", {{19,21},{26,26},{32,14},{27,6}}, 0.2)
local brand = label("Brand", header, "Arcane", UDim2.new(0, 57, 0, 10), UDim2.new(1, -73, 0, 28), 20, colors.white)
brand.Font = Enum.Font.GothamBold

local connectButton = Instance.new("TextButton")
connectButton.Name = "Connect"
connectButton.Position = UDim2.new(0, 14, 0, 100)
connectButton.Size = UDim2.new(1, -28, 0, 34)
connectButton.BackgroundColor3 = colors.red
connectButton.BorderSizePixel = 0
connectButton.Text, connectButton.TextColor3 = if savedKey then "Reconnect" else "Connect", colors.white
connectButton.Font = Enum.Font.GothamMedium
connectButton.TextSize = 14
connectButton.RichText = false
connectButton.Parent = content
corner(connectButton, 6)

local inputPanel = frame("KeyInput", content, UDim2.new(0, 14, 0, 54), UDim2.new(1, -28, 0, 36), colors.input)
corner(inputPanel, 5)
local stroke = Instance.new("UIStroke")
stroke.Color, stroke.Thickness = colors.divider, 1
stroke.Parent = inputPanel

-- Keep Studio's ordinary text editing and selection. The user's own saved
-- Arcane key remains visible here, including while connected.
local keyInput = Instance.new("TextBox")
keyInput.Name = "ApiKey"
keyInput.Position = UDim2.new()
keyInput.Size = UDim2.fromScale(1, 1)
keyInput.BackgroundTransparency = 1
keyInput.BorderSizePixel = 0
keyInput.ZIndex = 3
keyInput.Active = true
keyInput.Selectable = true
keyInput.Text = savedKey or ""
keyInput.TextColor3 = colors.white
keyInput.TextTransparency = 0
keyInput.MaxVisibleGraphemes = -1
keyInput.ClearTextOnFocus = false
keyInput.MultiLine = false
keyInput.RichText = false
keyInput.TextEditable = true
keyInput.TextSize = 13
keyInput.Font = Enum.Font.Gotham
keyInput.TextXAlignment = Enum.TextXAlignment.Left
keyInput.Parent = inputPanel
local inputPadding = Instance.new("UIPadding")
inputPadding.PaddingLeft, inputPadding.PaddingRight = UDim.new(0, 10), UDim.new(0, 10)
inputPadding.Parent = keyInput
keyInput.PlaceholderColor3 = colors.muted
local hint = "Arcane API key"
local keyFailed = false
local inputText = keyInput.Text
local function refreshHint(): ()
	keyInput.PlaceholderText = hint
end
local function clearInput(): ()
	inputText = "" -- Programmatic cleanup is not a new user edit.
	keyInput.Text = ""
	refreshHint()
end
refreshHint()
local function rememberState(connected: boolean, allowed: boolean?): ()
	if allowed ~= nil then autoConnect = allowed end
	-- Key edits/rejections already remove saved auth. Persist an opt-out only
	-- when a valid saved key remains (an explicit transport disconnect).
	local optOut = not autoConnect and savedKey ~= nil
	if lastKnownConnected == connected and storedOptOut == optOut then return end
	local record: any = {connected = connected}
	if optOut then record.autoConnect = false end
	local ok = pcall(function() plugin:SetSetting(STATE_SETTING, record) end)
	if ok then lastKnownConnected, storedOptOut = connected, optOut else storageFailed = true end
end
local function rejectKey(): ()
	-- A rejected key must not become a persistent reconnect trap. Clearing this
	-- owned setting never revokes a key at the daemon or touches provider logins.
	keyFailed, savedKey, hint = true, nil, "Enter a new API key"
	local ok = pcall(function() plugin:SetSetting(KEY_SETTING, "") end)
	if not ok then storageFailed = true end
	rememberState(false, false)
	connectButton.Text = "Failed"
	connectButton.BackgroundColor3, stroke.Color = colors.red, colors.red
	clearInput()
end
local transport: any
local function invalidateInput(): boolean
	if keyInput.Text == inputText then return false end
	inputText = keyInput.Text
	keyFailed, hint = false, "Arcane API key"
	if savedKey ~= nil then
		savedKey = nil
		local ok = pcall(function() plugin:SetSetting(KEY_SETTING, "") end)
		if not ok then storageFailed = true end
	end
	rememberState(false)
	-- Advance the transport generation on every edit, before another click.
	-- This forgets queued keys and fences yielding polls/editor callbacks.
	transport:requestDisconnect()
	refreshHint()
	return true
end
transport = Transport.new(game, function(status: any)
	-- Studio may defer the Text signal. Inspect the actual field before a late
	-- ACK/rejection or dispatch status can adopt the previous input's outcome.
	if invalidateInput() then return end
	if status.state == "failed" then rejectKey(); return end
	if status.state == "disconnecting" then rememberState(false, false)
	elseif status.state == "connecting" then rememberState(false, true) end
	local live = savedKey ~= nil and keyInput.Text == savedKey and status.sessionId ~= nil
		and (status.state == "connected" or status.state == "executing")
	-- Cached history never establishes a current session or green status.
	connectButton.BackgroundColor3 = if live and not keyFailed then colors.green else colors.red
	connectButton.Text = if keyFailed then "Failed" elseif live then "Connected" elseif savedKey then "Reconnect" else "Connect"
	if live then rememberState(true)
	else rememberState(false) end
	stroke.Color = if storageFailed then colors.amber elseif status.state == "retrying" or status.state == "reconciliation" then colors.red else colors.divider
end, artifactHash)
-- Check deferred text edits before every worker cycle and after every yielding
-- HTTP call, including status recovery that has not yet emitted a UI callback.
transport.checkInput = invalidateInput
-- Studio errors/warnings are kept only while this window is paired, and only
-- reported on the authenticated poll. Missing engine signals leave it inert.
local diagnostics = Diagnostics.new(game, function(): boolean return transport.pair ~= nil end)
local diagnosticsReady, diagnosticsStarted = pcall(function(): boolean return diagnostics:start() end)
if diagnosticsReady and diagnosticsStarted then transport.diagnostics = diagnostics end
-- A deferred Text signal must also be caught inside an already dispatched
-- editor callback. Keep the transport's original lifetime/lease checks intact.
local guard = transport.guard
transport.guard = function(client: any, command: any, pair: any): ()
	invalidateInput()
	guard(client, command, pair)
end
local connections: {RBXScriptConnection} = {}
table.insert(connections, button.Click:Connect(function() widget.Enabled = not widget.Enabled end))
table.insert(connections, widget:GetPropertyChangedSignal("Enabled"):Connect(function() button:SetActive(widget.Enabled) end))
button:SetActive(widget.Enabled)
table.insert(connections, keyInput:GetPropertyChangedSignal("Text"):Connect(function()
	invalidateInput()
end))
table.insert(connections, connectButton.Activated:Connect(function()
	invalidateInput()
	local entered = keyInput.Text -- Deleting the field never falls back to an old key.
	local valid = pcall(function() V.keyOrigin(entered) end)
	if not valid then
		rejectKey()
		-- Explicit failed input also fences any queued or live connection.
		transport:requestDisconnect()
		return
	end
	keyFailed, hint = false, "Arcane API key"
	local value = entered :: string
	local stored = pcall(function() plugin:SetSetting(KEY_SETTING, value) end)
	savedKey, storageFailed = value, not stored
	refreshHint()
	connectButton.Text, connectButton.BackgroundColor3 = "Reconnect", colors.red
	local ok = pcall(function() transport:requestConnect(value) end)
	if not ok then transport:requestDisconnect(); rememberState(false); stroke.Color = colors.red end
	entered, value = nil, ""
end))
table.insert(connections, plugin.Unloading:Connect(function()
	savedKey = nil
	clearInput()
	transport:stop()
	diagnostics:stop()
	for _, connection in ipairs(connections) do connection:Disconnect() end
	widget:Destroy()
	toolbar:Destroy()
end))
-- Queue safe recovery from any saved key unless the user explicitly opted out.
-- Cached health never proves a connection. Status precedes authentication; no
-- old session token, command, receipt or grant is restored in a new lifetime.
if savedKey ~= nil and autoConnect then
	local ok = pcall(function() transport:requestConnect(savedKey, true) end)
	if not ok then rememberState(false) end
end
transport:start()
