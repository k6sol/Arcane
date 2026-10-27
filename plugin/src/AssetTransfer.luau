--!strict
-- Internal receive-side data admission. No services, uploads, parenting or
-- engine verification. A live caller-owned scope guard is still mandatory.
local Sha256Stream = require(script.Parent.Sha256Stream)
local AssetMesh = require(script.Parent.AssetMesh)
local AssetTransfer = {}
local LIMITS = table.freeze({packetBytes = 256 * 1024, bytes = 48 * 1024 * 1024,
	packets = 8192, objects = 128, streams = 4096, binaryBytes = 32 * 1024 * 1024})

local function fail(code: string, message: string): never
	error(table.freeze({code = code, message = message}), 0)
end
local function hash(bytes: string): string
	local digest = Sha256Stream.new()
	digest:update(bytes)
	return digest:digest()
end
local function plain(value: any, label: string): any
	if type(value) ~= "table" or getmetatable(value) ~= nil then fail("INPUT", label .. " must be plain data.") end
	return value
end
local function finite(value: any, maximum: number, label: string): number
	if type(value) ~= "number" or value ~= value or math.abs(value) == math.huge or math.abs(value) > maximum then fail("INPUT", "Invalid " .. label .. ".") end
	return value
end
local function numbers(value: any, count: number, label: string): {number}
	plain(value, label)
	local keys = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > count then fail("INPUT", "Invalid " .. label .. " array.") end
		keys += 1
	end
	if keys ~= count then fail("INPUT", "Incomplete " .. label .. " array.") end
	local copy: {number} = {}
	for index = 1, count do copy[index] = finite(value[index], 1000000, label) end
	return table.freeze(copy)
end
local function conversionSnapshot(value: any, version: number?): any
	plain(value, "Conversion")
	local allowed = {sourceUnits = true, sourceUp = true, exportUnits = true, exportUp = true,
		targetUnits = true, targetUp = true, studsPerMeter = true}
	local count = 0
	for key in pairs(value) do if not allowed[key] then fail("INPUT", "Unsupported conversion field.") end; count += 1 end
	if count ~= 7 or value.sourceUnits ~= "meters" or value.sourceUp ~= (if version == 2 then "Y" else "Z") or value.exportUnits ~= "meters"
		or value.exportUp ~= "Y" or value.targetUnits ~= "studs" or value.targetUp ~= "Y" then fail("INPUT", "Unsupported conversion literals.") end
	local units = finite(value.studsPerMeter, 1000, "studs per meter")
	if units <= 0 then fail("INPUT", "Positive studs per meter required.") end
	return table.freeze({sourceUnits = "meters", sourceUp = if version == 2 then "Y" else "Z", exportUnits = "meters", exportUp = "Y",
		targetUnits = "studs", targetUp = "Y", studsPerMeter = units})
end
local function measuredBounds(value: any, collision: boolean): any
	plain(value, "Measured bounds")
	local count = 0
	for key in pairs(value) do if key ~= "min" and key ~= "max" then fail("INPUT", "Unsupported bounds field.") end; count += 1 end
	if count ~= 2 then fail("INPUT", "Incomplete measured bounds.") end
	local low, high = numbers(value.min, 3, "bounds minimum"), numbers(value.max, 3, "bounds maximum")
	local positive = 0
	for axis = 1, 3 do
		if low[axis] > high[axis] then fail("INPUT", "Reversed measured bounds.") end
		if low[axis] < high[axis] then positive += 1 end
	end
	if positive < (if collision then 3 else 2) then fail("INPUT", "Expected measured surface or collision volume bounds.") end
	return {min = low, max = high}
end

-- Pure numeric plan, never engine evidence or authority. Geometry and measured
-- bounds stay unchanged. Only the physical MeshPart size has an explicit floor.
function AssetTransfer.meshPartPlan(object: any, conversion: any, version: number?): any
	plain(object, "Mesh object")
	if object.role ~= "render" and object.role ~= "collision" then fail("INPUT", "Unsupported mesh role.") end
	local bounds = measuredBounds(object.bounds, object.role == "collision")
	measuredBounds(object.worldBounds, object.role == "collision")
	local units = conversionSnapshot(conversion, version).studsPerMeter
	local m, declared = numbers(object.exportTransform, 16, "export transform"), numbers(object.scale, 3, "export scale")
	if m[4] ~= 0 or m[8] ~= 0 or m[12] ~= 0 or m[16] ~= 1 then fail("UNSUPPORTED_TRANSFORM", "Expected an affine export transform.") end
	local scales: {number}, r: {number} = {}, {}
	for column = 1, 3 do
		local at = (column - 1) * 4
		local scale = math.sqrt(m[at + 1] ^ 2 + m[at + 2] ^ 2 + m[at + 3] ^ 2)
		if scale <= 0 or declared[column] <= 0 or math.abs(scale - declared[column]) > 1e-6 * math.max(1, scale, declared[column]) then
			fail("UNSUPPORTED_TRANSFORM", "Export scale disagrees with positive matrix columns.")
		end
		scales[column] = scale
		r[at + 1], r[at + 2], r[at + 3] = m[at + 1] / scale, m[at + 2] / scale, m[at + 3] / scale
	end
	for a = 0, 1 do
		for b = a + 1, 2 do
			local dot = r[a * 4 + 1] * r[b * 4 + 1] + r[a * 4 + 2] * r[b * 4 + 2] + r[a * 4 + 3] * r[b * 4 + 3]
			if math.abs(dot) > 1e-6 then fail("UNSUPPORTED_TRANSFORM", "Sheared export transform requires baking.") end
		end
	end
	local determinant = r[1] * (r[6] * r[11] - r[7] * r[10]) - r[5] * (r[2] * r[11] - r[3] * r[10]) + r[9] * (r[2] * r[7] - r[3] * r[6])
	if math.abs(determinant - 1) > 1e-6 then fail("UNSUPPORTED_TRANSFORM", "Expected a proper positive rotation.") end
	local centre: {number} = {}
	local size: {number}, padding: {number} = {}, {}
	for axis = 1, 3 do
		centre[axis] = (bounds.min[axis] + bounds.max[axis]) / 2
		local measuredSize = (bounds.max[axis] - bounds.min[axis]) * scales[axis] * units
		size[axis] = math.max(0.05, measuredSize) -- Existing Arcane physical-size policy, not mesh thickness.
		padding[axis] = size[axis] - measuredSize
	end
	local cframe = {
		(m[1] * centre[1] + m[5] * centre[2] + m[9] * centre[3] + m[13]) * units,
		(m[2] * centre[1] + m[6] * centre[2] + m[10] * centre[3] + m[14]) * units,
		(m[3] * centre[1] + m[7] * centre[2] + m[11] * centre[3] + m[15]) * units,
		r[1], r[5], r[9], r[2], r[6], r[10], r[3], r[7], r[11],
	}
	for _, values in ipairs({size, padding, cframe}) do
		for _, value in ipairs(values) do finite(value, math.huge, "physical sizing result") end
	end
	if version == 2 then
		local exact = {}
		for axis = 1, 3 do
			exact[axis] = (bounds.max[axis]-bounds.min[axis])*scales[axis]*units
			-- Arcane's existing physical floor is an initial delivery policy, not
			-- a verified Engine minimum. Never stretch a small nonzero surface.
			if exact[axis] > 0 and exact[axis] < 0.05 then fail("UNSUPPORTED_TRANSFORM", "Nonzero source extent is below the current physical sizing policy.") end
		end
		return table.freeze({size=table.freeze(size),cframe=table.freeze(cframe),physicalPaddingStuds=table.freeze(padding),
			exactSourceSizeStuds=table.freeze(exact),localBoundsCentre=table.freeze(centre),coordinateSpace="source-local-Y-up-meters",
			carrierCoordinateSpace="centered-carrier-meters",carrierLocalCentre=table.freeze(table.clone(centre)),
			sourcePivotCFrame=table.freeze({m[13]*units,m[14]*units,m[15]*units,r[1],r[5],r[9],r[2],r[6],r[10],r[3],r[7],r[11]}),
			pivotOffset=table.freeze({-centre[1]*scales[1]*units,-centre[2]*scales[2]*units,-centre[3]*scales[3]*units,1,0,0,0,1,0,0,0,1})})
	end
	return table.freeze({size = table.freeze(size), cframe = table.freeze(cframe), physicalPaddingStuds = table.freeze(padding)})
end
local function snapshot(value: any, depth: number, budget: any): any
	budget.count += 1
	if depth > (budget.depth or 32) or budget.count > (budget.maximum or 60000) then fail("BUDGET", "Decoded packet complexity exceeded.") end
	local kind = type(value)
	if kind == "nil" or kind == "boolean" then return value end
	if kind == "string" then if #value > LIMITS.packetBytes then fail("BUDGET", "Decoded string exceeded.") end; return value end
	if kind == "number" then if value ~= value or math.abs(value) == math.huge then fail("INPUT", "Nonfinite decoded number.") end; return value end
	plain(value, "Decoded packet value")
	local copy = {}
	for key, child in pairs(value) do
		if (type(key) ~= "string" and type(key) ~= "number") or key == "__proto__" or key == "prototype" or key == "constructor" then
			fail("INPUT", "Invalid decoded key.")
		end
		copy[key] = snapshot(child, depth + 1, budget)
	end
	return copy
end
local function integer(value: any, minimum: number, maximum: number): number
	if type(value) ~= "number" or value ~= value or value % 1 ~= 0 or value < minimum or value > maximum then
		fail("BUDGET", "Transfer integer exceeds its bounds.")
	end
	return value
end
local function digest(value: any): string
	if type(value) ~= "string" or #value ~= 64 or not string.match(value, "^[a-f0-9]+$") then
		fail("INPUT", "Expected exact SHA-256.")
	end
	return value
end
local function base64(text: any): string
	if type(text) ~= "string" or #text > LIMITS.packetBytes or #text % 4 ~= 0 then fail("INPUT", "Invalid bounded base64.") end
	local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	local result = table.create(math.ceil(#text / 4))
	local function sextet(character: string): number
		local at = string.find(alphabet, character, 1, true)
		if not at then fail("INPUT", "Invalid base64 alphabet.") end
		return at - 1
	end
	for at = 1, #text, 4 do
		local a, b, c, d = string.sub(text, at, at), string.sub(text, at + 1, at + 1),
			string.sub(text, at + 2, at + 2), string.sub(text, at + 3, at + 3)
		local x, y = sextet(a), sextet(b)
		local z, w = if c == "=" then 0 else sextet(c), if d == "=" then 0 else sextet(d)
		if (c == "=" and d ~= "=") or ((c == "=" or d == "=") and at + 3 ~= #text)
			or (c == "=" and y % 16 ~= 0) or (d == "=" and c ~= "=" and z % 4 ~= 0) then
			fail("INPUT", "Noncanonical base64 padding.")
		end
		local value = string.char(x * 4 + math.floor(y / 16))
		if c ~= "=" then value ..= string.char((y % 16) * 16 + math.floor(z / 4)) end
		if d ~= "=" then value ..= string.char((z % 4) * 64 + w) end
		result[#result + 1] = value
	end
	return table.concat(result)
end

-- Version two is authenticated by the ORIGINAL raw packet hash chain. These
-- checks are independent data checks, never a JS-number JSON reserialization
-- proof, same-process permission, or observed Engine fidelity.
local function closed(value: any, allowed: {string}): any
	plain(value, "Converted record")
	for key in pairs(value) do if not table.find(allowed, key) then fail("INPUT", "Unknown converted field.") end end
	return value
end
local function dense(value: any, maximum: number): any
	plain(value, "Converted array")
	local length = #value
	integer(length, 0, maximum)
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > length then fail("INPUT", "Expected a dense converted array.") end
		count += 1
	end
	if count ~= length then fail("INPUT", "Converted array has missing entries.") end
	return value
end
local function freezeData(value: any): any
	if type(value) == "table" and not table.isfrozen(value) then
		for _, child in pairs(value) do freezeData(child) end
		table.freeze(value)
	end
	return value
end
local function equalData(a: any, b: any): boolean
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	for key, child in pairs(a) do if not equalData(child, b[key]) then return false end end
	for key in pairs(b) do if a[key] == nil then return false end end
	return true
end
local IDENTITY = table.freeze({1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1})
local function multiply(a: any, b: any): any
	local out = {}
	for column = 0, 3 do for row = 1, 4 do
		local total = 0
		for k = 0, 3 do total += a[k * 4 + row] * b[column * 4 + k + 1] end
		out[column * 4 + row] = finite(total, 1000000, "converted world matrix")
	end end
	return out
end
local function proper(value: any, unit: boolean): any
	local m = numbers(value, 16, "converted matrix")
	if m[4] ~= 0 or m[8] ~= 0 or m[12] ~= 0 or m[16] ~= 1 then fail("UNSUPPORTED_TRANSFORM", "Expected an affine converted transform.") end
	local r, scales = {}, {}
	for c = 0, 2 do
		local at = c * 4
		local s = math.sqrt(m[at+1]^2 + m[at+2]^2 + m[at+3]^2)
		if s <= 0 or (unit and math.abs(s - 1) > 1e-6) then fail("UNSUPPORTED_TRANSFORM", "Scaled grouping pivot is unsupported.") end
		scales[c+1] = s
		for row = 1, 3 do r[at+row] = m[at+row] / s end
	end
	for a = 0, 1 do for b = a+1, 2 do
		if math.abs(r[a*4+1]*r[b*4+1]+r[a*4+2]*r[b*4+2]+r[a*4+3]*r[b*4+3]) > 1e-6 then fail("UNSUPPORTED_TRANSFORM", "Sheared converted transform is unsupported.") end
	end end
	local det = r[1]*(r[6]*r[11]-r[7]*r[10])-r[5]*(r[2]*r[11]-r[3]*r[10])+r[9]*(r[2]*r[7]-r[3]*r[6])
	if math.abs(det-1) > 1e-6 then fail("UNSUPPORTED_TRANSFORM", "Reflected converted transform is unsupported.") end
	return scales
end
local function nodeKey(value: any): string
	if type(value) ~= "string" or #value > 32 or not (string.match(value,"^node%d+$") or string.match(value,"^node%d+_primitive%d+$")) then fail("IDENTITY", "Invalid converted node key.") end
	return value
end
local function localMatrix(node: any): any
	if node.matrix ~= nil then
		if node.translation ~= nil or node.rotation ~= nil or node.scale ~= nil then fail("IDENTITY", "Ambiguous source node transform.") end
		return numbers(node.matrix,16,"source local matrix")
	end
	local t = if node.translation ~= nil then numbers(node.translation,3,"source translation") else {0,0,0}
	local q = if node.rotation ~= nil then numbers(node.rotation,4,"source rotation") else {0,0,0,1}
	local s = if node.scale ~= nil then numbers(node.scale,3,"source scale") else {1,1,1}
	local x,y,z,w = q[1],q[2],q[3],q[4]
	if math.abs(math.sqrt(x*x+y*y+z*z+w*w)-1)>0.001 then fail("IDENTITY","Source rotation is not a unit quaternion.") end
	-- Keep the host core's exact operation order; do not normalize quaternions
	-- or silently repair source transforms during native admission.
	return {(1-2*(y*y+z*z))*s[1],(2*(x*y+z*w))*s[1],(2*(x*z-y*w))*s[1],0,
		(2*(x*y-z*w))*s[2],(1-2*(x*x+z*z))*s[2],(2*(y*z+x*w))*s[2],0,
		(2*(x*z+y*w))*s[3],(2*(y*z-x*w))*s[3],(1-2*(x*x+y*y))*s[3],0,t[1],t[2],t[3],1}
end
local function matrixEqual(a: any, b: any): boolean
	for i = 1, 16 do if a[i] ~= b[i] then return false end end
	return true
end
local function convertedHeader(begin: any): ()
	if begin.origin ~= "converted-glb" or begin.identityScheme ~= "arcane-converted-v2" then fail("IDENTITY", "Unknown converted identity.") end
	digest(begin.projectId); digest(begin.sourceSha256); digest(begin.preparedDigest); digest(begin.conversionRequestDigest)
	local request = closed(begin.conversionRequest,{"schemaVersion","fidelityPolicy","kind","jobId","parentJobId","parentManifestSha256","name","sourceSha256","sourceBytes","importSha256","importBytes","sourceMapSha256","collision","renderResolution","renderSamples"})
	if request.schemaVersion ~= 2 or request.kind ~= "converted-glb" or request.fidelityPolicy ~= "arcane-static-fidelity-v1" then fail("IDENTITY", "Unsupported converted request policy.") end
	if request.jobId ~= begin.revisionId or request.sourceSha256 ~= begin.sourceSha256 or (request.collision ~= "none" and request.collision ~= "convex-hull") then fail("IDENTITY", "Converted request identity differs.") end
	if type(request.jobId) ~= "string" or type(request.parentJobId) ~= "string" or request.jobId == request.parentJobId or #request.jobId ~= 36 or #request.parentJobId ~= 36 then fail("IDENTITY", "Invalid converted lineage.") end
	digest(request.parentManifestSha256); digest(request.importSha256); digest(request.sourceMapSha256)
	integer(request.sourceBytes,1,64*1024*1024); integer(request.importBytes,1,64*1024*1024)
	integer(request.renderResolution,128,1024); integer(request.renderSamples,1,64)
	if type(request.name) ~= "string" or #request.name < 1 or #request.name > 48 then fail("IDENTITY", "Invalid conversion name.") end
	if begin.assetId ~= "arcane_" .. hash(begin.sourceSha256 .. "\nconverted-root") then fail("IDENTITY", "Converted asset identity differs from source.") end
	local header = closed(begin.graph,{"schemaVersion","sourceSceneIndex","nodeCount","meshCount","digest"})
	if header.schemaVersion ~= 1 then fail("IDENTITY", "Unknown graph schema.") end
	integer(header.sourceSceneIndex,0,4095); integer(header.nodeCount,1,128); integer(header.meshCount,1,128); digest(header.digest)
	-- Materialization allocates one outer Model in addition to selected nodes
	-- and the optional derived collision MeshPart. Reserve it before any bytes
	-- can reach an allocating reconstruction path; complete inventory is rechecked.
	integer(1+header.nodeCount+(if request.collision=="convex-hull" then 1 else 0),1,128)
	if header.meshCount ~= begin.objectCount or type(begin.texturesPresent) ~= "boolean" or (not begin.texturesPresent and begin.textureCount ~= 0) then fail("IDENTITY", "Converted graph counts differ.") end
	integer(begin.binaryByteLength,1,LIMITS.binaryBytes); integer(begin.chunkCount,1,4096)
	integer(begin.aggregateEncodedByteLength,1,LIMITS.bytes)
	dense(begin.anchors,0); dense(begin.files,2); dense(begin.sourceDocuments,2)
end
local function convertedGraph(begin: any, nodes: any, objects: any): any
	if #nodes ~= begin.graph.nodeCount then fail("IDENTITY", "Incomplete converted node phase.") end
	local byKey, worlds, depths, associations, meshes = {}, {}, {}, {}, {}
	for _, entry in ipairs(objects) do
		local a = closed(entry.association,{"sourceObjectId","nodeKey","sourcePivot","correspondenceSha256"})
		if a.sourceObjectId ~= entry.object.sourceObjectId or associations[a.sourceObjectId] then fail("IDENTITY", "Duplicate graph association.") end
		if not equalData(numbers(a.sourcePivot,3,"source pivot"),{0,0,0}) then fail("IDENTITY", "Converted pivot must retain source zero.") end
		associations[a.sourceObjectId] = a
		meshes[#meshes+1] = a
	end
	local nodeMeshes, collisions = {}, 0
	local renderIds = {}
	for _, entry in ipairs(objects) do
		local o, a = entry.object, entry.association
		if o.role ~= "render" and o.role ~= "collision" then fail("IDENTITY", "Unknown converted mesh role.") end
		if o.sourceObjectId ~= "arcane_" .. hash(begin.sourceSha256 .. "\n" .. o.role .. "\n" .. tostring(o.sourceKey)) then fail("IDENTITY", "Converted object ID differs from source.") end
		if o.role == "collision" then
			collisions += 1
			if a.nodeKey ~= nil or a.correspondenceSha256 ~= nil or o.sourceKey ~= "proxy" then fail("IDENTITY", "Derived collision cannot invent a graph node.") end
		else
			nodeKey(a.nodeKey); digest(a.correspondenceSha256)
			if a.nodeKey ~= o.sourceKey or nodeMeshes[a.nodeKey] then fail("IDENTITY", "Ambiguous converted mesh node.") end
			nodeMeshes[a.nodeKey] = entry
			table.insert(renderIds,o.sourceObjectId)
		end
	end
	if collisions ~= (if begin.conversionRequest.collision == "convex-hull" then 1 else 0) then fail("IDENTITY", "Collision inventory differs from request.") end
	table.sort(renderIds)
	integer(1+#nodes+collisions,1,128)
	for _, node in ipairs(nodes) do
		closed(node,{"nodeKey","parentKey","localMatrix","name"})
		local key = nodeKey(node.nodeKey)
		if byKey[key] or (node.name ~= nil and (type(node.name) ~= "string" or #node.name > 1024)) then fail("IDENTITY", "Invalid or duplicate converted node.") end
		if node.parentKey ~= nil and not byKey[nodeKey(node.parentKey)] then fail("IDENTITY", "Converted parent must precede child.") end
		local primitiveParent = string.match(key,"^(node%d+)_primitive%d+$")
		if primitiveParent then
			if node.parentKey ~= primitiveParent or not nodeMeshes[key] then fail("IDENTITY", "Primitive node lost its exact original parent.") end
		elseif nodeMeshes[key] then fail("IDENTITY", "Original grouping node cannot impersonate a primitive.") end
		local m = numbers(node.localMatrix,16,"graph local matrix")
		local world = multiply(if node.parentKey then worlds[node.parentKey] else IDENTITY,m)
		proper(m,nodeMeshes[key] == nil); proper(world,nodeMeshes[key] == nil)
		depths[key] = if node.parentKey then depths[node.parentKey]+1 else 1
		integer(depths[key],1,128); byKey[key]=node; worlds[key]=world
	end
	-- Exact deterministic DFS order, including all empty nodes and multiple roots.
	local children = {}
	for _, node in ipairs(nodes) do local key = node.parentKey or "";children[key]=children[key] or {};table.insert(children[key],node) end
	for _, list in pairs(children) do table.sort(list,function(a,b) return a.nodeKey < b.nodeKey end) end
	local order = {}
	local function visit(parent: string): () for _, child in ipairs(children[parent] or {}) do table.insert(order,child.nodeKey);visit(child.nodeKey) end end
	visit("")
	for i,node in ipairs(nodes) do if order[i] ~= node.nodeKey then fail("IDENTITY", "Converted node order differs from deterministic graph order.") end end
	for key, entry in pairs(nodeMeshes) do
		if not byKey[key] or not matrixEqual(worlds[key],numbers(entry.object.exportTransform,16,"object transform")) then fail("IDENTITY", "Converted mesh world transform differs from graph.") end
	end
	local documents, fileIds = {}, {}
	for _, file in ipairs(begin.files) do
		if file.fileId ~= "asset-glb" and file.fileId ~= "collision-glb" or fileIds[file.fileId] or file.contentType ~= "model/gltf-binary" then fail("IDENTITY", "Unknown converted file.") end
		fileIds[file.fileId]=true;digest(file.sha256);integer(file.byteLength,1,20000000)
	end
	if not fileIds["asset-glb"] or (fileIds["collision-glb"] == true) ~= (collisions == 1) or #begin.files ~= 1+collisions then fail("IDENTITY", "Converted file inventory differs.") end
	for _, source in ipairs(begin.sourceDocuments) do
		closed(source,{"fileId","jsonSha256","document"});digest(source.jsonSha256)
		if not fileIds[source.fileId] or documents[source.fileId] then fail("IDENTITY", "Source document inventory differs.") end
		documents[source.fileId]=source.document
	end
	if #begin.sourceDocuments ~= #begin.files then fail("IDENTITY", "Missing sealed source document.") end
	for fileId, doc in pairs(documents) do
		plain(doc,"Source document");dense(doc.nodes,128);dense(doc.scenes,1)
		if #doc.scenes ~= 1 or (doc.scene or 0) ~= 0 then fail("IDENTITY", "Converted source scene differs.") end
		local actualByKey, parents, seen = {}, {}, {}
		for at, node in ipairs(doc.nodes) do
			plain(node,"Source node")
			for _, child in ipairs(dense(node.children or {},128)) do
				integer(child,0,#doc.nodes-1)
				if parents[child+1] then fail("IDENTITY", "Ambiguous actual source parent.") end
				parents[child+1]=at
			end
			if fileId == "asset-glb" then
				local key = nodeKey(plain(node.extras,"Source markers").arcane_conversion_node_v2)
				if actualByKey[key] then fail("IDENTITY", "Duplicate actual node marker.") end
				actualByKey[key]=at
			end
		end
		local function walk(at: number, depth: number): ()
			integer(at,1,#doc.nodes);integer(depth,1,128)
			if seen[at] then fail("IDENTITY", "Repeated/cyclic source node.") end
			seen[at]=true
			for _, child in ipairs(doc.nodes[at].children or {}) do walk(child+1,depth+1) end
		end
		for _, at in ipairs(dense(doc.scenes[1].nodes,128)) do integer(at,0,#doc.nodes-1);if parents[at+1] then fail("IDENTITY", "Source root has a parent.") end;walk(at+1,1) end
		for at in ipairs(doc.nodes) do if not seen[at] then fail("IDENTITY", "Source EMPTY/node is outside selected scene.") end end
		if fileId == "asset-glb" then
			if #doc.nodes ~= #nodes then fail("IDENTITY", "Source EMPTY coverage differs.") end
			for _, node in ipairs(nodes) do
				local at=actualByKey[node.nodeKey];local actual=doc.nodes[at]
				if not actual then fail("IDENTITY", "Missing original node marker.") end
				local parent=parents[at];local parentKey=if parent then doc.nodes[parent].extras.arcane_conversion_node_v2 else nil
				if parentKey ~= node.parentKey or actual.name ~= node.name or not matrixEqual(localMatrix(actual),node.localMatrix) or (actual.mesh ~= nil) ~= (nodeMeshes[node.nodeKey] ~= nil) then fail("IDENTITY", "Source node parent/name/local matrix or EMPTY differs.") end
			end
		elseif #doc.nodes ~= 1 or doc.nodes[1].mesh == nil or parents[1] then fail("IDENTITY", "Collision source must be one derived mesh root.") end
	end
	for _, entry in ipairs(objects) do
		local o=entry.object;local doc=documents[o.exportFileId]
		if not doc then fail("IDENTITY", "Object references missing export.") end
		integer(o.nodeIndex,0,#doc.nodes-1)
		local node=doc.nodes[o.nodeIndex+1];local mesh=doc.meshes[integer(node.mesh,0,#doc.meshes-1)+1]
		local e=plain(node.extras,"Object markers")
		if e.arcane_identity_scheme ~= "arcane-converted-v2" or e.arcane_source_object_id ~= o.sourceObjectId or e.arcane_source_key ~= o.sourceKey or e.arcane_role ~= o.role or not equalData(e.arcane_pivot,{0,0,0}) or not equalData(o.pivot,{0,0,0}) then fail("IDENTITY", "Actual mesh marker identity differs.") end
		local targets=if o.role == "collision" then renderIds else {}
		local encoded={}
		for _,id in ipairs(targets) do encoded[#encoded+1]='"'..id..'"' end
		if not equalData(dense(o.collisionFor,128),targets) or e.arcane_collision_for ~= "["..table.concat(encoded,",").."]" then fail("IDENTITY","Collision target coverage differs from actual render objects.") end
		if o.role == "render" then
			local n,p=string.match(o.sourceKey,"^node(%d+)_primitive(%d+)$")
			if not n or e.arcane_conversion_node_v2 ~= o.sourceKey or e.arcane_conversion_origin_v1 ~= "glb_"..begin.sourceSha256..":"..n..":"..p then fail("IDENTITY", "Actual primitive origin differs.") end
		else
			if e.arcane_conversion_node_v2 ~= nil or e.arcane_conversion_origin_v1 ~= nil then fail("IDENTITY", "Collision cannot invent source node lineage.") end
			if not matrixEqual(localMatrix(node),o.exportTransform) then fail("IDENTITY", "Collision transform differs.") end
		end
		if not equalData(entry.provenance.node,node) or not equalData(entry.provenance.mesh,mesh) or entry.provenance.generator ~= doc.asset.generator or #entry.primitives ~= #mesh.primitives then fail("IDENTITY", "Actual source provenance differs.") end
		for i, primitive in ipairs(entry.primitives) do
			if not equalData(primitive.source,mesh.primitives[i]) then fail("IDENTITY", "Actual primitive provenance differs.") end
		end
	end
	table.sort(meshes,function(a,b) return a.sourceObjectId < b.sourceObjectId end)
	local sortedNodes=table.clone(nodes);table.sort(sortedNodes,function(a,b) return a.nodeKey < b.nodeKey end)
	return freezeData({schemaVersion=1,sourceSceneIndex=begin.graph.sourceSceneIndex,nodes=sortedNodes,meshes=meshes,digest=begin.graph.digest})
end
local function scalar(stream: any, at: number): number
	local width = if stream.componentType == 5121 then 1 elseif stream.componentType == 5123 then 2 else 4
	local value = if stream.componentType == 5126 then buffer.readf32(stream.bytes,at*width)
		elseif width == 1 then buffer.readu8(stream.bytes,at) elseif width == 2 then buffer.readu16(stream.bytes,at*2) else buffer.readu32(stream.bytes,at*4)
	if stream.normalized then value /= (if width == 1 then 255 else 65535) end
	return finite(value,1000000,"converted sample")
end
local function correspondenceDigest(ids: any, indices: any, check: () -> ()): string
	local rows = {}
	local function less(a: any,b: any): boolean
		for i=1,3 do if a[i] ~= b[i] then return a[i] < b[i] end end
		return false
	end
	for at=0,indices.count-1,3 do
		local a,b,c=ids[scalar(indices,at)+1],ids[scalar(indices,at+1)+1],ids[scalar(indices,at+2)+1]
		if a == nil or b == nil or c == nil then fail("IDENTITY","Correspondence index is outside its exact ID array.") end
		local row={a,b,c};local second,third={b,c,a},{c,a,b}
		if less(second,row) then row=second end;if less(third,row) then row=third end
		rows[#rows+1]=row
		if #rows % 256 == 0 then check() end
	end
	table.sort(rows,less)
	local encoded={}
	for _,row in ipairs(rows) do encoded[#encoded+1]="["..tostring(row[1])..","..tostring(row[2])..","..tostring(row[3]).."]" end
	return hash("["..table.concat(encoded,",").."]")
end
local function validateConvertedGeometry(begin: any, entry: any, actual: any, check: () -> ()): ()
	local doc: any = nil
	for _,source in ipairs(begin.sourceDocuments) do if source.fileId == entry.object.exportFileId then doc=source.document end end
	if not doc then fail("IDENTITY","Missing original source document.") end
	local low,high,worldLow,worldHigh={math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge},{math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge}
	local totalTriangles, materialIndex = 0, nil
	for at,primitive in ipairs(entry.primitives) do
		closed(primitive,{"mode","vertexCount","triangleCount","source","correspondence","attributes","indices"})
		local source=closed(primitive.source,{"attributes","indices","material","mode","extras"})
		if (source.mode or 4) ~= 4 or primitive.mode ~= 4 then fail("INPUT","Converted geometry must contain triangles.") end
		local attributes=closed(source.attributes,{"POSITION","NORMAL","TEXCOORD_0","_ARCANE_SOURCE_VERTEX_ID"})
		closed(primitive.attributes,{"POSITION","NORMAL","TEXCOORD_0"})
		local geometry=actual[at]
		for semantic,stream in pairs(primitive.attributes) do
			local ai=integer(attributes[semantic],0,#doc.accessors-1)
			local accessor=doc.accessors[ai+1];local view=doc.bufferViews[integer(accessor.bufferView,0,#doc.bufferViews-1)+1]
			local binding=closed(stream.source,{"accessorIndex","accessor","bufferView"})
			if binding.accessorIndex ~= ai or not equalData(binding.accessor,accessor) or not equalData(binding.bufferView,view) then fail("IDENTITY","Authoring stream lost its actual accessor binding.") end
			if stream.count ~= accessor.count or stream.componentType ~= accessor.componentType or stream.type ~= accessor.type or stream.normalized ~= (accessor.normalized or false) or accessor.sparse ~= nil then fail("IDENTITY","Authoring descriptor differs from actual accessor.") end
		end
		for semantic in pairs(attributes) do if semantic ~= "_ARCANE_SOURCE_VERTEX_ID" and not primitive.attributes[semantic] then fail("IDENTITY","Actual source attribute was silently dropped.") end end
		if source.indices == nil then
			if primitive.indices.source ~= nil or primitive.indices.count ~= primitive.vertexCount then fail("IDENTITY","Implicit source indices differ.") end
			for i=0,geometry.indices.count-1 do if scalar(geometry.indices,i) ~= i then fail("IDENTITY","Implicit source index sequence differs.") end end
		else
			local ai=integer(source.indices,0,#doc.accessors-1);local accessor=doc.accessors[ai+1]
			local binding=closed(primitive.indices.source,{"accessorIndex","accessor","bufferView"})
			if binding.accessorIndex ~= ai or not equalData(binding.accessor,accessor) or not equalData(binding.bufferView,doc.bufferViews[accessor.bufferView+1]) then fail("IDENTITY","Index accessor binding differs.") end
		end
		if entry.object.role == "render" then
			local proof=closed(primitive.correspondence,{"semantic","accessorIndex","count","sha256","orientedTriangleSha256","ids","accessor","bufferView"})
			local ai=integer(attributes._ARCANE_SOURCE_VERTEX_ID,0,#doc.accessors-1);local a=doc.accessors[ai+1]
			if proof.semantic ~= "_ARCANE_SOURCE_VERTEX_ID" or proof.accessorIndex ~= ai or proof.count ~= primitive.vertexCount or a.componentType ~= 5126 or a.type ~= "SCALAR" or a.count ~= proof.count or a.normalized == true or a.sparse ~= nil or not equalData(proof.accessor,a) or not equalData(proof.bufferView,doc.bufferViews[a.bufferView+1]) then fail("IDENTITY","Host ID proof differs from the actual source accessor.") end
			digest(proof.sha256);digest(proof.orientedTriangleSha256)
			local ids=dense(proof.ids,60000)
			if #ids ~= proof.count then fail("IDENTITY","Incomplete host ID proof.") end
			for _,id in ipairs(ids) do integer(id,0,59999) end
			-- Raw accessor SHA is host-authenticated metadata: normalized numeric
			-- IDs cannot recover an original -0 encoding. Oriented integer topology
			-- IS independently recomputed here; IDs never enter authoring streams.
			if correspondenceDigest(ids,geometry.indices,check) ~= proof.orientedTriangleSha256 or proof.orientedTriangleSha256 ~= entry.association.correspondenceSha256 then fail("CHECKSUM","Actual oriented ID triangles differ from graph.") end
		elseif primitive.correspondence ~= nil or attributes._ARCANE_SOURCE_VERTEX_ID ~= nil then fail("IDENTITY","Collision must not contain render ID proof.") end
		local slot=source.material or -1
		if materialIndex ~= nil and materialIndex ~= slot then fail("INPUT","One mesh cannot silently combine material slots.") end
		materialIndex=slot
		local p=geometry.attributes.POSITION;local m=entry.object.exportTransform
		for i=0,p.count-1 do
			local v={scalar(p,i*3),scalar(p,i*3+1),scalar(p,i*3+2)}
			for axis=1,3 do
				low[axis]=math.min(low[axis],v[axis]);high[axis]=math.max(high[axis],v[axis])
				local w=m[axis]*v[1]+m[4+axis]*v[2]+m[8+axis]*v[3]+m[12+axis]
				worldLow[axis]=math.min(worldLow[axis],w);worldHigh[axis]=math.max(worldHigh[axis],w)
			end
			if i % 256 == 0 then check() end
		end
		totalTriangles += primitive.triangleCount
	end
	if not equalData(entry.object.bounds,{min=low,max=high}) or not equalData(entry.object.worldBounds,{min=worldLow,max=worldHigh}) or totalTriangles ~= entry.object.triangles then fail("CHECKSUM","Measured converted geometry bounds/counts differ.") end
	local sourceMaterial=if materialIndex ~= -1 then doc.materials[materialIndex+1] else nil
	if not equalData(sourceMaterial,entry.provenance.material) or (sourceMaterial == nil) ~= (entry.material == nil) or (entry.object.role == "collision" and entry.material ~= nil) then fail("IDENTITY","Converted material source differs.") end
	if sourceMaterial then
		closed(sourceMaterial,{"name","extras","pbrMetallicRoughness","normalTexture","alphaMode","alphaCutoff","doubleSided","emissiveFactor","extensions"})
		local p=closed(sourceMaterial.pbrMetallicRoughness or {},{"baseColorFactor","metallicFactor","roughnessFactor","baseColorTexture","metallicRoughnessTexture","extras"})
		closed(sourceMaterial.extensions or {},{"KHR_materials_emissive_strength"})
		if sourceMaterial.alphaMode ~= nil and sourceMaterial.alphaMode ~= "OPAQUE" and sourceMaterial.alphaMode ~= "MASK" then fail("UNSUPPORTED_MATERIAL","Unsupported alpha semantics cannot be approximated.") end
		if not equalData(entry.material.baseColor,p.baseColorFactor or {1,1,1,1}) or entry.material.baseColor[4] ~= 1 or entry.material.metallic ~= (p.metallicFactor or 1) or entry.material.roughness ~= (p.roughnessFactor or 1) or entry.material.doubleSided ~= (sourceMaterial.doubleSided or false) or entry.material.alphaMode ~= (sourceMaterial.alphaMode or "OPAQUE") or entry.material.alphaCutoff ~= (sourceMaterial.alphaCutoff or 0.5) then fail("IDENTITY","Supported PBR channels differ from actual source.") end
		local factor=sourceMaterial.emissiveFactor or {0,0,0}
		local extension=(sourceMaterial.extensions or {}).KHR_materials_emissive_strength
		if extension ~= nil or not equalData(factor,{0,0,0}) then
			local emission=closed(entry.material.emission,{"factor","strength","map"})
			if not equalData(emission.factor,factor) or emission.strength ~= (if extension then extension.emissiveStrength or 1 else 1) or emission.map ~= nil then fail("IDENTITY","Source emission differs from sealed supported material.") end
		elseif entry.material.emission ~= nil then fail("IDENTITY","Material invented source emission.") end
		if entry.material.normalScale ~= (if sourceMaterial.normalTexture then sourceMaterial.normalTexture.scale or 1 else 1) then fail("IDENTITY","Source normal map scale differs.") end
	end
	check()
end

-- expected is supplied by the host's owned intake, never packet JSON. Digests
-- here prove exact data only; they do not prove human consent or creator rights.
function AssetTransfer.new(expected: any, decodeJson: (string) -> any, guard: () -> (), yieldBatch: () -> ()): any
	expected = plain(expected, "Expected transfer")
	local payloadDigest, manifestDigest, transferDigest = digest(expected.payloadDigest), digest(expected.manifestDigest), digest(expected.digest)
	if type(decodeJson) ~= "function" or type(guard) ~= "function" or type(yieldBatch) ~= "function" then fail("INPUT", "Trusted callbacks required.") end
	local state = "receiving"
	local ordinal, bytes, binaryBytes = 0, 0, 0
	local begin: any = nil
	local sealedConversion: any = nil
	local version: number? = nil
	local nodes: {any} = {}
	local sealedGraph: any = nil
	local chunksReceived = 0
	local encodedBytes = 0
	local rawPackets = {}
	local objects: {any} = {}
	local objectIds: {[string]: boolean} = {}
	local streams: {[string]: any} = {}
	local streamCount = 0
	local textures, textureCount, materialSlots = {}, 0, {}
	local contentHashes, packetHashes = Sha256Stream.new(), Sha256Stream.new()
	local resources: {any} = {}
	local function check(): ()
		local ok, result = pcall(guard)
		if not ok or (result ~= nil and result ~= true) then fail("CANCELLED", "Transfer scope changed.") end
	end
	local function abort(): ()
		state = "cancelled"
		local failures = 0
		for _, resource in ipairs(resources) do
			local cleaned = pcall(function() resource:Destroy() end)
			if not cleaned then failures += 1 end
		end
		table.clear(resources)
		table.clear(streams)
		table.clear(objects)
		table.clear(textures)
		table.clear(nodes); table.clear(rawPackets); sealedGraph = nil
		if failures > 0 then fail("CLEANUP", "Transfer failed; owned unparented resources may remain.") end
	end
	local receiver = {}
	function receiver:cancel(): () abort() end
	function receiver:status(): any
		return table.freeze({state = state, packetCount = ordinal, byteLength = bytes, engineVerification = "pending"})
	end
	local function declare(descriptor: any, objectId: string, primitiveIndex: number, semantic: string): ()
		descriptor = plain(descriptor, "Stream descriptor")
		if version == 2 then
			closed(descriptor,{"streamId","semantic","componentType","type","count","normalized","byteLength","sha256","source","chunks"})
			dense(descriptor.chunks,4096)
		end
		local id = digest(descriptor.streamId)
		if streams[id] or descriptor.semantic ~= semantic then fail("IDENTITY", "Duplicate/mismatched stream.") end
		streamCount = integer(streamCount + 1, 1, LIMITS.streams)
		local length = integer(descriptor.byteLength, 1, LIMITS.binaryBytes)
		binaryBytes = integer(binaryBytes + length, 1, LIMITS.binaryBytes)
		digest(descriptor.sha256)
		plain(descriptor.chunks, "Declared chunks")
		local offset = 0
		for _, chunk in ipairs(descriptor.chunks) do
			plain(chunk, "Declared chunk")
			if chunk.offset ~= offset then fail("CHECKSUM", "Declared chunk gap/overlap.") end
			offset += integer(chunk.byteLength, 1, 180 * 1024)
			if offset > length then fail("CHECKSUM", "Declared chunks overrun stream.") end
			digest(chunk.sha256)
		end
		if offset ~= length then fail("CHECKSUM", "Declared chunks do not cover stream.") end
		streams[id] = {objectId = objectId, primitiveIndex = primitiveIndex, descriptor = descriptor,
			offset = 0, chunkIndex = 1, parts = {}, hasher = Sha256Stream.new(), complete = false}
	end
	function receiver:accept(json: string): any
		if state ~= "receiving" then fail("STATE", "Transfer is not receiving.") end
		local ok, result = pcall(function(): any
			check()
			if type(json) ~= "string" or #json > LIMITS.packetBytes then fail("BUDGET", "Packet exceeds bridge argument limits.") end
			integer(ordinal + 1, 1, LIMITS.packets)
			integer(bytes + #json, 1, LIMITS.bytes)
			local decoded = plain(decodeJson(json), "Packet")
			local packet = plain(snapshot(decoded, 0, if decoded.formatVersion == 2 then {count=0,maximum=100000,depth=48} else {count=0}), "Packet")
			check()
			if (packet.formatVersion ~= 1 and packet.formatVersion ~= 2) or (version ~= nil and packet.formatVersion ~= version) or packet.payloadDigest ~= payloadDigest or packet.manifestDigest ~= manifestDigest
				or packet.ordinal ~= ordinal then fail("IDENTITY", "Packet revision/order differs from owned transfer.") end
			if version == 2 and (packet.kind == "texture" or packet.kind == "object") then
				for _,stream in pairs(streams) do if not stream.complete then fail("STATE","Converted next declaration precedes complete original chunks.") end end
			end
			local packetHash = hash(json)
			if packet.formatVersion == 2 then
				integer(ordinal+1,1,512)
				local fields = {
					begin={"projectId","assetId","revisionId","sourceSha256","origin","identityScheme","preparedDigest","target","conversionRequest","conversionRequestDigest","graph","producer","files","sourceDocuments","conversion","placement","bounds","anchors","objectCount","textureCount","texturesPresent","binaryByteLength","aggregateEncodedByteLength","chunkCount","delta"},
					node={"node"},texture={"texture"},object={"object","association","material","provenance","primitives","textureBindings"},
					chunk={"sourceObjectId","primitiveIndex","streamId","semantic","bufferSha256","offset","byteLength","sha256","encoding","data"},seal={"precedingPacketCount","precedingByteLength","contentDigest"},
				}
				local allowed = fields[packet.kind]
				if not allowed then fail("INPUT","Unknown converted packet kind.") end
				local keys = table.clone(allowed)
				for _, key in ipairs({"formatVersion","payloadDigest","manifestDigest","ordinal","kind"}) do table.insert(keys,key) end
				closed(packet,keys)
			end
			if packet.kind == "begin" then
				if ordinal ~= 0 or begin ~= nil then fail("STATE", "Begin must be first and unique.") end
				integer(packet.objectCount, 1, LIMITS.objects)
				integer(packet.textureCount or 0, 0, 256)
				version = packet.formatVersion
				if version == 2 then convertedHeader(packet) end
				sealedConversion = conversionSnapshot(packet.conversion, version)
				begin = packet
			elseif packet.kind == "node" then
				if version ~= 2 or begin == nil or #objects ~= 0 or textureCount ~= 0 then fail("STATE","Converted nodes must be the complete first phase.") end
				integer(#nodes+1,1,begin.graph.nodeCount)
				nodes[#nodes+1] = packet.node
			elseif packet.kind == "texture" then
				if begin == nil or #objects ~= 0 or (version == 2 and #nodes ~= begin.graph.nodeCount) then fail("STATE", "Textures must follow begin and precede objects.") end
				textureCount = integer(textureCount + 1, 1, begin.textureCount or 0)
				local texture = plain(packet.texture, "Texture")
				local imageId = digest(texture.imageId)
				if textures[imageId] then fail("IDENTITY", "Duplicate texture identity.") end
				local semantic = texture.semantic
				if semantic ~= "ColorMap" and semantic ~= "NormalMap" and semantic ~= "RoughnessMap" and semantic ~= "MetalnessMap" then fail("INPUT", "Unsupported texture map slot.") end
				local materialSlot = digest(texture.materialSha256) .. ":" .. semantic
				if materialSlots[materialSlot] then fail("IDENTITY", "A material slot cannot declare multiple images.") end
				materialSlots[materialSlot] = imageId
				local width, height = integer(texture.width, 1, 1024), integer(texture.height, 1, 1024)
				digest(texture.materialSha256); digest(texture.sourceSha256); digest(texture.sourceRgbaSha256); digest(texture.sha256)
				if texture.orientation ~= "top-left" or texture.colorSpace ~= (if semantic == "ColorMap" then "srgb" else "linear")
					or (semantic == "NormalMap" and texture.normalConvention ~= "OpenGL")
					or texture.componentType ~= 5121 or texture.type ~= "VEC4" or texture.normalized ~= false
					or texture.count ~= width * height or texture.byteLength ~= width * height * 4 then fail("INPUT", "Texture layout differs from RGBA8 pixels.") end
				local stream = plain(texture.stream, "Texture stream")
				for _, key in ipairs({"semantic", "componentType", "type", "normalized", "count", "byteLength", "sha256"}) do
					if stream[key] ~= texture[key] then fail("IDENTITY", "Texture and declared stream disagree.") end
				end
				declare(stream, "texture-" .. imageId, -1, semantic)
				textures[imageId] = texture
			elseif packet.kind == "object" then
				if begin == nil or textureCount ~= (begin.textureCount or 0) or (version == 2 and #nodes ~= begin.graph.nodeCount) then fail("STATE", "Object precedes complete texture declarations.") end
				integer(#objects + 1, 1, begin.objectCount)
				local object = plain(packet.object, "Object")
				local objectId = object.sourceObjectId
				if type(objectId) ~= "string" or #objectId > 128 or objectIds[objectId] then fail("IDENTITY", "Invalid/duplicate object identity.") end
				local primitives = plain(packet.primitives, "Primitives")
				if version == 2 then dense(primitives,128);if #primitives == 0 then fail("INPUT","Missing converted primitives.") end end

				for index, primitive in ipairs(primitives) do
					plain(primitive, "Primitive")
					for semantic, descriptor in pairs(plain(primitive.attributes, "Attributes")) do declare(descriptor, objectId, index - 1, semantic) end
					declare(primitive.indices, objectId, index - 1, "indices")
				end
				objectIds[objectId] = true
				objects[#objects + 1] = packet
			elseif packet.kind == "chunk" then
				local stream = streams[packet.streamId]
				if not stream or stream.complete or packet.sourceObjectId ~= stream.objectId
					or packet.primitiveIndex ~= stream.primitiveIndex or packet.semantic ~= stream.descriptor.semantic
					or packet.bufferSha256 ~= stream.descriptor.sha256 or packet.offset ~= stream.offset or packet.encoding ~= "base64" then
					fail("IDENTITY", "Chunk differs from declared stream or is repeated.")
				end
				local declared = stream.descriptor.chunks[stream.chunkIndex]
				if version == 2 then chunksReceived=integer(chunksReceived+1,1,4096);encodedBytes=integer(encodedBytes+#packet.data,1,LIMITS.bytes) end
				local data = base64(packet.data)
				if not declared or packet.byteLength ~= #data or packet.byteLength ~= declared.byteLength
					or packet.sha256 ~= declared.sha256 or hash(data) ~= declared.sha256 then fail("CHECKSUM", "Chunk bytes differ from declaration.") end
				stream.hasher:update(data)
				stream.parts[#stream.parts + 1] = data
				stream.offset += #data
				stream.chunkIndex += 1
				if stream.offset == stream.descriptor.byteLength then
					if stream.hasher:digest() ~= stream.descriptor.sha256 then fail("CHECKSUM", "Complete stream digest mismatch.") end
					stream.complete = true
				end
			elseif packet.kind == "seal" then
				if begin == nil or #objects ~= begin.objectCount or textureCount ~= (begin.textureCount or 0) or packet.precedingPacketCount ~= ordinal
					or packet.precedingByteLength ~= bytes or packet.contentDigest ~= contentHashes:digest() then fail("CHECKSUM", "Incomplete/mismatched seal.") end
				for _, stream in pairs(streams) do if not stream.complete then fail("CHECKSUM", "Seal contains incomplete streams.") end end
				local used = {}
				for _, entry in ipairs(objects) do
					if entry.textureBindings ~= nil then
						if entry.object.role == "collision" or type(entry.material) ~= "table" then fail("INPUT", "Only render materials can bind textures.") end
						for slot, imageId in pairs(plain(entry.textureBindings, "Texture bindings")) do
							local texture = textures[imageId]
							if not texture or texture.semantic ~= slot or texture.materialSha256 ~= entry.material.sha256 then fail("IDENTITY", "Texture belongs to another material or slot.") end
							used[imageId] = true
						end
						for slot, field in pairs({ColorMap = "colorMap", NormalMap = "normalMap", RoughnessMap = "roughnessMap", MetalnessMap = "metalnessMap"}) do
							local reference, imageId = entry.material[field], entry.textureBindings[slot]
							if (reference ~= nil) ~= (imageId ~= nil) or (reference ~= nil and (type(reference) ~= "table" or textures[imageId].sourceSha256 ~= reference.sha256)) then fail("IDENTITY", "Material texture reference coverage differs.") end
						end
					end
				end
				for imageId in pairs(textures) do if not used[imageId] then fail("IDENTITY", "Unbound texture cannot be silently discarded.") end end
				if version == 2 then
					if binaryBytes ~= begin.binaryByteLength or chunksReceived ~= begin.chunkCount or encodedBytes+4096 > begin.aggregateEncodedByteLength then fail("CHECKSUM","Converted stream totals differ.") end
					sealedGraph = convertedGraph(begin,nodes,objects)
				end
			else fail("INPUT", "Unknown packet kind.") end
			packetHashes:update((if ordinal == 0 then "" else "\n") .. packetHash)
			if packet.kind == "seal" then
				if packetHashes:digest() ~= transferDigest then fail("CHECKSUM", "Owned transfer digest mismatch.") end
				if version == 2 then
					freezeData(begin)
					for _,entry in ipairs(objects) do freezeData(entry) end
				end
				state = "sealed"
			else
				contentHashes:update((if ordinal == 0 then "" else "\n") .. tostring(ordinal) .. ":" .. packet.kind .. ":" .. tostring(#json) .. ":" .. packetHash)
			end
			if version == 2 then rawPackets[#rawPackets+1]=json end
			ordinal += 1
			bytes += #json
			check()
			return self:status()
		end)
		if not ok then abort(); error(result, 0) end
		return result
	end
	function receiver:reconstruct(assetService: any, textureIntake: ((any, any, () -> ()) -> any)?): any
		if state ~= "sealed" then fail("STATE", "Only a completely sealed transfer may reconstruct.") end
		state = "reconstructing"
		local ok, result = pcall(function(): any
			check()
			local reconstructed = {}
			-- Validate every retained transform/conversion before images or meshes
			-- can allocate; no model output or caller metadata supplies authority.
			for _, entry in ipairs(objects) do
				AssetTransfer.meshPartPlan(entry.object, sealedConversion, version)
				check()
			end
			local function materialize(descriptor: any): any
				local stream = streams[descriptor.streamId]
				return {semantic = descriptor.semantic, componentType = descriptor.componentType, type = descriptor.type,
					count = descriptor.count, normalized = descriptor.normalized, byteLength = descriptor.byteLength,
					bytes = buffer.fromstring(table.concat(stream.parts))}
			end
			local preparedGeometry, physicalPlans = {}, {}
			if version == 2 then
				local vertices,triangles=0,0
				for index, entry in ipairs(objects) do
					local primitives = {}
					for _, primitive in ipairs(entry.primitives) do
						local attrs = {}
						for semantic, descriptor in pairs(primitive.attributes) do attrs[semantic]=materialize(descriptor) end
						primitives[#primitives+1]={mode=primitive.mode,vertexCount=primitive.vertexCount,triangleCount=primitive.triangleCount,attributes=attrs,indices=materialize(primitive.indices)}
					end
					preparedGeometry[index]={primitives=primitives}
					physicalPlans[index]=AssetTransfer.meshPartPlan(entry.object,sealedConversion,2)
					local summary=AssetMesh.validate(preparedGeometry[index],check,yieldBatch,physicalPlans[index].carrierLocalCentre)
					vertices=integer(vertices+summary.vertexCount,1,120000);triangles=integer(triangles+summary.triangleCount,1,40000)
					validateConvertedGeometry(begin,entry,primitives,check)
				end
			end
			local handles, objectHandles = {}, {}
			-- Admit every image bundle before the first mesh/engine allocation. Only
			-- the caller's trusted intake can mint private material texture handles.
			for index, entry in ipairs(objects) do
				if entry.textureBindings ~= nil then
					if type(textureIntake) ~= "function" then fail("INPUT", "Trusted material texture intake is required.") end
					local materialId = entry.material.sha256
					if handles[materialId] == nil then
						local maps = {}
						for slot, imageId in pairs(entry.textureBindings) do
							local texture = textures[imageId]
							local copy = table.clone(texture)
							copy.stream = nil
							copy.bytes = materialize(texture.stream).bytes
							maps[slot] = copy
						end
						handles[materialId] = (textureIntake :: any)(entry.material, maps, check)
						check()
						if handles[materialId] == nil then fail("INPUT", "Material intake returned no texture ownership.") end
					end
					objectHandles[index] = handles[materialId]
				end
			end
			for index, entry in ipairs(objects) do
				local primitives = {}
				for _, primitive in ipairs(if version == 2 then {} else entry.primitives) do
					local attributes = {}
					for semantic, descriptor in pairs(primitive.attributes) do attributes[semantic] = materialize(descriptor) end
					primitives[#primitives + 1] = {mode = primitive.mode, vertexCount = primitive.vertexCount, triangleCount = primitive.triangleCount,
						attributes = attributes, indices = materialize(primitive.indices)}
				end
				local mesh = AssetMesh.create(if version == 2 then preparedGeometry[index] else {primitives = primitives}, assetService, check, yieldBatch,
					if version == 2 then physicalPlans[index].carrierLocalCentre else nil)
				resources[#resources + 1] = mesh.editableMesh
				check()
				reconstructed[#reconstructed + 1] = {object = entry.object, material = entry.material, mesh = mesh,
					textures = objectHandles[index], conversion = sealedConversion}
				if version == 2 then
					local item=reconstructed[#reconstructed];item.formatVersion=2;item.association=entry.association;item.nativePlan=physicalPlans[index]
				end
			end
			check()
			state = "taken"
			table.clear(resources) -- Ownership transferred exactly once to caller.
			table.clear(streams)
			table.clear(objects)
			table.clear(textures)
			return reconstructed
		end)
		if not ok then abort(); error(result, 0) end
		return result
	end
	function receiver:graphPlan(): any
		if state ~= "sealed" then fail("STATE","Only an original sealed receiver may expose graph metadata.") end
		check()
		if version ~= 2 then return nil end
		return freezeData({formatVersion=2,graph=sealedGraph,conversionRequest=begin.conversionRequest,
			conversionRequestDigest=begin.conversionRequestDigest,conversion=sealedConversion})
	end
	-- Original raw metadata remains retained only for this live receiver; hashes
	-- authenticate it without claiming a cross-language canonical JSON encoder.
	function receiver:originalPackets(): any
		if state ~= "sealed" or version ~= 2 then fail("STATE","Original converted sealed packets required.") end
		check();return table.freeze(table.clone(rawPackets))
	end
	-- Closed metadata from the ACTUAL sealed receiver, before any allocation.
	-- A serialized copy of this plan is still not permission or mesh ownership.
	function receiver:reconstructionPlan(): any
		if state ~= "sealed" then fail("STATE", "Only an original sealed transfer may plan reconstruction.") end
		check()
		local result = {}
		local vertices, triangles = 0, 0
		for _, entry in ipairs(objects) do
			local vertexCount, triangleCount = 0, 0
			for _, primitive in ipairs(entry.primitives) do
				vertexCount += integer(primitive.vertexCount, 1, 60000)
				triangleCount += integer(primitive.triangleCount, 1, 20000)
			end
			integer(vertexCount, 1, 60000); integer(triangleCount, 1, 20000)
			vertices += vertexCount; triangles += triangleCount
			integer(vertices, 1, 120000); integer(triangles, 1, 40000)
			result[#result + 1] = table.freeze({sourceObjectId = entry.object.sourceObjectId,
				meshExportSha256 = digest(entry.object.meshExportSha256), vertexCount = vertexCount, triangleCount = triangleCount})
		end
		if version == 2 then
			for _,entry in ipairs(objects) do AssetTransfer.meshPartPlan(entry.object,sealedConversion,2) end
		end
		check()
		return table.freeze(result)
	end
	return table.freeze(receiver)
end

return table.freeze(AssetTransfer)
