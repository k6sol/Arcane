--!strict
-- Scalar-only sidecar for the decoder's material manifest (not raw glTF JSON).
-- No services/globals are resolved; only injected factories create resources.
-- Exactly two constant 1x1 RGBA maps; no source image decoding or uploads.
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
	doubleSided: boolean, transparency: number, emissiveStrength: number?,
	supported: boolean, emissionSupport: "zero-only", limitations: {string},
	requiresSurfaceAppearance: boolean, engineVerification: "pending",
}
-- colorFromLinear is a caller-supplied color-space adapter, NOT a Roblox API.
-- It must encode linear glTF RGB for MeshPart.Color. This module never guesses
-- a renderer's color space or substitutes a built-in material/Reflectance/Neon.
export type Factories = {
	createEditableImage: ({Size: Vector2}) -> EditableImage?,
	createSurfaceAppearanceAsync: ({MetalnessMap: Content, RoughnessMap: Content}) -> SurfaceAppearance?,
	contentFromObject: (EditableImage) -> Content,
	vector2: (number, number) -> Vector2,
	colorFromLinear: (number, number, number) -> Color3,
}
export type Result = {
	surfaceAppearance: SurfaceAppearance,
	editableImages: {MetalnessMap: EditableImage, RoughnessMap: EditableImage},
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
	"Source texture decoding and non-opaque alpha are unsupported. Color-space conversion is injected.",
})
local AssetMaterials = {LIMITS = LIMITS}
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

-- Pure, bounded validation and detached frozen snapshot. Throws {code,field,
-- message}; never defaults missing decoded fields or clamps unsupported values.
-- A nil material denotes glTF's default metallic=1, roughness=1, white opaque.
-- A valid nonzero emission plan exposes supported=false; create rejects it.
function AssetMaterials.plan(material: Material?): Plan
	local value = record(if material == nil then {baseColor = {1, 1, 1, 1}, metallic = 1, roughness = 1,
		alphaMode = "OPAQUE", alphaCutoff = 0.5, doubleSided = false, normalScale = 1} else material, MATERIAL_FIELDS, "material")
	for _, field in ipairs(MAP_FIELDS) do
		if value[field] ~= nil then fail("UNSUPPORTED_TEXTURE", field, "Texture mapping requires decoded images.") end
	end
	local baseColor = channels(value.baseColor, 4, "baseColor")
	local metallic = scalar(value.metallic, 1, "metallic")
	local roughness = scalar(value.roughness, 1, "roughness")
	local cutoff = scalar(value.alphaCutoff, 1, "alphaCutoff")
	if value.alphaMode ~= "OPAQUE" or baseColor[4] ~= 1 then
		fail("UNSUPPORTED_MATERIAL", "alphaMode", "Only OPAQUE alpha=1 is supported; transparency is not approximated.")
	end
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
		alphaMode = "OPAQUE", alphaCutoff = cutoff, doubleSided = value.doubleSided,
		normalScale = normalScale, emission = emission, sha256 = value.sha256})
	return table.freeze({source = source, baseColorLinear = table.freeze({baseColor[1], baseColor[2], baseColor[3]}),
		constantMaps = table.freeze({MetalnessMap = constantMap(metallic), RoughnessMap = constantMap(roughness)}),
		metallic = metallic, roughness = roughness, doubleSided = source.doubleSided, transparency = 0,
		emissiveStrength = if emissionSupported then 0 else nil, supported = emissionSupported,
		emissionSupport = "zero-only", limitations = LIMITATIONS, requiresSurfaceAppearance = true, engineVerification = "pending"})
end

-- Adapters wrap CreateEditableImage({Size=...}), Content.fromObject(image),
-- Vector2.new(x,y), and CreateSurfaceAppearanceAsync({MetalnessMap=Content,
-- RoughnessMap=Content}). These are injected callbacks, not live services.
-- Factories must return NEW resources; EditableImage is a non-parentable Object.
-- Ownership of appearance AND BOTH IMAGES transfers only on success. Keep the
-- images alive with the appearance; engine packing/lifetime is unverified here.
-- No caller MeshPart is mutated.
-- Main applies meshPartProperties and parents the appearance under its own
-- live authorization/rollback boundary; a plan or hash never authorizes that.
function AssetMaterials.create(material: Material?, factories: Factories, guard: () -> boolean?): Result
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
		local plan = AssetMaterials.plan(material)
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
		local function image(map: ScalarMap, field: string): (EditableImage, Content)
			check()
			local size = makeVector(map.width, map.height)
			check()
			local editable = own(makeImage({Size = size}), field) :: EditableImage
			if editable.Size.X ~= 1 or editable.Size.Y ~= 1 then fail("INPUT", field, "Factory image must be exactly 1x1.") end
			check()
			local pixels = buffer.create(4)
			for index = 1, 4 do buffer.writeu8(pixels, index - 1, map.rgba[index]) end
			local origin = makeVector(0, 0)
			check()
			editable:WritePixelsBuffer(origin, size, pixels)
			check()
			local content = makeContent(editable)
			check()
			if content == nil then fail("INPUT", "contentFromObject", "Content adapter returned nil.") end
			return editable, content
		end
		local metalnessImage, metalnessContent = image(plan.constantMaps.MetalnessMap, "MetalnessMap")
		local roughnessImage, roughnessContent = image(plan.constantMaps.RoughnessMap, "RoughnessMap")
		check()
		local appearance = own(makeAppearance({MetalnessMap = metalnessContent, RoughnessMap = roughnessContent}), "surfaceAppearance") :: SurfaceAppearance
		if not appearance:IsA("SurfaceAppearance") or appearance.Parent ~= nil then
			fail("INPUT", "surfaceAppearance", "Factory must return a new detached SurfaceAppearance.")
		end
		check()
		appearance.EmissiveStrength = plan.emissiveStrength :: number
		check()
		return table.freeze({surfaceAppearance = appearance,
			editableImages = table.freeze({MetalnessMap = metalnessImage, RoughnessMap = roughnessImage}),
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
