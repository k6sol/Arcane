--!strict
local V = require(script.Parent.Validation)
local Properties = {}
Properties.PART_FIELDS = table.freeze({"Size", "Position", "Color", "Anchored", "CanCollide", "Transparency", "Material"})
Properties.CLASSES = table.freeze({"Folder", "Model", "Part", "Script", "LocalScript", "ModuleScript"})
Properties.MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Metal", "Wood", "WoodPlanks", "Concrete", "Brick", "Glass", "Neon", "Slate", "Sand", "Fabric", "Grass", "Ground", "Rock", "Cobblestone", "Asphalt"})

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
