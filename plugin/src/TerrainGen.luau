--!strict
-- Pure, deterministic terrain.generate computation: wire validation, heightfield, water,
-- surface materials and chunked voxel arrays. No engine globals are touched here; Operations
-- injects the Terrain writer, the material resolver and the between-chunk yield.
local V = require(script.Parent.Validation)
local TerrainGen = {}

TerrainGen.LIMITS = table.freeze({extent = 2048, minExtent = 16, height = 512, minHeight = 8, coordinate = 100000, floor = 10000,
	features = 32, points = 32, rules = 16, octaves = 8, voxel = 4, chunkColumns = 64, voxels = 33554432, chunkVoxels = 524288})
-- Surface materials (never Air or Water); the daemon policy carries the same list.
TerrainGen.MATERIALS = table.freeze({"Grass", "LeafyGrass", "Ground", "Mud", "Rock", "Slate", "Sand", "Sandstone", "Limestone", "Basalt", "Granite", "Pebble", "Snow", "Ice", "Glacier", "Salt", "Cobblestone", "Asphalt", "Concrete", "Brick", "WoodPlanks", "CrackedLava"})
TerrainGen.FEATURES = table.freeze({"hill", "mountain", "valley", "crater", "plateau", "flatten", "lake", "river", "path"})
local VOXEL = 4
local DEEP_BELOW = 12
local WATER_REACH = 64

local function clamp(value: number, low: number, high: number): number
	return if value < low then low elseif value > high then high else value
end
local function lerp(a: number, b: number, t: number): number return a + (b - a) * t end
local function smoothstep(t: number): number
	t = clamp(t, 0, 1)
	return t * t * (3 - 2 * t)
end
local function round(value: number): number return math.floor(value + 0.5) end

-- Integer LCG mixing (exact in doubles); offsets are fractional so math.noise never samples lattice zeros.
local function hash(seed: number, salt: number): number
	local s = (seed * 48271 + salt * 69621 + 12345) % 2147483647
	s = (s * 48271) % 2147483647
	s = (s * 48271) % 2147483647
	return s / 2147483647
end

local function pair(value: any, low: number, high: number, label: string): {number}
	local list = V.list(value, 2, label)
	if #list ~= 2 then V.fail("INPUT", label .. " needs two numbers.") end
	return {V.number(list[1], low, high, label), V.number(list[2], low, high, label)}
end
local function optional(value: any, low: number, high: number, label: string, fallback: number?): number?
	if value == nil then return fallback end
	return V.number(value, low, high, label)
end
local function material(value: any, label: string, fallback: string?): string?
	if value == nil then return fallback end
	if type(value) ~= "string" or not table.find(TerrainGen.MATERIALS, value) then V.fail("PROPERTY", "Unsupported " .. label .. ".") end
	return value
end

local function feature(raw: any, L: any): any
	local f = V.object(raw, "terrain feature")
	local kind = f.kind
	if type(kind) ~= "string" or not table.find(TerrainGen.FEATURES, kind) then V.fail("INPUT", "Unsupported terrain feature kind.") end
	local out: any = {kind = kind}
	if kind == "river" or kind == "path" then
		V.fields(f, {"kind", "points", "width", "depth", "bank", "material"}, kind)
		local points = V.list(f.points, L.points, kind .. " points")
		if #points < 2 then V.fail("INPUT", "A " .. kind .. " needs 2.." .. L.points .. " points.") end
		out.points = {}
		for _, point in ipairs(points) do table.insert(out.points, pair(point, -L.coordinate, L.coordinate, kind .. " point")) end
		out.width = V.number(f.width, 2, 256, kind .. " width")
		out.depth = optional(f.depth, 0, 64, kind .. " depth", if kind == "river" then 8 else 0.5)
		out.bank = optional(f.bank, 0, 256, kind .. " bank", out.width)
		out.material = material(f.material, kind .. " material", if kind == "river" then "Pebble" else "Ground")
		return out
	end
	out.center = pair(f.center, -L.coordinate, L.coordinate, kind .. " center")
	if kind == "lake" then
		V.fields(f, {"kind", "center", "radius", "level", "depth", "material"}, kind)
		out.radius = V.number(f.radius, 8, 1024, "lake radius")
		out.level = V.number(f.level, 0, L.height, "lake level")
		out.depth = optional(f.depth, 1, 256, "lake depth", 12)
		out.material = material(f.material, "lake material", "Mud")
	elseif kind == "plateau" or kind == "flatten" then
		V.fields(f, {"kind", "center", "radius", "level", "blend", "material"}, kind)
		out.radius = V.number(f.radius, 4, L.extent, kind .. " radius")
		if kind == "plateau" and f.level == nil then V.fail("INPUT", "A plateau needs level.") end
		out.level = optional(f.level, 0, L.height, kind .. " level")
		out.blend = optional(f.blend, 0, 512, kind .. " blend", if kind == "plateau" then out.radius * 0.2 else 16)
		out.material = material(f.material, kind .. " material")
	else
		V.fields(f, {"kind", "center", "radius", "height", "roughness"}, kind)
		out.radius = V.number(f.radius, 4, L.extent, kind .. " radius")
		out.height = V.number(f.height, 0, L.height, kind .. " height")
		out.roughness = optional(f.roughness, 0, 1, kind .. " roughness", if kind == "mountain" then 0.4 else 0)
	end
	return out
end

local RULE_FIELDS = {"material", "minHeight", "maxHeight", "minSlope", "maxSlope", "minNoise", "maxNoise", "nearWater"}
local function rule(raw: any, L: any): any
	local r = V.fields(raw, RULE_FIELDS, "material rule")
	return {material = material(r.material, "rule material") or V.fail("INPUT", "A material rule needs material."),
		minHeight = optional(r.minHeight, 0, L.height, "minHeight"), maxHeight = optional(r.maxHeight, 0, L.height, "maxHeight"),
		minSlope = optional(r.minSlope, 0, 90, "minSlope"), maxSlope = optional(r.maxSlope, 0, 90, "maxSlope"),
		minNoise = optional(r.minNoise, -1, 1, "minNoise"), maxNoise = optional(r.maxNoise, -1, 1, "maxNoise"),
		nearWater = optional(r.nearWater, 0, WATER_REACH, "nearWater")}
end

-- Default look: shores, wet banks, steep rock, ground on mid slopes, patchy grass; snow above snowLine.
local function defaultRules(snowLine: number?): {any}
	local rules: {any} = {}
	if snowLine then table.insert(rules, {material = "Snow", minHeight = snowLine, maxSlope = 42}) end
	table.insert(rules, {material = "Sand", nearWater = 6})
	table.insert(rules, {material = "Mud", nearWater = 14, maxSlope = 30})
	table.insert(rules, {material = "Rock", minSlope = 40})
	table.insert(rules, {material = "Slate", minSlope = 32})
	table.insert(rules, {material = "Ground", minSlope = 22})
	table.insert(rules, {material = "LeafyGrass", minNoise = 0.2})
	return rules
end

-- Validates wire arguments and snaps the region to the 4-stud voxel grid. The daemon policy mirrors this.
function TerrainGen.plan(args: any): any
	local L = TerrainGen.LIMITS
	V.fields(args, {"center", "size", "floor", "height", "baseHeight", "seed", "noise", "edge", "snowLine", "features", "materials"}, "terrain arguments")
	local center = pair(args.center, -L.coordinate, L.coordinate, "terrain center")
	local size = pair(args.size, L.minExtent, L.extent, "terrain size")
	local plan: any = {}
	plan.nx, plan.nz = round(size[1] / VOXEL), round(size[2] / VOXEL)
	plan.ny = round(V.number(args.height, L.minHeight, L.height, "terrain height") / VOXEL)
	plan.height = plan.ny * VOXEL
	plan.x0 = round((center[1] - plan.nx * VOXEL / 2) / VOXEL) * VOXEL
	plan.z0 = round((center[2] - plan.nz * VOXEL / 2) / VOXEL) * VOXEL
	plan.y0 = round(V.number(if args.floor == nil then 0 else args.floor, -L.floor, L.floor, "terrain floor") / VOXEL) * VOXEL
	plan.baseHeight = V.number(args.baseHeight, 0, plan.height, "baseHeight")
	plan.seed = V.integer(args.seed, 0, 2147483647, "seed")
	plan.voxels = plan.nx * plan.ny * plan.nz
	if plan.voxels > L.voxels then V.fail("BODY_LIMIT", "Terrain region exceeds the voxel budget.") end
	plan.ox, plan.oz, plan.oy = hash(plan.seed, 1) * 4096 + 0.37, hash(plan.seed, 2) * 4096 + 0.61, hash(plan.seed, 3) * 64 + 0.13
	plan.mx, plan.mz = hash(plan.seed, 4) * 4096 + 0.29, hash(plan.seed, 5) * 4096 + 0.83
	if args.noise ~= nil then
		local n = V.fields(args.noise, {"type", "octaves", "frequency", "amplitude", "persistence"}, "terrain noise")
		local kind = if n.type == nil then "fbm" else n.type
		if kind ~= "fbm" and kind ~= "ridged" then V.fail("INPUT", "Noise type must be fbm or ridged.") end
		plan.noise = {type = kind, octaves = V.integer(if n.octaves == nil then 5 else n.octaves, 1, L.octaves, "octaves"),
			frequency = V.number(if n.frequency == nil then 4 else n.frequency, 0.1, 100, "frequency"),
			amplitude = V.number(if n.amplitude == nil then 24 else n.amplitude, 0, L.height, "amplitude"),
			persistence = optional(n.persistence, 0.2, 0.8, "persistence", 0.5)}
	end
	plan.edge = optional(args.edge, 0, 1024, "edge", 0)
	plan.snowLine = optional(args.snowLine, 0, L.height, "snowLine")
	plan.features = {}
	if args.features ~= nil then
		for _, raw in ipairs(V.list(args.features, L.features, "terrain features")) do table.insert(plan.features, feature(raw, L)) end
	end
	local rules, fallback, deep = nil, "Grass", "Rock"
	if args.materials ~= nil then
		local m = V.fields(args.materials, {"rules", "fallback", "deep"}, "terrain materials")
		if m.rules ~= nil then
			rules = {}
			for _, raw in ipairs(V.list(m.rules, L.rules, "material rules")) do table.insert(rules, rule(raw, L)) end
		end
		fallback = material(m.fallback, "fallback material", fallback) :: string
		deep = material(m.deep, "deep material", deep) :: string
	end
	plan.rules, plan.fallback, plan.deep = rules or defaultRules(plan.snowLine), fallback, deep
	return plan
end

-- Fractal noise in [-1, 1]: fBm sums octaves, ridged folds each octave into sharp crests.
function TerrainGen.noise(plan: any, x: number, z: number): number
	local n = plan.noise
	local frequency, amplitude, sum, total = n.frequency / 1000, 1, 0, 0
	for octave = 1, n.octaves do
		local value = math.noise(x * frequency + plan.ox + octave * 31.71, z * frequency + plan.oz - octave * 17.29, plan.oy + octave * 0.618)
		if n.type == "ridged" then
			local crest = 1 - math.min(1, math.abs(value) * 2)
			value = crest * crest * 2 - 1
		else
			value = clamp(value * 2, -1, 1)
		end
		sum += value * amplitude
		total += amplitude
		amplitude *= n.persistence
		frequency *= 2
	end
	return sum / total
end

local function detail(plan: any, x: number, z: number, scale: number, salt: number): number
	return clamp(math.noise(x / scale + plan.mx + salt * 7.13, z / scale + plan.mz - salt * 3.71, plan.oy + salt) * 2, -1, 1)
end

-- Column grid helpers: column i covers [x0 + ix*4, x0 + ix*4 + 4] with its centre sample.
local function columnRange(plan: any, low: number, high: number, origin: number, count: number): (number, number)
	return math.max(0, math.ceil((low - origin) / VOXEL - 0.5)), math.min(count - 1, math.floor((high - origin) / VOXEL - 0.5))
end
local function each(plan: any, cx: number, cz: number, reach: number, fn: (number, number, number) -> ()): ()
	local ix0, ix1 = columnRange(plan, cx - reach, cx + reach, plan.x0, plan.nx)
	local iz0, iz1 = columnRange(plan, cz - reach, cz + reach, plan.z0, plan.nz)
	for iz = iz0, iz1 do
		local z = plan.z0 + (iz + 0.5) * VOXEL
		for ix = ix0, ix1 do fn(iz * plan.nx + ix + 1, plan.x0 + (ix + 0.5) * VOXEL, z) end
	end
end
local function sample(plan: any, grid: {number}, x: number, z: number): number
	local fx = clamp((x - plan.x0) / VOXEL - 0.5, 0, plan.nx - 1)
	local fz = clamp((z - plan.z0) / VOXEL - 0.5, 0, plan.nz - 1)
	local ix, iz = math.floor(fx), math.floor(fz)
	local ix1, iz1 = math.min(ix + 1, plan.nx - 1), math.min(iz + 1, plan.nz - 1)
	local tx, tz = fx - ix, fz - iz
	local a = lerp(grid[iz * plan.nx + ix + 1], grid[iz * plan.nx + ix1 + 1], tx)
	local b = lerp(grid[iz1 * plan.nx + ix + 1], grid[iz1 * plan.nx + ix1 + 1], tx)
	return lerp(a, b, tz)
end
local function nearest(points: {{number}}, x: number, z: number): (number, number, number)
	local best, bx, bz = math.huge, points[1][1], points[1][2]
	for index = 1, #points - 1 do
		local a, b = points[index], points[index + 1]
		local dx, dz = b[1] - a[1], b[2] - a[2]
		local length = dx * dx + dz * dz
		local t = if length > 0 then clamp(((x - a[1]) * dx + (z - a[2]) * dz) / length, 0, 1) else 0
		local px, pz = a[1] + dx * t, a[2] + dz * t
		local d = (x - px) ^ 2 + (z - pz) ^ 2
		if d < best then best, bx, bz = d, px, pz end
	end
	return math.sqrt(best), bx, bz
end

local function applyFeature(plan: any, f: any, h: {number}, water: {number}, bed: {[number]: string}, override: {[number]: string}): ()
	local kind = f.kind
	if kind == "river" or kind == "path" then
		local before = table.clone(h)
		local core = f.width / 2
		local reach = core + f.bank
		local lowX, highX, lowZ, highZ = math.huge, -math.huge, math.huge, -math.huge
		for _, p in ipairs(f.points) do
			lowX, highX, lowZ, highZ = math.min(lowX, p[1]), math.max(highX, p[1]), math.min(lowZ, p[2]), math.max(highZ, p[2])
		end
		local cx, cz = (lowX + highX) / 2, (lowZ + highZ) / 2
		each(plan, cx, cz, math.max(highX - lowX, highZ - lowZ) / 2 + reach, function(i: number, x: number, z: number)
			local d, px, pz = nearest(f.points, x, z)
			if d > reach then return end
			-- Level cross-sections: carve toward the centreline ground, minus depth.
			local ground = sample(plan, before, px, pz)
			local weight = if d <= core then 1 else 1 - smoothstep((d - core) / math.max(f.bank, 1e-6))
			h[i] = lerp(h[i], ground - f.depth, weight)
			if d <= core then override[i] = f.material end
			if kind == "river" then
				local level = ground - f.depth * 0.3
				if h[i] < level and level > water[i] then water[i] = level; bed[i] = f.material end
			end
		end)
		return
	end
	local cx, cz, r = f.center[1], f.center[2], f.radius
	if kind == "lake" then
		local rim = f.level + 1
		each(plan, cx, cz, r * 1.5, function(i: number, x: number, z: number)
			local t = math.sqrt((x - cx) ^ 2 + (z - cz) ^ 2) / r
			if t < 1 then
				h[i] = math.min(h[i], f.level - f.depth * (1 - t * t))
				if h[i] < f.level and f.level > water[i] then water[i] = f.level; bed[i] = f.material end
			elseif t < 1.5 then
				h[i] = math.max(h[i], lerp(rim, h[i], smoothstep((t - 1) / 0.5)))
			end
		end)
	elseif kind == "plateau" or kind == "flatten" then
		local level = f.level or sample(plan, h, cx, cz)
		local blend = math.max(f.blend, 1e-6)
		local before = h
		if kind == "plateau" then before = table.clone(h) end
		each(plan, cx, cz, r * 1.2 + blend, function(i: number, x: number, z: number)
			local d = math.sqrt((x - cx) ^ 2 + (z - cz) ^ 2)
			-- Plateaus get an irregular, natural outline; flatten circles stay exact for focal pads.
			local edge = if kind == "plateau" then r * (1 + 0.12 * detail(plan, x, z, 40, 11)) else r
			local weight = if d <= edge then 1 else 1 - smoothstep((d - edge) / blend)
			if weight <= 0 then return end
			h[i] = lerp(before[i], level, weight)
			if f.material and d <= edge then override[i] = f.material end
			if kind == "flatten" and d <= edge then water[i] = -1 end
		end)
	else
		each(plan, cx, cz, r * 2 + 8, function(i: number, x: number, z: number)
			local d = math.sqrt((x - cx) ^ 2 + (z - cz) ^ 2)
			local t = d / (r * (1 + 0.1 * detail(plan, x, z, 48, 5)))
			if kind == "crater" then
				if t < 1 then h[i] -= f.height * (1 - t * t) end
				h[i] += f.height * 0.3 * math.exp(-((t - 1) / 0.25) ^ 2)
			elseif t < 1 then
				if kind == "hill" then h[i] += f.height * (1 - t * t) ^ 2
				elseif kind == "valley" then h[i] -= f.height * (1 - t * t) ^ 2
				else
					local ridge = (1 - math.abs(detail(plan, x, z, 36, 9))) ^ 2
					h[i] += f.height * (1 - t) ^ 1.6 * (1 - f.roughness * 0.5 + f.roughness * ridge)
				end
			end
		end)
	end
end

-- Chamfer distance (studs) from every column to the nearest water column, capped at WATER_REACH.
local function waterDistance(plan: any, water: {number}, h: {number}): {number}
	local nx, nz = plan.nx, plan.nz
	local d = table.create(nx * nz, WATER_REACH)
	for i = 1, nx * nz do if water[i] > h[i] then d[i] = 0 end end
	local diagonal = VOXEL * math.sqrt(2)
	for iz = 0, nz - 1 do
		for ix = 0, nx - 1 do
			local i = iz * nx + ix + 1
			local best = d[i]
			if ix > 0 then best = math.min(best, d[i - 1] + VOXEL) end
			if iz > 0 then
				best = math.min(best, d[i - nx] + VOXEL)
				if ix > 0 then best = math.min(best, d[i - nx - 1] + diagonal) end
				if ix < nx - 1 then best = math.min(best, d[i - nx + 1] + diagonal) end
			end
			d[i] = best
		end
	end
	for iz = nz - 1, 0, -1 do
		for ix = nx - 1, 0, -1 do
			local i = iz * nx + ix + 1
			local best = d[i]
			if ix < nx - 1 then best = math.min(best, d[i + 1] + VOXEL) end
			if iz < nz - 1 then
				best = math.min(best, d[i + nx] + VOXEL)
				if ix < nx - 1 then best = math.min(best, d[i + nx + 1] + diagonal) end
				if ix > 0 then best = math.min(best, d[i + nx - 1] + diagonal) end
			end
			d[i] = best
		end
	end
	return d
end

function TerrainGen.matches(r: any, height: number, slope: number, noise: number, near: number): boolean
	return (r.minHeight == nil or height >= r.minHeight) and (r.maxHeight == nil or height <= r.maxHeight)
		and (r.minSlope == nil or slope >= r.minSlope) and (r.maxSlope == nil or slope <= r.maxSlope)
		and (r.minNoise == nil or noise >= r.minNoise) and (r.maxNoise == nil or noise <= r.maxNoise)
		and (r.nearWater == nil or (near > 0 and near < WATER_REACH and near <= r.nearWater))
end

-- Heightfield (studs above floor), water surface levels (-1 = dry), slopes (degrees) and surface materials.
-- slice (optional) is called once per row with that row's column count: the caller may yield there.
function TerrainGen.field(plan: any, slice: ((number?) -> ())?): any
	local nx, nz = plan.nx, plan.nz
	local count = nx * nz
	local h = table.create(count, plan.baseHeight)
	local water = table.create(count, -1)
	local bed: {[number]: string} = {}
	local override: {[number]: string} = {}
	if plan.noise and plan.noise.amplitude > 0 then
		local width, depth = nx * VOXEL, nz * VOXEL
		for iz = 0, nz - 1 do
			if slice then slice(1 + nx) end
			local z = plan.z0 + (iz + 0.5) * VOXEL
			for ix = 0, nx - 1 do
				local x = plan.x0 + (ix + 0.5) * VOXEL
				local weight = 1
				if plan.edge > 0 then
					local border = math.min((ix + 0.5) * VOXEL, width - (ix + 0.5) * VOXEL, (iz + 0.5) * VOXEL, depth - (iz + 0.5) * VOXEL)
					weight = smoothstep(border / plan.edge)
				end
				h[iz * nx + ix + 1] += TerrainGen.noise(plan, x, z) * plan.noise.amplitude * weight
			end
		end
	end
	for _, f in ipairs(plan.features) do applyFeature(plan, f, h, water, bed, override) end
	local low, high, wet = math.huge, -math.huge, 0
	for i = 1, count do
		h[i] = clamp(h[i], 0, plan.height)
		if water[i] > plan.height then water[i] = plan.height end
		if water[i] <= h[i] then water[i] = -1 else wet += 1 end
		low, high = math.min(low, h[i]), math.max(high, h[i])
	end
	local slope = table.create(count, 0)
	for iz = 0, nz - 1 do
		if slice then slice(1 + nx) end
		for ix = 0, nx - 1 do
			local i = iz * nx + ix + 1
			local left, right = if ix > 0 then i - 1 else i, if ix < nx - 1 then i + 1 else i
			local up, down = if iz > 0 then i - nx else i, if iz < nz - 1 then i + nx else i
			local gx = (h[right] - h[left]) / (math.max(1, (if ix > 0 then 1 else 0) + (if ix < nx - 1 then 1 else 0)) * VOXEL)
			local gz = (h[down] - h[up]) / (math.max(1, (if iz > 0 then 1 else 0) + (if iz < nz - 1 then 1 else 0)) * VOXEL)
			slope[i] = math.deg(math.atan(math.sqrt(gx * gx + gz * gz)))
		end
	end
	local near = waterDistance(plan, water, h)
	local materials = table.create(count, plan.fallback)
	for iz = 0, nz - 1 do
		if slice then slice(1 + nx) end
		local z = plan.z0 + (iz + 0.5) * VOXEL
		for ix = 0, nx - 1 do
			local i = iz * nx + ix + 1
			if water[i] > h[i] then
				materials[i] = override[i] or bed[i] or "Mud"
			elseif override[i] then
				materials[i] = override[i]
			else
				local noise = detail(plan, plan.x0 + (ix + 0.5) * VOXEL, z, 48, 1)
				for _, r in ipairs(plan.rules) do
					if TerrainGen.matches(r, h[i], slope[i], noise, near[i]) then materials[i] = r.material; break end
				end
			end
		end
	end
	return {heights = h, water = water, slope = slope, near = near, materials = materials, low = low, high = high, wet = wet}
end

-- One chunk's [x][y][z] material/occupancy arrays. Solid voxels more than DEEP_BELOW studs under
-- the surface use the deep material so cliff faces read as rock.
-- slice (optional) is the cooperative yield point between x-slices of a large chunk.
function TerrainGen.chunk(plan: any, field: any, ix0: number, iz0: number, width: number, depth: number, resolve: (string) -> any, slice: ((number?) -> ())?): (any, any)
	local ny, nx = plan.ny, plan.nx
	local air, waterMaterial, deep = resolve("Air"), resolve("Water"), resolve(plan.deep)
	local cache: {[string]: any} = {}
	local materials, occupancies = table.create(width), table.create(width)
	for x = 1, width do
		local mx, ox = table.create(ny), table.create(ny)
		for y = 1, ny do mx[y] = table.create(depth, air); ox[y] = table.create(depth, 0) end
		for z = 1, depth do
			local i = (iz0 + z - 1) * nx + ix0 + x
			local surface, level = field.heights[i], field.water[i]
			local name = field.materials[i]
			local top = cache[name]
			if top == nil then top = resolve(name); cache[name] = top end
			for y = 1, ny do
				local bottom = (y - 1) * VOXEL
				local fill = (surface - bottom) / VOXEL
				if fill >= 1 then
					mx[y][z] = if surface - bottom - VOXEL > DEEP_BELOW then deep else top
					ox[y][z] = 1
				elseif fill > 0 then
					mx[y][z] = top
					ox[y][z] = fill
				elseif level > bottom then
					mx[y][z] = waterMaterial
					ox[y][z] = math.min(1, (level - bottom) / VOXEL)
				else
					break
				end
			end
		end
		materials[x], occupancies[x] = mx, ox
		if slice then slice(1 + depth * ny // 1024) end
	end
	return materials, occupancies
end

-- Writes the whole region in bounded chunks (each <= LIMITS.chunkVoxels), yielding between chunks.
-- engine.write(min {x,y,z}, max {x,y,z}, materials, occupancies); engine.resolve(name); engine.yield().
function TerrainGen.write(plan: any, field: any, engine: any): number
	local C = TerrainGen.LIMITS.chunkColumns
	local chunks = 0
	for iz = 0, plan.nz - 1, C do
		for ix = 0, plan.nx - 1, C do
			local width, depth = math.min(C, plan.nx - ix), math.min(C, plan.nz - iz)
			if width * depth * plan.ny > TerrainGen.LIMITS.chunkVoxels then V.fail("BODY_LIMIT", "Terrain chunk exceeds the voxel budget.") end
			local materials, occupancies = TerrainGen.chunk(plan, field, ix, iz, width, depth, engine.resolve, engine.slice)
			local low = {plan.x0 + ix * VOXEL, plan.y0, plan.z0 + iz * VOXEL}
			engine.write(low, {low[1] + width * VOXEL, plan.y0 + plan.ny * VOXEL, low[3] + depth * VOXEL}, materials, occupancies)
			chunks += 1
			engine.yield()
		end
	end
	return chunks
end

-- Compact receipt summary: snapped region, counts and the surface material histogram.
function TerrainGen.summary(plan: any, field: any, chunks: number): any
	local surface: {[string]: number} = {}
	for i = 1, plan.nx * plan.nz do
		if field.water[i] <= field.heights[i] then surface[field.materials[i]] = (surface[field.materials[i]] or 0) + 1 end
	end
	local function hundredth(value: number): number return round(value * 100) / 100 end
	return {region = {origin = V.array({plan.x0, plan.y0, plan.z0}), size = V.array({plan.nx * VOXEL, plan.ny * VOXEL, plan.nz * VOXEL})},
		voxels = plan.voxels, chunks = chunks, seed = plan.seed, features = #plan.features, waterColumns = field.wet,
		surfaceRange = V.array({hundredth(field.low), hundredth(field.high)}), surface = surface}
end

return table.freeze(TerrainGen)
