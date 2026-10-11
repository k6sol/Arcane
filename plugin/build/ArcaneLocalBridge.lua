--!strict
-- Generated from plugin/src; install exactly one Arcane artifact.
-- Factories below contain trusted source code, never strings evaluated at runtime.
local __arcaneFactories: {[string]: () -> any} = {}
local __arcaneCache: {[string]: any} = {}
local __arcaneLoaded: {[string]: boolean} = {}
local __arcaneLoading: {[string]: boolean} = {}
local function __arcaneRequire(name: string): any
	local factory = __arcaneFactories[name]
	if factory == nil then error("Arcane bundle: undeclared module", 0) end
	if __arcaneLoaded[name] then return __arcaneCache[name] end
	if __arcaneLoading[name] then error("Arcane bundle: cyclic module dependency", 0) end
	__arcaneLoading[name] = true
	local ok, value = pcall(factory)
	__arcaneLoading[name] = nil
	if not ok then error(value, 0) end
	if value == nil then error("Arcane bundle: module returned nil", 0) end
	__arcaneCache[name] = value
	__arcaneLoaded[name] = true
	return value
end
-- BEGIN Types.luau
__arcaneFactories["Types"] = function()
-- Wire definitions mirror packages/protocol/src/studio.ts (protocol v1).
export type InstanceRef = {
	instanceId: string, sessionId: string, root: string,
	pathSegments: {string}, className: string,
}
export type PairResult = {
	sessionId: string, token: string, protocolVersion: number,
	allowedRoots: {string}, allowWrites: boolean,
}
export type Command = {
	protocolVersion: number, id: string, requestId: string, sessionId: string,
	clientSessionId: string, method: string, args: {[string]: any},
	allowedRoots: {string}, allowWrites: boolean, leaseEpoch: number,
	expiresAt: string, state: string,
}
export type MutationReceipt = {
	kind: string, ref: InstanceRef, before: any, after: {[string]: any},
}
export type Outcome = {state: string, result: any?, error: string?, unsafe: boolean?}
return {}
end
-- END Types.luau

-- BEGIN Validation.luau
__arcaneFactories["Validation"] = function()
local Validation = {}
Validation.PROTOCOL = 1
Validation.VERSION = "0.1.0"
Validation.ARGUMENT_BYTES = 256 * 1024
Validation.RESULT_BYTES = 512 * 1024
Validation.SOURCE_BYTES = 100 * 1024
Validation.MAX_REFS = 20000
Validation.MAX_RECEIPTS = 1024
Validation.MAX_CACHE_BYTES = 16 * 1024 * 1024
Validation.NULL = table.freeze({})
local ARRAY = table.freeze({})
Validation.ROOTS = table.freeze({"Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPlayer", "Lighting"})
Validation.READ_METHODS = table.freeze({"scene.children", "scene.inspect", "scene.search", "selection.read", "script.read"})
Validation.WRITE_METHODS = table.freeze({"scene.create", "scene.update", "script.update", "scene.restore"})

function Validation.fail(code: string, message: string): never
	error(table.freeze({code = code, message = message}), 0)
end

function Validation.object(value: any, label: string): {[string]: any}
	if type(value) ~= "table" or value == Validation.NULL or getmetatable(value) == ARRAY then
		Validation.fail("INPUT", label .. " must be an object.")
	end
	for key in pairs(value) do
		if type(key) ~= "string" or key == "__proto__" or key == "constructor" or key == "prototype" then
			Validation.fail("INPUT", label .. " contains an invalid key.")
		end
	end
	return value
end

function Validation.fields(value: any, allowed: {string}, label: string): {[string]: any}
	local result = Validation.object(value, label)
	for key in pairs(result) do
		if not table.find(allowed, key) then Validation.fail("INPUT", "Unsupported " .. label .. " field.") end
	end
	return result
end

function Validation.string(value: any, label: string, maximum: number, allowEmpty: boolean?): string
	if type(value) ~= "string" or #value > maximum or (not allowEmpty and #value == 0)
		or string.find(value, "\0", 1, true) or utf8.len(value) == nil then
		Validation.fail("INPUT", "Invalid " .. label .. ".")
	end
	return value
end

function Validation.number(value: any, low: number, high: number, label: string): number
	if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge or value < low or value > high then
		Validation.fail("INPUT", "Invalid " .. label .. ".")
	end
	return value
end

function Validation.integer(value: any, low: number, high: number, label: string): number
	local result = Validation.number(value, low, high, label)
	if result % 1 ~= 0 then Validation.fail("INPUT", label .. " must be an integer.") end
	return result
end

function Validation.boolean(value: any, label: string): boolean
	if type(value) ~= "boolean" then Validation.fail("INPUT", "Invalid " .. label .. ".") end
	return value
end

function Validation.array(value: {any}): {any}
	return setmetatable(value, ARRAY)
end

function Validation.list(value: any, maximum: number, label: string): {any}
	if type(value) ~= "table" or value == Validation.NULL or (#value == 0 and getmetatable(value) ~= ARRAY) or #value > maximum then Validation.fail("INPUT", "Invalid " .. label .. ".") end
	local count = 0
	for key in pairs(value) do
		count += 1
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #value then Validation.fail("INPUT", "Invalid " .. label .. ".") end
	end
	if count ~= #value then Validation.fail("INPUT", "Invalid " .. label .. ".") end
	return value
end

function Validation.roots(value: any): {string}
	local roots = Validation.list(value, #Validation.ROOTS, "roots")
	if #roots == 0 then Validation.fail("INPUT", "At least one root is required.") end
	local seen: {[string]: boolean} = {}
	for _, root in ipairs(roots) do
		if type(root) ~= "string" or not table.find(Validation.ROOTS, root) or seen[root] then Validation.fail("INPUT", "Invalid or duplicate root.") end
		seen[root] = true
	end
	return table.clone(roots)
end

function Validation.url(value: any): string
	local input = Validation.string(value, "daemon URL", 64)
	local portText = string.match(input, "^http://127%.0%.0%.1:([1-9][0-9]*)$")
	if not portText or #portText > 5 then Validation.fail("URL", "Use exactly http://127.0.0.1:PORT.") end
	Validation.integer(tonumber(portText), 1, 65535, "port")
	return input
end


-- The key carries only the literal loopback port. Never extract or display its
-- secret; keep the original key only until the human-triggered exchange starts.
function Validation.keyOrigin(value: any): string
	local input = Validation.string(value, "Arcane API key", 86)
	local port, secret = string.match(input, "^arcane_local_v1_([1-9][0-9]*)_([0-9a-f]+)$")
	if not port or #port > 5 or not secret or #secret ~= 64 then Validation.fail("KEY", "Enter a valid Arcane local API key.") end
	Validation.integer(tonumber(port), 1, 65535, "key port")
	return Validation.url("http://127.0.0.1:" .. port)
end

function Validation.equal(left: any, right: any): boolean
	if left == Validation.NULL or right == Validation.NULL then return left == right end
	if type(left) ~= type(right) then return false end
	if type(left) ~= "table" then return left == right end
	if (getmetatable(left) == ARRAY) ~= (getmetatable(right) == ARRAY) then return false end
	for key, item in pairs(left) do if not Validation.equal(item, right[key]) then return false end end
	for key, item in pairs(right) do if not Validation.equal(item, left[key]) then return false end end
	return true
end

function Validation.immutable(value: any): any
	if type(value) ~= "table" or value == Validation.NULL then return value end
	local copy: any = {}
	for key, item in pairs(value) do copy[key] = Validation.immutable(item) end
	if getmetatable(value) == ARRAY then setmetatable(copy, ARRAY) end
	return table.freeze(copy)
end

-- HttpService encodes {} as [] and drops nil. Preserve protocol objects and null
-- explicitly, and sort keys so identical result retries are byte-for-byte stable.
function Validation.encode(value: any, http: any): string
	local function encode(item: any, depth: number): string
		if depth > 80 then Validation.fail("INPUT", "JSON nesting is too deep.") end
		if item == nil or item == Validation.NULL then return "null" end
		local kind = type(item)
		if kind == "string" then
			if utf8.len(item) == nil then Validation.fail("INPUT", "Invalid UTF-8.") end
			return http:JSONEncode(item)
		end
		if kind == "boolean" then return if item then "true" else "false" end
		if kind == "number" then
			Validation.number(item, -math.huge, math.huge, "JSON number")
			return http:JSONEncode(item)
		end
		if kind ~= "table" then Validation.fail("INPUT", "Non-JSON value.") end
		local array = getmetatable(item) == ARRAY or #item > 0
		local pieces: {string} = {}
		if array then
			Validation.list(item, 20000, "JSON array")
			for _, child in ipairs(item) do table.insert(pieces, encode(child, depth + 1)) end
			return "[" .. table.concat(pieces, ",") .. "]"
		end
		Validation.object(item, "JSON object")
		local keys: {string} = {}
		for key in pairs(item) do table.insert(keys, key) end
		table.sort(keys)
		for _, key in ipairs(keys) do table.insert(pieces, http:JSONEncode(key) .. ":" .. encode(item[key], depth + 1)) end
		return "{" .. table.concat(pieces, ",") .. "}"
	end
	return encode(value, 0)
end


-- Preserve null entries and empty arrays; native JSONDecode erases null fields.
-- Only scalar strings use the engine unescaper. JSON is never executable.
function Validation.decode(text: string, http: any): any
	if type(text) ~= "string" or utf8.len(text) == nil then Validation.fail("PROTOCOL", "Invalid JSON text.") end
	local cursor, length = 1, #text
	local function invalid(): never Validation.fail("PROTOCOL", "Malformed daemon JSON.") end
	local function whitespace(): ()
		while cursor <= length and string.find(" \t\r\n", string.sub(text, cursor, cursor), 1, true) do cursor += 1 end
	end
	local function quoted(): string
		local start = cursor
		cursor += 1
		while cursor <= length do
			local byte = string.byte(text, cursor)
			if byte == 34 then
				cursor += 1
				local ok, value = pcall(function() return http:JSONDecode(string.sub(text, start, cursor - 1)) end)
				if not ok or type(value) ~= "string" or utf8.len(value) == nil then invalid() end
				return value
			elseif byte == 92 then
				cursor += 1
				local escape = string.sub(text, cursor, cursor)
				if escape == "u" then
					if not string.match(string.sub(text, cursor + 1, cursor + 4), "^%x%x%x%x$") then invalid() end
					cursor += 4
				elseif escape == "" or not string.find('"\\/bfnrt', escape, 1, true) then invalid() end
			elseif byte < 32 then invalid() end
			cursor += 1
		end
		return invalid()
	end
	local parse: (number) -> any
	parse = function(depth: number): any
		if depth > 80 then invalid() end
		whitespace()
		local char = string.sub(text, cursor, cursor)
		if char == '"' then return quoted() end
		if char == "{" or char == "[" then
			local object = char == "{"
			local close = if object then "}" else "]"
			local result: any = if object then {} else Validation.array({})
			cursor += 1
			whitespace()
			if string.sub(text, cursor, cursor) == close then cursor += 1; return result end
			while cursor <= length do
				local key: any = #result + 1
				if object then
					if string.sub(text, cursor, cursor) ~= '"' then invalid() end
					key = quoted()
					if result[key] ~= nil or key == "__proto__" or key == "constructor" or key == "prototype" then invalid() end
					whitespace()
					if string.sub(text, cursor, cursor) ~= ":" then invalid() end
					cursor += 1
				end
				result[key] = parse(depth + 1)
				whitespace()
				local separator = string.sub(text, cursor, cursor)
				cursor += 1
				if separator == close then return result end
				if separator ~= "," then invalid() end
				whitespace()
			end
			return invalid()
		end
		for _, literal in ipairs({"true", "false", "null"}) do
			if string.sub(text, cursor, cursor + #literal - 1) == literal then
				cursor += #literal
				return if literal == "null" then Validation.NULL else literal == "true"
			end
		end
		local start = cursor
		if char == "-" then cursor += 1 end
		local function digit(): boolean
			local byte = string.byte(text, cursor)
			return byte ~= nil and byte >= 48 and byte <= 57
		end
		if not digit() then invalid() end
		if string.sub(text, cursor, cursor) == "0" then cursor += 1
		else while digit() do cursor += 1 end end
		if string.sub(text, cursor, cursor) == "." then
			cursor += 1
			if not digit() then invalid() end
			while digit() do cursor += 1 end
		end
		local exponent = string.sub(text, cursor, cursor)
		if exponent == "e" or exponent == "E" then
			cursor += 1
			local sign = string.sub(text, cursor, cursor)
			if sign == "+" or sign == "-" then cursor += 1 end
			if not digit() then invalid() end
			while digit() do cursor += 1 end
		end
		local number = tonumber(string.sub(text, start, cursor - 1))
		if number == nil then invalid() end
		return Validation.number(number, -math.huge, math.huge, "JSON number")
	end
	local result = parse(0)
	whitespace()
	if cursor <= length then invalid() end
	return result
end

function Validation.safeError(value: any): string
	-- Never echo arbitrary engine/HTTP errors (they may contain source or bearer).
	if type(value) == "table" and type(value.code) == "string" and type(value.message) == "string" then
		return string.sub(value.code .. ": " .. value.message, 1, 512)
	end
	return "ENGINE: Operation failed; inspect the place and reconnect if reconciliation is required."
end

return table.freeze(Validation)
end
-- END Validation.luau

-- BEGIN Registry.luau
__arcaneFactories["Registry"] = function()
local V = __arcaneRequire("Validation")
local Registry = {}
Registry.__index = Registry
type Registry = any

function Registry.new(sessionId: string, roots: {string}, gameModel: any, http: any): Registry
	local services: {[string]: any} = {}
	for _, root in ipairs(roots) do services[root] = gameModel:GetService(root) end
	return setmetatable({sessionId = sessionId, services = services, gameModel = gameModel, http = http,
		byId = {}, byInstance = {}, owned = {}, count = 0}, Registry)
end

function Registry:rootOf(instance: any): string?
	for root, service in pairs(self.services) do
		if instance == service or instance:IsDescendantOf(service) then return root end
	end
	return nil
end

function Registry:root(name: any): any
	if type(name) ~= "string" or not self.services[name] then V.fail("GRANT", "Root is not granted.") end
	return self.services[name]
end

function Registry:isService(instance: any): boolean
	-- Class tags are not exposed to plugins; IsA(Service) is not a valid test.
	return instance.Parent == self.gameModel or table.find(V.ROOTS, instance.ClassName) ~= nil
end

function Registry:ref(instance: any): any
	local root = self:rootOf(instance)
	if not root then V.fail("REF", "Instance is outside granted roots.") end
	local id = self.byInstance[instance]
	if not id then
		if self.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
		id = self.http:GenerateGUID(false)
		self.byInstance[instance] = id
		self.byId[id] = instance
		self.count += 1
	end
	local path: {string} = {}
	local cursor = instance
	while cursor and cursor ~= self.services[root] do
		if #path >= 63 then V.fail("REF", "Instance hierarchy is too deep.") end
		table.insert(path, 1, V.string(cursor.Name, "instance name", 256, true))
		cursor = cursor.Parent
	end
	-- Root services have an empty display path; descendant paths are relative.
	return {instanceId = id, sessionId = self.sessionId, root = root,
		pathSegments = V.array(path), className = instance.ClassName}
end

function Registry:resolve(value: any): any
	local ref = V.fields(value, {"instanceId", "sessionId", "root", "pathSegments", "className"}, "reference")
	V.string(ref.instanceId, "instance ID", 256)
	V.string(ref.className, "class name", 256)
	local path = V.list(ref.pathSegments, 64, "display path")
	for _, segment in ipairs(path) do V.string(segment, "display path segment", 256, true) end
	if ref.sessionId ~= self.sessionId then V.fail("SESSION", "Reference belongs to another session.") end
	local instance = self.byId[ref.instanceId]
	if not instance or self:rootOf(instance) ~= ref.root or instance.ClassName ~= ref.className then
		V.fail("REF", "Reference is unknown, removed, moved outside its root, or has the wrong class.")
	end
	-- pathSegments are deliberately never used for resolution.
	return instance
end

function Registry:node(instance: any): any
	return {ref = self:ref(instance), name = V.string(instance.Name, "instance name", 256, true),
		className = instance.ClassName, childCount = #instance:GetChildren()}
end

return Registry
end
-- END Registry.luau

-- BEGIN Properties.luau
__arcaneFactories["Properties"] = function()
local V = __arcaneRequire("Validation")
local Properties = {}
Properties.PART_FIELDS = table.freeze({"Size", "Position", "Color", "Anchored", "CanCollide", "Transparency", "Material"})
Properties.CLASSES = table.freeze({"Folder", "Model", "Part", "Script", "LocalScript", "ModuleScript"})
Properties.MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Metal", "Wood", "WoodPlanks", "Concrete", "Brick", "Glass", "Neon", "Slate", "Sand", "Fabric"})

function Properties.decode(name: string, value: any, isPart: boolean): any
	if name == "Name" then return V.string(value, "Name", 100) end
	if not isPart or not table.find(Properties.PART_FIELDS, name) then V.fail("PROPERTY", "Property is not writable for this class.") end
	if name == "Anchored" or name == "CanCollide" then return V.boolean(value, name) end
	if name == "Transparency" then return V.number(value, 0, 1, name) end
	if name == "Material" then
		if type(value) ~= "string" or not table.find(Properties.MATERIALS, value) then V.fail("PROPERTY", "Unsupported Material.") end
		return Enum.Material[value]
	end
	local tag = V.fields(value, {"type", "value"}, "tagged property")
	local expectedType = if name == "Color" then "Color3" else "Vector3"
	if tag.type ~= expectedType then V.fail("PROPERTY", "Incorrect property type tag.") end
	local components = V.list(tag.value, 3, "components")
	if #components ~= 3 then V.fail("PROPERTY", "Property needs three components.") end
	for _, component in ipairs(components) do
		local low = if name == "Size" then 0.05 elseif name == "Color" then 0 else -100000
		local high = if name == "Size" then 2048 elseif name == "Color" then 1 else 100000
		V.number(component, low, high, name)
	end
	if name == "Color" then return Color3.new(components[1], components[2], components[3]) end
	return Vector3.new(components[1], components[2], components[3])
end

function Properties.encode(name: string, value: any): any
	if name == "Size" or name == "Position" then return {type = "Vector3", value = V.array({value.X, value.Y, value.Z})} end
	if name == "Color" then return {type = "Color3", value = V.array({value.R, value.G, value.B})} end
	if name == "Material" then return value.Name end
	return value
end

function Properties.validate(instance: any, values: any, service: boolean): ({[string]: any}, {string})
	V.object(values, "properties")
	local decoded: {[string]: any} = {}
	local names: {string} = {}
	for name, value in pairs(values) do
		if service and name == "Name" then V.fail("SERVICE", "Services cannot be renamed.") end
		decoded[name] = Properties.decode(name, value, instance:IsA("BasePart"))
		table.insert(names, name)
	end
	table.sort(names)
	return decoded, names
end

function Properties.snapshot(instance: any, names: {string}?): {[string]: any}
	local fields: {string} = names or {"Name"}
	if not names and instance:IsA("BasePart") then
		fields = table.clone(Properties.PART_FIELDS)
		table.insert(fields, "Name")
	end
	local result: {[string]: any} = {}
	for _, name in ipairs(fields) do result[name] = Properties.encode(name, instance[name]) end
	if not names and instance:IsA("BaseScript") then result.Disabled = instance.Disabled end
	return result
end

function Properties.compare(instance: any, expected: any, names: {string}): boolean
	-- Compare engine values (float32 Vector3/Color3 round-trip) after validation.
	local decoded = Properties.validate(instance, expected, false)
	for _, name in ipairs(names) do
		if expected[name] == nil or instance[name] ~= decoded[name] then return false end
	end
	return true
end

return table.freeze(Properties)
end
-- END Properties.luau

-- BEGIN Operations.luau
__arcaneFactories["Operations"] = function()
local V = __arcaneRequire("Validation")
local P = __arcaneRequire("Properties")
local Registry = __arcaneRequire("Registry")
local Operations = {}
Operations.__index = Operations
type Operations = any

function Operations.new(pair: any, gameModel: any, http: any): Operations
	return setmetatable({registry = Registry.new(pair.sessionId, pair.allowedRoots, gameModel, http),
		http = http, editor = gameModel:GetService("ScriptEditorService"),
		history = gameModel:GetService("ChangeHistoryService"), selection = gameModel:GetService("Selection"),
		collection = gameModel:GetService("CollectionService"), mutations = {}, restored = {}}, Operations)
end

function Operations:source(instance: any): string
	if not instance:IsA("LuaSourceContainer") then V.fail("CLASS", "Reference is not a script.") end
	return V.string(self.editor:GetEditorSource(instance), "script source", V.SOURCE_BYTES, true)
end

function Operations:record(command: any, guard: () -> (), action: (any) -> any): any
	guard()
	local recording = self.history:TryBeginRecording("Arcane." .. command.id, "Arcane " .. command.method)
	if not recording then V.fail("HISTORY", "Cannot begin an undo recording; no change was attempted.") end
	local progress: any = {touched = false}
	local ok, result = pcall(function()
		guard()
		local output = action(progress)
		guard()
		if #V.encode(output, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Mutation receipt exceeds 512 KiB.") end
		return output
	end)
	if ok then
		local committed = pcall(function() self.history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
		if committed then return result end
		progress.touched = true
		result = {code = "HISTORY", message = "Change applied but its undo recording could not be committed."}
	else
		-- Cancel only an untouched recording. A yielding editor write or partial
		-- property assignment is ambiguous; a broad undo could erase a later edit.
		local finish = if progress.touched then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		local finished = pcall(function() self.history:FinishRecording(recording, finish) end)
		if not finished then progress.touched = true end
	end
	if progress.touched then
		local recovery: any = {partial = true, needsReconciliation = true, rollbackVerified = false, commandId = command.id}
		if progress.ref then recovery.ref = progress.ref end
		error({code = "PARTIAL", message = V.safeError(result), recovery = recovery, unsafe = true}, 0)
	end
	error(result, 0)
end

function Operations:children(args: any): any
	V.fields(args, {"root", "ref", "limit"}, "children arguments")
	local root = self.registry:root(args.root)
	local parent = if args.ref then self.registry:resolve(args.ref) else root
	if self.registry:rootOf(parent) ~= args.root then V.fail("GRANT", "Parent is outside the requested root.") end
	local limit = if args.limit == nil then 100 else V.integer(args.limit, 1, 200, "limit")
	local children = parent:GetChildren()
	local items = V.array({})
	for index = 1, math.min(limit, #children) do table.insert(items, self.registry:node(children[index])) end
	return {items = items, truncated = #children > limit}
end

function Operations:search(args: any): any
	V.fields(args, {"root", "query", "limit"}, "search arguments")
	local root = self.registry:root(args.root)
	local query = string.lower(V.string(args.query, "query", 100))
	local limit = if args.limit == nil then 100 else V.integer(args.limit, 1, 200, "limit")
	local queue: {any} = {root}
	local items = V.array({})
	local head, visited, omitted = 1, 0, false
	while head <= #queue and visited < 5000 do
		local instance = queue[head]
		head += 1
		visited += 1
		if string.find(string.lower(instance.Name), query, 1, true) then
			if #items == limit then return {items = items, truncated = true} end
			table.insert(items, self.registry:node(instance))
		end
		for _, child in ipairs(instance:GetChildren()) do
			if #queue < 5000 then table.insert(queue, child) else omitted = true; break end
		end
	end
	return {items = items, truncated = omitted or head <= #queue}
end

function Operations:updateProperties(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"ref", "expected", "properties"}, "update arguments")
	local instance = self.registry:resolve(args.ref)
	local decoded, names = P.validate(instance, args.properties, self.registry:isService(instance))
	if #names == 0 then V.fail("INPUT", "Choose at least one property to update.") end
	P.validate(instance, args.expected, self.registry:isService(instance))
	for key in pairs(args.expected) do if not table.find(names, key) then V.fail("INPUT", "Expected properties must exactly cover the changed properties.") end end
	if not P.compare(instance, args.expected, names) then V.fail("CONFLICT", "Properties differ from the expected baseline.") end
	local ref = self.registry:ref(instance)
	local before = V.immutable(P.snapshot(instance, names))
	return self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(ref)
		if not P.compare(instance, args.expected, names) then V.fail("CONFLICT", "Properties changed before the write.") end
		progress.ref = ref
		for _, name in ipairs(names) do
			progress.touched = true
			instance[name] = decoded[name]
		end
		for _, name in ipairs(names) do if instance[name] ~= decoded[name] then V.fail("VERIFY", "Property write did not match the requested value.") end end
		return {ref = self.registry:ref(instance), mutation = {kind = "scene.update", ref = ref,
			before = {properties = before}, after = {properties = P.snapshot(instance, names)}}}
	end)
end

function Operations:updateSource(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"ref", "expectedSource", "source"}, "source arguments")
	local instance = self.registry:resolve(args.ref)
	local expected = V.string(args.expectedSource, "expected source", V.SOURCE_BYTES, true)
	local source = V.string(args.source, "source", V.SOURCE_BYTES, true)
	if self:source(instance) ~= expected then V.fail("CONFLICT", "Editor source differs from the expected baseline.") end
	local ref = self.registry:ref(instance)
	local proposed = {ref = ref, mutation = {kind = "script.update", ref = ref, before = {source = expected}, after = {source = source}}}
	if #V.encode(proposed, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Source receipt would exceed 512 KiB; no change attempted.") end
	return self:record(command, guard, function(progress: any): any
		local conflict = false
		self.editor:UpdateSourceAsync(instance, function(current: string): string?
			-- Roblox may invoke this callback again. Every invocation fences the
			-- session and compares the exact editor baseline; never yield here.
			guard()
			self.registry:resolve(ref)
			if current ~= expected then conflict = true end
			if conflict then return nil end
			progress.ref = ref
			progress.touched = true
			return source
		end)
		local observed = self:source(instance)
		if conflict then
			-- Once a callback proposed a write, keep the uncertainty flag sticky.
			V.fail("CONFLICT", "Editor changed during the source update.")
		end
		if observed ~= source then V.fail("VERIFY", "Editor source did not match after the update.") end
		return {ref = self.registry:ref(instance), mutation = {kind = "script.update", ref = ref,
			before = {source = expected}, after = {source = observed}}}
	end)
end

function Operations:create(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"parent", "className", "name", "properties"}, "create arguments")
	local parent = self.registry:resolve(args.parent)
	if type(args.className) ~= "string" or not table.find(P.CLASSES, args.className) then V.fail("CLASS", "Class is not creatable.") end
	local name = V.string(args.name, "name", 100)
	local properties = if args.properties == nil then {} else args.properties
	if self.registry.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	-- Decode the complete payload before allocating or parenting an Instance.
	V.object(properties, "properties")
	local decoded: {[string]: any} = {}
	for key, value in pairs(properties) do
		if key == "Name" then V.fail("PROPERTY", "Use the create name field.") end
		decoded[key] = P.decode(key, value, args.className == "Part")
	end
	local instance: any = nil
	local result = self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(args.parent)
		instance = Instance.new(args.className)
		local prepared, prepareError = pcall(function()
			instance.Name = name
			if instance:IsA("BaseScript") then instance.Disabled = true end
			for key, value in pairs(decoded) do instance[key] = value end
			for key, value in pairs(decoded) do if instance[key] ~= value then V.fail("VERIFY", "Created property differs from the requested value.") end end
			guard()
		end)
		if not prepared then instance:Destroy(); error(prepareError, 0) end
		progress.touched = true
		instance.Parent = parent
		local ref = self.registry:ref(instance)
		progress.ref = ref
		local snapshot = P.snapshot(instance)
		local source = if instance:IsA("LuaSourceContainer") then self:source(instance) else nil
		self.registry.owned[instance] = {parent = parent, properties = V.immutable(snapshot), source = source,
			attributes = V.immutable(instance:GetAttributes()), tags = V.immutable(self.collection:GetTags(instance))}
		return {ref = ref, mutation = {kind = "scene.create", ref = ref, before = V.NULL, after = {properties = snapshot}}}
	end)
	return result
end

function Operations:restore(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"receiptCommandId", "mutation"}, "restore arguments")
	local receiptId = V.string(args.receiptCommandId, "receipt command ID", 256)
	local original = self.mutations[receiptId]
	if not original or self.restored[receiptId] then V.fail("RECEIPT", "Receipt is unknown or already restored in this session.") end
	-- Do not trust a caller-supplied inverse, even on the paired daemon route.
	if not V.equal(original, args.mutation) then V.fail("RECEIPT", "Restoration payload differs from the immutable local receipt.") end
	local instance = self.registry:resolve(original.ref)
	if self.registry:isService(instance) then V.fail("SERVICE", "Services cannot be restored by mutation.") end
	if original.kind == "scene.create" then
		local owned = self.registry.owned[instance]
		local function matches(): boolean
			return owned ~= nil and instance.Parent == owned.parent and #instance:GetChildren() == 0
				and V.equal(P.snapshot(instance), original.after.properties)
				and V.equal(instance:GetAttributes(), owned.attributes)
				and V.equal(self.collection:GetTags(instance), owned.tags)
				and (owned.source == nil or self:source(instance) == owned.source)
		end
		if not matches() then V.fail("CONFLICT", "Created instance has changed, moved, or gained children; restoration refused.") end
		self:record(command, guard, function(progress: any): any
			guard()
			self.registry:resolve(original.ref)
			if not matches() then V.fail("CONFLICT", "Created instance changed before restoration.") end
			progress.ref = original.ref
			progress.touched = true
			instance:Destroy()
			return {restored = true, ref = original.ref}
		end)
	elseif original.kind == "scene.update" then
		self:updateProperties(command, {ref = original.ref, expected = original.after.properties, properties = original.before.properties}, guard)
	elseif original.kind == "script.update" then
		self:updateSource(command, {ref = original.ref, expectedSource = original.after.source, source = original.before.source}, guard)
	else V.fail("RECEIPT", "Unsupported mutation receipt.") end
	self.restored[receiptId] = true
	return {restored = true, ref = original.ref}
end

function Operations:execute(command: any, guard: () -> ()): any
	guard()
	local args = V.object(command.args, "arguments")
	local method = command.method
	local result: any
	if method == "scene.children" then result = self:children(args)
	elseif method == "scene.search" then result = self:search(args)
	elseif method == "scene.inspect" then
		V.fields(args, {"ref"}, "inspect arguments")
		local instance = self.registry:resolve(args.ref)
		local node = self.registry:node(instance)
		node.properties = P.snapshot(instance)
		result = node
	elseif method == "selection.read" then
		V.fields(args, {}, "selection arguments")
		local items = V.array({})
		for _, instance in ipairs(self.selection:Get()) do
			if self.registry:rootOf(instance) then
				if #items >= 200 then V.fail("BODY_LIMIT", "Selection exceeds 200 granted instances.") end
				table.insert(items, self.registry:node(instance))
			end
		end
		result = {items = items}
	elseif method == "script.read" then
		V.fields(args, {"ref"}, "read arguments")
		local instance = self.registry:resolve(args.ref)
		result = {ref = self.registry:ref(instance), source = self:source(instance)}
	elseif method == "scene.create" then result = self:create(command, args, guard)
	elseif method == "scene.update" then result = self:updateProperties(command, args, guard)
	elseif method == "script.update" then result = self:updateSource(command, args, guard)
	elseif method == "scene.restore" then result = self:restore(command, args, guard)
	else V.fail("METHOD", "Unsupported Studio method.") end
	if not table.find(V.WRITE_METHODS, method) then guard() end
	if #V.encode(result, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Result exceeds 512 KiB.") end
	result = V.immutable(result)
	if result.mutation then self.mutations[command.id] = result.mutation end
	return result
end

return Operations
end
-- END Operations.luau

-- BEGIN Transport.luau
__arcaneFactories["Transport"] = function()
local V = __arcaneRequire("Validation")
local Operations = __arcaneRequire("Operations")
local Transport = {}
Transport.__index = Transport
Transport.POLL_SECONDS = 2
Transport.MAX_BACKOFF_SECONDS = 30
local ROUTES = table.freeze({connect = "/v1/plugin/connect", pair = "/v1/plugin/pair", poll = "/v1/plugin/poll", result = "/v1/plugin/result", disconnect = "/v1/plugin/disconnect"})
type Transport = any

function Transport.new(gameModel: any, onStatus: (any) -> ()): Transport
	local http = gameModel:GetService("HttpService")
	return setmetatable({gameModel = gameModel, http = http, run = gameModel:GetService("RunService"),
		clientSessionId = http:GenerateGUID(false), onStatus = onStatus, generation = 0,
		pair = nil, desiredPair = nil, disconnectRequested = false, stopped = false,
		inFlight = false, started = false, failures = 0, cache = {}, cacheCount = 0,
		cacheBytes = 0, highEpoch = 0, pending = nil, blocked = false}, Transport)
end

function Transport:status(state: string, detail: string, commandId: string?)
	if self.stopped then return end
	local pair = if self.pair and self.generation == self.pair.generation and not self.disconnectRequested then self.pair else nil
	self.onStatus({state = state, detail = detail, commandId = commandId,
		sessionId = if pair then pair.sessionId else nil,
		allowedRoots = if pair then table.clone(pair.allowedRoots) else {},
		allowWrites = if pair then pair.allowWrites else false,
		clientSessionId = self.clientSessionId, editMode = self.run:IsEdit()})
end


function Transport:forgetDesired(): ()
	local desired = self.desiredPair
	if desired then desired.code = nil; desired.apiKey = nil end
	self.desiredPair = nil
end

function Transport:requestConnect(apiKey: any): ()
	if self.stopped then return end
	local origin = V.keyOrigin(apiKey)
	if not self.run:IsEdit() then V.fail("PLAY", "Stop playtesting before connecting.") end
	self.generation += 1
	self:forgetDesired()
	self.desiredPair = {url = origin, apiKey = apiKey, generation = self.generation}
	self.disconnectRequested = true
	self:status("connecting", "Connecting to the Arcane workbench.")
end

-- Compatibility entry point for legacy fixtures; never exposed by Main.
function Transport:requestPair(url: any, code: any): ()
	if self.stopped then return end
	local origin = V.url(url)
	local pairingCode = V.string(code, "pairing code", 128)
	if not self.run:IsEdit() then V.fail("PLAY", "Stop playtesting before pairing.") end
	self.generation += 1 -- Immediately fences callbacks already waiting on Studio.
	self:forgetDesired()
	self.desiredPair = {url = origin, code = pairingCode, generation = self.generation}
	self.disconnectRequested = true
	self:status("pairing", "Pairing requested; waiting for the current request to finish.")
end

function Transport:requestDisconnect(): ()
	if self.stopped then return end
	self.generation += 1
	self:forgetDesired()
	self.disconnectRequested = true
	self:status("disconnecting", "Local writes are fenced; disconnecting from the daemon.")
end

function Transport:stop(): ()
	-- Unloading must not yield or launch a second network request. The daemon
	-- observes heartbeat loss; no token or session state is saved anywhere.
	self.generation += 1
	self.stopped = true
	self:forgetDesired()
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self.operations = nil
	self.pending = nil
	self.cache = {}
end

function Transport:post(url: string, route: string, payload: any, token: string?): any
	V.url(url)
	if not table.find({ROUTES.connect, ROUTES.pair, ROUTES.poll, ROUTES.result, ROUTES.disconnect}, route) then V.fail("URL", "Unsupported plugin route.") end
	if self.inFlight then V.fail("FLIGHT", "Another HTTP request is in flight.") end
	local headers = { ["Content-Type"] = "application/json", ["Accept"] = "application/json" }
	if token then headers.Authorization = "Bearer " .. token end
	local body = V.encode(payload, self.http)
	if #body > V.RESULT_BYTES + 4096 then V.fail("BODY_LIMIT", "Request exceeds the transport bound.") end
	self.inFlight = true
	local ok, response = pcall(function()
		return self.http:RequestAsync({Url = url .. route, Method = "POST", Headers = headers, Body = body, Timeout = 10})
	end)
	self.inFlight = false
	if not ok then V.fail("NETWORK", "Loopback request failed or timed out.") end
	if type(response) ~= "table" or type(response.StatusCode) ~= "number" or type(response.Success) ~= "boolean" then V.fail("PROTOCOL", "Invalid HTTP response.") end
	-- Never inspect/follow Location, and never construct a URL from a response.
	-- RequestAsync documents Timeout, but no redirect-disable option. Native redirect
	-- behavior still needs a disposable-fixture check; see docs/build/PLUGIN.md.
	if response.StatusCode >= 300 and response.StatusCode < 400 then V.fail("REDIRECT", "Daemon returned a redirect; connection refused.") end
	if response.StatusCode == 401 or response.StatusCode == 403 then V.fail("REVOKED", "Session expired or was revoked; connect again.") end
	if response.StatusCode == 409 then V.fail("RECONCILE", "Daemon refused the session or receipt; inspect the command and connect again.") end
	if not response.Success then V.fail("NETWORK", "Daemon request failed (HTTP " .. tostring(response.StatusCode) .. ").") end
	if type(response.Body) ~= "string" or #response.Body > V.RESULT_BYTES + V.ARGUMENT_BYTES + 8192 then V.fail("BODY_LIMIT", "Daemon response exceeds the transport bound.") end
	local decoded, data = pcall(function() return V.decode(response.Body, self.http) end)
	if not decoded then V.fail("PROTOCOL", "Daemon response is not valid JSON.") end
	return V.object(data, "daemon response")
end

function Transport:clearSession(): ()
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self.operations = nil
	self.pending = nil
	self.cache = {}
	self.cacheCount, self.cacheBytes, self.highEpoch = 0, 0, 0
	self.blocked = false
end

function Transport:exchange(desired: any): ()
	if self.stopped or desired.generation ~= self.generation then desired.code = nil; desired.apiKey = nil; return end
	local capabilities = table.clone(V.READ_METHODS)
	for _, method in ipairs(V.WRITE_METHODS) do table.insert(capabilities, method) end
	local isKey = desired.apiKey ~= nil
	local payload: any = {
		protocolVersion = V.PROTOCOL,
		identity = {clientSessionId = self.clientSessionId, placeId = self.gameModel.PlaceId,
			universeId = self.gameModel.GameId, name = string.sub(self.gameModel.Name, 1, 256), pluginVersion = V.VERSION},
		capabilities = V.array(capabilities),
	}
	if isKey then payload.apiKey = desired.apiKey else payload.code = desired.code end
	desired.apiKey, desired.code = nil, nil
	local result = self:post(desired.url, if isKey then ROUTES.connect else ROUTES.pair, payload, nil)
	payload.apiKey, payload.code = nil, nil
	V.fields(result, {"sessionId", "token", "protocolVersion", "allowedRoots", "allowWrites"}, "pair result")
	if result.protocolVersion ~= V.PROTOCOL then V.fail("PROTOCOL", "Unsupported daemon protocol.") end
	V.string(result.sessionId, "session ID", 256)
	V.string(result.token, "session token", 4096)
	result.allowedRoots = V.roots(result.allowedRoots)
	V.boolean(result.allowWrites, "write grant")
	-- Keep a late pair only long enough to revoke it in the single worker loop.
	result.url = desired.url
	result.generation = desired.generation
	if self.stopped then result.token = nil; return end
	local operations = Operations.new(result, self.gameModel, self.http)
	self.pair = result
	self.operations = operations
	self.failures = 0
	if self.generation ~= desired.generation then self.disconnectRequested = true; return end
	self:status("connected", "Connected to this Studio window. " .. (if result.allowWrites then "Writes granted." else "Read only."))
end

function Transport:envelope(command: any): ()
	V.object(command, "command")
	local pair = self.pair
	if not pair or command.protocolVersion ~= V.PROTOCOL or command.sessionId ~= pair.sessionId
		or command.clientSessionId ~= self.clientSessionId or command.state ~= "dispatched" then
		V.fail("SESSION", "Command targets another session or has an invalid protocol/state.")
	end
	V.string(command.id, "command ID", 256)
	V.string(command.requestId, "request ID", 256)
	V.integer(command.leaseEpoch, 1, 9007199254740991, "lease epoch")
	local roots = V.roots(command.allowedRoots)
	if #roots ~= #pair.allowedRoots then V.fail("GRANT", "Command root grants differ from pairing.") end
	for _, root in ipairs(roots) do if not table.find(pair.allowedRoots, root) then V.fail("GRANT", "Command root is not granted.") end end
	if command.allowWrites ~= pair.allowWrites then V.fail("GRANT", "Command write grant differs from pairing.") end
	if not table.find(V.READ_METHODS, command.method) and not table.find(V.WRITE_METHODS, command.method) then V.fail("METHOD", "Unsupported Studio method.") end
	V.string(command.expiresAt, "command expiry", 64)
	V.object(command.args, "arguments")
	if #V.encode(command.args, self.http) > V.ARGUMENT_BYTES then V.fail("BODY_LIMIT", "Arguments exceed 256 KiB.") end
end

function Transport:guard(command: any, pair: any): ()
	if self.stopped or self.blocked or self.pair ~= pair or self.generation ~= pair.generation
		or self.disconnectRequested then V.fail("SESSION", "Local session was disconnected or replaced.") end
	self:envelope(command)
	if command.leaseEpoch ~= self.highEpoch then V.fail("LEASE", "Command lease is stale.") end
	-- DateTime.fromIsoDate accepts UTC RFC3339 daemon timestamps.
	if not string.match(command.expiresAt, "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d.*Z$") then V.fail("LEASE", "Expiry must be a UTC timestamp.") end
	local ok, expires = pcall(function() return DateTime.fromIsoDate(command.expiresAt) end)
	if not ok or not expires or expires.UnixTimestampMillis <= DateTime.now().UnixTimestampMillis then V.fail("LEASE", "Command lease has expired.") end
	if not self.run:IsEdit() then V.fail("PLAY", "Commands are only available in Studio edit mode.") end
	if table.find(V.WRITE_METHODS, command.method) and not pair.allowWrites then V.fail("GRANT", "Session is read only.") end
end

function Transport:dispatch(command: any): ()
	self:envelope(command)
	local fingerprint = V.encode(command, self.http)
	local cached = self.cache[command.id]
	if cached then
		if cached.fingerprint ~= fingerprint then V.fail("RECONCILE", "Command ID was reused with a different payload.") end
		self.pending = cached -- Resend the immutable receipt; never execute twice.
		return
	end
	if command.leaseEpoch <= self.highEpoch then V.fail("LEASE", "New command has an old lease epoch.") end
	-- Fail closed without evicting command IDs or unacknowledged receipts.
	if self.cacheCount >= V.MAX_RECEIPTS or self.cacheBytes + #fingerprint + V.RESULT_BYTES + 4096 > V.MAX_CACHE_BYTES then
		V.fail("CAPACITY", "Session receipt capacity reached; inspect receipts and connect again.")
	end
	self.highEpoch = command.leaseEpoch
	local pair = self.pair
	self:status("executing", command.method, command.id)
	local ok, output = pcall(function()
		self:guard(command, pair)
		return self.operations:execute(command, function() self:guard(command, pair) end)
	end)
	local unsafe = not ok and type(output) == "table" and output.unsafe == true
	local payload: any = {sessionId = pair.sessionId, commandId = command.id,
		state = if ok then "succeeded" else "failed"}
	if ok then payload.result = output
	else
		payload.error = V.safeError(output)
		if unsafe then payload.result = output.recovery end
	end
	local encoded = V.encode(payload, self.http)
	local entry = {fingerprint = fingerprint, body = V.immutable(payload), unsafe = unsafe, acknowledged = false}
	self.cache[command.id] = entry
	self.cacheCount += 1
	self.cacheBytes += #fingerprint + #encoded
	self.pending = entry
	if unsafe then self.blocked = true end
end

function Transport:tick(): number
	if self.disconnectRequested then
		local old = self.pair
		if old and old.token then
			-- Best effort revoke, never retry a disconnect forever while pairing.
			pcall(function() self:post(old.url, ROUTES.disconnect, {sessionId = old.sessionId}, old.token) end)
		end
		self:clearSession()
		self.disconnectRequested = false
		if not self.desiredPair then self:status("disconnected", "Disconnected. Enter your Arcane API key and click Connect.") end
	end
	if self.desiredPair then
		local desired = self.desiredPair
		self.desiredPair = nil
		-- Human-triggered exchanges are never automatically retried after an
		-- uncertain response: a session may already exist at the daemon.
		local ok, err = pcall(function() self:exchange(desired) end)
		desired.code, desired.apiKey = nil, nil
		if not ok then self:status("disconnected", V.safeError(err) .. " Click Connect to try again.") end
		return Transport.POLL_SECONDS
	end
	local pair = self.pair
	if not pair then return Transport.POLL_SECONDS end
	if self.pending then
		local receipt = self.pending
		local response = self:post(pair.url, ROUTES.result, receipt.body, pair.token)
		if response.accepted ~= true then V.fail("RECONCILE", "Daemon did not acknowledge the receipt.") end
		receipt.acknowledged = true
		self.pending = nil
		self:status(if self.blocked then "reconciliation" else "connected",
			if self.blocked then "Partial change: inspect the command and place before pairing again." else "Receipt acknowledged.", receipt.body.commandId)
		return Transport.POLL_SECONDS
	end
	if self.blocked then return Transport.POLL_SECONDS end
	local response = self:post(pair.url, ROUTES.poll, {sessionId = pair.sessionId}, pair.token)
	-- A poll that returns after disconnect/re-pair can never dispatch old work.
	if self.stopped or self.pair ~= pair or self.generation ~= pair.generation or self.disconnectRequested then return Transport.POLL_SECONDS end
	V.fields(response, {"commands"}, "poll response")
	local commands = V.list(response.commands, 1, "command queue")
	if #commands == 1 then self:dispatch(commands[1])
	else self:status("connected", if self.run:IsEdit() then "Connected; waiting for commands." else "Connected; commands are fenced during playtesting.") end
	return Transport.POLL_SECONDS
end

function Transport:cycle(): number
	local ok, delay = pcall(function() return self:tick() end)
	if ok then self.failures = 0; return delay end
	if type(delay) == "table" and delay.code == "NETWORK" then
		self.failures = math.min(self.failures + 1, 5)
		local backoff = math.min(Transport.MAX_BACKOFF_SECONDS, Transport.POLL_SECONDS * 2 ^ self.failures)
		self:status("retrying", "Loopback unavailable; retrying in " .. tostring(backoff) .. " seconds. Completed work will only resend its receipt.")
		return backoff
	end
	self.blocked = true
	if type(delay) == "table" and delay.code == "REVOKED" then
		self:clearSession()
		self.generation += 1
		self:status("disconnected", V.safeError(delay))
	else self:status("reconciliation", V.safeError(delay)) end
	return Transport.MAX_BACKOFF_SECONDS
end

function Transport:start(): ()
	if self.started then return end
	self.started = true
	task.spawn(function()
		while not self.stopped do
			local delay = self:cycle()
			if self.stopped then break end
			task.wait(delay)
		end
	end)
end

return Transport
end
-- END Transport.luau

table.freeze(__arcaneFactories)

-- BEGIN Main.server.luau
local function __arcaneMain(): ()
-- Local plugin UI only. Secrets are transient input and transport memory.
local V = __arcaneRequire("Validation")
local Transport = __arcaneRequire("Transport")
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
end
__arcaneMain()
-- END Main.server.luau
