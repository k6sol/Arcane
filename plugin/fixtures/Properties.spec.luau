--!strict
-- Real production operations under the standalone Luau VM and explicit doubles.
local V = Validation
local checks, serial = 0, 0
local function check(condition: boolean, label: string): ()
	assert(condition, label)
	checks += 1
end
local function refuses(code: string, callback: () -> any): ()
	local ok, err = pcall(callback)
	check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
end
local function fresh(): any
	fixture.historyHook, fixture.failProperty = nil, nil
	local workspace = game:GetService("Workspace")
	for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
	return Operations.new({sessionId = "geometry-test", allowedRoots = {"Workspace"}}, game, http)
end
local function run(ops: any, method: string, args: any): (any, string)
	serial += 1
	local id = "geometry-" .. serial
	return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function vector(x: number, y: number, z: number): any return {type = "Vector3", value = {x, y, z}} end
local function create(ops: any, className: string, properties: any?): (any, string)
	return run(ops, "scene.create", {parent = ops.registry:ref(game:GetService("Workspace")), className = className, name = className, properties = properties or {}})
end
local function restore(ops: any, id: string, result: any): any
	return run(ops, "scene.restore", {receiptCommandId = id, mutation = result.mutation})
end

-- Root discovery returns a real opaque parent, including an empty Workspace.
do
	local ops = fresh()
	local root = run(ops, "scene.children", {root = "Workspace"})
	check(#root.items == 0 and root.parentRef.className == "Workspace" and #root.parentRef.pathSegments == 0, "empty root returns service parentRef")
	check(ops.registry:resolve(root.parentRef) == game:GetService("Workspace"), "root parentRef resolves to exact granted root")
	check(root.parentRef.sessionId == "geometry-test" and root.parentRef.root == "Workspace", "root ref is session and grant scoped")
	local folder = run(ops, "scene.create", {parent = root.parentRef, className = "Folder", name = "SpawnMap"})
	check(ops.registry:resolve(folder.ref).Parent == game:GetService("Workspace"), "root-discovered ref parents without a Baseplate")
	local requested = table.clone(folder.ref)
	requested.pathSegments = V.array({"invented", "display-only"})
	local children = run(ops, "scene.children", {root = "Workspace", ref = requested})
	check(children.parentRef.instanceId == folder.ref.instanceId and #children.items == 0, "requested parent returns its actual opaque ref")
	check(V.equal(children.parentRef.pathSegments, V.array({"SpawnMap"})), "returned ref reflects actual path instead of caller display path")
	local geometry = run(ops, "scene.create", {parent = children.parentRef, className = "Part", name = "CircularSpawn", properties = {Shape = "Cylinder", Size = vector(1, 24, 24), Orientation = vector(0, 0, 90)}})
	check(ops.registry:resolve(geometry.ref).Parent == ops.registry:resolve(folder.ref), "requested parent ref supports geometry creation")
	local listed = run(ops, "scene.children", {root = "Workspace", limit = 1})
	check(listed.parentRef.instanceId == root.parentRef.instanceId and #listed.items == 1, "root identity stays stable with children")
	local foreign = table.clone(children.parentRef); foreign.sessionId = "another"
	refuses("SESSION", function() run(ops, "scene.children", {root = "Workspace", ref = foreign}) end)
	refuses("GRANT", function() run(ops, "scene.children", {root = "ServerStorage", ref = children.parentRef}) end)
	refuses("SERVICE", function() run(ops, "scene.update", {ref = root.parentRef, expected = {Name = "Workspace"}, properties = {Name = "New"}}) end)
end

-- The stored instance becomes a short cylinder with its local X axis vertical.
do
	local ops = fresh()
	local properties = V.decode('{"Shape":"Cylinder","Orientation":{"type":"Vector3","value":[0,0,90]},"Size":{"type":"Vector3","value":[1,24,24]},"Position":{"type":"Vector3","value":[0,1,0]},"Anchored":true,"Material":"SmoothPlastic","CastShadow":false,"Reflectance":0.25}', http)
	local result, id = create(ops, "Part", properties)
	local instance = ops.registry:resolve(result.ref)
	check(instance.Shape == Enum.PartType.Cylinder and instance.Material == Enum.Material.SmoothPlastic, "JSON names become typed enum items")
	check(instance.Orientation == Vector3.new(0, 0, 90), "orientation changes stored object")
	local geometry = fixture.geometry(instance)
	check(geometry.primitive == "Cylinder" and geometry.axialLength == 1 and geometry.diameters[1] == 24 and geometry.diameters[2] == 24, "short circular cylinder geometry")
	check(math.abs(geometry.axis[1]) < 1e-6 and math.abs(geometry.axis[2] - 1) < 1e-6 and math.abs(geometry.axis[3]) < 1e-6, "cylinder axis is vertical")
	local inspected = run(ops, "scene.inspect", {ref = result.ref})
	check(inspected.properties.Shape == "Cylinder" and inspected.properties.Material == "SmoothPlastic", "inspection reflects enum protocol names")
	check(V.equal(inspected.properties.Orientation, {type = "Vector3", value = V.array({0, 0, 90})}), "inspection reflects typed orientation")
	check(V.equal(inspected.properties, result.mutation.after.properties), "creation receipt reflects exact full snapshot")
	check(result.mutation.after.properties.CastShadow == false and result.mutation.after.properties.Reflectance == 0.25, "receipt preserves false and reflectance")
	check(string.find(V.encode(result, http), '"Shape":"Cylinder"', 1, true) ~= nil, "receipt is JSON, not a native enum table")
	restore(ops, id, result)
	check(instance._destroyed and instance.Parent == nil, "unchanged created cylinder restores")
end

-- All added classes get physical properties; only native Part subclasses get Shape.
for _, className in ipairs({"WedgePart", "CornerWedgePart", "SpawnLocation"}) do
	local ops = fresh()
	local properties: any = {Size = vector(4, 1, 4), Orientation = vector(0, 45, 0), Anchored = true, CastShadow = false, Reflectance = 0.5}
	if className == "SpawnLocation" then properties.Shape = "Cylinder" end
	local result, id = create(ops, className, properties)
	local instance = ops.registry:resolve(result.ref)
	check(instance:IsA("BasePart") and instance.Orientation == Vector3.new(0, 45, 0), className .. " physical create")
	check((result.mutation.after.properties.Shape ~= nil) == instance:IsA("Part"), className .. " class-specific snapshot")
	restore(ops, id, result)
	check(instance._destroyed, className .. " receipt restore")
end

-- Invalid class/property/enum payloads cannot allocate, record, or mutate.
do
	local ops = fresh()
	ops.registry:ref(game:GetService("Workspace"))
	for _, className in ipairs({"WedgePart", "CornerWedgePart", "Folder", "Model", "Script"}) do
		local count, writes, committed = #fixture.created, fixture.writes, fixture.committed
		refuses("PROPERTY", function() create(ops, className, {Shape = "Cylinder"}) end)
		check(#fixture.created == count and fixture.writes == writes and fixture.committed == committed, className .. " preflight before allocation")
	end
	for _, values in ipairs({{Shape = "Wedge"}, {Shape = V.NULL}, {Shape = {Name = "Cylinder"}}, {Material = "Water"},
		{Orientation = vector(361, 0, 0)}, {Orientation = vector(0, -361, 0)}, {Orientation = vector(0, 0, math.huge)},
		{Orientation = vector(0 / 0, 0, 0)}, {Orientation = {type = "Color3", value = {0, 0, 0}}},
		{CastShadow = 1}, {Reflectance = 1.01}, {Reflectance = -0.01}}) do
		local count, writes = #fixture.created, fixture.writes
		local ok = pcall(function() create(ops, "Part", values) end)
		check(not ok and #fixture.created == count and fixture.writes == writes, "invalid property is rejected before allocation")
	end
	for _, json in ipairs({'{"Shape":null}', '{"Material":null}', '{"Shape":{"Name":"Cylinder"}}', '{"Orientation":{"type":"Vector3","value":[0,0,null]}}'}) do
		local count, writes = #fixture.created, fixture.writes
		local ok = pcall(function() create(ops, "Part", V.decode(json, http)) end)
		check(not ok and #fixture.created == count and fixture.writes == writes, "decoded JSON null or fabricated enum fails before allocation")
	end
	for _, case in ipairs({{category = Enum.PartType, name = "Cylinder", property = "Shape"}, {category = Enum.Material, name = "Metal", property = "Material"}}) do
		local saved = case.category[case.name]
		for _, replacement in ipairs({V.NULL, {Name = case.name}, Enum.Material.Plastic}) do
			case.category[case.name] = if replacement == V.NULL then nil else replacement
			local count, writes = #fixture.created, fixture.writes
			refuses("PROPERTY", function() create(ops, "Part", {[case.property] = case.name}) end)
			check(#fixture.created == count and fixture.writes == writes, "missing or mistyped native enum is rejected before allocation")
		end
		case.category[case.name] = saved
	end
end

-- Native inheritance checks override caller metadata. Updates cover all BaseParts.
for _, className in ipairs(V.BASE_PART_CLASSES) do
	local ops = fresh()
	local instance = Instance.new(className)
	instance.Parent = game:GetService("Workspace")
	local ref = ops.registry:ref(instance)
	local result, id = run(ops, "scene.update", {ref = ref,
		expected = {Orientation = vector(0, 0, 0), CastShadow = true, Reflectance = 0},
		properties = {Orientation = vector(0, 30, 0), CastShadow = false, Reflectance = 0.25}})
	check(instance.Orientation == Vector3.new(0, 30, 0) and not instance.CastShadow and instance.Reflectance == 0.25, className .. " update actual physical values")
	check(V.equal(result.mutation.before.properties.Orientation, {type = "Vector3", value = V.array({0, 0, 0})}), className .. " exact typed baseline")
	restore(ops, id, result)
	check(instance.Orientation == Vector3.new(0, 0, 0) and instance.CastShadow and instance.Reflectance == 0, className .. " restore physical values")
	if not instance:IsA("Part") then
		local writes = fixture.writes
		refuses("PROPERTY", function() run(ops, "scene.update", {ref = ref, expected = {Shape = "Block"}, properties = {Shape = "Cylinder"}}) end)
		check(fixture.writes == writes, className .. " refuses Shape before mutation")
	end
end

-- Exact baseline conflicts remain fenced, including between validation and write.
do
	local ops = fresh()
	local created = create(ops, "Part")
	local instance, ref = ops.registry:resolve(created.ref), created.ref
	local args = {ref = ref, expected = {Shape = "Block", Orientation = vector(0, 0, 0), CastShadow = true, Reflectance = 0},
		properties = {Shape = "Cylinder", Orientation = vector(0, 0, 90), CastShadow = false, Reflectance = 0.5}}
	instance.Shape = Enum.PartType.Ball
	local writes, committed = fixture.writes, fixture.committed
	refuses("CONFLICT", function() run(ops, "scene.update", args) end)
	check(fixture.writes == writes and fixture.committed == committed, "baseline conflict never begins mutation")
	instance.Shape = Enum.PartType.Block
	fixture.historyHook = function() instance.Orientation = Vector3.new(0, 0, 1) end
	refuses("CONFLICT", function() run(ops, "scene.update", args) end)
	check(instance.Shape == Enum.PartType.Block and instance.Orientation == Vector3.new(0, 0, 1), "race preserves intervening edit")
	fixture.historyHook = nil
	instance.Orientation = Vector3.new(0, 0, 0)
	local result, id = run(ops, "scene.update", args)
	check(result.mutation.before.properties.Shape == "Block" and result.mutation.after.properties.Shape == "Cylinder", "update receipt has exact enum baseline and after-state")
	check(V.equal(result.mutation.after.properties.Orientation, {type = "Vector3", value = V.array({0, 0, 90})}), "update receipt has typed orientation")
	for _, edit in ipairs({{name = "Shape", value = Enum.PartType.Ball}, {name = "Orientation", value = Vector3.new(0, 0, 80)}, {name = "CastShadow", value = true}, {name = "Reflectance", value = 0.75}}) do
		local previous = instance[edit.name]
		instance[edit.name] = edit.value
		local beforeWrites = fixture.writes
		refuses("CONFLICT", function() restore(ops, id, result) end)
		check(fixture.writes == beforeWrites and not ops.restored[id], "restore conflict preserves " .. edit.name)
		instance[edit.name] = previous
	end
	restore(ops, id, result)
	check(instance.Shape == Enum.PartType.Block and instance.Orientation == Vector3.new(0, 0, 0) and instance.CastShadow and instance.Reflectance == 0, "successful restoration returns exact baseline")
	refuses("RECEIPT", function() restore(ops, id, result) end)
end

-- Create restoration continues to refuse later edits, children, reparenting and source.
for _, changed in ipairs({"Shape", "Orientation", "CastShadow", "Reflectance", "children", "parent", "source"}) do
	local ops = fresh()
	local result, id = create(ops, if changed == "source" then "Script" else "Part")
	local instance = ops.registry:resolve(result.ref)
	if changed == "Shape" then instance.Shape = Enum.PartType.Ball
	elseif changed == "Orientation" then instance.Orientation = Vector3.new(0, 0, 1)
	elseif changed == "CastShadow" then instance.CastShadow = false
	elseif changed == "Reflectance" then instance.Reflectance = 0.25
	elseif changed == "children" then Instance.new("Folder").Parent = instance
	elseif changed == "parent" then
		local folder = Instance.new("Folder"); folder.Parent = game:GetService("Workspace"); instance.Parent = folder
	else
		check(instance.Disabled == true, "created script remains disabled")
		fixture.sources[instance] = "print('later edit')"
	end
	local writes = fixture.writes
	refuses("CONFLICT", function() restore(ops, id, result) end)
	check(not instance._destroyed and fixture.writes == writes, "created restore preserves later " .. changed)
end

do
	local ops = fresh()
	local rootRef = ops.registry:ref(game:GetService("Workspace"))
	refuses("SERVICE", function() run(ops, "scene.update", {ref = rootRef, expected = {Name = "Workspace"}, properties = {Name = "New"}}) end)
	for _, forbidden in ipairs({"Parent", "Source", "Disabled", "CFrame", "Enabled", "Neutral", "CanTouch"}) do
		refuses("PROPERTY", function() create(ops, "SpawnLocation", {[forbidden] = true}) end)
	end
end

print("Arcane property checks passed: " .. checks)
