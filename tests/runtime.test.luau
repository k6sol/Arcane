--!strict
-- A preparation helper replaces the single RUNTIME_UNDER_TEST line with the
-- byte-exact Runtime.luau in a lexical wrapper. No production injection API is added.
local realTypeof = typeof
local allocated = 0
local signalConnections = 0
local now = 0
local created: {any} = {}
local warnings: {string} = {}
local propertyFailure: string? = nil
local emitFailure = false
local client = true

local function signal(): any
	local entries = {}
	local result: any = {}
	function result:Connect(callback: (...any) -> ()): any
		local entry: any = {Connected=true, callback=callback}
		function entry:Disconnect(): ()
			if self.Connected then self.Connected=false; signalConnections -= 1 end
		end
		signalConnections += 1
		table.insert(entries, entry)
		return entry
	end
	function result:Fire(...: any): ()
		for _, entry in ipairs(table.clone(entries)) do if entry.Connected then entry.callback(...) end end
	end
	function result:Count(): number
		local count = 0
		for _, entry in ipairs(entries) do if entry.Connected then count += 1 end end
		return count
	end
	function result:LastCallback(): any return entries[#entries].callback end
	return result
end

local methods: {[string]: any} = {}
local function ancestry(instance: any): ()
	instance.AncestryChanged:Fire(instance, instance.Parent)
	for _, child in ipairs(table.clone(instance._children)) do ancestry(child) end
end
local function setParent(instance: any, parent: any): ()
	local previous = instance._props.Parent
	if previous == parent then return end
	if previous then
		local found = table.find(previous._children, instance)
		if found then table.remove(previous._children, found) end
	end
	instance._props.Parent = parent
	if parent then table.insert(parent._children, instance) end
	ancestry(instance)
end
local fakeMeta = {
	__index=function(self: any, key: string): any
		if methods[key] then return methods[key] end
		if key == "ClassName" then return self._class end
		return self._props[key]
	end,
	__newindex=function(self: any, key: string, value: any): ()
		if key == propertyFailure then error("fake property setup failure") end
		if key == "Parent" then setParent(self, value) else self._props[key]=value end
	end,
}
local Instance: any = {}
function Instance.new(class: string): any
	allocated += 1
	local instance: any = setmetatable({_class=class, _props={}, _children={}, _destroyed=false, _emitted=0, _cleared=0, _emissions={}, AncestryChanged=signal()}, fakeMeta)
	table.insert(created, instance)
	return instance
end
function methods:IsDescendantOf(ancestor: any): boolean
	local node = self.Parent
	while node do if node == ancestor then return true end; node=node.Parent end
	return false
end
function methods:Destroy(): ()
	if self._destroyed then return end
	self._destroyed = true
	for _, child in ipairs(table.clone(self._children)) do child:Destroy() end
	setParent(self, nil)
end
function methods:Emit(count: number): ()
	assert(self._class == "ParticleEmitter" and not self._destroyed)
	assert(self.Enabled == false and self.Rate == 0, "native automatic emission must stay disabled")
	assert(count > 0 and count % 1 == 0)
	if emitFailure then error("fake Emit failure") end
	self._emitted += count
	table.insert(self._emissions, {count=count, at=now})
end
function methods:Clear(): () self._cleared += 1 end

local game: any = Instance.new("DataModel")
local workspace: any = Instance.new("Workspace")
workspace.Parent = game
local heartbeat = signal()
local runService: any = {Heartbeat=heartbeat, IsClient=function(_self: any): boolean return client end}
function game:GetService(name: string): any
	if name == "RunService" then return runService end
	if name == "Workspace" then return workspace end
	error("Unexpected service access: " .. name)
end
local function typeof(value: any): string
	if type(value) == "table" and rawget(value, "_class") then return "Instance" end
	if type(value) == "table" and rawget(value, "_tag") then return value._tag end
	return realTypeof(value)
end
local Vector3: any = {new=function(x: number, y: number, z: number): any return {X=x, Y=y, Z=z, _tag="Vector3"} end}
local Vector2: any = {new=function(x: number, y: number): any return {X=x, Y=y, _tag="Vector2"} end}
local CFrame: any = {}
function CFrame.new(x: number?, y: number?, z: number?): any
	local result: any = {_tag="CFrame", x=x or 0, y=y or 0, z=z or 0}
	function result:GetComponents(): ...number return self.x, self.y, self.z, 1, 0, 0, 0, 1, 0, 0, 0, 1 end
	function result:VectorToWorldSpace(value: any): any return value end
	return result
end
local NumberRange: any = {new=function(low: number, high: number?): any return {Min=low, Max=high or low} end}
local NumberSequenceKeypoint: any = {new=function(time: number, value: number, envelope: number?): any return {Time=time, Value=value, Envelope=envelope or 0} end}
local NumberSequence: any = {new=function(points: {any}): any return {Keypoints=points} end}
local Color3: any = {new=function(r: number, g: number, b: number): any return {R=r, G=g, B=b} end}
local ColorSequence: any = {new=function(color: any): any return {Color=color} end}
local Enum: any = {ParticleFlipbookLayout={Grid4x4="Grid4x4"}, ParticleFlipbookMode={OneShot="OneShot"}, NormalId={Top="Top"}}
local function warn(message: string): () table.insert(warnings, message) end

local Runtime = nil :: any -- RUNTIME_UNDER_TEST

local tests = 0
local function same(actual: any, expected: any, label: string?): ()
	assert(actual == expected, (label or "value") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual))
end
local function near(actual: number, expected: number): () assert(math.abs(actual-expected)<1e-8) end
local function copy(value: any): any
	if type(value) ~= "table" then return value end
	local out = {}
	for key, child in pairs(value) do out[key]=copy(child) end
	return out
end
local function fixture(): any
	return {version=1, name="runtime-test", seed=37, duration=1, budgets={peakParticles=100, totalParticles=200, textureMiB=16}, layers={
		{id="sparks", start=0, duration=0.5, burst=2, rate=4, life={0.1,0.2}, speed={1,3}, spread=35, position={1,2,3}, acceleration={0,-4,0}, drag=0.5, texture="spark", blend="add", color={1,0.4,0.1}, size={{0,0.2},{1,0}}, alpha={{0,1},{1,0}}},
	}}
end
local textures = {spark="rbxassetid://12345"}
local function parent(): any local p=Instance.new("Folder"); p.Name="Unrelated user parent"; p.Parent=workspace; return p end
local function advance(delta: number): () now += delta; heartbeat:Fire(delta) end
local function emitters(start: number): {any}
	local out = {}
	for index=start+1,#created do if created[index].ClassName=="ParticleEmitter" then table.insert(out,created[index]) end end
	return out
end
local function total(items: {any}): number local count=0; for _, item in ipairs(items) do count += item._emitted end; return count end
local function rejected(callback: () -> (), fragment: string): ()
	local before=allocated
	local ok, message=pcall(callback)
	assert(not ok and string.find(tostring(message),fragment,1,true), "Expected refusal: " .. fragment .. "; got " .. tostring(message))
	same(allocated,before,"refusal must precede Instance allocation")
end
local function test(name: string, callback: () -> ()): ()
	assert(signalConnections==0,"prior test leaked connections")
	now=0
	callback()
	assert(signalConnections==0,"test leaked connections: " .. name)
	tests += 1
	print("PASS " .. name)
end

test("native properties, cumulative counts, finite drain and no post-finish backlog", function()
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(2,4,6),fixture(),textures)
	local rows=emitters(first); same(#rows,1)
	local emitter=rows[1]
	same(emitter.Texture,"rbxassetid://12345"); same(emitter.FlipbookLayout,"Grid4x4"); same(emitter.FlipbookMode,"OneShot")
	same(emitter.FlipbookStartRandom,false); same(emitter.LightEmission,1)
	near(emitter.Color.Color.G,0.4); near(emitter.Size.Keypoints[1].Value,0.2)
	same(emitter.Transparency.Keypoints[1].Value,0); same(emitter.Transparency.Keypoints[2].Value,1)
	same(emitter.Parent.Position.Y,2); same(emitter.Parent.Parent.CFrame.z,6)
	same(total(rows),2); advance(0.25); same(total(rows),3); advance(0.25); same(total(rows),4)
	same(handle:IsFinished(),false); advance(0.19); same(handle:IsFinished(),false); advance(0.02)
	same(handle:IsFinished(),true); same(handle:GetError(),nil); same(#p._children,0); same(p._destroyed,false)
	same(emitter._destroyed,true); same(emitter._cleared,1)
	advance(10); same(total(rows),4); handle:Cancel(); same(emitter._cleared,1); p:Destroy()
end)

test("frame stalls preserve every due count when the full batch fits", function()
	local spec=fixture(); spec.duration=2; spec.layers[1].duration=2; spec.layers[1].burst=3; spec.layers[1].rate=10; spec.layers[1].life={1,1}
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),spec,textures); local rows=emitters(first)
	same(total(rows),3); advance(0.9); same(total(rows),12); advance(1.1); same(total(rows),23)
	same(handle:IsFinished(),false); advance(1); same(handle:IsFinished(),true); same(handle:GetError(),nil)
	advance(3); same(total(rows),23); p:Destroy()
end)

test("over-budget stalled batch cancels explicitly before any partial catch-up", function()
	local spec=fixture(); spec.duration=2; spec.layers[1].duration=2; spec.layers[1].burst=0; spec.layers[1].rate=10; spec.layers[1].life={0.1,0.1}; spec.budgets.peakParticles=1
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),spec,textures); local rows=emitters(first)
	advance(0.5); same(total(rows),0); same(handle:IsFinished(),true)
	assert(string.find(handle:GetError(),"live particle budget",1,true)); same(#p._children,0)
	handle:Cancel(); assert(handle:GetError()~=nil); advance(10); same(total(rows),0); p:Destroy()
end)

test("expired undelivered schedule is an error rather than a late emission flood", function()
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),fixture(),textures); local rows=emitters(first)
	advance(100); same(total(rows),2); same(handle:IsFinished(),true)
	assert(string.find(handle:GetError(),"schedule expired",1,true)); same(#p._children,0); p:Destroy()
end)

test("bad texture mapping and invalid data allocate nothing", function()
	local p=parent()
	for _, mapping in ipairs({{}, {spark="rbxassetid://YOUR_ID"}, {spark=12345}, {spark="rbxassetid://0"}, {spark="https://example.invalid/x"}, {spark="rbxassetid://12345", smoke="bad"}}) do
		rejected(function() Runtime.play(p,CFrame.new(),fixture(),mapping) end, "texture")
	end
	local mutations={
		function(s: any) s.seed=true end,
		function(s: any) s.layers[1].rate=0/0 end,
		function(s: any) s.layers[1].speed={3,1} end,
		function(s: any) s.layers[1].duration=2 end,
		function(s: any) s.layers[1].size={{0,1},{0,2},{1,0}} end,
		function(s: any) s.layers[1].kind="beam" end,
		function(s: any) s.layers[1].Source="ignored code" end,
		function(s: any) s.layers[2]=copy(s.layers[1]) end,
		function(s: any) s.layers[2]=copy(s.layers[1]); s.layers[2].id="valid"; s.layers[1].burst=0; s.layers[1].rate=1; s.layers[1].duration=0 end,
		function(s: any) s.budgets.peakParticles=1 end,
		function(s: any) s.budgets.totalParticles=1 end,
	}
	for _, mutate in ipairs(mutations) do
		local spec=fixture(); mutate(spec)
		rejected(function() Runtime.play(p,CFrame.new(),spec,textures) end,"Arcane VFX")
	end
	client=false; rejected(function() Runtime.play(p,CFrame.new(),fixture(),textures) end,"client"); client=true
	rejected(function() Runtime.play(p,CFrame.new(0/0,0,0),fixture(),textures) end,"origin")
	p.Parent=nil; rejected(function() Runtime.play(p,CFrame.new(),fixture(),textures) end,"parent"); p:Destroy()
end)

test("window comparison shares the normalizer's floating-point tolerance", function()
	local spec=fixture(); spec.duration=0.3; spec.layers[1].start=0.1; spec.layers[1].duration=0.2
	assert(spec.layers[1].start+spec.layers[1].duration>spec.duration)
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),spec,textures); local rows=emitters(first)
	advance(0.3); same(total(rows),2); advance(0.21); same(handle:IsFinished(),true); same(handle:GetError(),nil); p:Destroy()
end)

test("caller mutation cannot change a scheduled effect or its texture IDs", function()
	local spec=fixture(); spec.layers[1].start=0.2
	local mapping={spark="rbxassetid://12345"}
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),spec,mapping); local rows=emitters(first)
	spec.layers[1].burst=4000; spec.layers[1].rate=400; spec.layers[1].life[2]=20; spec.layers[1].alpha[1][2]=0; mapping.spark="bad"
	advance(0.2); same(total(rows),2); same(rows[1].Texture,"rbxassetid://12345"); same(rows[1].Transparency.Keypoints[1].Value,0)
	advance(0.5); same(total(rows),4); advance(0.21); same(handle:IsFinished(),true); p:Destroy()
end)

test("idempotent early Cancel rejects even a stale native callback", function()
	local spec=fixture(); spec.layers[1].start=0.4
	local p, first=parent(),#created
	local handle=Runtime.play(p,CFrame.new(),spec,textures); local stale=heartbeat:LastCallback(); local rows=emitters(first)
	handle:Cancel(); handle:Cancel(); stale(1); advance(1)
	same(handle:IsFinished(),true); same(handle:GetError(),nil); same(total(rows),0); same(#p._children,0); same(rows[1]._cleared,1); p:Destroy()
end)

test("parent removal clears only the effect and preserves unrelated children", function()
	local p=parent(); local foreign=Instance.new("Part"); foreign.Name="User geometry"; foreign.Parent=p
	local handle=Runtime.play(p,CFrame.new(),fixture(),textures)
	p.Parent=nil
	same(handle:IsFinished(),true); assert(handle:GetError()~=nil); same(foreign.Parent,p); same(foreign._destroyed,false); same(#p._children,1)
	p:Destroy()
end)

test("partial native setup failure cleans detached owned allocations", function()
	local p, first=parent(),#created
	propertyFailure="Texture"
	local ok, message=pcall(function() Runtime.play(p,CFrame.new(),fixture(),textures) end)
	propertyFailure=nil
	assert(not ok and string.find(tostring(message),"setup failure",1,true)); same(#p._children,0)
	for index=first+1,#created do same(created[index]._destroyed,true,"setup allocation cleanup") end
	local handle=Runtime.play(p,CFrame.new(),fixture(),textures); handle:Cancel(); p:Destroy()
end)

test("native Emit error during playback is observable and clears the scope", function()
	local p=parent(); local handle=Runtime.play(p,CFrame.new(),fixture(),textures)
	emitFailure=true; advance(0.25); emitFailure=false
	same(handle:IsFinished(),true); assert(string.find(handle:GetError(),"fake Emit failure",1,true)); same(#p._children,0)
	advance(1); p:Destroy()
end)

test("24 active admission limit refuses before allocation and cancellation releases a slot", function()
	local p=parent(); local handles={}
	for _=1,24 do table.insert(handles,Runtime.play(p,CFrame.new(),fixture(),textures)) end
	same(#p._children,24)
	rejected(function() Runtime.play(p,CFrame.new(),fixture(),textures) end,"24 active")
	handles[1]:Cancel(); local replacement=Runtime.play(p,CFrame.new(),fixture(),textures); same(#p._children,24)
	for _, handle in ipairs(handles) do handle:Cancel() end
	replacement:Cancel(); same(#p._children,0); p:Destroy()
end)

test("6000 global reserved peak is bounded and released on drain, cancel and setup failure", function()
	local p=parent(); local spec=fixture(); spec.budgets.peakParticles=2000
	propertyFailure="Texture"
	local ok=pcall(function() Runtime.play(p,CFrame.new(),spec,textures) end)
	propertyFailure=nil; same(ok,false)
	local one=Runtime.play(p,CFrame.new(),spec,textures)
	local two=Runtime.play(p,CFrame.new(),spec,textures)
	local three=Runtime.play(p,CFrame.new(),spec,textures)
	rejected(function() Runtime.play(p,CFrame.new(),spec,textures) end,"6000 reserved")
	two:Cancel(); two:Cancel()
	local replacement=Runtime.play(p,CFrame.new(),spec,textures)
	one:Cancel(); three:Cancel(); replacement:Cancel(); same(#p._children,0)
	local drained=Runtime.play(p,CFrame.new(),spec,textures); advance(0.5); advance(0.21); same(drained:IsFinished(),true)
	local a=Runtime.play(p,CFrame.new(),spec,textures); local b=Runtime.play(p,CFrame.new(),spec,textures); local c=Runtime.play(p,CFrame.new(),spec,textures)
	a:Cancel(); b:Cancel(); c:Cancel(); same(#p._children,0); p:Destroy()
end)

same(heartbeat:Count(),0); same(signalConnections,0)
print("ARCANE_VFX_RUNTIME_TESTS " .. tests .. " PASS; Roblox API fakes only; native rendering unverified")
