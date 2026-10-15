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
	local objects: {any} = {}
	local objectIds: {[string]: boolean} = {}
	local streams: {[string]: any} = {}
	local streamCount = 0
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
		if failures > 0 then fail("CLEANUP", "Transfer failed; owned unparented resources may remain.") end
	end
	local receiver = {}
	function receiver:cancel(): () abort() end
	function receiver:status(): any
		return table.freeze({state = state, packetCount = ordinal, byteLength = bytes, engineVerification = "pending"})
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
				begin = packet
			elseif packet.kind == "object" then
				if begin == nil then fail("STATE", "Object precedes begin.") end
				integer(#objects + 1, 1, begin.objectCount)
				local object = plain(packet.object, "Object")
				local objectId = object.sourceObjectId
				if type(objectId) ~= "string" or #objectId > 128 or objectIds[objectId] then fail("IDENTITY", "Invalid/duplicate object identity.") end
				local primitives = plain(packet.primitives, "Primitives")
				local function declare(descriptor: any, primitiveIndex: number, semantic: string): ()
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
				for index, primitive in ipairs(primitives) do
					plain(primitive, "Primitive")
					for semantic, descriptor in pairs(plain(primitive.attributes, "Attributes")) do declare(descriptor, index - 1, semantic) end
					declare(primitive.indices, index - 1, "indices")
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
				if begin == nil or #objects ~= begin.objectCount or packet.precedingPacketCount ~= ordinal
					or packet.precedingByteLength ~= bytes or packet.contentDigest ~= contentHashes:digest() then fail("CHECKSUM", "Incomplete/mismatched seal.") end
				for _, stream in pairs(streams) do if not stream.complete then fail("CHECKSUM", "Seal contains incomplete streams.") end end
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
	function receiver:reconstruct(assetService: any): any
		if state ~= "sealed" then fail("STATE", "Only a completely sealed transfer may reconstruct.") end
		state = "reconstructing"
		local ok, result = pcall(function(): any
			check()
			local reconstructed = {}
			local function materialize(descriptor: any): any
				local stream = streams[descriptor.streamId]
				return {semantic = descriptor.semantic, componentType = descriptor.componentType, type = descriptor.type,
					count = descriptor.count, normalized = descriptor.normalized, byteLength = descriptor.byteLength,
					bytes = buffer.fromstring(table.concat(stream.parts))}
			end
			for _, entry in ipairs(objects) do
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
				reconstructed[#reconstructed + 1] = {object = entry.object, material = entry.material, mesh = mesh}
			end
			check()
			state = "taken"
			table.clear(resources) -- Ownership transferred exactly once to caller.
			table.clear(streams)
			table.clear(objects)
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
