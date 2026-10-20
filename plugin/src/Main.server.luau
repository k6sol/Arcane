--!strict
-- Only the user's Arcane local key is remembered in Studio plugin settings.
-- Provider credentials and session bearers are never saved.
local V = require(script.Validation)
local Transport = require(script.Transport)
local Sha256 = require(script.Sha256)
local Diagnostics = require(script.Diagnostics)
-- Identity covers the actual loaded hierarchy, independent of XML serialization.
local ARTIFACT_MODULES = table.freeze({"Types", "Validation", "Registry", "Properties", "Operations", "Transport", "TestProof", "Sha256", "AssetMesh", "Sha256Stream", "AssetTransfer", "AssetMaterials", "AssetUpload", "Diagnostics", "AssetPlacement", "TerrainGen"})
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
-- Periods in Plugin setting keys can corrupt its JSON store. Read old names only to migrate.
local KEY_SETTING = "Arcane_LocalApiKey_v2"
local STATE_SETTING = "Arcane_LastConnection_v2"
local LEGACY_KEY_SETTING = "Arcane.LocalApiKey.v1"
local LEGACY_STATE_SETTING = "Arcane.LastConnection.v1"
local SETTING_ATTEMPTS = 3
local savedKey: string? = nil
local lastKnownConnected = false
-- Legacy connected=false records describe transient health, not user intent.
-- Only an explicit opt-out in this existing owned record suppresses startup.
local autoConnect = true
local storedOptOut = false
local storageFailed = false
local settingsRevision, settingsRetired = 0, false
local startupPending = true
local pendingWrites: {[string]: any} = {}
local storageProblems: {[string]: boolean} = {}
local stateNeedsWrite = false
local function validState(value: any): boolean
	if type(value) ~= "table" or getmetatable(value) ~= nil then return false end
	local count = 0
	for _ in pairs(value) do count += 1 end
	return (count == 1 or (count == 2 and type(value.autoConnect) == "boolean")) and type(value.connected) == "boolean"
end
local function validSetting(name: string, value: any): boolean
	if name == KEY_SETTING then return type(value) == "string" and (value == "" or pcall(function() V.keyOrigin(value) end)) end
	return name == STATE_SETTING and validState(value)
end
local function readOwnedSetting(name: string): (boolean, any)
	assert(name == KEY_SETTING or name == STATE_SETTING or name == LEGACY_KEY_SETTING or name == LEGACY_STATE_SETTING, "Unexpected Arcane setting.")
	return pcall(function() return plugin:GetSetting(name) end)
end
local function writeOwnedSetting(name: string, value: any): boolean
	assert((name == KEY_SETTING or name == STATE_SETTING) and validSetting(name, value), "Unexpected Arcane setting write.")
	local ok = pcall(function() plugin:SetSetting(name, value) end)
	if not ok then return false end
	local read, actual = readOwnedSetting(name)
	return read and V.equal(actual, value)
end
local function storageProblem(name: string, failed: boolean): ()
	storageProblems[name] = if failed then true else nil
	storageFailed = next(storageProblems) ~= nil
end
local function attemptWrite(name: string, job: any): ()
	if settingsRetired or job.revision ~= settingsRevision or pendingWrites[name] ~= job then return end
	job.attempts += 1
	local stored = writeOwnedSetting(name, job.value)
	storageProblem(name, not stored)
	if stored or job.attempts >= SETTING_ATTEMPTS then pendingWrites[name] = nil; job.value = nil end
end
local function persistSetting(name: string, value: any): ()
	if settingsRetired then return end
	local previous = pendingWrites[name]
	if previous and previous.revision == settingsRevision and V.equal(previous.value, value) then return end
	local job = {value = value, attempts = 0, revision = settingsRevision}
	pendingWrites[name] = job
	attemptWrite(name, job) -- No yields; only a failed round trip is retried by the existing worker.
end
local keyRead: any = {name = KEY_SETTING, legacy = LEGACY_KEY_SETTING, attempts = 0, done = false}
local stateRead: any = {name = STATE_SETTING, legacy = LEGACY_STATE_SETTING, attempts = 0, done = false}
local function observeSetting(job: any): ()
	if job.done then return end
	job.attempts += 1
	local ok, value = readOwnedSetting(job.name)
	if ok and value ~= nil then
		-- An empty key is an authoritative deletion tombstone. Malformed canonical data
		-- also blocks fallback; an older credential must never replace either one.
		job.done, job.failed = true, not validSetting(job.name, value)
		if not job.failed then job.value = value end
	else
		local legacyOk, legacy = readOwnedSetting(job.legacy)
		if legacyOk and validSetting(job.name, legacy) then job.legacyValue = legacy end
		if job.attempts >= SETTING_ATTEMPTS then
			job.done, job.failed = true, not ok or not legacyOk
			if not job.failed then job.value, job.migrate = job.legacyValue, job.legacyValue ~= nil end
		end
	end
	if job.done then storageProblem(job.name, job.failed == true); job.legacyValue = nil end
end
local function adoptSettings(): ()
	assert(keyRead.done and stateRead.done, "Saved key and connection preference resolve together.")
	startupPending = false
	savedKey = if not keyRead.failed and type(keyRead.value) == "string" and keyRead.value ~= "" then keyRead.value else nil
	local previousState = stateRead.value
	autoConnect = not stateRead.failed
	if validState(previousState) then
		lastKnownConnected, autoConnect = previousState.connected, previousState.autoConnect ~= false
	end
	storedOptOut = not autoConnect
end
local function retireSettings(): ()
	settingsRevision += 1
	startupPending = false
	if pendingWrites[STATE_SETTING] or storageProblems[STATE_SETTING] then stateNeedsWrite = true end
	for _, job in pairs(pendingWrites) do job.value = nil end
	pendingWrites = {}
	keyRead.value, keyRead.legacyValue, stateRead.value, stateRead.legacyValue = nil, nil, nil, nil
end
observeSetting(keyRead)
observeSetting(stateRead)
if keyRead.done and stateRead.done then adoptSettings() end
local toolbar = plugin:CreateToolbar("Arcane")
local button = toolbar:CreateButton("ArcaneBridge", "Open Arcane", "", "Arcane")
button.ClickableWhenViewportHidden = true
-- A new stable widget identity migrates the old compact layout once. Studio
-- owns floating-window placement; opening the UI never connects a place.
local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, true, 300, 380, 264, 352)
local widget = plugin:CreateDockWidgetPluginGuiAsync("ArcaneLocalBridgeFloatingV4", info)
widget.Title = "Arcane"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

-- Arcane desktop brand: black glass, white text, Arcane red accents. The glass
-- card keeps these colours in both Studio themes; only the surround follows Studio.
local colors = {
	body = Color3.fromRGB(10, 10, 12), glass = Color3.fromRGB(26, 26, 31),
	input = Color3.fromRGB(16, 16, 19), divider = Color3.fromRGB(58, 58, 66),
	white = Color3.fromRGB(245, 245, 245), muted = Color3.fromRGB(166, 166, 174),
	red = Color3.fromRGB(255, 51, 64), idle = Color3.fromRGB(112, 112, 120),
	green = Color3.fromRGB(71, 203, 133), amber = Color3.fromRGB(225, 166, 68),
}
local DOT = " " .. utf8.char(0x00B7) .. " "
local connections: {RBXScriptConnection} = {}
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
local function outline(parent: Instance, color: Color3, transparency: number): UIStroke
	local item = Instance.new("UIStroke")
	item.Color, item.Thickness, item.Transparency = color, 1, transparency
	item.Parent = parent
	return item
end
local function gradient(parent: Instance, first: Color3, last: Color3, rotation: number): UIGradient
	local item = Instance.new("UIGradient")
	item.Color = ColorSequence.new({ColorSequenceKeypoint.new(0, first), ColorSequenceKeypoint.new(1, last)})
	item.Rotation = rotation
	item.Parent = parent
	return item
end
local function padding(parent: Instance, top: number, right: number, bottom: number, left: number): UIPadding
	local item = Instance.new("UIPadding")
	item.PaddingTop, item.PaddingRight = UDim.new(0, top), UDim.new(0, right)
	item.PaddingBottom, item.PaddingLeft = UDim.new(0, bottom), UDim.new(0, left)
	item.Parent = parent
	return item
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
	item.TextTruncate = Enum.TextTruncate.AtEnd
	item.Parent = parent
	return item
end
local function section(name: string, parent: Instance, height: number, order: number): Frame
	local item = frame(name, parent, UDim2.new(), UDim2.new(1, 0, 0, height), colors.body)
	item.BackgroundTransparency = 1
	item.LayoutOrder = order
	return item
end

-- Black glass card: a soft vertical sheen over near-black, a hairline edge and a red top accent.
local glass = frame("Glass", panel, UDim2.new(0, 8, 0, 8), UDim2.new(1, -16, 1, -16), Color3.fromRGB(255, 255, 255))
corner(glass, 12)
gradient(glass, colors.glass, colors.body, 90)
outline(glass, colors.white, 0.88)
local accent = frame("Accent", glass, UDim2.new(0, 18, 0, 0), UDim2.new(1, -36, 0, 2), Color3.fromRGB(255, 255, 255))
gradient(accent, Color3.fromRGB(224, 27, 44), Color3.fromRGB(255, 51, 64), 0)
local accentFade = Instance.new("UIGradient")
accentFade.Transparency = NumberSequence.new({NumberSequenceKeypoint.new(0, 1), NumberSequenceKeypoint.new(0.5, 0), NumberSequenceKeypoint.new(1, 1)})
accentFade.Parent = accent
accent.ZIndex = 2

local content = frame("Content", glass, UDim2.new(), UDim2.fromScale(1, 1), colors.body)
content.BackgroundTransparency = 1
local panelPadding = padding(content, 16, 16, 18, 16)
local layout = Instance.new("UIListLayout")
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Padding = UDim.new(0, 10)
layout.Parent = content

local header = section("Header", content, 32, 1)
local mark = frame("ArcaneMark", header, UDim2.new(0, 0, 0, 2), UDim2.new(0, 28, 0, 28), colors.body)
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
local brand = label("Brand", header, "Arcane", UDim2.new(0, 38, 0, 2), UDim2.new(1, -110, 0, 28), 19, colors.white)
brand.Font = Enum.Font.GothamBold
local version = label("Version", header, "Studio" .. DOT .. "v" .. V.VERSION, UDim2.new(1, -96, 0, 2), UDim2.new(0, 96, 0, 28), 12, colors.muted)
version.TextXAlignment = Enum.TextXAlignment.Right

-- Status: one glass tile with a coloured dot, a short state title and one plain sentence.
local statusCard = section("StatusCard", content, 64, 2)
statusCard.BackgroundColor3, statusCard.BackgroundTransparency = colors.white, 0.95
corner(statusCard, 10)
outline(statusCard, colors.white, 0.9)
local statusDot = frame("StatusDot", statusCard, UDim2.new(0, 14, 0, 16), UDim2.new(0, 10, 0, 10), colors.idle)
local dotCorner = Instance.new("UICorner")
dotCorner.CornerRadius = UDim.new(1, 0)
dotCorner.Parent = statusDot
local statusTitle = label("StatusTitle", statusCard, "Not connected", UDim2.new(0, 34, 0, 10), UDim2.new(1, -46, 0, 20), 14, colors.white)
statusTitle.Font = Enum.Font.GothamBold
local statusText = label("StatusText", statusCard, "", UDim2.new(0, 34, 0, 31), UDim2.new(1, -46, 0, 28), 12, colors.muted)
statusText.TextWrapped = true
statusText.TextYAlignment = Enum.TextYAlignment.Top

-- Entry: the 6-digit code shown in Arcane. Pasting a local key is the Advanced fallback.
local entry = section("Entry", content, 62, 3)
local fieldLabel = label("FieldLabel", entry, "Code shown in Arcane", UDim2.new(), UDim2.new(1, 0, 0, 16), 12, colors.muted)
fieldLabel.Font = Enum.Font.GothamMedium
local inputPanel = frame("KeyInput", entry, UDim2.new(0, 0, 0, 22), UDim2.new(1, 0, 0, 40), colors.input)
corner(inputPanel, 8)
local stroke = outline(inputPanel, colors.divider, 0)
local savedRow = section("SavedKey", content, 40, 4)
savedRow.BackgroundColor3, savedRow.BackgroundTransparency = colors.input, 0
corner(savedRow, 8)
outline(savedRow, colors.divider, 0)
local savedLabel = label("SavedKeyLabel", savedRow, "", UDim2.new(0, 12, 0, 0), UDim2.new(1, -96, 1, 0), 13, colors.white)
local replaceButton = Instance.new("TextButton")
replaceButton.Name = "ReplaceKey"
replaceButton.Position, replaceButton.Size = UDim2.new(1, -80, 0, 6), UDim2.new(0, 72, 0, 28)
replaceButton.BackgroundColor3, replaceButton.BackgroundTransparency = colors.white, 0.92
replaceButton.BorderSizePixel = 0
replaceButton.Text, replaceButton.TextColor3 = "Replace", colors.white
replaceButton.Font = Enum.Font.GothamMedium
replaceButton.TextSize = 12
replaceButton.RichText = false
replaceButton.Parent = savedRow
corner(replaceButton, 6)

local connectButton = Instance.new("TextButton")
connectButton.Name = "Connect"
connectButton.LayoutOrder = 5
connectButton.Size = UDim2.new(1, 0, 0, 40)
connectButton.BackgroundColor3 = colors.red
connectButton.BorderSizePixel = 0
connectButton.Text, connectButton.TextColor3 = if savedKey then "Reconnect" else "Connect", colors.white
connectButton.Font = Enum.Font.GothamBold
connectButton.TextSize = 14
connectButton.RichText = false
connectButton.Parent = content
corner(connectButton, 8)
-- UIGradient multiplies the red base: exactly #e01b2c at the top to #c8102e at the bottom.
local buttonGradient = gradient(connectButton, Color3.new(224 / 255, 27 / 51, 44 / 64), Color3.new(200 / 255, 16 / 51, 46 / 64), 90)

local advancedButton = Instance.new("TextButton")
advancedButton.Name = "Advanced"
advancedButton.LayoutOrder = 6
advancedButton.Size = UDim2.new(1, 0, 0, 18)
advancedButton.BackgroundTransparency = 1
advancedButton.BorderSizePixel = 0
advancedButton.Text, advancedButton.TextColor3 = "Advanced: use a local key", colors.muted
advancedButton.Font = Enum.Font.GothamMedium
advancedButton.TextSize = 12
advancedButton.RichText = false
advancedButton.TextXAlignment = Enum.TextXAlignment.Left
advancedButton.Parent = content

local meta = section("Meta", content, 36, 7)
local activityLabel = label("Activity", meta, "No builds yet", UDim2.new(), UDim2.new(1, 0, 0, 16), 12, colors.muted)
local diagnosticsLabel = label("DiagnosticsCount", meta, "Output: idle", UDim2.new(0, 0, 0, 20), UDim2.new(1, 0, 0, 16), 12, colors.muted)

-- Follow the Studio theme only around the card; the brand card stays readable in Light and Dark.
local function applyTheme(): ()
	local ok, color = pcall(function(): any
		return settings().Studio.Theme:GetColor(Enum.StudioStyleGuideColor.MainBackground)
	end)
	panel.BackgroundColor3 = if ok and typeof(color) == "Color3" then color else colors.body
end
applyTheme()
pcall(function()
	table.insert(connections, settings().Studio.ThemeChanged:Connect(applyTheme))
end)

-- Keep Studio's ordinary text editing and selection. A saved Arcane key is never
-- rendered in full: while the field holds it, the field is hidden behind a short
-- masked summary and Replace is the only way to change it.
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
keyInput.TextSize = 15
keyInput.Font = Enum.Font.GothamMedium
keyInput.TextXAlignment = Enum.TextXAlignment.Left
keyInput.Parent = inputPanel
local inputPadding = Instance.new("UIPadding")
inputPadding.PaddingLeft, inputPadding.PaddingRight = UDim.new(0, 12), UDim.new(0, 12)
inputPadding.Parent = keyInput
keyInput.PlaceholderColor3 = colors.muted
local DEFAULT_HINT = "6-digit code from Arcane"
local hint = DEFAULT_HINT
local keyFailed = false
local inputText = keyInput.Text
-- Two-sided pairing (docs/studio-pairing.md): the user types the 6-digit code Arcane shows and clicks Connect.
-- Nothing is looked up before that click. Arcane must prove the code before the plugin trusts it, and the
-- connection finishes only after the user clicks Approve in Arcane. The code is never kept or saved here.
local pairingStage: string? = nil
local liveNow = false
local advancedOpen = false
-- Display-only memory of the last status; it never grants access or survives a reload.
local phase, executing, writable, editMode = "idle", false, false, true
local lastActivity: string?, lastActivityAt = nil, 0
local function arcaneCode(text: string): boolean
	return string.match(text, "^%s*%d%d%d[%s%-]?%d%d%d%s*$") ~= nil
end
local function placeName(): string
	local ok, name = pcall(function(): any return game.Name end)
	if not ok or type(name) ~= "string" or name == "" then return "this place" end
	return if #name > 48 then string.sub(name, 1, 45) .. "..." else name
end
local function commas(value: number): string
	local text = tostring(math.floor(value))
	local result = string.reverse((string.gsub(string.reverse(text), "(%d%d%d)", "%1,")))
	return (string.gsub(result, "^,", ""))
end
local function ago(seconds: number): string
	if seconds < 60 then return "just now" end
	if seconds < 3600 then return tostring(math.floor(seconds / 60)) .. " min ago" end
	return tostring(math.floor(seconds / 3600)) .. " h ago"
end
local function statusView(): (string, string, Color3)
	if liveNow and not keyFailed then
		local line = if executing then "Working on a request from Arcane."
			elseif not editMode then "Paused while playtesting."
			elseif writable then "Ready. Arcane can build in this place." else "Ready with read-only access."
		if storageFailed then return "Connected to " .. placeName(), "Connected for this session. Reconnect to retry saving it before closing Studio.", colors.amber end
		return "Connected to " .. placeName(), line, colors.green
	end
	if pairingStage == "approval" then return "Waiting for Arcane", "Click Approve in the Arcane window to finish.", colors.amber end
	if pairingStage == "connecting" then return "Waiting for Arcane", "Checking the code with Arcane.", colors.amber end
	if phase == "update" then return "Update required", "Update the Studio plugin from Arcane, then restart Studio.", colors.amber end
	if phase == "reconciliation" then return "Reconciliation needed", "Review the last change in Arcane, then click Reconnect.", colors.red end
	if keyFailed then return "Not connected", hint, colors.red end
	if storageFailed then return "Saved connection needs attention", "Reconnect to retry saving your connection. Keep Studio open until it is saved.", colors.amber end
	local typed = keyInput.Text
	if typed ~= "" and typed ~= savedKey then
		if arcaneCode(typed) then return "Code entry", "Click Connect to pair with Arcane.", colors.red end
		if string.match(typed, "^[%d%s%-]+$") then return "Code entry", "Type all 6 digits, then click Connect.", colors.red end
		return "Code entry", "Click Connect to use this local key.", colors.red
	end
	if phase == "retrying" or phase == "connecting" then return "Waiting for Arcane", "Open Arcane on this computer. Checking again automatically.", colors.amber end
	if savedKey then return "Not connected", "Your saved key is ready. Click Reconnect.", colors.idle end
	return "Not connected", "In Arcane, click Connect Studio, then type the code here.", colors.idle
end
local transport: any
local function diagnosticsText(): string
	if not (liveNow and transport and transport.diagnostics) then return "Output: idle" end
	local errors, warnings = 0, 0
	for _, item in pairs(transport.diagnostics.entries or {}) do
		if item.kind == "error" then errors += item.count else warnings += item.count end
	end
	if errors == 0 and warnings == 0 then return "Output: no errors" end
	return "Output: " .. commas(errors) .. (if errors == 1 then " error" else " errors") .. DOT .. commas(warnings) .. (if warnings == 1 then " warning" else " warnings")
end
-- Presentation only: visibility, colours and copy. It never edits the field text.
local function render(): ()
	local masked = savedKey ~= nil and keyInput.Text == savedKey
	entry.Visible = not masked
	savedRow.Visible = masked and advancedOpen
	if masked then savedLabel.Text = "Local key ending " .. string.sub(savedKey :: string, -4) end
	fieldLabel.Text = if advancedOpen then "Local key (Advanced)" else "Code shown in Arcane"
	advancedButton.Text = if advancedOpen then "Hide advanced" else "Advanced: use a local key"
	local title, line, dot = statusView()
	statusTitle.Text, statusText.Text, statusDot.BackgroundColor3 = title, line, dot
	buttonGradient.Enabled = connectButton.BackgroundColor3 ~= colors.green
	activityLabel.Text = if lastActivity then lastActivity .. DOT .. ago(os.clock() - lastActivityAt) else "No builds yet"
	diagnosticsLabel.Text = diagnosticsText()
end
local function refreshHint(): ()
	keyInput.PlaceholderText = if pairingStage == "approval" then "Click Approve in Arcane"
		elseif advancedOpen and hint == DEFAULT_HINT then "Paste your Arcane local key" else hint
	render()
end
local function buttonText(): string
	if liveNow and not keyFailed then return "Connected" end
	if pairingStage == "approval" then return "Approve in Arcane..." end
	if pairingStage == "connecting" then return "Checking Arcane..." end
	return if keyFailed then "Failed" elseif savedKey then "Reconnect" else "Connect"
end
-- Takes the typed Arcane code out of the field. It is not a key: never kept, saved or shown again.
local function takeCode(): string
	local typed = keyInput.Text
	inputText = "" -- Programmatic cleanup is not a new user edit.
	keyInput.Text = ""
	return typed
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
	if lastKnownConnected == connected and storedOptOut == optOut and not stateNeedsWrite then return end
	local record: any = {connected = connected}
	if optOut then record.autoConnect = false end
	-- Track the latest intent even while its bounded persistence retry is pending.
	lastKnownConnected, storedOptOut = connected, optOut
	stateNeedsWrite = false
	persistSetting(STATE_SETTING, record)
end
local function rejectKey(): ()
	-- A rejected key must not become a persistent reconnect trap. Clearing this
	-- owned setting never revokes a key at the daemon or touches provider logins.
	retireSettings()
	keyFailed, savedKey, hint = true, nil, "Enter a new API key"
	persistSetting(KEY_SETTING, "")
	rememberState(false, false)
	connectButton.Text = "Failed"
	connectButton.BackgroundColor3, stroke.Color = colors.red, colors.red
	clearInput()
end
local function invalidateInput(): boolean
	if keyInput.Text == inputText then return false end
	inputText = keyInput.Text
	keyFailed, hint, pairingStage = false, DEFAULT_HINT, nil
	local hadSavedKey = startupPending or savedKey ~= nil or (type(keyRead.value) == "string" and keyRead.value ~= "") or (type(keyRead.legacyValue) == "string" and keyRead.legacyValue ~= "")
	retireSettings()
	if hadSavedKey then
		savedKey = nil
		persistSetting(KEY_SETTING, "")
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
	liveNow = live
	connectButton.Text = buttonText()
	if live then rememberState(true)
	else rememberState(false) end
	stroke.Color = if storageFailed then colors.amber elseif status.state == "retrying" or status.state == "reconciliation" then colors.red else colors.divider
	-- Fixed copy per state: daemon-supplied detail text is never rendered here.
	local detail = if type(status.detail) == "string" then status.detail else ""
	phase = if status.state == "reconciliation" then "reconciliation"
		elseif string.find(detail, "Unsupported", 1, true) or string.find(detail, "UPDATE_REQUIRED", 1, true) then "update"
		else status.state
	executing, writable, editMode = status.state == "executing", status.allowWrites == true, status.editMode ~= false
	render()
end, artifactHash)
-- The pairing proofs (HMAC) use the same bounded SHA-256 module that verifies this artifact.
transport.sha256 = Sha256
-- Check deferred text edits before every worker cycle and after every yielding
-- HTTP call, including status recovery that has not yet emitted a UI callback.
transport.checkInput = invalidateInput
-- Progress of a code attempt the Connect click started: waiting for Approve in Arcane, or why it stopped.
transport.onPairing = function(stage: any, detail: any): ()
	if stage == "approval" then pairingStage = "approval"
	elseif stage == "failed" then
		pairingStage, keyFailed = nil, true
		hint = if type(detail) == "string" and detail ~= "" then string.sub(detail, 1, 160) else DEFAULT_HINT
		stroke.Color = colors.red
	end
	refreshHint()
	connectButton.Text = buttonText()
end
-- A successful claim returns this daemon's local key once. Save it exactly like an entered key so
-- Studio and Arcane restarts reconnect through the existing saved-key recovery.
transport.onPaired = function(apiKey: any): ()
	local valid = pcall(function() V.keyOrigin(apiKey) end)
	if not valid then return end
	retireSettings()
	keyFailed, hint, pairingStage = false, DEFAULT_HINT, nil
	persistSetting(KEY_SETTING, apiKey)
	savedKey = apiKey
	inputText = apiKey -- Programmatic fill is not a new user edit.
	keyInput.Text = apiKey
	advancedOpen = false
	refreshHint()
	rememberState(false, true)
end
-- Completed write work, summarized for the activity line. Method names and counts only.
local ACTIVITY: {[string]: string} = {["scene.create"] = "Created an object", ["environment.apply"] = "Updated lighting",
	["terrain.generate"] = "Generated terrain", ["scene.update"] = "Updated properties", ["script.update"] = "Edited a script",
	["script.set_enabled"] = "Toggled a script", ["scene.restore"] = "Restored a change", ["scene.place_asset"] = "Placed an asset",
	["scene.apply_material"] = "Applied a material"}
transport.onActivity = function(method: any, count: any): ()
	local summary = if method == "scene.build" and type(count) == "number" then "Built " .. commas(count) .. (if count == 1 then " part" else " parts")
		elseif method == "scene.build" then "Built a scene" else ACTIVITY[method]
	if summary == nil then return end
	lastActivity, lastActivityAt = summary, os.clock()
	render()
end
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
table.insert(connections, button.Click:Connect(function() widget.Enabled = not widget.Enabled end))
table.insert(connections, widget:GetPropertyChangedSignal("Enabled"):Connect(function() button:SetActive(widget.Enabled) end))
button:SetActive(widget.Enabled)
table.insert(connections, widget:GetPropertyChangedSignal("Enabled"):Connect(render))
table.insert(connections, keyInput:GetPropertyChangedSignal("Text"):Connect(function()
	invalidateInput()
	render()
end))
-- Presentation only: switches the field between the Arcane code and a pasted local key.
table.insert(connections, advancedButton.Activated:Connect(function()
	advancedOpen = not advancedOpen
	refreshHint()
end))
-- Replacing the saved key is an explicit edit: like deleting the field text, it forgets the
-- saved key and fences the current session. No request is made until the next Connect click.
table.insert(connections, replaceButton.Activated:Connect(function()
	keyInput.Text = ""
	invalidateInput()
	refreshHint()
end))
table.insert(connections, connectButton.Activated:Connect(function()
	invalidateInput()
	if keyInput.Text == "" then
		-- Nothing typed: no network, no fallback to a deleted saved key. The code comes from Arcane.
		keyFailed, hint, pairingStage = true, "Enter the 6-digit code shown in Arcane", nil
		refreshHint()
		connectButton.Text = buttonText()
		return
	end
	if arcaneCode(keyInput.Text) then
		-- The code shown in Arcane: this click is the only thing that starts a pairing attempt. The field is
		-- cleared at once, so the code is never saved or shown again.
		local typed = takeCode()
		keyFailed, hint = false, DEFAULT_HINT
		local started = pcall(function() transport:requestArcaneCode(typed) end)
		typed = ""
		pairingStage = if started then "connecting" else nil
		if not started then keyFailed = true; stroke.Color = colors.red end
		refreshHint()
		connectButton.Text = buttonText()
		return
	end
	local entered = keyInput.Text -- Deleting the field never falls back to an old key.
	local valid = pcall(function() V.keyOrigin(entered) end)
	if not valid then
		rejectKey()
		-- Explicit failed input also fences any queued or live connection.
		transport:requestDisconnect()
		return
	end
	keyFailed, hint = false, DEFAULT_HINT
	local value = entered :: string
	persistSetting(KEY_SETTING, value)
	savedKey = value
	connectButton.Text, connectButton.BackgroundColor3 = "Reconnect", colors.red
	advancedOpen = false
	refreshHint()
	local ok = pcall(function() transport:requestConnect(value) end)
	if not ok then transport:requestDisconnect(); rememberState(false); stroke.Color = colors.red end
	entered, value = nil, ""
end))
table.insert(connections, plugin.Unloading:Connect(function()
	settingsRetired = true
	retireSettings()
	savedKey = nil
	pairingStage = nil
	clearInput()
	transport:stop()
	diagnostics:stop()
	for _, connection in ipairs(connections) do connection:Disconnect() end
	widget:Destroy()
	toolbar:Destroy()
end))
-- Settings retries share the transport's one bounded worker. They never wait,
-- issue HTTP, restore a session, or survive an edit/unload revision.
local cycle = transport.cycle
transport.cycle = function(client: any): number
	if not settingsRetired and not client.stopped then
		invalidateInput() -- A deferred edit must retire startup reads before they can refill the field.
		for name, job in pairs(pendingWrites) do attemptWrite(name, job) end
		if startupPending then
			observeSetting(keyRead)
			observeSetting(stateRead)
			if keyRead.done and stateRead.done then
				adoptSettings()
				if keyRead.migrate then persistSetting(KEY_SETTING, keyRead.value) end
				if stateRead.migrate then persistSetting(STATE_SETTING, stateRead.value) end
				keyRead.value, stateRead.value = nil, nil
				if savedKey then
					inputText, keyInput.Text = savedKey, savedKey
					refreshHint()
					connectButton.Text = buttonText()
					if autoConnect then
						local ok = pcall(function() client:requestConnect(savedKey, true) end)
						if not ok then rememberState(false) end
					end
				end
			end
		end
		render()
	end
	return cycle(client)
end
-- Queue safe recovery from any saved key unless the user explicitly opted out.
-- Cached health never proves a connection. Status precedes authentication; no
-- old session token, command, receipt or grant is restored in a new lifetime.
if savedKey ~= nil and autoConnect then
	local ok = pcall(function() transport:requestConnect(savedKey, true) end)
	if not ok then rememberState(false) end
end
render()
transport:start()
