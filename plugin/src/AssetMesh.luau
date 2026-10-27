--!strict
-- One caller-owned, decoded payload object. Digests/chunks/source metadata grant
-- no authority here: the caller assembles streams and supplies a live guard.
-- EditableMesh is an Object (not a parentable Instance). No MeshPart is made.
-- API checked 2026-10-14: create.roblox.com/docs/reference/engine/classes/
-- EditableMesh and AssetService. Engine behavior remains pending.

export type Stream = {
	semantic: string, componentType: number, type: string, count: number,
	normalized: boolean, byteLength: number, bytes: buffer,
}
export type Primitive = {
	mode: number, vertexCount: number, triangleCount: number,
	attributes: {[string]: Stream}, indices: Stream,
}
export type Data = {primitives: {Primitive}}
export type MeshService = {CreateEditableMesh: (self: any) -> EditableMesh?}
export type Mapping = {
	vertexIds: {number}, faceIds: {number}, normalIds: {number}, uvIds: {number},
}
export type Result = {
	editableMesh: EditableMesh, primitives: {Mapping}, vertexCount: number,
	triangleCount: number, coordinateSpace: "export-meters" | "centered-carrier-meters", engineVerification: "pending",
	sourceLocalCentre: {number}?,
}
type Values = {positions: {{number}}, normals: {{number}}?, uvs: {{number}}?, indices: {number}}
type DenseStream = {bytes: buffer, count: number, width: number, size: number, componentType: number, divisor: number}
type Plan = {position: DenseStream, normal: DenseStream?, uv: DenseStream?, indices: DenseStream}

local LIMITS = table.freeze({vertices = 60000, triangles = 20000, coordinate = 1000000, batch = 256})
local AssetMesh = {LIMITS = LIMITS}
local STREAM_FIELDS = table.freeze({semantic = true, componentType = true, type = true, count = true,
	normalized = true, byteLength = true, bytes = true, sha256 = true, source = true, chunks = true, streamId = true})

local function fail(code: string, message: string): never
	error(table.freeze({code = code, message = message}), 0)
end

local function record(value: any, allowed: {[string]: boolean}, label: string): any
	if type(value) ~= "table" or getmetatable(value) ~= nil then fail("INPUT", label .. " must be plain data.") end
	local count = 0
	for key in pairs(value) do
		count += 1
		if count > 16 or type(key) ~= "string" or not allowed[key] then
			fail("UNSUPPORTED_ATTRIBUTE", "Unsupported " .. label .. " field.")
		end
	end
	return value
end

local function integer(value: any, maximum: number, minimum: number, label: string): number
	if type(value) ~= "number" or value ~= value or value < minimum or value > maximum or value % 1 ~= 0 then
		fail("BUDGET", "Invalid " .. label .. " count/range.")
	end
	return value
end

local function stream(value: any, semantic: string, count: number): DenseStream
	local descriptor = record(value, STREAM_FIELDS, semantic)
	local component = descriptor.componentType
	local size = if semantic == "indices" then 1 elseif semantic == "TEXCOORD_0" then 2 else 3
	local shape = if size == 1 then "SCALAR" elseif size == 2 then "VEC2" else "VEC3"
	if descriptor.semantic ~= semantic or descriptor.type ~= shape or type(descriptor.normalized) ~= "boolean" then
		fail("UNSUPPORTED_ATTRIBUTE", "Invalid " .. semantic .. " descriptor.")
	end
	local uvInteger = semantic == "TEXCOORD_0" and (component == 5121 or component == 5123)
	local supported = if semantic == "indices" then component == 5121 or component == 5123 or component == 5125
		else component == 5126 or uvInteger
	if not supported or descriptor.normalized ~= uvInteger then
		fail("UNSUPPORTED_ATTRIBUTE", "Unsupported " .. semantic .. " component/normalization.")
	end
	if integer(descriptor.count, LIMITS.vertices, 1, semantic) ~= count then fail("INPUT", "Stream counts differ.") end
	local width = if component == 5121 then 1 elseif component == 5123 then 2 else 4
	local length = count * size * width
	if descriptor.byteLength ~= length or typeof(descriptor.bytes) ~= "buffer" or buffer.len(descriptor.bytes) ~= length then
		fail("INPUT", "Exact dense " .. semantic .. " buffer range required.")
	end
	-- Snapshot this stream before yielding. Caller convenience buffers remain
	-- mutable; reconstruction must never read their later contents.
	local bytes = buffer.create(length)
	buffer.copy(bytes, 0, descriptor.bytes, 0, length)
	return {bytes = bytes, count = count, width = width, size = size, componentType = component,
		divisor = if uvInteger then (if width == 1 then 255 else 65535) else 1}
end

local function sample(input: DenseStream, at: number): number
	local value = if input.componentType == 5126 then buffer.readf32(input.bytes, at)
		elseif input.width == 1 then buffer.readu8(input.bytes, at)
		elseif input.width == 2 then buffer.readu16(input.bytes, at) else buffer.readu32(input.bytes, at)
	value /= input.divisor
	if value ~= value or math.abs(value) > LIMITS.coordinate then fail("INPUT", "Nonfinite or out-of-bounds sample.") end
	return value
end

-- Throws a structured error. Only this invocation's freshly created resource is
-- destroyed on failure; success transfers ownership to the caller. Mappings use
-- source vertex/triangle ordinal + 1, never assume engine IDs are contiguous.
local function prepare(data: Data, check: () -> (), tick: () -> ()): any
	local object = record(data, {object = true, material = true, primitives = true, provenance = true}, "object")
	local primitives = object.primitives
	if type(primitives) ~= "table" or getmetatable(primitives) ~= nil then fail("INPUT", "Plain primitive array required.") end
	local primitiveCount = 0
	for key in pairs(primitives) do
		integer(key, LIMITS.triangles, 1, "primitive index")
		primitiveCount += 1
		if primitiveCount > LIMITS.triangles then fail("BUDGET", "Too many primitives.") end
		tick()
	end
	if primitiveCount == 0 then fail("INPUT", "At least one primitive required.") end
	local plans: {Plan} = {}
	local vertexCount, triangleCount = 0, 0
	for index = 1, primitiveCount do
		local primitive = record(primitives[index], {mode = true, vertexCount = true, triangleCount = true,
			attributes = true, indices = true, source = true}, "primitive")
		if primitive.mode ~= 4 then fail("UNSUPPORTED_ATTRIBUTE", "Triangle mode 4 required.") end
		local vertices = integer(primitive.vertexCount, LIMITS.vertices, 1, "vertex")
		local triangles = integer(primitive.triangleCount, LIMITS.triangles, 1, "triangle")
		vertexCount = integer(vertexCount + vertices, LIMITS.vertices, 1, "aggregate vertex")
		triangleCount = integer(triangleCount + triangles, LIMITS.triangles, 1, "aggregate triangle")
		local attributes = record(primitive.attributes, {POSITION = true, NORMAL = true, TEXCOORD_0 = true}, "attribute")
		plans[index] = {position = stream(attributes.POSITION, "POSITION", vertices),
			normal = if attributes.NORMAL ~= nil then stream(attributes.NORMAL, "NORMAL", vertices) else nil,
			uv = if attributes.TEXCOORD_0 ~= nil then stream(attributes.TEXCOORD_0, "TEXCOORD_0", vertices) else nil,
			indices = stream(primitive.indices, "indices", triangles * 3)}
		tick()
	end
	-- Validate and snapshot ALL values before the first AssetService/engine call.
	-- No descriptor, buffer or caller metadata is read during reconstruction.
	local function rows(input: DenseStream): {{number}}
		local values: {{number}} = table.create(input.count)
		for index = 1, input.count do
			local row: {number} = table.create(input.size)
			for component = 1, input.size do
				row[component] = sample(input, ((index - 1) * input.size + component - 1) * input.width)
			end
			values[index] = row
			tick()
		end
		return values
	end
	local decoded: {Values} = {}
	for index, plan in ipairs(plans) do
		local positions = rows(plan.position)
		local normals = if plan.normal then rows(plan.normal) else nil
		local uvs = if plan.uv then rows(plan.uv) else nil
		local indices: {number} = table.create(plan.indices.count)
		local restart = 2 ^ (plan.indices.width * 8) - 1
		for ordinal = 1, plan.indices.count do
			local vertex = sample(plan.indices, (ordinal - 1) * plan.indices.width)
			if vertex >= plan.position.count or vertex == restart then fail("INPUT", "Triangle index out of range/restart.") end
			indices[ordinal] = vertex + 1
			tick()
		end
		-- Arcane policy shared with host preparation: doubled area in square
		-- meters must exceed 1e-10. Validate before every engine allocation;
		-- duplicated positions at distinct UV seams are not globally welded.
		for at = 1, #indices, 3 do
			local a, b, c = positions[indices[at]], positions[indices[at + 1]], positions[indices[at + 2]]
			local ux, uy, uz = b[1] - a[1], b[2] - a[2], b[3] - a[3]
			local vx, vy, vz = c[1] - a[1], c[2] - a[2], c[3] - a[3]
			local x, y, z = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
			if math.sqrt(x * x + y * y + z * z) <= 1e-10 then fail("INPUT", "Degenerate triangle; doubled area must exceed 1e-10.") end
			tick()
		end
		decoded[index] = {positions = positions, normals = normals, uvs = uvs, indices = indices}
	end

	return {decoded=decoded,vertices=vertexCount,triangles=triangleCount}
end
-- Explicit carrier construction; NEVER assume CreateMeshPartAsync recenters.
-- Original sealed data is untouched. Only this detached numeric delivery copy
-- is translated; topology, ordinal mappings, normals and UVs are unchanged.
local function centerDelivery(prepared: any, centre: any, check: () -> (), tick: () -> ()): any
	if centre == nil then return nil end
	if type(centre) ~= "table" or getmetatable(centre) ~= nil or #centre ~= 3 then fail("INPUT","Expected exact carrier center.") end
	local copy,keys={},0
	for key in pairs(centre) do integer(key,3,1,"carrier center axis");keys+=1 end
	if keys ~= 3 then fail("INPUT","Carrier center must be dense.") end
	for axis=1,3 do
		local value=centre[axis]
		if type(value) ~= "number" or value ~= value or math.abs(value)>LIMITS.coordinate then fail("INPUT","Invalid carrier center component.") end
		copy[axis]=value
	end
	for _,values in ipairs(prepared.decoded) do
		for _,point in ipairs(values.positions) do
			for axis=1,3 do
				local value=point[axis]-copy[axis]
				if value ~= value or math.abs(value)>LIMITS.coordinate then fail("INPUT","Centered carrier position exceeds numeric bounds.") end
				point[axis]=value
			end
			tick()
		end
		for at=1,#values.indices,3 do
			local a,b,c=values.positions[values.indices[at]],values.positions[values.indices[at+1]],values.positions[values.indices[at+2]]
			local ux,uy,uz=b[1]-a[1],b[2]-a[2],b[3]-a[3]
			local vx,vy,vz=c[1]-a[1],c[2]-a[2],c[3]-a[3]
			local x,y,z=uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx
			if math.sqrt(x*x+y*y+z*z)<=1e-10 then fail("INPUT","Centered carrier triangle is degenerate.") end
			tick()
		end
	end
	check();return table.freeze(copy)
end
function AssetMesh.validate(data: Data, guard: () -> (), yieldBatch: () -> (), deliveryCentre: {number}?): any
	local count=0
	local function check(): ()
		local ok,result=pcall(guard)
		if not ok or (result ~= nil and result ~= true) then fail("CANCELLED","Mesh scope changed.") end
	end
	local function tick(): () count+=1;if count % LIMITS.batch == 0 then check();yieldBatch();check() end end
	check();local prepared=prepare(data,check,tick);centerDelivery(prepared,deliveryCentre,check,tick);check()
	return table.freeze({vertexCount=prepared.vertices,triangleCount=prepared.triangles})
end

function AssetMesh.create(data: Data, assetService: MeshService, guard: () -> boolean?, yieldBatch: () -> (), deliveryCentre: {number}?): Result
	local ownedMesh: EditableMesh? = nil
	local ok, result = pcall(function(): Result
		if type(guard) ~= "function" or type(yieldBatch) ~= "function" then fail("INPUT", "Guard and yield callback required.") end
		local function check(): ()
			local alive, allowed = pcall(guard)
			-- Existing operation guards return nothing on success and throw on
			-- revocation. A predicate may also explicitly accept/reject ownership.
			if not alive or (allowed ~= nil and allowed ~= true) then fail("CANCELLED", "Mesh ownership guard revoked.") end
		end
		local work = 0
		local function tick(): ()
			work += 1
			if work == LIMITS.batch then
				check()
				yieldBatch()
				check()
				work = 0
			end
		end
		check()
		local prepared = prepare(data,check,tick)
		local sourceLocalCentre = centerDelivery(prepared,deliveryCentre,check,tick)
		local decoded,vertexCount,triangleCount=prepared.decoded,prepared.vertices,prepared.triangles
		check()
		ownedMesh = assetService:CreateEditableMesh()
		check() -- Keep the reference BEFORE this check so revocation cannot leak it.
		if ownedMesh == nil then fail("MEMORY", "EditableMesh allocation returned nil.") end
		local mesh = ownedMesh :: EditableMesh
		local function engineId(value: any): number
			check()
			return integer(value, 9007199254740991, 0, "engine ID")
		end
		local mappings: {Mapping} = {}
		for index, values in ipairs(decoded) do
			local mapping: Mapping = {vertexIds = {}, faceIds = {}, normalIds = {}, uvIds = {}}
			mappings[index] = mapping
			for ordinal, point in ipairs(values.positions) do
				check()
				mapping.vertexIds[ordinal] = engineId(mesh:AddVertex(Vector3.new(point[1], point[2], point[3])))
				if values.normals then
					local normal = values.normals[ordinal]
					check()
					mapping.normalIds[ordinal] = engineId(mesh:AddNormal(Vector3.new(normal[1], normal[2], normal[3])))
				end
				if values.uvs then
					local uv = values.uvs[ordinal]
					check()
					mapping.uvIds[ordinal] = engineId(mesh:AddUV(Vector2.new(uv[1], uv[2])))
				end
				tick()
			end
			for at = 1, #values.indices, 3 do
				local a, b, c = values.indices[at], values.indices[at + 1], values.indices[at + 2]
				check()
				local face = engineId(mesh:AddTriangle(mapping.vertexIds[a], mapping.vertexIds[b], mapping.vertexIds[c]))
				mapping.faceIds[(at + 2) / 3] = face
				if values.normals then
					check()
					mesh:SetFaceNormals(face, {mapping.normalIds[a], mapping.normalIds[b], mapping.normalIds[c]})
					check()
				end
				if values.uvs then
					check()
					mesh:SetFaceUVs(face, {mapping.uvIds[a], mapping.uvIds[b], mapping.uvIds[c]})
					check()
				end
				tick()
			end
		end
		check()
		return {editableMesh = mesh, primitives = mappings, vertexCount = vertexCount, triangleCount = triangleCount,
			coordinateSpace = if sourceLocalCentre then "centered-carrier-meters" else "export-meters",
			sourceLocalCentre = sourceLocalCentre, engineVerification = "pending"}
	end)
	if not ok then
		if ownedMesh ~= nil then
			local cleaned = pcall(function() (ownedMesh :: EditableMesh):Destroy() end)
			if not cleaned then error(table.freeze({code = "ENGINE", message = "Mesh reconstruction failed; owned resource destruction also failed.", cleanupFailed = true}), 0) end
		end
		if type(result) == "table" and type(result.code) == "string" then error(result, 0) end
		fail("ENGINE", "Mesh reconstruction or injected callback failed: " .. tostring(result))
	end
	return result :: Result
end

return table.freeze(AssetMesh)
