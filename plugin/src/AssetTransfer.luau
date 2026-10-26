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
local function conversionSnapshot(value: any): any
	plain(value, "Conversion")
	local allowed = {sourceUnits = true, sourceUp = true, exportUnits = true, exportUp = true,
		targetUnits = true, targetUp = true, studsPerMeter = true}
	local count = 0
	for key in pairs(value) do if not allowed[key] then fail("INPUT", "Unsupported conversion field.") end; count += 1 end
	if count ~= 7 or value.sourceUnits ~= "meters" or value.sourceUp ~= "Z" or value.exportUnits ~= "meters"
		or value.exportUp ~= "Y" or value.targetUnits ~= "studs" or value.targetUp ~= "Y" then fail("INPUT", "Unsupported conversion literals.") end
	local units = finite(value.studsPerMeter, 1000, "studs per meter")
	if units <= 0 then fail("INPUT", "Positive studs per meter required.") end
	return table.freeze({sourceUnits = "meters", sourceUp = "Z", exportUnits = "meters", exportUp = "Y",
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
function AssetTransfer.meshPartPlan(object: any, conversion: any): any
	plain(object, "Mesh object")
	if object.role ~= "render" and object.role ~= "collision" then fail("INPUT", "Unsupported mesh role.") end
	local bounds = measuredBounds(object.bounds, object.role == "collision")
	measuredBounds(object.worldBounds, object.role == "collision")
	local units = conversionSnapshot(conversion).studsPerMeter
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
	return table.freeze({size = table.freeze(size), cframe = table.freeze(cframe), physicalPaddingStuds = table.freeze(padding)})
end
local function snapshot(value: any, depth: number, budget: any): any
	budget.count += 1
	if depth > 32 or budget.count > 60000 then fail("BUDGET", "Decoded packet complexity exceeded.") end
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
		if failures > 0 then fail("CLEANUP", "Transfer failed; owned unparented resources may remain.") end
	end
	local receiver = {}
	function receiver:cancel(): () abort() end
	function receiver:status(): any
		return table.freeze({state = state, packetCount = ordinal, byteLength = bytes, engineVerification = "pending"})
	end
	local function declare(descriptor: any, objectId: string, primitiveIndex: number, semantic: string): ()
		descriptor = plain(descriptor, "Stream descriptor")
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
			local packet = plain(snapshot(decodeJson(json), 0, {count = 0}), "Packet")
			check()
			if packet.formatVersion ~= 1 or packet.payloadDigest ~= payloadDigest or packet.manifestDigest ~= manifestDigest
				or packet.ordinal ~= ordinal then fail("IDENTITY", "Packet revision/order differs from owned transfer.") end
			local packetHash = hash(json)
			if packet.kind == "begin" then
				if ordinal ~= 0 or begin ~= nil then fail("STATE", "Begin must be first and unique.") end
				integer(packet.objectCount, 1, LIMITS.objects)
				integer(packet.textureCount or 0, 0, 256)
				sealedConversion = conversionSnapshot(packet.conversion)
				begin = packet
			elseif packet.kind == "texture" then
				if begin == nil or #objects ~= 0 then fail("STATE", "Textures must follow begin and precede objects.") end
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
				if begin == nil or textureCount ~= (begin.textureCount or 0) then fail("STATE", "Object precedes complete texture declarations.") end
				integer(#objects + 1, 1, begin.objectCount)
				local object = plain(packet.object, "Object")
				local objectId = object.sourceObjectId
				if type(objectId) ~= "string" or #objectId > 128 or objectIds[objectId] then fail("IDENTITY", "Invalid/duplicate object identity.") end
				local primitives = plain(packet.primitives, "Primitives")

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
			else fail("INPUT", "Unknown packet kind.") end
			packetHashes:update((if ordinal == 0 then "" else "\n") .. packetHash)
			if packet.kind == "seal" then
				if packetHashes:digest() ~= transferDigest then fail("CHECKSUM", "Owned transfer digest mismatch.") end
				state = "sealed"
			else
				contentHashes:update((if ordinal == 0 then "" else "\n") .. tostring(ordinal) .. ":" .. packet.kind .. ":" .. tostring(#json) .. ":" .. packetHash)
			end
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
				AssetTransfer.meshPartPlan(entry.object, sealedConversion)
				check()
			end
			local function materialize(descriptor: any): any
				local stream = streams[descriptor.streamId]
				return {semantic = descriptor.semantic, componentType = descriptor.componentType, type = descriptor.type,
					count = descriptor.count, normalized = descriptor.normalized, byteLength = descriptor.byteLength,
					bytes = buffer.fromstring(table.concat(stream.parts))}
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
				for _, primitive in ipairs(entry.primitives) do
					local attributes = {}
					for semantic, descriptor in pairs(primitive.attributes) do attributes[semantic] = materialize(descriptor) end
					primitives[#primitives + 1] = {mode = primitive.mode, vertexCount = primitive.vertexCount, triangleCount = primitive.triangleCount,
						attributes = attributes, indices = materialize(primitive.indices)}
				end
				local mesh = AssetMesh.create({primitives = primitives}, assetService, check, yieldBatch)
				resources[#resources + 1] = mesh.editableMesh
				check()
				reconstructed[#reconstructed + 1] = {object = entry.object, material = entry.material, mesh = mesh,
					textures = objectHandles[index], conversion = sealedConversion}
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
		check()
		return table.freeze(result)
	end
	return table.freeze(receiver)
end

return table.freeze(AssetTransfer)
