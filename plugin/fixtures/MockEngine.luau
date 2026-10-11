--!strict
-- Standalone Luau test doubles only. They do not certify Roblox native behavior.
local fixture: any = {now = 1000, expiry = 2000, edit = true, guid = 0, requests = 0,
	responses = {}, sources = {}, created = {}, writes = 0, committed = 0, cancelled = 0}
local function triple(first: number, second: number, third: number): any
	local scratch = buffer.create(4)
	local function round(value: number): number buffer.writef32(scratch, 0, value); return buffer.readf32(scratch, 0) end
	first, second, third = round(first), round(second), round(third)
	return setmetatable({X = first, Y = second, Z = third, R = first, G = second, B = third}, {
		__eq = function(a: any, b: any): boolean return a.X == b.X and a.Y == b.Y and a.Z == b.Z end,
	})
end
local Vector3: any = {new = triple}
local Color3: any = {new = triple}
local materials: any = setmetatable({}, {__index = function(self: any, name: string): any
	local value = {Name = name}; rawset(self, name, value); return value
end})
local Enum: any = {Material = materials, FinishRecordingOperation = {Commit = "Commit", Cancel = "Cancel"}}
local DateTime: any = {
	now = function(): any return {UnixTimestampMillis = fixture.now} end,
	fromIsoDate = function(value: string): any
		if value ~= "2099-01-01T00:00:00.000Z" then return nil end
		return {UnixTimestampMillis = fixture.expiry}
	end,
}
local task: any = {spawn = function(_callback: any): () error("Test worker must be driven explicitly") end,
	wait = function(_seconds: number): () error("No real sleeps in logic tests") end}
local methods: any = {}
local instanceMetatable: any
local game: any

function methods:IsA(name: string): boolean
	return name == "Instance" or name == self.ClassName
		or (name == "BasePart" and table.find({"Part", "MeshPart", "WedgePart", "UnionOperation", "TrussPart"}, self.ClassName) ~= nil)
		or (name == "BaseScript" and table.find({"Script", "LocalScript"}, self.ClassName) ~= nil)
		or (name == "LuaSourceContainer" and table.find({"Script", "LocalScript", "ModuleScript"}, self.ClassName) ~= nil)
end
function methods:IsDescendantOf(ancestor: any): boolean
	local cursor = self.Parent
	while cursor do if cursor == ancestor then return true end; cursor = cursor.Parent end
	return false
end
function methods:GetChildren(): {any} return table.clone(self._children) end
function methods:GetAttributes(): any return table.clone(self._attributes) end
function methods:Destroy(): ()
	if fixture.failDestroy then error("injected destroy failure") end
	self.Parent = nil
	self._destroyed = true
	for _, child in ipairs(self:GetChildren()) do child:Destroy() end
end
instanceMetatable = {
	__index = function(self: any, key: string): any return methods[key] or self._properties[key] end,
	__newindex = function(self: any, key: string, value: any): ()
		if string.sub(key, 1, 1) == "_" then rawset(self, key, value); return end
		if fixture.failProperty == key then error("injected property setter failure") end
		if key == "Parent" then
			local previous = self._properties.Parent
			if previous and previous._children then
				local index = table.find(previous._children, self)
				if index then table.remove(previous._children, index) end
			end
			if value and value._children then table.insert(value._children, self) end
		end
		fixture.writes += 1
		self._properties[key] = value
	end,
}
local Instance: any = {}
function Instance.new(className: string): any
	local result = setmetatable({_properties = {ClassName = className, Name = className,
		Size = triple(4, 1, 2), Position = triple(0, 0, 0), Color = triple(0.5, 0.5, 0.5),
		Material = materials.Plastic, Anchored = false, CanCollide = true, Transparency = 0, Disabled = false, Source = ""},
		_children = {}, _attributes = {}, _destroyed = false}, instanceMetatable)
	table.insert(fixture.created, result)
	return result
end
local services: any = {}
game = {PlaceId = 0, GameId = 0, Name = "ArcaneDisposableFixture", _children = {}}
function game:GetService(name: string): any
	if not services[name] then services[name] = Instance.new(name); services[name].Parent = game end
	return services[name]
end
local http: any = {}
function http:GenerateGUID(_braces: boolean): string fixture.guid += 1; return "opaque-" .. tostring(fixture.guid) end
function http:JSONEncode(value: any): string
	if type(value) ~= "string" then return tostring(value) end
	return '"' .. string.gsub(value, '[%z\1-\31\\"]', function(character: string): string
		if character == '"' then return '\\"' end
		if character == "\\" then return "\\\\" end
		return string.format("\\u%04x", string.byte(character))
	end) .. '"'
end
function http:JSONDecode(value: string): any
	-- Independent scalar string double. Production uses native JSONDecode only
	-- for strings, never tables; the protocol parser is exercised on real JSON.
	if string.sub(value, 1, 1) ~= '"' or string.sub(value, -1) ~= '"' then error("not a JSON string") end
	local output, cursor = {}, 2
	local escapes: any = {['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t"}
	while cursor < #value do
		local char = string.sub(value, cursor, cursor)
		if char ~= "\\" then table.insert(output, char); cursor += 1
		else
			local escape = string.sub(value, cursor + 1, cursor + 1)
			if escape == "u" then
				local code = tonumber(string.sub(value, cursor + 2, cursor + 5), 16)
				if not code then error("bad unicode") end
				cursor += 6
				if code >= 0xD800 and code <= 0xDBFF then
					if string.sub(value, cursor, cursor + 1) ~= "\\u" then error("unpaired surrogate") end
					local low = tonumber(string.sub(value, cursor + 2, cursor + 5), 16)
					if not low or low < 0xDC00 or low > 0xDFFF then error("bad low surrogate") end
					code = 0x10000 + (code - 0xD800) * 0x400 + low - 0xDC00
					cursor += 6
				elseif code >= 0xDC00 and code <= 0xDFFF then error("unpaired surrogate") end
				table.insert(output, utf8.char(code))
			else
				if escapes[escape] == nil then error("bad escape") end
				table.insert(output, escapes[escape]); cursor += 2
			end
		end
	end
	return table.concat(output)
end
function http:RequestAsync(request: any): any
	fixture.requests += 1
	if fixture.httpHook then return fixture.httpHook(request) end
	error("unexpected HTTP request")
end
services.HttpService = http
services.RunService = {IsEdit = function(_self: any): boolean return fixture.edit end}
services.Selection = {Get = function(_self: any): {any} return fixture.selection or {} end}
services.CollectionService = {GetTags = function(_self: any, instance: any): {string} return instance._tags or {} end}
local editor: any = {}
function editor:GetEditorSource(instance: any): string return fixture.sources[instance] or instance.Source end
function editor:UpdateSourceAsync(instance: any, callback: any): ()
	if fixture.editorHook then fixture.editorHook(instance, callback); return end
	local updated = callback(self:GetEditorSource(instance))
	if updated ~= nil then fixture.sources[instance] = updated end
end
services.ScriptEditorService = editor
services.ChangeHistoryService = {
	TryBeginRecording = function(_self: any, _name: string, _display: string): string?
		if fixture.historyHook then fixture.historyHook() end
		if fixture.failBegin then return nil end
		return "recording"
	end,
	FinishRecording = function(_self: any, _id: string, operation: string): ()
		if fixture.failFinish then error("injected history failure") end
		if operation == "Commit" then fixture.committed += 1 else fixture.cancelled += 1 end
	end,
}
local function response(data: any, status: number?): any
	local key = "response-" .. tostring(fixture.requests)
	fixture.responses[key] = data
	local code = status or 200
	return {StatusCode = code, Success = code >= 200 and code < 300, Body = fixture.encode(data), Headers = {}}
end
