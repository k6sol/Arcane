--!strict
-- GUI/startup doubles for the official standalone Luau VM; never installed.
-- These fixtures do not certify native Studio focus, selection or key events.
local function signal(): any
	local value: any = {connections = {}}
	function value:Connect(callback: any): any
		local connection: any = {Connected = true, callback = callback}
		function connection:Disconnect(): () self.Connected = false end
		table.insert(self.connections, connection)
		return connection
	end
	function value:Fire(): ()
		for _, connection in ipairs(table.clone(self.connections)) do
			if connection.Connected then connection.callback() end
		end
	end
	return value
end
function methods:GetPropertyChangedSignal(name: string): any
	self._signals = self._signals or {}
	self._signals[name] = self._signals[name] or signal()
	return self._signals[name]
end
local function enumGroup(names: {string}): any
	local group: any = {}
	for _, name in ipairs(names) do group[name] = {Name = name} end
	return group
end
Enum.InitialDockState = enumGroup({"Right", "Float"})
Enum.ZIndexBehavior = enumGroup({"Sibling"})
Enum.AutomaticSize = enumGroup({"Y"})
Enum.SortOrder = enumGroup({"LayoutOrder"})
Enum.Font = enumGroup({"SourceSans", "SourceSansSemibold", "Gotham", "GothamBold", "GothamMedium", "Code"})
Enum.TextXAlignment = enumGroup({"Left", "Center", "Right"})
Enum.TextYAlignment = enumGroup({"Top", "Center"})
Enum.TextTruncate = enumGroup({"AtEnd"})
Color3.fromRGB = function(r: number, g: number, b: number): any return Color3.new(r / 255, g / 255, b / 255) end
local UDim: any = {new = function(scale: number, offset: number): any return {Scale = scale, Offset = offset} end}
local UDim2: any = {new = function(xScale: number?, xOffset: number?, yScale: number?, yOffset: number?): any return {xScale or 0, xOffset or 0, yScale or 0, yOffset or 0} end,
	fromScale = function(x: number, y: number): any return {x, 0, y, 0} end}
-- Value doubles for the brand gradients; GUI rendering itself is not certified here.
local ColorSequenceKeypoint: any = {new = function(time: number, color: any): any return table.freeze({Time = time, Value = color}) end}
local ColorSequence: any = {new = function(points: any): any return table.freeze({Keypoints = table.freeze(table.clone(points))}) end}
local NumberSequenceKeypoint: any = {new = function(time: number, value: number): any return table.freeze({Time = time, Value = value}) end}
local NumberSequence: any = {new = function(points: any): any return table.freeze({Keypoints = table.freeze(table.clone(points))}) end}
local DockWidgetPluginGuiInfo: any = {new = function(...: any): any return {...} end}
fixture.workers = {}
task.spawn = function(callback: any): () table.insert(fixture.workers, callback) end
local originalNew = Instance.new
Instance.new = function(className: string): any
	local instance = originalNew(className)
	if className == "TextButton" then instance.Activated = signal() end
	return instance
end
local plugin: any = {Unloading = signal()}
fixture.settingNames = table.freeze({apiKey = "Arcane.LocalApiKey.v1", lastConnection = "Arcane.LastConnection.v1"})
fixture.pluginSettings = fixture.pluginSettings or {}
fixture.getCalls, fixture.setCalls = {}, {}
local function settingCopy(value: any): any
	if type(value) ~= "table" then return value end
	local copy: any = {}
	for key, item in pairs(value) do copy[key] = settingCopy(item) end
	return copy
end
function plugin:GetSetting(name: string): any
	table.insert(fixture.getCalls, name)
	local fault = fixture.getSettingError or (fixture.getSettingFaults and fixture.getSettingFaults[name])
	if fault then error(fault, 0) end
	return settingCopy(fixture.pluginSettings[name])
end
function plugin:SetSetting(name: string, value: any): ()
	table.insert(fixture.setCalls, {key = name, value = settingCopy(value)})
	local fault = fixture.setSettingError or (fixture.setSettingFaults and fixture.setSettingFaults[name])
	if fault then error(fault, 0) end
	fixture.pluginSettings[name] = settingCopy(value)
end
function plugin:CreateToolbar(name: string): any
	local toolbar: any = {name = name, destroyed = false}
	function toolbar:CreateButton(_id: string, _tooltip: string, _icon: string, _text: string): any
		local button: any = {Click = signal(), active = false}
		function button:SetActive(active: boolean): () self.active = active end
		fixture.button = button
		return button
	end
	function toolbar:Destroy(): () self.destroyed = true end
	fixture.toolbar = toolbar
	return toolbar
end
function plugin:CreateDockWidgetPluginGuiAsync(id: string, info: any): any
	assert(id == "ArcaneLocalBridgeFloatingV2" and #info == 7, "widget API parameters")
	fixture.widgetInfo = table.clone(info)
	local widget = Instance.new("DockWidgetPluginGui")
	widget.Enabled = info[2]
	fixture.widget = widget
	return widget
end
