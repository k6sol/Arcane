--!strict
-- Scalar and privately admitted texture sidecar for the decoder's material manifest (not raw glTF JSON).
-- No services are resolved (only Enum.AlphaMode, read for MASK); only injected factories create resources.
-- Decoded RGBA8 pixels arrive only from a sealed receiver intake; no PNG decoding or uploads.
-- Checked 2026-10-14 against primary docs:
-- https://create.roblox.com/docs/reference/engine/classes/SurfaceAppearance
-- https://create.roblox.com/docs/reference/engine/classes/MeshPart
-- https://create.roblox.com/docs/reference/engine/classes/AssetService#CreateSurfaceAppearanceAsync
-- https://create.roblox.com/docs/reference/engine/classes/EditableImage#WritePixelsBuffer
-- SurfaceAppearance has MAPS, not scalar Metalness/Roughness properties.
-- CreateSurfaceAppearanceAsync consumes a Content map dictionary. Only red is
-- sampled for metalness/roughness. WritePixelsBuffer consumes RGBA bytes with
-- alpha=255 for opaque pixels. Factors are rounded to nearest byte (ties up).
-- Emission is mask-driven and multiplied by albedo; glTF emission is additive.
-- Without verified mask/albedo handling, only zero effective emission is faithful.

export type Emission = {factor: {number}, strength: number, map: any?}
export type Material = {
	baseColor: {number}, metallic: number, roughness: number, alphaMode: string,
	alphaCutoff: number, doubleSided: boolean, normalScale: number,
	colorMap: any?, normalMap: any?, roughnessMap: any?, metalnessMap: any?,
	emission: Emission?, sha256: string?,
}
export type ScalarMap = {
	width: number, height: number, format: "RGBA8", rgba: {number},
	sourceFactor: number, redByte: number, normalizedFactor: number,
	quantizationError: number, rounding: "nearest-half-up", engineVerification: "pending",
}
export type Plan = {
	source: Material, baseColorLinear: {number}, metallic: number, roughness: number,
	constantMaps: {MetalnessMap: ScalarMap, RoughnessMap: ScalarMap},
	doubleSided: boolean, transparency: number, alphaMode: string, emissiveStrength: number?,
	supported: boolean, emissionSupport: "zero-only", limitations: {string},
	requiresSurfaceAppearance: boolean, engineVerification: "pending",
}
-- colorFromLinear is a caller-supplied color-space adapter, NOT a Roblox API.
-- It must encode linear glTF RGB for MeshPart.Color. This module never guesses
-- a renderer's color space or substitutes a built-in material/Reflectance/Neon.
export type Factories = {
	createEditableImage: ({Size: Vector2}) -> EditableImage?,
	createSurfaceAppearanceAsync: ({[string]: Content}) -> SurfaceAppearance?,
	contentFromObject: (EditableImage) -> Content,
	vector2: (number, number) -> Vector2,
	colorFromLinear: (number, number, number) -> Color3,
}
export type Result = {
	surfaceAppearance: SurfaceAppearance,
	editableImages: {[string]: EditableImage},
	meshPartProperties: {Color: Color3, Transparency: number, DoubleSided: boolean},
	plan: Plan, engineVerification: "pending",
}

local MATERIAL_FIELDS = table.freeze({baseColor = true, metallic = true, roughness = true,
	alphaMode = true, alphaCutoff = true, doubleSided = true, normalScale = true,
	colorMap = true, normalMap = true, roughnessMap = true, metalnessMap = true,
	emission = true, sha256 = true})
local EMISSION_FIELDS = table.freeze({factor = true, strength = true, map = true})
local MAP_FIELDS = table.freeze({"colorMap", "normalMap", "roughnessMap", "metalnessMap"})
local LIMITS = table.freeze({editableImages = 2, surfaceAppearances = 1, width = 1, height = 1, pixelBytes = 8})
local EMISSION_LIMITATION = "Nonzero additive glTF emission needs verified emissive mask/albedo mapping; scalar emission is unsupported."
local LIMITATIONS = table.freeze({
	"Metallic and roughness use nearest RGBA8 values; original factors and quantization errors are preserved. Engine rendering is pending.",
	EMISSION_LIMITATION,
	"Texture delivery requires privately admitted RGBA8 maps; only UV0 repeat sampling, opaque alpha and glTF MASK (host-thresholded ColorMap alpha 0/255, AlphaMode Transparency) are supported; BLEND is not. Engine sampling and cutout rendering are pending.",
})
local TEXTURE_LIMITS = table.freeze({width = 1024, height = 1024, maps = 4, bytes = 16 * 1024 * 1024})
local AssetMaterials = {LIMITS = LIMITS, TEXTURE_LIMITS = TEXTURE_LIMITS}
-- This process-local handle never serializes pixel ownership. Raw metadata or a
-- JSON lookalike cannot be passed to plan/create as a verified texture bundle.
local textureHandles: {[any]: any} = setmetatable({}, {__mode = "k"})
local SLOT_FIELDS = table.freeze({ColorMap = "colorMap", NormalMap = "normalMap", RoughnessMap = "roughnessMap", MetalnessMap = "metalnessMap"})
local CHANNELS = table.freeze({ColorMap = "rgba", NormalMap = "rgb", RoughnessMap = "g", MetalnessMap = "b"})
local internalErrors: {[any]: boolean} = setmetatable({}, {__mode = "k"})

local function fail(code: string, field: string, message: string): never
	local value = table.freeze({code = code, field = field, message = message})
	internalErrors[value] = true
	error(value, 0)
end

local function record(value: any, fields: {[string]: boolean}, label: string): any
	if type(value) ~= "table" or getmetatable(value) ~= nil then
		fail("INPUT", label, "Expected a plain material data record.")
	end
	for key in pairs(value) do
		if type(key) ~= "string" or not fields[key] then
			fail("UNSUPPORTED_MATERIAL", label, "Unsupported material field.")
		end
	end
	return value
end

local function scalar(value: any, maximum: number, field: string): number
	if type(value) ~= "number" or value ~= value or value < 0 or value > maximum then
		fail("INPUT", field, "Expected a finite scalar in its supported range.")
	end
	return value
end

local function channels(value: any, count: number, field: string): {number}
	if type(value) ~= "table" or getmetatable(value) ~= nil then
		fail("INPUT", field, "Expected a plain dense color array.")
	end
	local length = 0
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > count then
			fail("INPUT", field, "Expected an exact color array length.")
		end
		length += 1
	end
	if length ~= count then fail("INPUT", field, "Expected an exact color array length.") end
	local copy: {number} = table.create(count)
	for index = 1, count do copy[index] = scalar(value[index], 1, field) end
	return table.freeze(copy)
end

local function constantMap(factor: number): ScalarMap
	local red = math.floor(factor * 255 + 0.5)
	local normalized = red / 255
	return table.freeze({width = LIMITS.width, height = LIMITS.height, format = "RGBA8",
		rgba = table.freeze({red, red, red, 255}), sourceFactor = factor, redByte = red,
		normalizedFactor = normalized, quantizationError = normalized - factor,
		rounding = "nearest-half-up", engineVerification = "pending"})
end

local function sameData(a: any, b: any, depth: number): boolean
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	if depth > 8 or getmetatable(a) ~= nil or getmetatable(b) ~= nil then return false end
	for key, value in pairs(a) do if not sameData(value, b[key], depth + 1) then return false end end
	for key in pairs(b) do if a[key] == nil then return false end end
	return true
end

-- Pure, bounded validation and detached frozen snapshot. Throws {code,field,
-- message}; never defaults missing decoded fields or clamps unsupported values.
-- A nil material denotes glTF's default metallic=1, roughness=1, white opaque.
-- A valid nonzero emission plan exposes supported=false; create rejects it.
function AssetMaterials.plan(material: Material?, textures: any?): Plan
	local value = record(if material == nil then {baseColor = {1, 1, 1, 1}, metallic = 1, roughness = 1,
		alphaMode = "OPAQUE", alphaCutoff = 0.5, doubleSided = false, normalScale = 1} else material, MATERIAL_FIELDS, "material")
	local bundle = if textures == nil then nil else textureHandles[textures]
	if textures ~= nil and (bundle == nil or bundle.materialSha256 ~= value.sha256) then fail("INPUT", "textures", "Expected an original private texture bundle for this material.") end
	if bundle ~= nil and bundle.source ~= nil and not sameData(value, bundle.source, 0) then fail("INPUT", "textures", "Material data changed after private texture intake.") end
	local sourceMaps = {}
	for slot, field in pairs(SLOT_FIELDS) do
		if value[field] ~= nil then
			if bundle == nil or bundle.maps[slot] == nil then fail("UNSUPPORTED_TEXTURE", field, "Texture mapping requires privately admitted decoded images.") end
			local reference = value[field]
			if type(reference) ~= "table" or getmetatable(reference) ~= nil or reference.sha256 ~= bundle.references[field].sha256
				or reference.channel ~= bundle.references[field].channel or reference.texCoord ~= 0 then fail("INPUT", field, "Material reference changed after texture intake.") end
			for key in pairs(reference) do if key ~= "sha256" and key ~= "channel" and key ~= "texCoord" then fail("INPUT", field, "Unexpected texture reference field.") end end
			sourceMaps[field] = bundle.references[field]
		elseif bundle ~= nil and bundle.maps[slot] ~= nil then fail("INPUT", field, "Unexpected texture map for a scalar material.") end
	end
	local baseColor = channels(value.baseColor, 4, "baseColor")
	local metallic = scalar(value.metallic, 1, "metallic")
	local roughness = scalar(value.roughness, 1, "roughness")
	local cutoff = scalar(value.alphaCutoff, 1, "alphaCutoff")
	-- MASK is a binary cutout already thresholded by the host (alpha >= cutoff
	-- becomes 255, else 0). BLEND and fractional factor alpha are never approximated.
	if (value.alphaMode ~= "OPAQUE" and value.alphaMode ~= "MASK") or baseColor[4] ~= 1 then
		fail("UNSUPPORTED_MATERIAL", "alphaMode", "Only OPAQUE or MASK with alpha=1 is supported; blending is not approximated.")
	end
	local alphaMode: string = value.alphaMode
	if type(value.doubleSided) ~= "boolean" then fail("INPUT", "doubleSided", "Expected a boolean.") end
	-- With no normal map, this factor has no visual effect. Preserve it as data.
	local normalScale = value.normalScale
	if type(normalScale) ~= "number" or normalScale ~= normalScale or math.abs(normalScale) > 1000000 then
		fail("INPUT", "normalScale", "Expected a bounded finite normal scale.")
	end
	if value.sha256 ~= nil and (type(value.sha256) ~= "string" or #value.sha256 ~= 64
		or string.find(value.sha256, "[^0-9a-f]") ~= nil) then
		fail("INPUT", "sha256", "Expected a lowercase SHA-256 digest; a digest grants no authority.")
	end
	local emission: Emission? = nil
	local emissionSupported = true
	if value.emission ~= nil then
		local input = record(value.emission, EMISSION_FIELDS, "emission")
		if input.map ~= nil then fail("UNSUPPORTED_TEXTURE", "emission.map", "Emission textures require decoded images.") end
		local factor = channels(input.factor, 3, "emission.factor")
		local strength = scalar(input.strength, 1000, "emission.strength")
		-- Compare independently rather than multiplying: tiny nonzero emission
		-- must not underflow to zero and pass the unsupported mapping gate.
		emissionSupported = strength == 0 or (factor[1] == 0 and factor[2] == 0 and factor[3] == 0)
		emission = table.freeze({factor = factor, strength = strength})
	end
	local source: Material = table.freeze({baseColor = baseColor, metallic = metallic, roughness = roughness,
		alphaMode = alphaMode, alphaCutoff = cutoff, doubleSided = value.doubleSided,
		normalScale = normalScale, emission = emission, sha256 = value.sha256,
		colorMap = sourceMaps.colorMap, normalMap = sourceMaps.normalMap, roughnessMap = sourceMaps.roughnessMap, metalnessMap = sourceMaps.metalnessMap})
	return table.freeze({source = source, baseColorLinear = if bundle ~= nil and bundle.maps.ColorMap ~= nil then table.freeze({1, 1, 1}) else table.freeze({baseColor[1], baseColor[2], baseColor[3]}),
		constantMaps = table.freeze({MetalnessMap = constantMap(metallic), RoughnessMap = constantMap(roughness)}),
		metallic = metallic, roughness = roughness, doubleSided = source.doubleSided, transparency = 0, alphaMode = alphaMode,
		emissiveStrength = if emissionSupported then 0 else nil, supported = emissionSupported,
		emissionSupport = "zero-only", limitations = LIMITATIONS, requiresSurfaceAppearance = true, engineVerification = "pending"})
end


-- Internal trusted callback for AssetTransfer.reconstruct AFTER exact stream and
-- seal verification. No engine resources are allocated here. Caller conveniences
-- are copied before any later yielding engine callback can observe them.
function AssetMaterials.admitTextures(material: any, maps: any, guard: () -> ()): any
	material = record(material, MATERIAL_FIELDS, "material")
	local materialId = material.sha256
	if type(materialId) ~= "string" or #materialId ~= 64 or string.find(materialId, "[^0-9a-f]") ~= nil then fail("INPUT", "material", "Expected exact material identity.") end
	if type(maps) ~= "table" or getmetatable(maps) ~= nil or type(guard) ~= "function" then fail("INPUT", "textures", "Trusted texture intake requires plain maps and guard.") end
	local function check(): ()
		local ok, result = pcall(guard)
		if not ok or (result ~= nil and result ~= true) then fail("CANCELLED", "guard", "Texture ownership guard revoked.") end
	end
	local owned, references, count, bytes = {}, {}, 0, 0
	local baseColor = channels(material.baseColor, 4, "baseColor")
	local metallic, roughness = scalar(material.metallic, 1, "metallic"), scalar(material.roughness, 1, "roughness")
	check()
	for slot, map in pairs(maps) do
		local field = SLOT_FIELDS[slot]
		if field == nil or type(map) ~= "table" or getmetatable(map) ~= nil then fail("INPUT", "textures", "Unsupported texture slot or data.") end
		local reference = material[field]
		if type(reference) ~= "table" or getmetatable(reference) ~= nil then fail("INPUT", field, "Missing source texture reference.") end
		for key in pairs(reference) do if key ~= "sha256" and key ~= "channel" and key ~= "texCoord" then fail("INPUT", field, "Unexpected source texture field.") end end
		if reference.sha256 ~= map.sourceSha256 or reference.channel ~= CHANNELS[slot] or reference.texCoord ~= 0
			or map.materialSha256 ~= materialId or map.semantic ~= slot or map.channel ~= CHANNELS[slot]
			or map.orientation ~= "top-left" or map.colorSpace ~= (if slot == "ColorMap" then "srgb" else "linear")
			or (slot == "NormalMap" and (map.normalConvention ~= "OpenGL" or material.normalScale ~= 1)) then fail("INPUT", field, "Texture provenance differs from material.") end
		for _, key in ipairs({"imageId", "sourceSha256", "sourceRgbaSha256", "sha256"}) do
			if type(map[key]) ~= "string" or #map[key] ~= 64 or string.find(map[key], "[^0-9a-f]") ~= nil then fail("INPUT", field, "Expected texture digest.") end
		end
		local width, height = map.width, map.height
		if type(width) ~= "number" or type(height) ~= "number" or width % 1 ~= 0 or height % 1 ~= 0 or width < 1 or height < 1
			or width > TEXTURE_LIMITS.width or height > TEXTURE_LIMITS.height or typeof(map.bytes) ~= "buffer"
			or buffer.len(map.bytes) ~= width * height * 4 or map.byteLength ~= width * height * 4 then fail("INPUT", field, "Expected bounded RGBA8 image bytes.") end
		local expected = if slot == "ColorMap" then {baseColor[1], baseColor[2], baseColor[3]}
			elseif slot == "NormalMap" then {material.normalScale} elseif slot == "RoughnessMap" then {roughness} else {metallic}
		if type(map.factors) ~= "table" or getmetatable(map.factors) ~= nil or #map.factors ~= #expected then fail("INPUT", field, "Expected baked material factors.") end
		for index, factor in ipairs(expected) do if map.factors[index] ~= factor then fail("INPUT", field, "Baked factor differs from material.") end end
		count += 1; bytes += width * height * 4
		if count > TEXTURE_LIMITS.maps or bytes > TEXTURE_LIMITS.bytes then fail("INPUT", field, "Texture bundle exceeds bounds.") end
		local copy = buffer.create(width * height * 4)
		buffer.copy(copy, 0, map.bytes, 0, buffer.len(copy))
		-- Only a MASK ColorMap may carry binary cutout coverage; every other map stays opaque.
		local cutout = slot == "ColorMap" and material.alphaMode == "MASK"
		for index = 3, buffer.len(copy) - 1, 4 do
			local alpha = buffer.readu8(copy, index)
			if alpha ~= 255 and not (cutout and alpha == 0) then fail("INPUT", field, "Delivered map pixels require alpha 255 (or 0/255 for a MASK ColorMap).") end
			if index % 16384 == 16383 then check() end
		end
		owned[slot] = table.freeze({width = width, height = height, bytes = copy})
		references[field] = table.freeze({sha256 = reference.sha256, channel = reference.channel, texCoord = 0})
		check()
	end
	for slot, field in pairs(SLOT_FIELDS) do if (material[field] ~= nil) ~= (owned[slot] ~= nil) then fail("INPUT", field, "Texture coverage differs from material.") end end
	if count == 0 then fail("INPUT", "textures", "An empty texture bundle is not ownership.") end
	local handle = table.freeze({kind = "arcane-private-material-textures"})
	textureHandles[handle] = {materialSha256 = materialId, maps = table.freeze(owned), references = table.freeze(references)}
	local ok, plan = pcall(AssetMaterials.plan, material, handle)
	if not ok then textureHandles[handle] = nil; error(plan, 0) end
	textureHandles[handle].source = plan.source
	check()
	return handle
end

-- Adapters wrap CreateEditableImage({Size=...}), Content.fromObject(image),
-- Vector2.new(x,y), and CreateSurfaceAppearanceAsync({MetalnessMap=Content,
-- RoughnessMap=Content}). These are injected callbacks, not live services.
-- Factories must return NEW resources; EditableImage is a non-parentable Object.
-- Ownership of appearance AND ALL IMAGES transfers only on success. Keep the
-- images alive with the appearance; engine packing/lifetime is unverified here.
-- No caller MeshPart is mutated.
-- Main applies meshPartProperties and parents the appearance under its own
-- live authorization/rollback boundary; a plan or hash never authorizes that.
function AssetMaterials.create(material: Material?, factories: Factories, guard: () -> boolean?, textures: any?): Result
	local owned: {any} = {}
	local ok, result = pcall(function(): Result
		if type(guard) ~= "function" or type(factories) ~= "table"
			or type(factories.createEditableImage) ~= "function" or type(factories.createSurfaceAppearanceAsync) ~= "function"
			or type(factories.contentFromObject) ~= "function" or type(factories.vector2) ~= "function"
			or type(factories.colorFromLinear) ~= "function" then
			fail("INPUT", "factories", "Explicit image/appearance/content/vector/color factories and a live guard are required.")
		end
		local function check(): ()
			local alive, allowed = pcall(guard)
			if not alive or (allowed ~= nil and allowed ~= true) then
				fail("CANCELLED", "guard", "Material ownership guard revoked.")
			end
		end
		check()
		local plan = AssetMaterials.plan(material, textures)
		local bundle = if textures == nil then nil else textureHandles[textures]
		if not plan.supported then fail("UNSUPPORTED_MATERIAL", "emission", EMISSION_LIMITATION) end
		-- Snapshot callback references before any callback can yield/change them.
		local makeColor, makeAppearance = factories.colorFromLinear, factories.createSurfaceAppearanceAsync
		local makeImage, makeContent, makeVector = factories.createEditableImage, factories.contentFromObject, factories.vector2
		local function own(resource: any, field: string): any
			if resource ~= nil then
				for _, previous in ipairs(owned) do
					if previous == resource then fail("INPUT", field, "Factory must return a new distinct resource.") end
				end
				owned[#owned + 1] = resource -- BEFORE cancellation checking.
			end
			check()
			if resource == nil then fail("MEMORY", field, "Resource allocation returned nil.") end
			return resource
		end
		check()
		local rgb = plan.baseColorLinear
		local color = makeColor(rgb[1], rgb[2], rgb[3])
		check()
		if color == nil then fail("INPUT", "colorFromLinear", "Color adapter returned nil.") end
		local function image(map: any, field: string): (EditableImage, Content)
			check()
			local size = makeVector(map.width, map.height)
			check()
			local editable = own(makeImage({Size = size}), field) :: EditableImage
			if editable.Size.X ~= map.width or editable.Size.Y ~= map.height then fail("INPUT", field, "Factory image dimensions differ from admitted pixels.") end
			check()
			local pixels = buffer.create(map.width * map.height * 4)
			if map.bytes ~= nil then buffer.copy(pixels, 0, map.bytes, 0, buffer.len(map.bytes))
			else for index = 1, 4 do buffer.writeu8(pixels, index - 1, map.rgba[index]) end end
			local origin = makeVector(0, 0)
			check()
			editable:WritePixelsBuffer(origin, size, pixels)
			check()
			local content = makeContent(editable)
			check()
			if content == nil then fail("INPUT", "contentFromObject", "Content adapter returned nil.") end
			return editable, content
		end
		local images, contents = {}, {}
		for _, slot in ipairs({"MetalnessMap", "RoughnessMap", "ColorMap", "NormalMap"}) do
			local map = if bundle ~= nil and bundle.maps[slot] ~= nil then bundle.maps[slot] else plan.constantMaps[slot]
			if map ~= nil then images[slot], contents[slot] = image(map, slot) end
		end
		check()
		local appearance = own(makeAppearance(contents), "surfaceAppearance") :: SurfaceAppearance
		if not appearance:IsA("SurfaceAppearance") or appearance.Parent ~= nil then
			fail("INPUT", "surfaceAppearance", "Factory must return a new detached SurfaceAppearance.")
		end
		check()
		appearance.EmissiveStrength = plan.emissiveStrength :: number
		if bundle ~= nil and bundle.maps.ColorMap ~= nil then appearance.Color = color end
		-- MASK ColorMap alpha is already binary; Transparency makes it cut out.
		-- Without a ColorMap, factor alpha 1 always passes the cutoff (opaque).
		-- MeshPart.Transparency stays 0. Native cutout rendering is pending.
		if plan.alphaMode == "MASK" and bundle ~= nil and bundle.maps.ColorMap ~= nil then appearance.AlphaMode = (Enum :: any).AlphaMode.Transparency end
		check()
		return table.freeze({surfaceAppearance = appearance,
			editableImages = table.freeze(images),
			meshPartProperties = table.freeze({Color = color, Transparency = plan.transparency, DoubleSided = plan.doubleSided}),
			plan = plan, engineVerification = "pending"})
	end)
	if not ok then
		local cleanupFailed = false
		for index = #owned, 1, -1 do
			local cleaned = pcall(function() owned[index]:Destroy() end)
			if not cleaned then cleanupFailed = true end
		end
		if cleanupFailed then fail("ENGINE", "cleanup", "Material creation failed; owned resource destruction also failed.") end
		if type(result) == "table" and internalErrors[result] then
			error(result, 0)
		end
		-- Do not echo injected/engine errors, which may contain private values.
		fail("ENGINE", "create", "Material creation or injected callback failed.")
	end
	return result :: Result
end

return table.freeze(AssetMaterials)
