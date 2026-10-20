--!strict
--[[
MIT License
Copyright (c) 2026 Arcane contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
]]
-- Original client-only particle playback. The effect seed belongs to authored assets;
-- native ParticleEmitter random motion is not a deterministic preview replay.

export type Handle = {
	Cancel: (self: Handle) -> (),
	IsFinished: (self: Handle) -> boolean,
	GetError: (self: Handle) -> string?,
}
type Curve = {{number}}
type Layer = {
	id: string, start: number, duration: number, burst: number, rate: number,
	life: {number}, speed: {number}, spread: number, position: {number}, acceleration: {number},
	drag: number, texture: string, blend: string, color: {number}, size: Curve, alpha: Curve,
}
type Effect = {layers: {Layer}, peak: number, total: number, deadline: number}
type Playback = {layer: Layer, emitter: ParticleEmitter, sent: number}
type Batch = {count: number, expires: number}

local Runtime = {}
local MAX_ACTIVE = 24
local MAX_RESERVED_PEAK = 6000
local EPSILON = 1e-9
local active = 0
local reservedPeak = 0
local TEXTURES = {flare = true, ring = true, smoke = true, spark = true}

local function refuse(message: string): never
	error("Arcane VFX: " .. message, 3)
end

local function record(value: any, allowed: {[string]: boolean}, label: string): {[string]: any}
	if type(value) ~= "table" or getmetatable(value) ~= nil then refuse(label .. " must be a plain table") end
	for key in pairs(value) do
		if type(key) ~= "string" or not allowed[key] then refuse(label .. " has an unsupported field") end
	end
	return value
end

local function array(value: any, minimum: number, maximum: number, label: string): {any}
	if type(value) ~= "table" or getmetatable(value) ~= nil then refuse(label .. " must be an array") end
	local count = #value
	if count < minimum or count > maximum then refuse(label .. " has an invalid length") end
	for key in pairs(value) do
		if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > count then refuse(label .. " must be dense") end
	end
	for index = 1, count do if rawget(value, index) == nil then refuse(label .. " must be dense") end end
	return value
end

local function number(value: any, minimum: number, maximum: number, label: string): number
	if type(value) ~= "number" or value ~= value or value < minimum or value > maximum then refuse(label .. " is outside its finite range") end
	return value
end

local function integer(value: any, minimum: number, maximum: number, label: string): number
	local result = number(value, minimum, maximum, label)
	if result % 1 ~= 0 then refuse(label .. " must be an integer") end
	return result
end

local function name(value: any, label: string): string
	if type(value) ~= "string" or #value < 1 or #value > 48 or not string.match(value, "^[a-z][a-z0-9-]*$") then refuse(label .. " is invalid") end
	return value
end

local function vector(value: any, maximum: number, label: string, minimum: number?): {number}
	local input, result = array(value, 3, 3, label), {}
	for index = 1, 3 do result[index] = number(input[index], minimum or -maximum, maximum, label) end
	return result
end

local function range(value: any, minimum: number, maximum: number, label: string): {number}
	local input = array(value, 2, 2, label)
	local low, high = number(input[1], minimum, maximum, label), number(input[2], minimum, maximum, label)
	if low > high then refuse(label .. " is reversed") end
	return {low, high}
end

local function curve(value: any, maximum: number, label: string): Curve
	local input, output, previous = array(value, 2, 8, label), {}, -1
	for index, raw in ipairs(input) do
		local pair = array(raw, 2, 2, label)
		local age, magnitude = number(pair[1], 0, 1, label), number(pair[2], 0, maximum, label)
		if age <= previous then refuse(label .. " ages must increase") end
		output[index], previous = {age, magnitude}, age
	end
	if output[1][1] ~= 0 or output[#output][1] ~= 1 then refuse(label .. " requires ages 0 and 1") end
	return output
end

local function validate(effect: any, textureIDs: any): (Effect, {[string]: string})
	local input = record(effect, {version=true, name=true, seed=true, duration=true, layers=true, budgets=true}, "effect")
	if input.version ~= 1 then refuse("unsupported effect version") end
	name(input.name, "effect name")
	integer(input.seed, 0, 2147483647, "seed")
	local duration = number(input.duration, 0.05, 15, "effect duration")
	local budgets = if input.budgets == nil then {} else record(input.budgets, {peakParticles=true, totalParticles=true, textureMiB=true}, "budgets")
	local peakLimit = integer(if budgets.peakParticles == nil then 600 else budgets.peakParticles, 1, 2000, "peakParticles")
	local totalLimit = integer(if budgets.totalParticles == nil then 2048 else budgets.totalParticles, 1, 4096, "totalParticles")
	integer(if budgets.textureMiB == nil then 16 else budgets.textureMiB, 1, 64, "textureMiB")
	local layers: {Layer} = {}
	local identities: {[string]: boolean} = {}
	local peak, total, deadline = 0, 0, 0
	for _, raw in ipairs(array(input.layers, 1, 8, "layers")) do
		local row = record(raw, {id=true, kind=true, start=true, duration=true, burst=true, rate=true, life=true, speed=true, spread=true, position=true, acceleration=true, drag=true, texture=true, blend=true, color=true, size=true, alpha=true}, "layer")
		if row.kind ~= nil and row.kind ~= "particles" then refuse("only particle layers are supported") end
		local id = name(row.id, "layer id")
		if identities[id] then refuse("duplicate layer id") end
		identities[id] = true
		local start, span = number(row.start, 0, 15, "layer start"), number(row.duration, 0, 15, "layer duration")
		if start + span > duration + EPSILON then refuse("layer window exceeds effect duration") end
		local burst, rate = integer(row.burst, 0, 4096, "burst"), number(row.rate, 0, 400, "rate")
		if burst + math.floor(rate * span + EPSILON) == 0 then refuse("empty particle layer") end
		local life = range(row.life, 0.01, 20, "life")
		if type(row.texture) ~= "string" or not TEXTURES[row.texture] then refuse("unknown generated texture") end
		if row.blend ~= "alpha" and row.blend ~= "add" then refuse("unsupported blend") end
		local layer: Layer = {
			id=id, start=start, duration=span, burst=burst, rate=rate, life=life,
			speed=range(row.speed, 0, 200, "speed"), spread=number(row.spread, 0, 180, "spread"),
			position=vector(row.position, 10000, "position"), acceleration=vector(row.acceleration, 1000, "acceleration"),
			drag=number(row.drag, 0, 10, "drag"), texture=row.texture, blend=row.blend,
			color=vector(row.color, 1, "color", 0), size=curve(row.size, 100, "size"), alpha=curve(row.alpha, 1, "alpha"),
		}
		table.insert(layers, layer)
		peak += burst + math.ceil(rate * math.min(span, life[2]))
		total += burst + math.floor(rate * span + EPSILON)
		deadline = math.max(deadline, start + span + life[2])
	end
	if total == 0 then refuse("effect emits no particles") end
	if total > totalLimit or peak > peakLimit then refuse("authored particle budget exceeded") end
	local mapping = record(textureIDs, TEXTURES, "textureIDs")
	local textures: {[string]: string} = {}
	for key, value in pairs(mapping) do
		if type(value) ~= "string" or #value > 33 or not string.match(value, "^rbxassetid://[1-9][0-9]*$") then refuse("texture IDs must be positive numeric rbxassetid strings") end
		textures[key] = value
	end
	for _, layer in ipairs(layers) do if textures[layer.texture] == nil then refuse("missing texture ID: " .. layer.texture) end end
	return {layers=layers, peak=peakLimit, total=total, deadline=deadline}, textures
end

local function sequence(keys: Curve, invert: boolean): NumberSequence
	local points = {}
	for index, pair in ipairs(keys) do points[index] = NumberSequenceKeypoint.new(pair[1], if invert then 1 - pair[2] else pair[2], 0) end
	return NumberSequence.new(points)
end

function Runtime.play(parent: Instance, origin: CFrame, effect: any, textureIDs: {[string]: string}): Handle
	-- Validate and detach caller-owned data before the first Instance.new.
	local spec, textures = validate(effect, textureIDs)
	if typeof(parent) ~= "Instance" or not parent:IsDescendantOf(game) then refuse("parent must be in the current DataModel") end
	if typeof(origin) ~= "CFrame" then refuse("origin must be a CFrame") end
	local components = {origin:GetComponents()}
	for index, value in ipairs(components) do number(value, if index <= 3 then -1000000 else -1, if index <= 3 then 1000000 else 1, "origin") end
	local service = game:GetService("RunService")
	if not service:IsClient() then refuse("playback requires a client") end
	if active >= MAX_ACTIVE then refuse("24 active effects already admitted") end
	if reservedPeak + spec.peak > MAX_RESERVED_PEAK then refuse("6000 reserved live-particle capacity already admitted") end
	active += 1
	reservedPeak += spec.peak
	local host: Part? = nil
	local playback: {Playback}, batches: {Batch}, connections: {RBXScriptConnection} = {}, {}, {}
	local elapsed, sent, lastExpiry = 0, 0, 0
	local finished, failure = false, nil :: string?
	local function finish(reason: string?): ()
		if finished then return end
		finished, failure = true, reason
		active -= 1
		reservedPeak -= spec.peak
		for _, connection in ipairs(connections) do pcall(function() connection:Disconnect() end) end
		table.clear(connections)
		for _, item in ipairs(playback) do
			pcall(function() item.emitter.Enabled = false; item.emitter:Clear() end)
		end
		table.clear(batches)
		local owned = host
		if owned then pcall(function() owned:Destroy() end) end
	end
	local function update(delta: number): ()
		if finished then return end
		number(delta, 0, 1000000, "frame delta")
		elapsed += delta
		if not parent:IsDescendantOf(game) or host == nil or host.Parent ~= parent then finish("effect parent or host was removed"); return end
		-- Expired undelivered events are an explicit playback failure, never silent thinning.
		if sent < spec.total and elapsed > spec.deadline then refuse("schedule expired during a frame stall") end
		local live, retained = 0, {}
		for _, batch in ipairs(batches) do
			if batch.expires > elapsed then live += batch.count; table.insert(retained, batch) end
		end
		batches = retained
		local due, sum = {}, 0
		for index, item in ipairs(playback) do
			local layer = item.layer
			local target = if elapsed < layer.start then 0 else layer.burst + math.floor(layer.rate * math.min(elapsed - layer.start, layer.duration) + EPSILON)
			local count = target - item.sent
			due[index], sum = count, sum + count
		end
		if live + sum > spec.peak then refuse("frame-stall catch-up exceeds the live particle budget") end
		-- Decide the entire frame's budget before performing any native emission.
		for index, item in ipairs(playback) do
			local count = due[index]
			if count > 0 then
				item.emitter:Emit(count)
				item.sent += count
				sent += count
				local expiry = elapsed + item.layer.life[2]
				table.insert(batches, {count=count, expires=expiry})
				lastExpiry = math.max(lastExpiry, expiry)
			end
		end
		if sent == spec.total and elapsed >= lastExpiry then finish(nil) end
	end
	local ok, message = pcall(function()
		local owned = Instance.new("Part")
		host = owned
		owned.Name = "ArcaneVFX"
		owned.Anchored, owned.Transparency = true, 1
		owned.CanCollide, owned.CanTouch, owned.CanQuery, owned.CastShadow = false, false, false, false
		owned.Size, owned.CFrame = Vector3.new(0.1, 0.1, 0.1), origin
		for _, layer in ipairs(spec.layers) do
			local attachment = Instance.new("Attachment")
			attachment.Parent = owned
			attachment.Name, attachment.Position = layer.id, Vector3.new(layer.position[1], layer.position[2], layer.position[3])
			local emitter = Instance.new("ParticleEmitter")
			emitter.Parent = attachment
			table.insert(playback, {layer=layer, emitter=emitter, sent=0})
			emitter.Name, emitter.Enabled, emitter.Rate = layer.id, false, 0
			emitter.Texture = textures[layer.texture]
			emitter.FlipbookLayout, emitter.FlipbookMode = Enum.ParticleFlipbookLayout.Grid4x4, Enum.ParticleFlipbookMode.OneShot
			emitter.FlipbookStartRandom, emitter.FlipbookBlendFrames = false, true
			emitter.Lifetime, emitter.Speed = NumberRange.new(layer.life[1], layer.life[2]), NumberRange.new(layer.speed[1], layer.speed[2])
			emitter.SpreadAngle, emitter.EmissionDirection = Vector2.new(layer.spread, layer.spread), Enum.NormalId.Top
			emitter.Acceleration = origin:VectorToWorldSpace(Vector3.new(layer.acceleration[1], layer.acceleration[2], layer.acceleration[3]))
			emitter.Drag, emitter.VelocityInheritance, emitter.LockedToPart, emitter.WindAffectsDrag = layer.drag, 0, false, false
			emitter.Color = ColorSequence.new(Color3.new(layer.color[1], layer.color[2], layer.color[3]))
			emitter.Size, emitter.Transparency = sequence(layer.size, false), sequence(layer.alpha, true)
			emitter.LightEmission, emitter.LightInfluence = if layer.blend == "add" then 1 else 0, 0
		end
		owned.Parent = parent
		table.insert(connections, parent.AncestryChanged:Connect(function()
			local current, present = pcall(function() return parent:IsDescendantOf(game) end)
			if not current or not present then finish("effect parent was removed") end
		end))
		update(0)
		if not finished then
			table.insert(connections, service.Heartbeat:Connect(function(delta: number)
				if finished then return end
				local success, reason = pcall(update, delta)
				if not success then
					finish(tostring(reason))
					warn("Arcane VFX playback cancelled: " .. tostring(reason))
				end
			end))
		end
	end)
	if not ok then finish(tostring(message)); error(message, 2) end
	local handle: Handle = {
		Cancel=function(_self: Handle): () finish(nil) end,
		IsFinished=function(_self: Handle): boolean return finished end,
		GetError=function(_self: Handle): string? return failure end,
	}
	return table.freeze(handle)
end

return table.freeze(Runtime)
