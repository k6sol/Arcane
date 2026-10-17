--!strict
local V = require(script.Parent.Validation)
local Properties = {}
Properties.PART_FIELDS = table.freeze({"Size", "Position", "Color", "Anchored", "CanCollide", "Transparency", "Material"})
Properties.CLASSES = table.freeze({"Folder", "Model", "Part", "Script", "LocalScript", "ModuleScript"})
Properties.MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Metal", "Wood", "WoodPlanks", "Concrete", "Brick", "Glass", "Neon", "Slate", "Sand", "Fabric", "Grass", "Ground", "Rock", "Cobblestone", "Asphalt", "Marble", "Granite", "Limestone", "Sandstone", "Basalt", "Pebble", "LeafyGrass", "Mud", "Snow", "Ice", "Pavement", "Plaster", "DiamondPlate", "CorrodedMetal", "Foil"})

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

-- Post-assignment verification only. Baseline comparison above stays exact.
-- Native BasePart.Color stores RGB8: the engine multiplies float32 channels
-- by 255 in float32, then truncates. Double arithmetic would corrupt some
-- already-canonical byte values (for example 7/255).
function Properties.assignedMatches(instance: any, name: string, requested: any): boolean
	if name == "Color" then
		local product = buffer.create(4)
		local function channel(value: number): number
			buffer.writef32(product, 0, value * 255)
			return math.floor(buffer.readf32(product, 0))
		end
		local canonical = Color3.fromRGB(channel(requested.R), channel(requested.G), channel(requested.B))
		return instance.Color == canonical
	end
	return instance[name] == requested
end

-- Effects classes. Fixed allowlist mirrored from packages/core/src/studio-policy.ts EFFECT_PROPERTIES;
-- the daemon validates first, this module re-validates, assigns and verifies every value read back.
local NORMAL_IDS = {"Top", "Bottom", "Left", "Right", "Front", "Back"}
local function merge(...: any): any
	local result = {}
	for _, source in ipairs({...}) do for key, value in pairs(source) do result[key] = value end end
	return result
end
local LIGHT = {Brightness = {"number", 0, 40}, Range = {"number", 0, 60}, Color = {"color"}, Shadows = {"boolean"}, Enabled = {"boolean"}}
local FACED_LIGHT = merge(LIGHT, {Angle = {"number", 0, 180}, Face = {"enum", "NormalId", NORMAL_IDS}})
local GLOW = {LightEmission = {"number", 0, 1}, LightInfluence = {"number", 0, 1}, Brightness = {"number", 0, 20}}
local TEXTURE_MODE = {"enum", "TextureMode", {"Stretch", "Wrap", "Static"}}
local DECAL = {Texture = {"content"}, Face = {"enum", "NormalId", NORMAL_IDS}, Color3 = {"color"}, Transparency = {"number", 0, 1}}
Properties.EFFECT_SPECS = table.freeze({
	Attachment = {Position = {"vector3", -2048, 2048}, Orientation = {"vector3", -360, 360}},
	ParticleEmitter = merge(GLOW, {Enabled = {"boolean"}, Rate = {"number", 0, 500}, Lifetime = {"range", 0, 20}, Speed = {"range", 0, 500},
		SpreadAngle = {"vector2", -360, 360}, Acceleration = {"vector3", -500, 500}, Drag = {"number", 0, 50}, Size = {"sequence", 0, 100},
		Transparency = {"sequence", 0, 1}, Squash = {"sequence", -3, 3}, Color = {"colorSequence"}, Rotation = {"range", -360, 360}, RotSpeed = {"range", -1000, 1000},
		Orientation = {"enum", "ParticleOrientation", {"FacingCamera", "FacingCameraWorldUp", "VelocityParallel", "VelocityPerpendicular"}},
		EmissionDirection = {"enum", "NormalId", NORMAL_IDS}, Shape = {"enum", "ParticleEmitterShape", {"Box", "Sphere", "Cylinder", "Disc"}},
		ShapeStyle = {"enum", "ParticleEmitterShapeStyle", {"Volume", "Surface"}}, ShapeInOut = {"enum", "ParticleEmitterShapeInOut", {"Outward", "Inward", "InAndOut"}},
		LockedToPart = {"boolean"}, ZOffset = {"number", -50, 50}, TimeScale = {"number", 0, 1}, Texture = {"content"}}),
	Beam = merge(GLOW, {Attachment0 = {"attachment"}, Attachment1 = {"attachment"}, Color = {"colorSequence"}, Transparency = {"sequence", 0, 1},
		Width0 = {"number", 0, 100}, Width1 = {"number", 0, 100}, CurveSize0 = {"number", -100, 100}, CurveSize1 = {"number", -100, 100}, Segments = {"integer", 1, 100},
		FaceCamera = {"boolean"}, Enabled = {"boolean"}, Texture = {"content"}, TextureMode = TEXTURE_MODE, TextureLength = {"number", 0.01, 100},
		TextureSpeed = {"number", -100, 100}, ZOffset = {"number", -50, 50}}),
	Trail = merge(GLOW, {Attachment0 = {"attachment"}, Attachment1 = {"attachment"}, Color = {"colorSequence"}, Transparency = {"sequence", 0, 1},
		WidthScale = {"sequence", 0, 10}, Lifetime = {"number", 0.01, 20}, MinLength = {"number", 0, 100}, MaxLength = {"number", 0, 1000},
		FaceCamera = {"boolean"}, Enabled = {"boolean"}, Texture = {"content"}, TextureMode = TEXTURE_MODE, TextureLength = {"number", 0.01, 100}}),
	PointLight = LIGHT, SpotLight = FACED_LIGHT, SurfaceLight = FACED_LIGHT,
	Highlight = {FillColor = {"color"}, OutlineColor = {"color"}, FillTransparency = {"number", 0, 1}, OutlineTransparency = {"number", 0, 1},
		DepthMode = {"enum", "HighlightDepthMode", {"AlwaysOnTop", "Occluded"}}, Enabled = {"boolean"}},
	Fire = {Size = {"number", 2, 30}, Heat = {"number", -25, 25}, Color = {"color"}, SecondaryColor = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Smoke = {Size = {"number", 0.1, 100}, Opacity = {"number", 0, 1}, RiseVelocity = {"number", -25, 25}, Color = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Sparkles = {SparkleColor = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Decal = DECAL,
	Texture = merge(DECAL, {StudsPerTileU = {"number", 0.01, 1000}, StudsPerTileV = {"number", 0.01, 1000}, OffsetStudsU = {"number", -1000, 1000}, OffsetStudsV = {"number", -1000, 1000}}),
})
Properties.EFFECT_HOSTS = table.freeze({Attachment = {"part"}, ParticleEmitter = {"part", "attachment"}, PointLight = {"part", "attachment"},
	SpotLight = {"part", "attachment"}, SurfaceLight = {"part"}, Fire = {"part", "attachment"}, Smoke = {"part", "attachment"}, Sparkles = {"part", "attachment"},
	Decal = {"part"}, Texture = {"part"}, Beam = {"part", "group"}, Trail = {"part", "group"}, Highlight = {"part", "group"}})
Properties.EFFECT_LIMITS = table.freeze({properties = 32, keypoints = 20})
local CONTENT_EXTENSIONS = {"png", "jpg", "jpeg", "dds", "tga"}
local TAGS = {color = "Color3", vector3 = "Vector3", vector2 = "Vector2", range = "NumberRange", sequence = "NumberSequence", colorSequence = "ColorSequence"}

-- Only numeric rbxassetid or built-in rbxasset://textures paths. Never URLs or other schemes.
function Properties.contentId(value: any, label: string): string
	if type(value) == "string" and #value <= 200 then
		local digits = string.match(value, "^rbxassetid://([1-9]%d*)$")
		if digits and #digits <= 19 then return value end
		local path = string.match(value, "^rbxasset://textures/([%w_%-/%.]+)$")
		local stem, extension = string.match(path or "", "^(.+)%.(%a+)$")
		if stem and #stem <= 160 and table.find(CONTENT_EXTENSIONS, extension) and not string.find(path, "..", 1, true) then return value end
	end
	return V.fail("PROPERTY", label .. " must be rbxassetid://<digits> or a built-in rbxasset://textures/... path.")
end

function Properties.hostKind(instance: any): string?
	if instance:IsA("BasePart") then return "part" end
	if instance:IsA("Attachment") then return "attachment" end
	if instance:IsA("Model") or instance:IsA("Folder") or instance.ClassName == "Workspace" then return "group" end
	return nil
end

local function numbers(value: any, count: number, low: number, high: number, label: string): {number}
	local list = V.list(value, count, label)
	if #list ~= count then V.fail("PROPERTY", label .. " needs " .. count .. " numbers.") end
	for _, item in ipairs(list) do V.number(item, low, high, label) end
	return list
end

local function keypoints(value: any, width: number, label: string): {any}
	local list = V.list(value, Properties.EFFECT_LIMITS.keypoints, label)
	if #list < 2 then V.fail("PROPERTY", label .. " needs at least two keypoints.") end
	local last = -1
	for index, point in ipairs(list) do
		local items = V.list(point, width, label .. " keypoint")
		if #items < 2 then V.fail("PROPERTY", label .. " keypoints need time and value.") end
		local time = V.number(items[1], 0, 1, label .. " time")
		if time <= last or (index == 1 and time ~= 0) or (index == #list and time ~= 1) then V.fail("PROPERTY", label .. " keypoint times must rise from 0 to 1.") end
		last = time
	end
	return list
end

-- resolve(tag, label) maps a {type="Ref"} value to what is assigned (an Attachment or a build marker).
function Properties.decodeEffect(className: string, name: string, value: any, resolve: (any, string) -> any): any
	local specs = Properties.EFFECT_SPECS[className]
	local spec = if specs then specs[name] else nil
	local label = className .. "." .. name
	if not spec then V.fail("PROPERTY", label .. " is not writable by the safe bridge.") end
	local kind = spec[1]
	if kind == "boolean" then return V.boolean(value, label) end
	if kind == "content" then return Properties.contentId(value, label) end
	if kind == "number" then return V.number(value, spec[2], spec[3], label) end
	if kind == "integer" then return V.integer(value, spec[2], spec[3], label) end
	if kind == "enum" then return V.enum(value, spec[3], Enum[spec[2]], label) end
	if kind == "attachment" then
		local tag = V.object(value, label)
		if tag.type ~= "Ref" then V.fail("PROPERTY", label .. " must be a Ref to an Attachment.") end
		return resolve(tag, label)
	end
	local tag = V.fields(value, {"type", "value"}, label)
	if tag.type ~= TAGS[kind] then V.fail("PROPERTY", "Incorrect property type tag for " .. label .. ".") end
	if kind == "color" then
		local c = numbers(tag.value, 3, 0, 1, label)
		return Color3.new(c[1], c[2], c[3])
	elseif kind == "vector3" then
		local c = numbers(tag.value, 3, spec[2], spec[3], label)
		return Vector3.new(c[1], c[2], c[3])
	elseif kind == "vector2" then
		local c = numbers(tag.value, 2, spec[2], spec[3], label)
		return Vector2.new(c[1], c[2])
	elseif kind == "range" then
		local c = numbers(tag.value, 2, spec[2], spec[3], label)
		if c[1] > c[2] then V.fail("PROPERTY", label .. " min must not exceed max.") end
		return NumberRange.new(c[1], c[2])
	elseif kind == "sequence" then
		local points = {}
		for _, point in ipairs(keypoints(tag.value, 3, label)) do
			local envelope = if point[3] == nil then 0 else V.number(point[3], 0, (spec[3] - spec[2]) / 2, label .. " envelope")
			table.insert(points, NumberSequenceKeypoint.new(point[1], V.number(point[2], spec[2], spec[3], label), envelope))
		end
		return NumberSequence.new(points)
	end
	local points = {}
	for _, point in ipairs(keypoints(tag.value, 4, label)) do
		if #point ~= 4 then V.fail("PROPERTY", label .. " keypoints are [time,r,g,b].") end
		for channel = 2, 4 do V.number(point[channel], 0, 1, label) end
		table.insert(points, ColorSequenceKeypoint.new(point[1], Color3.new(point[2], point[3], point[4])))
	end
	return ColorSequence.new(points)
end

function Properties.decodeEffects(className: string, values: any, resolve: (any, string) -> any): {[string]: any}
	if not Properties.EFFECT_SPECS[className] then V.fail("CLASS", "Unsupported effect class.") end
	V.object(values, "effect properties")
	local decoded, count = {}, 0
	for name, value in pairs(values) do
		count += 1
		if count > Properties.EFFECT_LIMITS.properties then V.fail("INPUT", "Too many effect properties.") end
		if name == "Name" then V.fail("PROPERTY", "Use the name field.") end
		decoded[name] = Properties.decodeEffect(className, name, value, resolve)
	end
	return decoded
end

local function near(actual: any, expected: number): boolean
	return type(actual) == "number" and math.abs(actual - expected) <= 0.0005 * math.max(1, math.abs(expected))
end
local function sameColor(actual: any, expected: any): boolean
	return typeof(actual) == "Color3" and near(actual.R, expected.R) and near(actual.G, expected.G) and near(actual.B, expected.B)
end
-- Euler triples (YXZ, degrees) are compared as rotations: the engine may normalize angles.
local function rotation(v: any): {number}
	local x, y, z = math.rad(v.X), math.rad(v.Y), math.rad(v.Z)
	local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
	return {cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
end

function Properties.effectMatches(instance: any, className: string, name: string, expected: any): boolean
	local kind = Properties.EFFECT_SPECS[className][name][1]
	local ok, actual = pcall(function(): any return instance[name] end)
	if not ok then return false end
	if kind == "number" or kind == "integer" then return near(actual, expected) end
	if kind == "color" then return sameColor(actual, expected) end
	if kind == "vector3" and className == "Attachment" and name == "Orientation" then
		if typeof(actual) ~= "Vector3" then return false end
		local a, b = rotation(actual), rotation(expected)
		for index = 1, 9 do if math.abs(a[index] - b[index]) > 0.0001 then return false end end
		return true
	end
	if kind == "vector3" then return typeof(actual) == "Vector3" and near(actual.X, expected.X) and near(actual.Y, expected.Y) and near(actual.Z, expected.Z) end
	if kind == "vector2" then return typeof(actual) == "Vector2" and near(actual.X, expected.X) and near(actual.Y, expected.Y) end
	if kind == "range" then return typeof(actual) == "NumberRange" and near(actual.Min, expected.Min) and near(actual.Max, expected.Max) end
	if kind == "sequence" or kind == "colorSequence" then
		local want = expected.Keypoints
		if typeof(actual) ~= (if kind == "sequence" then "NumberSequence" else "ColorSequence") or #actual.Keypoints ~= #want then return false end
		for index, point in ipairs(actual.Keypoints) do
			local target = want[index]
			if not near(point.Time, target.Time) then return false end
			if kind == "sequence" and (not near(point.Value, target.Value) or not near(point.Envelope, target.Envelope)) then return false end
			if kind == "colorSequence" and not sameColor(point.Value, target.Value) then return false end
		end
		return true
	end
	return actual == expected
end

-- Assign in sorted order, then verify every value read back. resolveMarker maps build markers to Instances.
function Properties.applyEffect(instance: any, className: string, decoded: {[string]: any}, resolveMarker: ((any) -> any)?): ()
	local names: {string} = {}
	for name in pairs(decoded) do table.insert(names, name) end
	table.sort(names)
	local values: {[string]: any} = {}
	for _, name in ipairs(names) do
		local value = decoded[name]
		if Properties.EFFECT_SPECS[className][name][1] == "attachment" and resolveMarker then value = resolveMarker(value) end
		values[name] = value
		local ok = pcall(function() instance[name] = value end)
		if not ok then V.fail("VERIFY", "Studio refused " .. className .. "." .. name .. ".") end
	end
	for _, name in ipairs(names) do
		if not Properties.effectMatches(instance, className, name, values[name]) then V.fail("VERIFY", className .. "." .. name .. " did not take the requested value.") end
	end
end

return table.freeze(Properties)
