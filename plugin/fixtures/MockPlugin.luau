--!strict
-- GUI/startup doubles for the native Lua bundle; never installed or packaged.
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
Enum.InitialDockState = enumGroup({"Right"})
Enum.ZIndexBehavior = enumGroup({"Sibling"})
Enum.AutomaticSize = enumGroup({"Y"})
Enum.SortOrder = enumGroup({"LayoutOrder"})
Enum.Font = enumGroup({"SourceSans", "SourceSansSemibold", "Gotham", "GothamBold", "GothamMedium", "Code"})
Enum.TextXAlignment = enumGroup({"Left"})
Enum.TextYAlignment = enumGroup({"Top", "Center"})
Enum.TextTruncate = enumGroup({"AtEnd"})
Color3.fromRGB = function(r: number, g: number, b: number): any return Color3.new(r / 255, g / 255, b / 255) end
local UDim: any = {new = function(scale: number, offset: number): any return {Scale = scale, Offset = offset} end}
local UDim2: any = {new = function(...: any): any return {...} end,
	fromScale = function(x: number, y: number): any return {x, 0, y, 0} end}
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
	assert(id == "ArcaneLocalBridgeV1" and #info == 7, "widget API parameters")
	local widget = Instance.new("DockWidgetPluginGui")
	widget.Enabled = false
	fixture.widget = widget
	return widget
end
