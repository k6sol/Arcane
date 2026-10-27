--!strict
-- Native asset adoption: the built-in Studio tools insert or generate an instance; this module
-- adopts exactly that one instance (strip scripts by default, fit, ground, pivot, anchor, parent)
-- under one undo recording and receipt, and clones script-free templates for scene.build.
local V = require(script.Parent.Validation)
local AssetPlacement = {}

AssetPlacement.LIMITS = table.freeze({descendants = 5000, templateDescendants = 2000, templates = 16, watches = 4,
	watchSeconds = 600, additions = 64, arrivalSeconds = 10, materialTargets = 64, removedNames = 20})
AssetPlacement.GENERATED_MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Wood", "WoodPlanks", "Marble", "Basalt", "Slate", "CrackedLava",
	"Concrete", "Limestone", "Granite", "Pavement", "Brick", "Pebble", "Cobblestone", "Rock", "Sandstone", "CorrodedMetal", "DiamondPlate", "Foil",
	"Metal", "Grass", "LeafyGrass", "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt", "Salt", "Ice", "Glacier", "Cardboard", "Carpet",
	"CeramicTiles", "ClayRoofTiles", "RoofShingles", "Leather", "Plaster", "Rubber"})
local L = AssetPlacement.LIMITS

local function triple(value: any, low: number, high: number, label: string): {number}
	local list = V.list(value, 3, label)
	if #list ~= 3 then V.fail("INPUT", label .. " needs three numbers.") end
	for _, item in ipairs(list) do V.number(item, low, high, label) end
	return {list[1], list[2], list[3]}
end

-- Pure placement math (also exercised directly by the standalone tests).
-- components are CFrame:GetComponents(): x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22.
function AssetPlacement.worldExtents(c: {number}, size: any): {number}
	local sx, sy, sz = size.X, size.Y, size.Z
	return {math.abs(c[4]) * sx + math.abs(c[5]) * sy + math.abs(c[6]) * sz,
		math.abs(c[7]) * sx + math.abs(c[8]) * sy + math.abs(c[9]) * sz,
		math.abs(c[10]) * sx + math.abs(c[11]) * sy + math.abs(c[12]) * sz}
end
-- Uniform scale that fits the world extents inside maxSize (the tightest axis wins).
function AssetPlacement.fitScale(extents: {number}, maxSize: {number}?): number
	if not maxSize then return 1 end
	local scale = math.huge
	for axis = 1, 3 do
		if extents[axis] > 1e-6 then scale = math.min(scale, maxSize[axis] / extents[axis]) end
	end
	if scale == math.huge then V.fail("ASSET", "The asset has no measurable size; nothing was adopted.") end
	if scale < 0.01 or scale > 100 then V.fail("ASSET", "Fitting the asset to maxSize needs a scale outside 0.01..100; choose a closer size or another asset.") end
	return scale
end
function AssetPlacement.bottomCenter(c: {number}, extents: {number}): {number}
	return {c[1], c[2] - extents[2] / 2, c[3]}
end

-- Exact extents of the same oriented box after the requested world Y rotation.
function AssetPlacement.worldExtentsAtYaw(c: {number}, size: any, yaw: number): {number}
	local angle = math.rad(yaw)
	local cosine, sine = math.cos(angle), math.sin(angle)
	return AssetPlacement.worldExtents({c[1], c[2], c[3],
		cosine * c[4] + sine * c[10], cosine * c[5] + sine * c[11], cosine * c[6] + sine * c[12],
		c[7], c[8], c[9],
		-sine * c[4] + cosine * c[10], -sine * c[5] + cosine * c[11], -sine * c[6] + cosine * c[12]}, size)
end

local function boxOf(root: any, yaw: number): ({number}, {number}, {number})
	local cframe, size = root:GetBoundingBox()
	local components = {cframe:GetComponents()}
	return components, AssetPlacement.worldExtents(components, size), AssetPlacement.worldExtentsAtYaw(components, size, yaw)
end

-- Converted graphs are attached only to actual locally materialized Instances.
-- Neither attributes, serialized receipts nor a caller-supplied graph establish
-- this ownership. Clones are admitted only from an unchanged private baseline.
local converted: {[any]: any} = setmetatable({}, {__mode = "k"})
local NODE_ATTRIBUTE = "ArcaneConvertedNodeKey"
local OBJECT_ATTRIBUTE = "ArcaneConvertedObjectId"
local function finite(value: any): number
	return V.number(value, -1000000, 1000000, "converted number")
end
local function matrix(value: any): {number}
	if type(value) ~= "table" or #value ~= 16 then V.fail("IDENTITY", "Converted affine matrix is incomplete.") end
	local result = {}
	for index = 1, 16 do result[index] = finite(value[index]) end
	if result[4] ~= 0 or result[8] ~= 0 or result[12] ~= 0 or result[16] ~= 1 then V.fail("UNSUPPORTED_TRANSFORM", "Converted matrix is not affine.") end
	return result
end
local function multiply(a: any, b: any): {number}
	local result = {}
	for column = 0, 3 do for row = 1, 4 do
		local total = 0
		for k = 0, 3 do total += a[k * 4 + row] * b[column * 4 + k + 1] end
		result[column * 4 + row] = finite(total)
	end end
	return result
end
local function rigid(m: any, unit: boolean, units: number): {number}
	local scales, r = {}, {}
	for column = 0, 2 do
		local at = column * 4
		local scale = math.sqrt(m[at + 1]^2 + m[at + 2]^2 + m[at + 3]^2)
		if scale <= 0 or (unit and math.abs(scale - 1) > 1e-6) then V.fail("UNSUPPORTED_TRANSFORM", "Converted grouping scale requires a baked delivery copy.") end
		scales[column + 1] = scale
		for row = 1, 3 do r[at + row] = m[at + row] / scale end
	end
	for a = 0, 1 do for b = a + 1, 2 do
		if math.abs(r[a*4+1]*r[b*4+1]+r[a*4+2]*r[b*4+2]+r[a*4+3]*r[b*4+3]) > 1e-6 then V.fail("UNSUPPORTED_TRANSFORM", "Converted shear requires a baked delivery copy.") end
	end end
	local determinant = r[1]*(r[6]*r[11]-r[7]*r[10])-r[5]*(r[2]*r[11]-r[3]*r[10])+r[9]*(r[2]*r[7]-r[3]*r[6])
	if math.abs(determinant - 1) > 1e-6 then V.fail("UNSUPPORTED_TRANSFORM", "Converted reflection requires a baked delivery copy.") end
	return {m[13]*units,m[14]*units,m[15]*units,r[1],r[5],r[9],r[2],r[6],r[10],r[3],r[7],r[11]}
end
local function sameNumbers(a: any, b: any, tolerance: number): boolean
	if #a ~= #b then return false end
	for index, value in ipairs(a) do if math.abs(value-b[index]) > tolerance then return false end end
	return true
end
local function components(value: any): {number} return {value:GetComponents()} end
local function scaledFrame(values: any, scale: number): any
	return CFrame.new(values[1]*scale,values[2]*scale,values[3]*scale,table.unpack(values,4,12))
end
local function physicalSize(plan: any, scale: number): any
	local size = {}
	for axis = 1, 3 do
		local extent = plan.exactSourceSizeStuds[axis] * scale
		if extent ~= 0 and (extent < 0.05 or extent > 2048) then V.fail("UNSUPPORTED_TRANSFORM", "Converted scale would stretch or exceed the physical sizing policy.") end
		size[axis] = if extent == 0 then 0.05 else extent
	end
	return Vector3.new(size[1],size[2],size[3])
end

-- Metadata/native-subset preflight, called with the ORIGINAL receiver's sealed
-- graph and retained mesh entries before any Model/MeshPart allocation. This
-- does not narrow the converter's affine data domain or certify Engine output.
function AssetPlacement.convertedPlan(source: any, resources: any): any
	if source.formatVersion ~= 2 or type(source.graph) ~= "table" or source.graph.schemaVersion ~= 1 then V.fail("IDENTITY", "Original converted graph is required.") end
	local graph, byKey, rows, associations = source.graph, {}, {}, {}
	-- The detached outer Model is a real allocation, not a selected source node.
	if #graph.nodes < 1 or 1+#graph.nodes > 128 or #resources > 128 then V.fail("BODY_LIMIT", "Converted instance budget exceeded.") end
	for _, resource in ipairs(resources) do
		local association = resource.association
		if resource.formatVersion ~= 2 or not association or association.sourceObjectId ~= resource.object.sourceObjectId
			or not V.equal(association.sourcePivot,{0,0,0}) then V.fail("IDENTITY", "Converted mesh association or source pivot changed.") end
		if associations[association.sourceObjectId] then V.fail("IDENTITY", "Duplicate converted mesh association.") end
		associations[association.sourceObjectId] = resource
		if not resource.nativePlan or not sameNumbers(resource.nativePlan.sourcePivotCFrame,rigid(matrix(resource.object.exportTransform),false,source.conversion.studsPerMeter),1e-6) then V.fail("IDENTITY", "Converted native plan differs from its retained source transform.") end
		physicalSize(resource.nativePlan,1)
	end
	local derived = 0
	for _, association in ipairs(graph.meshes) do
		local resource = associations[association.sourceObjectId]
		if not resource or not V.equal(resource.association,association) then V.fail("IDENTITY", "Converted graph mesh inventory differs.") end
		if association.nodeKey == nil or association.nodeKey == V.NULL then
			if resource.object.role ~= "collision" then V.fail("IDENTITY", "Only derived collision may have no selected node.") end
			derived += 1
		end
	end
	if #graph.meshes ~= #resources or derived > 1 or 1+#graph.nodes+derived > 128 then V.fail("BODY_LIMIT", "Converted graph coverage or instance budget differs.") end
	for _, node in ipairs(graph.nodes) do
		if type(node.nodeKey) ~= "string" or byKey[node.nodeKey] then V.fail("IDENTITY", "Converted node identity is duplicated.") end
		if node.name~=nil and node.name~=V.NULL and (type(node.name)~="string" or #node.name>256 or string.find(node.name,"\0",1,true) or utf8.len(node.name)==nil) then V.fail("UNSUPPORTED_TRANSFORM","Authored node name exceeds the exact reference display domain.") end
		local row: any = {node=node,localMatrix=matrix(node.localMatrix)}
		byKey[node.nodeKey] = row
		for _, resource in ipairs(resources) do if resource.association.nodeKey == node.nodeKey then
			if row.resource or resource.object.role ~= "render" then V.fail("IDENTITY", "Selected node mesh association is ambiguous.") end
			row.resource = resource
		end end
		rigid(row.localMatrix,row.resource==nil,source.conversion.studsPerMeter)
	end
	-- Iterative topological order handles arbitrary signed graph ordering and
	-- refuses cycles/missing parents without recursion or nearest-mesh guesses.
	while #rows < #graph.nodes do
		local advanced = false
		for _, node in ipairs(graph.nodes) do
			local row, parent = byKey[node.nodeKey], byKey[node.parentKey]
			local root = node.parentKey == nil or node.parentKey == V.NULL
			if row.world == nil and (root or (parent and parent.world)) then
				row.world = if root then row.localMatrix else multiply(parent.world,row.localMatrix)
				row.depth = if root then 1 else parent.depth+1
				row.pivot = rigid(row.world,row.resource==nil,source.conversion.studsPerMeter)
				if parent and parent.resource then V.fail("UNSUPPORTED_TRANSFORM", "A mesh parent with children requires a baked delivery copy.") end
				if row.resource and not sameNumbers(row.world,row.resource.object.exportTransform,1e-6) then V.fail("IDENTITY", "Converted graph and mesh world transform differ.") end
				rows[#rows+1] = row; advanced = true
			end
		end
		if not advanced then V.fail("IDENTITY", "Converted graph has a cycle or unavailable direct parent.") end
	end
	local children,stack,ordered={},{},{}
	for _,row in ipairs(rows) do local key=row.node.parentKey;if key==nil or key==V.NULL then key="" end;children[key]=children[key] or {};table.insert(children[key],row) end
	for _,list in pairs(children) do table.sort(list,function(a: any,b: any): boolean return a.node.nodeKey<b.node.nodeKey end) end
	local roots=children[""] or {};for index=#roots,1,-1 do stack[#stack+1]=roots[index] end
	while #stack>0 do local row=table.remove(stack);ordered[#ordered+1]=row;local list=children[row.node.nodeKey] or {};for index=#list,1,-1 do stack[#stack+1]=list[index] end end
	rows=ordered
	for _,resource in ipairs(resources) do if resource.object.role=="render" and (not byKey[resource.association.nodeKey] or byKey[resource.association.nodeKey].resource~=resource) then V.fail("IDENTITY","Converted render association has no exact graph node.") end end
	return {source=source,rows=rows,byKey=byKey,resources=resources}
end
function AssetPlacement.verifyCarrier(part: any, object: any): ()
	local size=part.MeshSize
	for axis,key in ipairs({"X","Y","Z"}) do
		local actual=finite(size[key])
		local expected=object.bounds.max[axis]-object.bounds.min[axis]
		-- MeshSize is the unscaled source geometry size (TriangleMeshPart docs).
		-- A truly planar axis remains zero at every vertex, independently of the
		-- Engine's positive physical thickness metadata; no nonzero axis is padded.
		if actual<0 or (expected>0 and math.abs(actual-expected)>1e-5*math.max(1,expected)) then V.fail("VERIFY","Engine carrier MeshSize differs from measured source extent.") end
	end
end

-- Source-space measured bounds, not padded MeshPart boxes. Yaw keeps the
-- measured world Y extrema exact; X/Z fitting uses their conservative box.
function AssetPlacement.convertedBounds(plan: any, yaw: number): (any, any)
	local low,high = {math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge}
	local angle,units = math.rad(yaw),plan.source.conversion.studsPerMeter
	local c,s = math.cos(angle),math.sin(angle)
	for _,resource in ipairs(plan.resources) do if resource.object.role == "render" then
		local bounds = resource.object.worldBounds
		for _,x in ipairs({bounds.min[1],bounds.max[1]}) do for _,y in ipairs({bounds.min[2],bounds.max[2]}) do for _,z in ipairs({bounds.min[3],bounds.max[3]}) do
			local p = {(c*x+s*z)*units,y*units,(-s*x+c*z)*units}
			for axis=1,3 do low[axis]=math.min(low[axis],p[axis]);high[axis]=math.max(high[axis],p[axis]) end
		end end end
	end end
	if low[1] == math.huge then V.fail("ASSET", "Converted graph has no render bounds.") end
	return low,high
end
function AssetPlacement.convertedScale(plan: any, maxSize: any, yaw: number): number
	local low,high = AssetPlacement.convertedBounds(plan,yaw)
	local scale = AssetPlacement.fitScale({high[1]-low[1],high[2]-low[2],high[3]-low[3]},maxSize)
	for _,resource in ipairs(plan.resources) do physicalSize(resource.nativePlan,scale) end
	return scale
end

local function scalar(value: any): string
	if type(value)=="number" then
		if value~=value or math.abs(value)==math.huge then V.fail("VERIFY","Nonfinite observed state.") end
		return if value==0 then "0" else string.format("%.17g",value)
	elseif type(value)=="string" then return string.format("%q",value)
	elseif type(value)=="boolean" then return if value then "true" else "false"
	elseif value==nil then return "null" end
	V.fail("VERIFY","Unsupported observed state value.")
end
local function observed(instance: any, collection: any): any
	local state: any = {name=instance.Name,className=instance.ClassName,attributes=instance:GetAttributes(),tags=collection:GetTags(instance)}
	table.sort(state.tags)
	if instance:IsA("BasePart") then
		state.cframe=components(instance.CFrame);state.pivotOffset=components(instance.PivotOffset)
		state.size={instance.Size.X,instance.Size.Y,instance.Size.Z}
		state.flags={instance.Anchored,instance.CanCollide,instance.CanQuery,instance.CanTouch,instance.CastShadow,instance.Transparency,instance.DoubleSided}
		state.material={tostring(instance.Material),instance.Color.R,instance.Color.G,instance.Color.B}
		state.extra={tostring(instance.MaterialVariant),tostring(instance.Reflectance),tostring(instance.Massless),tostring(instance.CollisionGroup),tostring(instance.CustomPhysicalProperties),tostring(instance.Locked),tostring(instance.RootPriority)}
	elseif instance:IsA("Model") then state.pivot=components(instance.WorldPivot);state.primary=instance.PrimaryPart==nil end
	if instance:IsA("SurfaceAppearance") then
		state.appearance={tostring(instance.AlphaMode),tostring(instance.Color),tostring(instance.ColorMapContent),tostring(instance.NormalMapContent),tostring(instance.MetalnessMapContent),tostring(instance.RoughnessMapContent)}
	end
	return state
end
local function stateBytes(value: any): string
	if type(value)~="table" then return scalar(value) end
	local keys,out={},{}
	for key in pairs(value) do keys[#keys+1]=key end
	table.sort(keys,function(a: any,b: any): boolean return tostring(a)<tostring(b) end)
	for _,key in ipairs(keys) do out[#out+1]=scalar(key)..":"..stateBytes(value[key]) end
	return "{"..table.concat(out,",").."}"
end
local function snapshot(root: any, ops: any): any
	local items = root:GetDescendants();table.insert(items,1,root)
	local result={}
	for _,item in ipairs(items) do result[#result+1]={instance=item,parent=item.Parent,children=item:GetChildren(),state=stateBytes(observed(item,ops.collection))} end
	return result
end
local function unchanged(state: any, ops: any): boolean
	if not state.baseline then return false end
	for _,row in ipairs(state.baseline) do
		if row.instance.Parent~=row.parent or #row.instance:GetChildren()~=#row.children or stateBytes(observed(row.instance,ops.collection))~=row.state then return false end
		local children=row.instance:GetChildren()
		for _,child in ipairs(row.children) do if not table.find(children,child) then return false end end
	end
	return #state.root:GetDescendants()+1==#state.baseline
end

function AssetPlacement.registerConverted(root: any, plan: any, instances: any, parts: any, hash: any, appearances: any): ()
	if converted[root] then V.fail("STATE","Converted graph was already registered.") end
	converted[root]={root=root,plan=plan,instances=instances,parts=parts,appearances=appearances,hash=hash,scale=1,transform=CFrame.new(),baseline=nil}
end
function AssetPlacement.convertedMatches(root: any, ops: any): boolean
	local state=converted[root]
	return state==nil or unchanged(state,ops)
end
function AssetPlacement.preflightConverted(plan: any, maxSize: any, yaw: number, depth: number): ()
	AssetPlacement.convertedScale(plan,maxSize,yaw)
	for _,row in ipairs(plan.rows) do if depth+1+row.depth>63 then V.fail("BODY_LIMIT","Converted graph exceeds the reference hierarchy depth.") end end
end
local function verifyConverted(state: any): ()
	local owned={[state.root]=true}
	for _,item in pairs(state.instances) do owned[item]=true end
	for _,item in ipairs(state.parts) do owned[item]=true end
	for index,item in pairs(state.appearances) do
		owned[item]=true
		if item.Parent~=state.parts[index] then V.fail("VERIFY","Converted appearance ownership changed.") end
	end
	for _,item in ipairs(state.root:GetDescendants()) do if not owned[item] then V.fail("CONFLICT","Converted hierarchy gained an unowned child; no child is removed.") end end
	for _,row in ipairs(state.plan.rows) do
		local item=state.instances[row.node.nodeKey]
		local parent=state.instances[row.node.parentKey] or state.root
		local name=if row.node.name==nil or row.node.name==V.NULL then row.node.nodeKey else row.node.name
		if item.Parent~=parent or item.Name~=name or item:GetAttribute(NODE_ATTRIBUTE)~=row.node.nodeKey then V.fail("VERIFY","Converted direct parent, name or node marker differs.") end
		local expected=state.transform*scaledFrame(row.pivot,state.scale)
		if not sameNumbers(components(item:GetPivot()),components(expected),1e-4) then V.fail("VERIFY","Converted source-zero pivot differs after Engine assignment.") end
	end
	for index,resource in ipairs(state.plan.resources) do
		local part,plan=state.parts[index],resource.nativePlan
		local desired=state.transform*scaledFrame(plan.cframe,state.scale)
		local size=physicalSize(plan,state.scale)
		if not sameNumbers(components(part.CFrame),components(desired),1e-4)
			or not sameNumbers(components(part.PivotOffset),components(scaledFrame(plan.pivotOffset,state.scale)),1e-4)
			or not sameNumbers({part.Size.X,part.Size.Y,part.Size.Z},{size.X,size.Y,size.Z},1e-4)
			or part:GetAttribute(OBJECT_ATTRIBUTE)~=resource.object.sourceObjectId then V.fail("VERIFY","Converted physical mesh assignment differs.") end
		if resource.object.role=="collision" and part.Parent~=state.root then V.fail("VERIFY","Derived collision must remain a root association.") end
	end
end
function AssetPlacement.initializeConverted(root: any): ()
	local state=converted[root]
	if not state then V.fail("STATE","Converted materialization metadata is absent.") end
	-- Setter-only pivots: unlike PivotTo, setting WorldPivot leaves already
	-- positioned descendants untouched (official pivot-tools/Model docs).
	for _,row in ipairs(state.plan.rows) do if not row.resource then state.instances[row.node.nodeKey].WorldPivot=CFrame.new(table.unpack(row.pivot)) end end
	root.WorldPivot=CFrame.new()
	verifyConverted(state)
end
local function transformConverted(state: any, transform: any, scale: number): ()
	for _,resource in ipairs(state.plan.resources) do physicalSize(resource.nativePlan,scale) end -- BEFORE mutation
	for index,resource in ipairs(state.plan.resources) do
		local part,plan=state.parts[index],resource.nativePlan
		part.Size=physicalSize(plan,scale)
		part.CFrame=transform*scaledFrame(plan.cframe,scale)
		part.PivotOffset=scaledFrame(plan.pivotOffset,scale)
	end
	for _,row in ipairs(state.plan.rows) do if not row.resource then state.instances[row.node.nodeKey].WorldPivot=transform*scaledFrame(row.pivot,scale) end end
	state.scale,state.transform=scale,transform
	verifyConverted(state)
end
function AssetPlacement.observeConverted(root: any, ops: any): any
	local state=converted[root]
	if not state then return nil end
	verifyConverted(state)
	local nodes,objects=V.array({}),V.array({})
	local function observation(item: any): any
		local ref=ops.registry:ref(item)
		local digest=state.hash("arcane-converted-owned-state-v1\n"..stateBytes(observed(item,ops.collection)))
		return {instanceRef=ref.instanceId,ownedStateSha256=digest,authoredChildren=V.array({})}
	end
	for _,row in ipairs(state.plan.rows) do
		local result=observation(state.instances[row.node.nodeKey]);result.nodeKey=row.node.nodeKey;nodes[#nodes+1]=result
	end
	for index,resource in ipairs(state.plan.resources) do
		local result=observation(state.parts[index]);result.sourceObjectId=resource.object.sourceObjectId;objects[#objects+1]=result
	end
	state.baseline=snapshot(root,ops)
	return {formatVersion=2,receiptScope="studio-session-observation",imported=false,engineVerification="pending",graphDigest=state.plan.source.graph.digest,conversionRequestDigest=state.plan.source.conversionRequestDigest,nodes=nodes,objects=objects}
end

-- One-shot watch: records top-level instances added under Workspace after it is armed.
function AssetPlacement.watch(ops: any): any
	local workspace = ops.registry:root("Workspace")
	local watches = ops.assetWatches
	if not watches then watches = {}; ops.assetWatches = watches end
	local now = os.clock()
	local count, oldestId, oldestAt = 0, nil, math.huge
	for id, entry in pairs(watches) do
		if entry.expires <= now then entry.connection:Disconnect(); watches[id] = nil
		else
			count += 1
			if entry.started < oldestAt then oldestId, oldestAt = id, entry.started end
		end
	end
	if count >= L.watches and oldestId then watches[oldestId].connection:Disconnect(); watches[oldestId] = nil end
	local id = (string.gsub(ops.http:GenerateGUID(false), "[^%w_%-]", ""))
	local entry: any = {additions = {}, seen = {}, overflow = false, started = now, expires = now + L.watchSeconds}
	entry.connection = workspace.DescendantAdded:Connect(function(instance: any)
		local cursor = instance.Parent
		while cursor and cursor ~= workspace do
			if entry.seen[cursor] then return end
			cursor = cursor.Parent
		end
		if #entry.additions >= L.additions then entry.overflow = true; return end
		entry.seen[instance] = true
		table.insert(entry.additions, instance)
	end)
	watches[id] = entry
	return {watch = id, expiresInSeconds = L.watchSeconds}
end

local function release(ops: any, id: string): ()
	local entry = ops.assetWatches and ops.assetWatches[id]
	if entry then entry.connection:Disconnect(); ops.assetWatches[id] = nil end
end

local function candidates(ops: any, entry: any, workspace: any): {any}
	local tops: {any} = {}
	for _, instance in ipairs(entry.additions) do
		if instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance]
			and (instance:IsA("Model") or instance:IsA("BasePart") or instance:IsA("Folder")) then
			local nested, cursor = false, instance.Parent
			while cursor and cursor ~= workspace do
				if entry.seen[cursor] then nested = true; break end
				cursor = cursor.Parent
			end
			if not nested then table.insert(tops, instance) end
		end
	end
	return tops
end

-- Waits up to arrivalSeconds for exactly one inserted instance. Never adopts on ambiguity.
function AssetPlacement.arrival(ops: any, id: string, expectName: string?, workspace: any): any
	local entry = ops.assetWatches and ops.assetWatches[id]
	if not entry or entry.expires <= os.clock() then V.fail("WATCH", "The insertion watch is unknown or expired; start the insert again.") end
	local polls = L.arrivalSeconds * 4
	for attempt = 0, polls do
		if entry.overflow then V.fail("AMBIGUOUS", "Too many instances appeared in Workspace during the insertion; nothing was adopted. Inspect Workspace before trying again.") end
		local tops = candidates(ops, entry, workspace)
		local chosen: any = nil
		if expectName then
			local named: {any} = {}
			for _, instance in ipairs(tops) do if instance.Name == expectName then table.insert(named, instance) end end
			if #named > 1 then V.fail("AMBIGUOUS", "Several instances share the inserted asset name; nothing was adopted.") end
			chosen = named[1]
		end
		if not chosen and #tops > 1 then V.fail("AMBIGUOUS", "Several new instances appeared in Workspace during the insertion; nothing was adopted. Inspect Workspace and remove any unwanted insert.") end
		chosen = chosen or tops[1]
		if chosen then
			-- A script dropped next to the asset (not inside it) would escape the strip below: refuse instead.
			for _, instance in ipairs(entry.additions) do
				if instance ~= chosen and instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance]
					and not instance:IsDescendantOf(chosen) and not chosen:IsDescendantOf(instance) then
					local scripted = instance:IsA("LuaSourceContainer")
					if not scripted then for _, item in ipairs(instance:GetDescendants()) do if item:IsA("LuaSourceContainer") then scripted = true; break end end end
					if scripted then V.fail("AMBIGUOUS", "Scripts appeared in Workspace next to the inserted asset; nothing was adopted.") end
				end
			end
			return chosen
		end
		if attempt < polls then task.wait(0.25) end
	end
	V.fail("NOT_FOUND", "No inserted instance appeared in Workspace within " .. L.arrivalSeconds .. " seconds; nothing was adopted.")
	return nil
end

function AssetPlacement.place(ops: any, command: any, args: any, guard: () -> ()): any
	V.fields(args, {"watch", "expectName", "parent", "name", "maxSize", "position", "yaw", "ground", "anchor", "allowScripts"}, "asset placement")
	local id = V.string(args.watch, "insertion watch", 128)
	local expectName = if args.expectName == nil then nil else V.string(args.expectName, "expected asset name", 100)
	local container = ops.registry:resolve(args.parent)
	local name = V.string(args.name, "asset name", 100)
	local maxSize = if args.maxSize == nil then nil else triple(args.maxSize, 0.2, 2048, "asset maxSize")
	local position = triple(args.position, -100000, 100000, "asset position")
	local yaw = V.number(args.yaw, -360, 360, "asset yaw")
	local ground, anchor, allowScripts = V.boolean(args.ground, "ground"), V.boolean(args.anchor, "anchor"), V.boolean(args.allowScripts, "allowScripts")
	local workspace = ops.registry:root("Workspace")
	if ops.registry.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	-- "editable-<digest>" adopts this plugin's retained reconstruction (procedural/Blender
	-- meshes) as new MeshParts instead of waiting for a native insertion.
	local editable = string.match(id, "^editable%-([0-9a-f]+)$")
	local placed: (() -> ())? = nil
	local asset: any
	local watched = if editable then nil else ops.assetWatches and ops.assetWatches[id]
	-- A refused native insert stays in Workspace for the person to inspect, but never with its scripts or package links.
	local function scrub(): ()
		if allowScripts or not watched then return end
		for _, instance in ipairs(watched.additions) do
			if instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance] then
				local items = instance:GetDescendants()
				table.insert(items, instance)
				for _, item in ipairs(items) do
					if item.Parent ~= nil and (item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink") then pcall(function() item:Destroy() end) end
				end
			end
		end
	end
	if editable then
		if type(ops.materializeReconstruction) ~= "function" then V.fail("WATCH", "This plugin cannot place reconstructed meshes.") end
		asset, placed = ops:materializeReconstruction(editable, guard, {maxSize=maxSize,yaw=yaw,depth=#args.parent.pathSegments})
	else
		local arrived, value = pcall(AssetPlacement.arrival, ops, id, expectName, workspace)
		if not arrived then scrub(); error(value, 0) end
		asset = value
	end
	local ok, result = pcall(AssetPlacement.adopt, ops, command, args, guard, asset, container, name, maxSize, position, yaw, ground, anchor, allowScripts, editable ~= nil, id)
	if not ok then
		-- A detached materialized model never reached the scene: release it, no receipt.
		if editable and asset.Parent == nil then
			local cleaned=pcall(function() asset:Destroy() end)
			if not cleaned and converted[asset] then ops.assetCleanupFailed=true;V.fail("CLEANUP","Detached converted placement cleanup could not be established.") end
		elseif editable and placed and converted[asset] then placed() end -- A partial converted effect is consumed, never replayed.
		scrub()
		error(result, 0)
	end
	if placed then placed() end
	return result
end

function AssetPlacement.adopt(ops: any, command: any, args: any, guard: () -> (), asset: any, container: any, name: string, maxSize: {number}?,
	position: {number}, yaw: number, ground: boolean, anchor: boolean, allowScripts: boolean, detached: boolean, id: string): any
	local workspace = ops.registry:root("Workspace")
	if converted[asset] then verifyConverted(converted[asset]) end
	local descendants = asset:GetDescendants()
	if #descendants + 1 > L.descendants then V.fail("BODY_LIMIT", "The inserted asset has more than " .. L.descendants .. " instances; nothing was adopted. Remove it or choose a lighter asset.") end
	local physical = asset:IsA("BasePart")
	for _, item in ipairs(descendants) do if item:IsA("BasePart") then physical = true; break end end
	if not physical then V.fail("ASSET", "The inserted asset has no 3D parts; nothing was adopted. Remove it from Workspace if unwanted.") end
	return ops:record(command, guard, function(progress: any): any
		guard()
		ops.registry:resolve(args.parent)
		if asset.Parent == nil and not detached then V.fail("ASSET", "The inserted asset disappeared before adoption.") end
		progress.touched = true
		-- Free models can carry hostile scripts: remove every script unless explicitly allowed.
		local removed: number, kept: number, classes: {[string]: number}, names: any = 0, 0, {}, V.array({})
		for _, item in ipairs(asset:GetDescendants()) do
			if item.Parent ~= nil and item.ClassName == "PackageLink" then
				-- An auto-updating package could bring scripts back after adoption.
				item:Destroy()
			elseif item.Parent ~= nil and item:IsA("LuaSourceContainer") then
				if allowScripts then
					kept += 1
					-- Kept scripts land disabled; turning one on is a separate, reviewed script.set_enabled.
					if item:IsA("BaseScript") then item.Disabled = true end
				else
					removed += 1
					classes[item.ClassName] = (classes[item.ClassName] or 0) + 1
					if #names < L.removedNames then table.insert(names, string.sub(item.Name, 1, 100)) end
					item:Destroy()
				end
			end
		end
		local root = asset
		if asset:IsA("Model") then asset.Parent = nil
		else
			root = Instance.new("Model")
			asset.Parent = root
		end
		local anchored: number = 0
		if anchor then
			for _, item in ipairs(root:GetDescendants()) do
				if item:IsA("BasePart") then item.Anchored = true; anchored += 1 end
			end
		end
		local state=converted[root]
		local scale,placedExtents,bottom
		if state then
			AssetPlacement.preflightConverted(state.plan,maxSize,yaw,#args.parent.pathSegments)
			scale=AssetPlacement.convertedScale(state.plan,maxSize,yaw)
			local low,high=AssetPlacement.convertedBounds(state.plan,0)
			bottom={(low[1]+high[1])/2,low[2],(low[3]+high[3])/2}
			local yawLow,yawHigh=AssetPlacement.convertedBounds(state.plan,yaw)
			placedExtents={(yawHigh[1]-yawLow[1])*scale,(yawHigh[2]-yawLow[2])*scale,(yawHigh[3]-yawLow[3])*scale}
		else
			local components, extents, fitted = boxOf(root, yaw)
			placedExtents=fitted
			scale = AssetPlacement.fitScale(placedExtents, maxSize)
			if scale ~= 1 then
				root:ScaleTo(root:GetScale() * scale)
				components, extents, placedExtents = boxOf(root, yaw)
			end
			bottom = AssetPlacement.bottomCenter(components, extents)
			root.WorldPivot = CFrame.new(bottom[1], bottom[2], bottom[3])
		end
		local y, grounded = position[2], false
		if ground then
			-- The asset is detached, so the probe only sees existing terrain and parts.
			local hit = workspace:Raycast(Vector3.new(position[1], position[2] + 500, position[3]), Vector3.new(0, -1000, 0))
			if hit then y, grounded = hit.Position.Y, true end
		end
		local placement=CFrame.new(position[1], y, position[3]) * CFrame.Angles(0, math.rad(yaw), 0)
		if state then
			transformConverted(state,placement*CFrame.new(-bottom[1]*scale,-bottom[2]*scale,-bottom[3]*scale),scale)
			root.WorldPivot=placement
		else root:PivotTo(placement) end
		root.Name = name
		root.Parent = container
		local ref = ops.registry:ref(root)
		progress.ref = ref
		local count = #root:GetDescendants()
		ops.registry.owned[root] = {parent = container, placed = {count = count, pivot = {root.WorldPivot:GetComponents()}}}
		release(ops, id)
		local rounded = math.floor(scale * 10000 + 0.5) / 10000
		local result: any = {ref = ref, adopted = {name = string.sub(asset.Name, 1, 100), className = asset.ClassName},
			removedScripts = {count = removed, classes = classes, names = names}, keptScripts = kept, anchored = anchored,
			scale = rounded, size = V.array({placedExtents[1], placedExtents[2], placedExtents[3]}), grounded = grounded,
			mutation = {kind = "scene.place_asset", ref = ref, before = V.NULL,
				after = {descendants = count, removedScripts = removed, keptScripts = kept, scale = rounded}}}
		if state then result.converted=AssetPlacement.observeConverted(root,ops) end
		return result
	end)
end

-- Applies a generated MaterialVariant (under MaterialService) to bounded parts with a receipt.
function AssetPlacement.applyMaterial(ops: any, command: any, args: any, guard: () -> ()): any
	V.fields(args, {"refs", "material", "variant"}, "material arguments")
	local list = V.list(args.refs, L.materialTargets, "material targets")
	if #list == 0 then V.fail("INPUT", "Choose at least one part.") end
	local materialName = V.string(args.material, "material", 32)
	if not table.find(AssetPlacement.GENERATED_MATERIALS, materialName) then V.fail("PROPERTY", "Unsupported generated base material.") end
	local found, material = pcall(function(): any return (Enum.Material :: any)[materialName] end)
	if not found or material == nil then V.fail("PROPERTY", "This Studio build lacks the requested base material.") end
	local variantName = V.string(args.variant, "material variant", 100)
	if not string.match(variantName, "^[%w_]+$") then V.fail("INPUT", "Material variant names are [A-Za-z0-9_].") end
	local service = ops.registry.gameModel:GetService("MaterialService")
	local variant = service:FindFirstChild(variantName, true)
	if not variant or variant.ClassName ~= "MaterialVariant" then V.fail("MATERIAL", "The generated material variant was not found under MaterialService.") end
	if variant.BaseMaterial ~= material then V.fail("MATERIAL", "The generated variant's base material differs from the requested material.") end
	local parts: {any}, seen: {[any]: boolean} = {}, {}
	for _, raw in ipairs(list) do
		local part = ops.registry:resolve(raw)
		if not part:IsA("BasePart") then V.fail("CLASS", "Materials apply to BaseParts only.") end
		if seen[part] then V.fail("INPUT", "Material targets must be distinct.") end
		seen[part] = true
		table.insert(parts, part)
	end
	return ops:record(command, guard, function(progress: any): any
		guard()
		local items: any = V.array({})
		for _, part in ipairs(parts) do
			table.insert(items, {ref = ops.registry:ref(part), Material = part.Material.Name, MaterialVariant = part.MaterialVariant})
		end
		progress.touched = true
		for _, part in ipairs(parts) do
			part.Material = material
			part.MaterialVariant = variantName
			if part.Material ~= material or part.MaterialVariant ~= variantName then V.fail("VERIFY", "A part did not take the generated material.") end
		end
		local ref = items[1].ref
		progress.ref = ref
		return {ref = ref, applied = #parts, mutation = {kind = "scene.apply_material", ref = ref, before = {items = items},
			after = {material = materialName, variant = variantName, count = #parts}}}
	end)
end

local function samePivot(current: any, recorded: {number}): boolean
	local now = {current:GetComponents()}
	for index, value in ipairs(recorded) do if math.abs(now[index] - value) > 1e-3 then return false end end
	return true
end

function AssetPlacement.restore(ops: any, command: any, original: any, instance: any, guard: () -> ()): ()
	if original.kind == "scene.place_asset" then
		local owned = ops.registry.owned[instance]
		local placed = owned and owned.placed
		local function matches(): boolean
			return placed ~= nil and instance.Parent == owned.parent and #instance:GetDescendants() == placed.count and samePivot(instance.WorldPivot, placed.pivot)
				and AssetPlacement.convertedMatches(instance,ops)
		end
		if not matches() then V.fail("CONFLICT", "The placed asset changed, moved, or gained/lost instances; restoration refused.") end
		ops:record(command, guard, function(progress: any): any
			guard()
			ops.registry:resolve(original.ref)
			if not matches() then V.fail("CONFLICT", "The placed asset changed before restoration.") end
			progress.ref = original.ref
			progress.touched = true
			instance:Destroy()
			return {restored = true, ref = original.ref}
		end)
		return
	end
	local parts: {any} = {}
	for _, item in ipairs(original.before.items) do
		local part = ops.registry:resolve(item.ref)
		if part.Material.Name ~= original.after.material or part.MaterialVariant ~= original.after.variant then
			V.fail("CONFLICT", "A part's material changed after the generated material was applied; restoration refused.")
		end
		local ok, prior = pcall(function(): any return (Enum.Material :: any)[item.Material] end)
		if not ok or prior == nil then V.fail("RECEIPT", "The recorded prior material is unavailable.") end
		table.insert(parts, {part = part, material = prior, variant = item.MaterialVariant})
	end
	ops:record(command, guard, function(progress: any): any
		guard()
		progress.ref = original.ref
		progress.touched = true
		for _, entry in ipairs(parts) do
			entry.part.Material = entry.material
			entry.part.MaterialVariant = entry.variant
		end
		return {restored = true, ref = original.ref}
	end)
end

-- scene.build clone templates: script-free Model/BasePart instances inside the granted roots.
function AssetPlacement.buildTemplates(ops: any, raw: any): {any}
	local templates: {any} = {}
	for _, value in ipairs(V.list(raw, L.templates, "clone templates")) do
		local template = ops.registry:resolve(value)
		if not (template:IsA("Model") or template:IsA("BasePart")) then V.fail("CLASS", "Clone templates must be a Model or BasePart.") end
		local descendants = template:GetDescendants()
		if #descendants > L.templateDescendants then V.fail("BODY_LIMIT", "A clone template may hold at most " .. L.templateDescendants .. " instances.") end
		for _, item in ipairs(descendants) do
			if item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink" then V.fail("SCRIPT", "Clone templates must be script-free; adopt them with scripts stripped.") end
		end
		if converted[template] and not unchanged(converted[template],ops) then V.fail("CONFLICT","Converted clone template changed or gained authored children.") end
		table.insert(templates, {instance = template, extra = #descendants})
	end
	return templates
end

function AssetPlacement.planClone(ops: any, item: any, name: string, into: number, templates: {any}): any
	V.fields(item, {"kind", "template", "name", "parent", "at", "yaw", "scale", "ground", "key"}, "clone item")
	local template = templates[V.integer(item.template, 1, math.max(1, #templates), "template index")]
	if not template then V.fail("INPUT", "Clone item names an unknown template.") end
	local at = triple(item.at, -100000, 100000, "clone position")
	if item.ground ~= nil and V.boolean(item.ground, "clone ground") then
		-- Read-only probe of existing terrain/parts; nothing from this build is parented yet.
		local hit = ops.registry:root("Workspace"):Raycast(Vector3.new(at[1], at[2] + 500, at[3]), Vector3.new(0, -1000, 0))
		if hit then at[2] = hit.Position.Y end
	end
	local yaw,scale=V.number(item.yaw,-360,360,"clone yaw"),V.number(item.scale,0.1,20,"clone scale")
	local state=converted[template.instance]
	if state then for _,resource in ipairs(state.plan.resources) do physicalSize(resource.nativePlan,state.scale*scale) end end
	return {clone = template.instance, extra = template.extra, className = template.instance.ClassName, name = name, parent = into,
		at = at, yaw = yaw, scale = scale, converted=state, convertedOps=if state then ops else nil}
end

function AssetPlacement.instantiate(entry: any): any
	if entry.converted and not unchanged(entry.converted,entry.convertedOps) then V.fail("CONFLICT","Converted template changed before cloning.") end
	local copy = entry.clone:Clone()
	if not copy then V.fail("VERIFY", "The clone template is not archivable.") end
	if entry.converted then
		local ok,result=pcall(function(): any
			local original=entry.converted
			local instances,parts,appearances={},{},{}
			for _,item in ipairs(copy:GetDescendants()) do
				local key,id=item:GetAttribute(NODE_ATTRIBUTE),item:GetAttribute(OBJECT_ATTRIBUTE)
				if key then
					if instances[key] or not original.plan.byKey[key] then V.fail("IDENTITY","Converted clone node coverage differs.") end
					instances[key]=item
				end
				if id then
					local matched=false
					for index,resource in ipairs(original.plan.resources) do if resource.object.sourceObjectId==id then
						if parts[index] or not item:IsA("MeshPart") then V.fail("IDENTITY","Converted clone mesh coverage differs.") end
						parts[index]=item;matched=true
					end end
					if not matched then V.fail("IDENTITY","Converted clone contains a foreign mesh.") end
				end
			end
			for index,resource in ipairs(original.plan.resources) do
				if not parts[index] then V.fail("IDENTITY","Converted clone mesh is absent.") end
				if original.appearances[index] then
					for _,child in ipairs(parts[index]:GetChildren()) do if child:IsA("SurfaceAppearance") then
						if appearances[index] then V.fail("IDENTITY","Converted clone appearance is duplicated.") end
						appearances[index]=child
					end end
					if not appearances[index] then V.fail("IDENTITY","Converted clone appearance is absent.") end
				end
			end
			for _,row in ipairs(original.plan.rows) do if not instances[row.node.nodeKey] then V.fail("IDENTITY","Converted clone node is absent.") end end
			AssetPlacement.registerConverted(copy,original.plan,instances,parts,original.hash,appearances)
			local state=converted[copy]
			local oldPivot=components(original.root:GetPivot())
			local target=CFrame.new(entry.at[1],entry.at[2],entry.at[3])*CFrame.Angles(0,math.rad(entry.yaw),0)
			-- Scale the template about its own placement pivot, then move once.
			local basis=CFrame.new(table.unpack(oldPivot));local relative=basis:Inverse()*original.transform
			local rc=components(relative);rc[1]*=entry.scale;rc[2]*=entry.scale;rc[3]*=entry.scale
			transformConverted(state,target*CFrame.new(table.unpack(rc)),original.scale*entry.scale)
			copy.WorldPivot=target
			return copy
		end)
		if not ok then
			if not pcall(function() copy:Destroy() end) then entry.convertedOps.assetCleanupFailed=true;V.fail("CLEANUP","Converted clone cleanup could not be established.") end
			error(result,0)
		end
		return result
	end
	-- The template was checked when the build was planned; it may have changed since, so check the copy itself.
	for _, item in ipairs(copy:GetDescendants()) do
		if item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink" then
			copy:Destroy()
			V.fail("SCRIPT", "Clone templates must be script-free; adopt them with scripts stripped.")
		end
	end
	if entry.scale ~= 1 then
		if copy:IsA("Model") then copy:ScaleTo(copy:GetScale() * entry.scale)
		else copy.Size = Vector3.new(copy.Size.X * entry.scale, copy.Size.Y * entry.scale, copy.Size.Z * entry.scale) end
	end
	copy:PivotTo(CFrame.new(entry.at[1], entry.at[2], entry.at[3]) * CFrame.Angles(0, math.rad(entry.yaw), 0))
	return copy
end

-- "Keep this mesh" (docs/build/MESH_KEEP.md). Uploads each retained EditableMesh of ONE placed procedural reconstruction to
-- the signed-in Studio user's own Roblox account through AssetUpload (AssetService.CreateAssetAsync), then swaps every
-- session MeshPart for a persistent MeshPart made from its new asset ID (AssetService.CreateMeshPartAsync) in one undo
-- recording. Only the host mesh-keep service can queue it, after the person confirmed the Arcane dialog; the host records
-- the intent durably before queueing, which is what recordIntent acknowledges. Nothing is retried. Asset IDs are always
-- returned, even when a later upload or the swap fails, so an upload is never lost from the receipt.
-- APIs (create.roblox.com, checked 2026-10-18): AssetService.CreateAssetAsync(object, Enum.AssetType, {CreatorId,
-- CreatorType, Name, Description}) -> (Enum.CreateAssetResult, assetId or error); AssetService.CreateMeshPartAsync(Content,
-- options) -> MeshPart; Content.fromAssetId(id), with Content.fromUri("rbxassetid://" .. id) as the fallback.
-- keepSupported probes every one of them; when any is missing the capability is not advertised (fails closed).
AssetPlacement.KEEP_LIMITS = table.freeze({meshes = 16, nameCodepoints = 50})
local KL = AssetPlacement.KEEP_LIMITS

function AssetPlacement.keepSupported(gameModel: any): boolean
	local ok, supported = pcall(function(): boolean
		local service = gameModel:GetService("AssetService")
		local enums: any, content: any = Enum, Content
		return type(service.CreateAssetAsync) == "function" and type(service.CreateMeshPartAsync) == "function"
			and typeof(enums.AssetType.Mesh) == "EnumItem" and typeof(enums.AssetCreatorType.User) == "EnumItem"
			and typeof(enums.CreateAssetResult.Success) == "EnumItem"
			and (type(content.fromAssetId) == "function" or type(content.fromUri) == "function")
	end)
	return ok and supported == true
end

-- Production engine bindings; the standalone tests inject doubles with the same shape.
function AssetPlacement.keepEngine(ops: any, assetUpload: any): any
	local content: any = Content
	return {service = ops.gameModel:GetService("AssetService"), AssetUpload = assetUpload,
		enums = {AssetType = Enum.AssetType, AssetCreatorType = Enum.AssetCreatorType, CreateAssetResult = Enum.CreateAssetResult},
		content = function(id: number): any
			if type(content.fromAssetId) == "function" then return content.fromAssetId(id) end
			return content.fromUri("rbxassetid://" .. string.format("%d", id))
		end,
		userId = function(): number return ops.gameModel:GetService("StudioService"):GetUserId() end}
end

local function clipName(name: string, suffix: string): string
	local room = KL.nameCodepoints - utf8.len(suffix)
	if (utf8.len(name) or 0) > room then name = string.sub(name, 1, (utf8.offset(name, room + 1) or (#name + 1)) - 1) end
	return name .. suffix
end

local SWAP_FIELDS = table.freeze({"Name", "Size", "CFrame", "Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow", "Transparency", "Material", "Color", "DoubleSided"})

-- The converted transaction prepares every replacement off-scene, then swaps
-- without yielding. Returned upload IDs survive every refusal/failure. Private
-- node pointers change only after the complete graph passes readback.
local function keepConverted(ops: any, state: any, owner: any, entries: any, guard: any, engine: any, attemptId: string): (number, any)
	local fresh,copies,oldParts,oldAppearances,oldIds,parents={},{},{},{},{},{}
	local originalBaseline=state.baseline
	local observation: any=nil
	local function clean(): ()
		for _,part in pairs(fresh) do if part and part.Parent==nil then
			if not pcall(function() part:Destroy() end) then ops.assetCleanupFailed=true end
		end end
		for _,copy in pairs(copies) do if copy and copy.Parent==nil then
			if not pcall(function() copy:Destroy() end) then ops.assetCleanupFailed=true end
		end end
	end
	local ok=pcall(function()
		guard()
		if owner.retired or not unchanged(state,ops) then V.fail("CONFLICT","Converted graph changed before persistent swap.") end
		for index,resource in ipairs(owner.meshes) do
			oldParts[index],oldAppearances[index],oldIds[index],parents[index]=resource.part,resource.appearance,resource.keptAssetId,resource.part.Parent
			if resource.keptAssetId==entries[index].assetId then fresh[index]=false
			else
				local old=resource.part
				local part=engine.service:CreateMeshPartAsync(engine.content(entries[index].assetId),{CollisionFidelity=old.CollisionFidelity,RenderFidelity=old.RenderFidelity})
				if part~=nil then fresh[index]=part end -- Retain late allocations BEFORE the guard.
				guard()
				if part==nil or not part:IsA("MeshPart") or part.Parent~=nil then V.fail("ENGINE","Expected a detached persistent MeshPart.") end
				AssetPlacement.verifyCarrier(part,resource.object)
				for _,field in ipairs(SWAP_FIELDS) do part[field]=old[field] end
				for _,field in ipairs({"PivotOffset","MaterialVariant","Reflectance","Massless","CollisionGroup","CustomPhysicalProperties","Locked","RootPriority"}) do part[field]=old[field] end
				for key,value in pairs(old:GetAttributes()) do part:SetAttribute(key,value) end
				for _,tag in ipairs(ops.collection:GetTags(old)) do ops.collection:AddTag(part,tag) end
				if resource.appearance then
					local appearance=resource.appearance:Clone()
					if appearance~=nil then copies[index]=appearance end
					guard()
					if appearance==nil or not appearance:IsA("SurfaceAppearance") or appearance.Parent~=nil then V.fail("ENGINE","Expected a detached persistent appearance copy.") end
					appearance.Parent=part
				end
				if stateBytes(observed(part,ops.collection))~=stateBytes(observed(old,ops.collection)) then V.fail("VERIFY","Persistent replacement properties differ.") end
			end
		end
		guard()
		if owner.retired or not unchanged(state,ops) then V.fail("CONFLICT","Converted graph changed while loading persistent assets.") end
		local recording=ops.history:TryBeginRecording("Arcane.keep."..attemptId,"Arcane keep converted mesh")
		if not recording then V.fail("HISTORY","Cannot begin persistent graph recording.") end
		local swapped,swapError=pcall(function()
			for index,resource in ipairs(owner.meshes) do
				local part=fresh[index]
				if part then
					part.Parent=parents[index];oldParts[index].Parent=nil
					resource.part,resource.appearance,resource.keptAssetId=part,copies[index],entries[index].assetId
					state.parts[index],state.appearances[index]=part,copies[index]
					local key=resource.association.nodeKey
					if key~=nil and key~=V.NULL then state.instances[key]=part end
				end
			end
			verifyConverted(state)
			observation=AssetPlacement.observeConverted(state.root,ops)
			for _,object in ipairs(observation.objects) do
				for resourceIndex,resource in ipairs(owner.meshes) do if object.sourceObjectId==resource.object.sourceObjectId then object.meshAssetId=tostring(entries[resourceIndex].assetId) end end
			end
			if not pcall(function() ops.history:FinishRecording(recording,Enum.FinishRecordingOperation.Commit) end) then V.fail("HISTORY","Persistent graph recording could not be committed.") end
		end)
		if not swapped then
			-- No engine call yields within this transaction. Still refuse to
			-- erase a callback-added child or other unexpected replacement state.
			local rollback=pcall(function()
				state.baseline=originalBaseline
				for index,resource in ipairs(owner.meshes) do
					local part=fresh[index]
					if part then
						for _,child in ipairs(part:GetChildren()) do if child~=copies[index] then V.fail("CONFLICT","Persistent replacement gained an authored child.") end end
						part.Parent=nil;oldParts[index].Parent=parents[index]
						resource.part,resource.appearance,resource.keptAssetId=oldParts[index],oldAppearances[index],oldIds[index]
						state.parts[index],state.appearances[index]=oldParts[index],oldAppearances[index]
						local key=resource.association.nodeKey
						if key~=nil and key~=V.NULL then state.instances[key]=oldParts[index] end
					end
				end
				verifyConverted(state)
				if not unchanged(state,ops) then V.fail("VERIFY","Persistent graph rollback differs from its original baseline.") end
			end)
			pcall(function() ops.history:FinishRecording(recording,Enum.FinishRecordingOperation.Commit) end)
			if not rollback then ops.assetCleanupFailed=true;owner.graphUncertain=true end
			error(swapError,0)
		end
	end)
	if not ok then
		clean()
		for _,entry in ipairs(entries) do entry.reason=if ops.assetCleanupFailed then "CLEANUP" else "SWAP_REFUSED" end
		return 0,nil
	end
	for _,entry in ipairs(entries) do entry.swapped=true end
	local owned=ops.registry.owned[state.root]
	if owned and owned.placed then owned.placed.count=#state.root:GetDescendants() end
	-- Old parts are detached owned session objects. Retire them only after every
	-- pointer/baseline moved; never destroy an object that gained an authored child.
	for index,old in ipairs(oldParts) do if fresh[index] then
		local safe=true
		for _,child in ipairs(old:GetChildren()) do if child~=oldAppearances[index] then safe=false end end
		if not safe or not pcall(function() old:Destroy() end) then ops.assetCleanupFailed=true end
	end end
	if ops.assetCleanupFailed then for _,entry in ipairs(entries) do entry.reason="CLEANUP" end end
	return #entries,observation
end

function AssetPlacement.keep(ops: any, owner: any, digest: string, args: any, guard: () -> (), engine: any): any
	V.fields(args, {"source", "attemptId", "name", "description", "creatorId", "continuity", "finish", "assetIds"}, "keep-mesh arguments")
	local attemptId = V.string(args.attemptId, "attempt ID", 36)
	if not string.match(attemptId, "^%x+%-%x+%-%x+%-%x+%-%x+$") then V.fail("INPUT", "Expected a host upload attempt ID.") end
	local name = V.string(args.name, "asset name", 200)
	if (utf8.len(name) or 0) > KL.nameCodepoints or not string.find(name, "%S") then V.fail("INPUT", "Invalid asset name.") end
	local description = V.string(args.description, "asset description", 4096, true)
	local creatorId = V.integer(args.creatorId, 1, 9007199254740991, "creator ID")
	local continuity = V.fields(args.continuity, {"clientLifetimeId", "pluginArtifactHash", "playEpoch"}, "keep-mesh continuity")
	local finish = V.boolean(args.finish, "finish")
	local reuse: {number}? = nil
	if finish then
		reuse = {}
		for index, value in ipairs(V.list(args.assetIds, KL.meshes, "asset IDs")) do (reuse :: any)[index] = V.integer(value, 1, 9007199254740991, "asset ID") end
	elseif args.assetIds ~= nil then V.fail("INPUT", "A new keep never carries asset IDs.") end
	local meshes = owner.meshes
	if #meshes == 0 or #meshes > KL.meshes then V.fail("CAPACITY", "Keep this mesh supports 1.." .. KL.meshes .. " meshes per model; nothing was uploaded.") end
	if reuse and #reuse ~= #meshes then V.fail("SCOPE", "The recorded asset IDs do not match this model's meshes.") end
	local model = owner.placed
	if model == nil or model.Parent == nil then V.fail("STATE", "The placed model was removed or undone; nothing was uploaded. Place it again first.") end
	local convertedState=converted[model]
	if owner.graph and (not convertedState or not unchanged(convertedState,ops) or owner.graphUncertain) then V.fail("CONFLICT","Converted graph changed or its ownership is uncertain; nothing was uploaded.") end
	for _, resource in ipairs(meshes) do
		if resource.disposed or resource.mesh == nil then V.fail("STATE", "The session meshes were released; nothing was uploaded.") end
	end
	-- The account the person confirmed in Arcane must still be the signed-in Studio user, right before any upload.
	local function signedIn(): boolean
		local ok, id = pcall(engine.userId)
		return ok and id == creatorId
	end
	if not signedIn() then V.fail("ACCOUNT", "The Roblox account signed in to Studio changed since you confirmed. Nothing was uploaded.") end
	guard()
	local entries: {any} = {}
	local started = 0
	if reuse then
		for index, resource in ipairs(meshes) do
			local object = resource.object
			entries[index] = {index = index, name = if type(object) == "table" and type(object.name) == "string" then string.sub(object.name, 1, 100) else "Mesh" .. index,
				assetId = reuse[index], upload = "reused", reason = V.NULL, swapped = false}
		end
	else
		local lastResult: string? = nil
		-- Pass-through that only remembers the engine's own CreateAssetResult name for the receipt (quota, moderation...).
		local recorder = {CreateAssetAsync = function(_self: any, resource: any, assetType: any, parameters: any): (any, any)
			local result, idOrError = engine.service:CreateAssetAsync(resource, assetType, parameters)
			lastResult = if typeof(result) == "EnumItem" and type(result.Name) == "string" and string.match(result.Name, "^%a+$") then string.sub(result.Name, 1, 40) else nil
			return result, idOrError
		end}
		local function current(resource: any): boolean
			for _, item in ipairs(meshes) do if item.mesh == resource and not item.disposed then return true end end
			return false
		end
		local uploader = engine.AssetUpload.new(recorder, engine.enums, {
			assertAdmission = function(_ticket: any, resource: any): ()
				if owner.retired or not current(resource) or not signedIn() or (convertedState and not unchanged(convertedState,ops)) then error("admission", 0) end
			end,
			liveGuard = function(_ticket: any, _resource: any): () guard() end,
			-- The host wrote this attempt's intent receipt before the command existed; the command is that acknowledgement.
			recordIntent = function(ticket: any): any return table.freeze({phase = "intent", ticket = ticket}) end,
			recordResult = function(ticket: any, observation: any): any
				return table.freeze({phase = "result", ticket = ticket, assetId = observation.assetId})
			end,
		})
		local identity = {sessionId = ops.registry.sessionId, clientLifetimeId = V.string(continuity.clientLifetimeId, "client lifetime", 128),
			pluginArtifactHash = V.string(continuity.pluginArtifactHash, "plugin artifact hash", 64), playEpoch = V.integer(continuity.playEpoch, 0, 9007199254740991, "play epoch"),
			placeId = ops.gameModel.PlaceId, universeId = ops.gameModel.GameId}
		local stop: string? = nil
		for index, resource in ipairs(meshes) do
			local object = resource.object
			local label = if type(object) == "table" and type(object.name) == "string" then string.sub(object.name, 1, 100) else "Mesh" .. index
			local entry: any = {index = index, name = label, assetId = V.NULL, upload = "skipped", reason = V.NULL, swapped = false}
			entries[index] = entry
			if stop then entry.reason = stop; continue end
			local sha = if type(object) == "table" then object.meshExportSha256 else nil
			if type(sha) ~= "string" or not string.match(sha, "^[0-9a-f]+$") or #sha ~= 64 then entry.upload, entry.reason, stop = "failed", "SOURCE_METADATA", "STOPPED"; continue end
			lastResult = nil
			local ticket = table.freeze({attemptId = attemptId .. "." .. index, assetType = "Mesh",
				creator = table.freeze({kind = "user", id = creatorId}),
				source = table.freeze({jobId = "transfer-" .. string.sub(digest, 1, 32), resourceId = "mesh-" .. index, sha256 = sha}),
				uploader = table.freeze({status = "available", id = creatorId, provenance = "StudioService:GetUserId"}),
				continuity = table.freeze(table.clone(identity)),
				name = if #meshes == 1 then name else clipName(name, " " .. index), description = description})
			local called, outcome = pcall(uploader.upload, uploader, ticket, resource.mesh)
			if not called then
				entry.upload, entry.reason, stop = "failed", if type(outcome) == "table" and type(outcome.code) == "string" and string.match(outcome.code, "^[%u_]+$") then outcome.code else "INPUT", "STOPPED"
				continue
			end
			if outcome.uploadStarted then started += 1 end
			if outcome.state == "succeeded" then entry.assetId, entry.upload = outcome.assetId, "succeeded"
			elseif outcome.assetId ~= nil then
				-- Roblox created the asset but continuing scope was lost: keep the ID, stop further uploads.
				entry.assetId, entry.upload, entry.reason, stop = outcome.assetId, "succeeded", outcome.reason, "STOPPED"
			elseif outcome.state == "failed" then
				entry.upload, entry.reason, stop = "failed", "ENGINE_REJECTED" .. (if lastResult then ":" .. lastResult else ""), "STOPPED"
			else
				entry.upload, entry.reason, stop = if outcome.uploadStarted then "reconciliation" else "failed", outcome.reason or "UNKNOWN", "STOPPED"
			end
		end
	end
	-- Swap only when every mesh has an asset ID: a model is never left half persistent by a partial upload.
	local complete = true
	for _, entry in ipairs(entries) do if entry.assetId == V.NULL then complete = false end end
	local swapped = 0
	local convertedObservation: any=nil
	if complete and convertedState then
		swapped,convertedObservation=keepConverted(ops,convertedState,owner,entries,guard,engine,attemptId)
	elseif complete then
		local fresh: {any}, copies: {any} = {}, {}
		pcall(function()
			guard()
			if model.Parent == nil then V.fail("STATE", "The placed model was removed.") end
			for index, resource in ipairs(meshes) do
				local old, id = resource.part, entries[index].assetId
				if resource.keptAssetId == id and old ~= nil and old.Parent ~= nil then fresh[index] = false -- already persistent (earlier finish)
				else
					if old == nil or old.Parent == nil or not old:IsDescendantOf(model) then V.fail("STATE", "A session part was removed from the model.") end
					local part = engine.service:CreateMeshPartAsync(engine.content(id), {CollisionFidelity = old.CollisionFidelity, RenderFidelity = old.RenderFidelity})
					if part ~= nil then fresh[index] = part end -- Own late allocations before the guard.
					guard()
					if part == nil or not part:IsA("MeshPart") then V.fail("ENGINE", "CreateMeshPartAsync did not return a MeshPart.") end
					fresh[index] = part
				end
			end
			local recording = ops.history:TryBeginRecording("Arcane.keep." .. attemptId, "Arcane keep mesh")
			if not recording then V.fail("HISTORY", "Cannot begin an undo recording.") end
			local done = pcall(function()
				for index, resource in ipairs(meshes) do
					local part = fresh[index]
					if part then
						local old = resource.part
						for _, field in ipairs(SWAP_FIELDS) do (part :: any)[field] = old[field] end
						local appearance = resource.appearance
						if appearance ~= nil and appearance.Parent == old then
							local copy = appearance:Clone()
							if copy == nil then V.fail("ENGINE", "SurfaceAppearance could not be copied to the kept mesh.") end
							copies[index] = copy
							copy.Parent = part
						end
						part.Parent = old.Parent
						old.Parent = nil
						resource.part, resource.keptAssetId = part, entries[index].assetId
						if copies[index] then resource.appearance = copies[index] end
					end
					entries[index].swapped = true
				end
			end)
			pcall(function() ops.history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
			if not done then V.fail("ENGINE", "The part swap stopped part-way.") end
		end)
		-- Preserve uploaded IDs while retiring only unswapped detached replacements.
		for index, part in pairs(fresh) do
			if part and meshes[index].part ~= part and part.Parent == nil then
				if not pcall(function() part:Destroy() end) then ops.assetCleanupFailed = true end
			end
		end
		for index, copy in pairs(copies) do
			if meshes[index].appearance ~= copy and copy.Parent == nil then
				if not pcall(function() copy:Destroy() end) then ops.assetCleanupFailed = true end
			end
		end
		for _, entry in ipairs(entries) do if entry.swapped then swapped += 1 end end
		-- The placement receipt stays restorable: same model, same instance count after a 1:1 swap.
		local owned = if swapped == #entries then ops.registry.owned[model] else nil
		if owned and owned.placed then owned.placed.count = #model:GetDescendants() end
	end
	local ids = 0
	for _, entry in ipairs(entries) do if entry.assetId ~= V.NULL then ids += 1 end end
	local state = if ids == 0 then "failed" elseif ids < #entries then "partial" elseif swapped == #entries then "kept" else "uploaded"
	local refOk, ref = pcall(function(): any return ops.registry:ref(model) end)
	local result: any = {state = state, meshes = V.array(entries), uploadsStarted = started, swapped = swapped,
		persistence = if state == "kept" then "saved-asset" else "studio-session-only", creatorId = creatorId, ref = if refOk then ref else V.NULL}
	if convertedObservation then result.converted=convertedObservation end
	return result
end

return table.freeze(AssetPlacement)
