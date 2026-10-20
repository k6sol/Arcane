--!strict
local Validation = {}
Validation.PROTOCOL = 1
Validation.VERSION = "0.2.0"
Validation.ARGUMENT_BYTES = 256 * 1024
Validation.RESULT_BYTES = 512 * 1024
Validation.SOURCE_BYTES = 100 * 1024
Validation.MAX_REFS = 20000
Validation.MAX_RECEIPTS = 1024
Validation.MAX_CACHE_BYTES = 16 * 1024 * 1024
Validation.NULL = table.freeze({})
local ARRAY = table.freeze({})
Validation.ROOTS = table.freeze({"Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPlayer", "Lighting"})
Validation.READ_METHODS = table.freeze({"scene.children", "scene.inspect", "scene.search", "selection.read", "script.read", "script.search", "scene.import_context", "scene.upload_context", "scene.asset_watch", "output.read"})
Validation.WRITE_METHODS = table.freeze({"scene.create", "scene.update", "script.update", "script.set_enabled", "scene.restore", "scene.remove", "scene.build", "environment.apply", "scene.place_asset", "scene.apply_material", "terrain.generate"})
Validation.REMOVE_LIMITS = table.freeze({targets = 64, topLevel = 10000, descendants = 100000})
Validation.BUILD_LIMITS = table.freeze({items = 2000, prototypes = 32, prototypeParts = 64, instances = 4000, keys = 32})
Validation.BUILD_PART_CLASSES = table.freeze({"Part", "WedgePart", "CornerWedgePart", "SpawnLocation"})
Validation.ASSET_STAGE_METHODS = table.freeze({"asset.stage_packet", "asset.reconstruct"})
-- Keep this mesh: host-only upload + swap; advertised only when the Studio upload API probe passes (AssetPlacement.keepSupported).
Validation.MESH_KEEP_METHODS = table.freeze({"asset.keep_mesh"})
-- Non-method feature capabilities (effects classes, environment extras, inspect bounds; GUI classes and ScreenGui builds;
-- character classes: Humanoid, HumanoidDescription, AnimationController, Animator).
Validation.FEATURE_CAPABILITIES = table.freeze({"scene.effects", "scene.gui", "scene.gui.flex", "scene.gui.edit", "scene.characters", "asset.mesh_parts", "scene.search.class"})
Validation.CREATE_CLASSES = table.freeze({"Folder", "Model", "Part", "Script", "LocalScript", "ModuleScript", "WedgePart", "CornerWedgePart", "SpawnLocation"})
Validation.BASE_PART_CLASSES = table.freeze({"Part", "FlagStand", "Platform", "Seat", "SkateboardPlatform", "SpawnLocation", "MeshPart", "UnionOperation", "NegateOperation", "IntersectOperation", "WedgePart", "CornerWedgePart", "TrussPart", "VehicleSeat"})
Validation.PART_SHAPE_CLASSES = table.freeze({"Part", "FlagStand", "Platform", "Seat", "SkateboardPlatform", "SpawnLocation"})
Validation.SHAPES = table.freeze({"Block", "Ball", "Cylinder"})
Validation.MAX_PROPERTIES = 12

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

-- Protocol enum names are data. Resolve only a bounded enum and verify the
-- native result before recording, allocating, or assigning any property.
function Validation.enum(value: any, allowed: {string}, category: any, label: string): any
	if type(value) ~= "string" or not table.find(allowed, value) then Validation.fail("PROPERTY", "Unsupported " .. label .. ".") end
	local ok, item = pcall(function() return category[value] end)
	if not ok or typeof(item) ~= "EnumItem" or item.EnumType ~= category or item.Name ~= value then
		Validation.fail("PROPERTY", "Native " .. label .. " enum is unavailable.")
	end
	return item
end

-- Extend the frozen legacy codec without changing its six-class public list.
-- Creation uses reflected class allowlists; existing objects use native IsA.
function Validation.geometryProperties(legacy: any): any
	local codec: any = {CLASSES = Validation.CREATE_CLASSES, MATERIALS = legacy.MATERIALS}
	local fields = table.clone(legacy.PART_FIELDS)
	for _, name in ipairs({"Orientation", "CastShadow", "Reflectance"}) do table.insert(fields, name) end
	codec.PART_FIELDS = table.freeze(fields)
	function codec.decode(name: string, value: any, isBasePart: boolean, isPart: boolean?): any
		if name == "Shape" then
			if not isPart then Validation.fail("PROPERTY", "Shape requires a native Part.") end
			return Validation.enum(value, Validation.SHAPES, Enum.PartType, name)
		end
		if name == "Orientation" or name == "CastShadow" or name == "Reflectance" then
			if not isBasePart then Validation.fail("PROPERTY", "Property requires a native BasePart.") end
			if name == "CastShadow" then return Validation.boolean(value, name) end
			if name == "Reflectance" then return Validation.number(value, 0, 1, name) end
			local tag = Validation.fields(value, {"type", "value"}, "tagged property")
			if tag.type ~= "Vector3" then Validation.fail("PROPERTY", "Incorrect property type tag.") end
			local components = Validation.list(tag.value, 3, "components")
			if #components ~= 3 then Validation.fail("PROPERTY", "Property needs three components.") end
			for _, component in ipairs(components) do Validation.number(component, -360, 360, name) end
			return Vector3.new(components[1], components[2], components[3])
		end
		if name == "Material" then
			if not isBasePart then Validation.fail("PROPERTY", "Property requires a native BasePart.") end
			return Validation.enum(value, legacy.MATERIALS, Enum.Material, name)
		end
		return legacy.decode(name, value, isBasePart)
	end
	function codec.encode(name: string, value: any): any
		if name == "Orientation" then return {type = "Vector3", value = Validation.array({value.X, value.Y, value.Z})} end
		if name == "Shape" then return value.Name end
		return legacy.encode(name, value)
	end
	function codec.validate(instance: any, values: any, service: boolean): ({[string]: any}, {string})
		Validation.object(values, "properties")
		local decoded: {[string]: any}, names: {string} = {}, {}
		for name, value in pairs(values) do
			if service then Validation.fail("SERVICE", "Service properties cannot be changed.") end
			if #names >= Validation.MAX_PROPERTIES then Validation.fail("INPUT", "Too many properties.") end
			decoded[name] = codec.decode(name, value, instance:IsA("BasePart"), instance:IsA("Part"))
			table.insert(names, name)
		end
		table.sort(names)
		return decoded, names
	end
	function codec.snapshot(instance: any, names: {string}?): {[string]: any}
		local selected: {string} = names or {"Name"}
		if not names and instance:IsA("BasePart") then
			selected = table.clone(codec.PART_FIELDS)
			table.insert(selected, "Name")
			if instance:IsA("Part") then table.insert(selected, "Shape") end
		end
		local result: {[string]: any} = {}
		for _, name in ipairs(selected) do result[name] = codec.encode(name, instance[name]) end
		if not names and instance:IsA("BaseScript") then result.Disabled = instance.Disabled end
		return result
	end
	function codec.compare(instance: any, expected: any, names: {string}): boolean
		local decoded = codec.validate(instance, expected, false)
		for _, name in ipairs(names) do
			if expected[name] == nil or instance[name] ~= decoded[name] then return false end
		end
		return true
	end

	function codec.assignedMatches(instance: any, name: string, requested: any): boolean
		if name == "Orientation" then
			-- Euler values wrap and can have equivalent gimbal representations.
			-- Check the actual rotation, not a relaxed expected-baseline match.
			local desired = {CFrame.fromOrientation(math.rad(requested.X), math.rad(requested.Y), math.rad(requested.Z)):GetComponents()}
			local actual = {instance.CFrame:GetComponents()}
			for index = 4, 12 do
				if math.abs(actual[index] - desired[index]) > 0.000001 then return false end
			end
			return true
		end
		return legacy.assignedMatches(instance, name, requested)
	end
	-- Verification against a value already read back once (scene.build reads each snapshot
	-- field exactly once and verifies from it). An Orientation read back bit-identical to the
	-- request is the same rotation; anything else falls back to the full rotation-matrix check.
	function codec.readMatches(instance: any, name: string, requested: any, actual: any): boolean
		if name == "Orientation" then return actual == requested or codec.assignedMatches(instance, name, requested) end
		return legacy.readMatches(name, requested, actual)
	end
	-- The managed property names retained privately for creation/build ownership checks.
	-- Depends only on the class, so a build computes it once per class.
	function codec.snapshotFields(instance: any): {string}
		local selected: {string} = {"Name"}
		if instance:IsA("BasePart") then
			selected = table.clone(codec.PART_FIELDS)
			table.insert(selected, "Name")
			if instance:IsA("Part") then table.insert(selected, "Shape") end
		end
		if instance:IsA("BaseScript") then table.insert(selected, "Disabled") end
		local specs = legacy.specsOf(instance.ClassName)
		if specs then
			for name in pairs(specs) do if not table.find(selected, name) then table.insert(selected, name) end end
			table.sort(selected)
		end
		return table.freeze(selected)
	end
	-- Ownership baselines are exact. Post-assignment tolerances never authorize deleting a later manual edit.
	local function sameValue(a: any, b: any): boolean
		if a == nil then a = Validation.NULL end
		if b == nil then b = Validation.NULL end
		local kind = typeof(a)
		if kind ~= typeof(b) then return false end
		if kind == "NumberSequence" or kind == "ColorSequence" then
			local first, second = a.Keypoints, b.Keypoints
			if #first ~= #second then return false end
			for index, point in ipairs(first) do
				local other = second[index]
				if point.Time ~= other.Time or not sameValue(point.Value, other.Value) then return false end
				if kind == "NumberSequence" and point.Envelope ~= other.Envelope then return false end
			end
			return true
		elseif kind == "Font" then return a.Family == b.Family and a.Weight == b.Weight and a.Style == b.Style
		elseif kind == "Color3" then return a.R == b.R and a.G == b.G and a.B == b.B
		elseif kind == "Vector2" then return a.X == b.X and a.Y == b.Y
		elseif kind == "Vector3" then return a.X == b.X and a.Y == b.Y and a.Z == b.Z
		elseif kind == "UDim" then return a.Scale == b.Scale and a.Offset == b.Offset
		elseif kind == "UDim2" then return sameValue(a.X, b.X) and sameValue(a.Y, b.Y)
		elseif kind == "NumberRange" then return a.Min == b.Min and a.Max == b.Max
		elseif kind == "CFrame" then
			local first, second = {a:GetComponents()}, {b:GetComponents()}
			for index, value in ipairs(first) do if value ~= second[index] then return false end end
			return true
		end
		return a == b
	end
	local function sameMap(a: any, b: any): boolean
		local count = 0
		for key, value in pairs(a) do if b[key] == nil or not sameValue(value, b[key]) then return false end; count += 1 end
		for _ in pairs(b) do count -= 1 end
		return count == 0
	end
	local function tagsOf(instance: any, collection: any): any
		local result = {}
		for _, tag in ipairs(collection:GetTags(instance)) do result[tag] = true end
		return result
	end
	function codec.captureOwnership(instance: any, collection: any, properties: any?): any
		if properties == nil then
			properties = {}
			for _, name in ipairs(codec.snapshotFields(instance)) do
				local value = instance[name]
				properties[name] = if value == nil then Validation.NULL else value
			end
			properties = table.freeze(properties)
		end
		return table.freeze({properties = properties, attributes = table.freeze(table.clone(instance:GetAttributes())), tags = table.freeze(tagsOf(instance, collection))})
	end
	function codec.ownershipMatches(instance: any, collection: any, owned: any): boolean
		for name, value in pairs(owned.properties) do if not sameValue(instance[name], value) then return false end end
		return sameMap(instance:GetAttributes(), owned.attributes) and sameMap(tagsOf(instance, collection), owned.tags)
	end
	return table.freeze(codec)
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
			-- Printable ASCII without quote, backslash or slash needs no escaping: skip the engine call.
			if not string.find(item, "[^ -~]") and not string.find(item, '["/\\]') then return '"' .. item .. '"' end
			if utf8.len(item) == nil then Validation.fail("INPUT", "Invalid UTF-8.") end
			return http:JSONEncode(item)
		end
		if kind == "boolean" then return if item then "true" else "false" end
		if kind == "number" then
			Validation.number(item, -math.huge, math.huge, "JSON number")
			-- Safe integers print exactly as decimal digits; other numbers keep the engine encoder.
			if item % 1 == 0 and math.abs(item) < 9007199254740992 and not (item == 0 and 1 / item < 0) then return string.format("%d", item) end
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
		for _, key in ipairs(keys) do table.insert(pieces, encode(key, depth + 1) .. ":" .. encode(item[key], depth + 1)) end
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
		while true do
			local byte = string.byte(text, cursor)
			if byte ~= 32 and byte ~= 9 and byte ~= 13 and byte ~= 10 then return end
			cursor += 1
		end
	end
	-- Jumps between quote, backslash and control bytes instead of stepping every byte. A string
	-- with no escape is the raw slice: the whole text already passed utf8.len, and a slice
	-- between two ASCII quotes stays valid UTF-8, so the engine unescaper is only needed (and
	-- only called) for strings that contain an escape.
	local function quoted(): string
		local start = cursor
		cursor += 1
		local escaped = false
		while true do
			local at = string.find(text, '[%c"\\]', cursor)
			if not at then return invalid() end
			local byte = string.byte(text, at)
			if byte == 34 then
				cursor = at + 1
				if not escaped then return string.sub(text, start + 1, at - 1) end
				local ok, value = pcall(function() return http:JSONDecode(string.sub(text, start, at)) end)
				if not ok or type(value) ~= "string" or utf8.len(value) == nil then invalid() end
				return value
			elseif byte == 92 then
				escaped = true
				local escape = string.sub(text, at + 1, at + 1)
				if escape == "u" then
					if not string.match(string.sub(text, at + 2, at + 5), "^%x%x%x%x$") then invalid() end
					cursor = at + 6
				elseif escape == "" or not string.find('"\\/bfnrt', escape, 1, true) then invalid()
				else cursor = at + 2 end
			elseif byte == 127 then
				cursor = at + 1 -- DEL is a legal unescaped JSON string byte.
			else invalid() end
		end
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
