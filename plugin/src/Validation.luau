--!strict
local Validation = {}
Validation.PROTOCOL = 1
Validation.VERSION = "0.1.3"
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
