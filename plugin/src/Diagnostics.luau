--!strict
-- Bounded Studio output diagnostics for the paired workspace. Only error and
-- warning output is kept, deduplicated by kind/source/text, and reported on
-- the existing authenticated poll. Nothing here can queue or execute work.
local Diagnostics = {}
Diagnostics.__index = Diagnostics
Diagnostics.CAPABILITY = "studio.diagnostics"
Diagnostics.MAX_ENTRIES = 100
Diagnostics.MAX_PER_REPORT = 10
Diagnostics.MAX_REPORT_BYTES = 64 * 1024
Diagnostics.MESSAGE_BYTES = 2048
Diagnostics.STACK_BYTES = 2048
Diagnostics.SOURCE_BYTES = 512
-- Repeats inside this window count against one entry; a later repeat opens a new one.
Diagnostics.WINDOW_SECONDS = 60
-- LogService and ScriptContext both describe one script error; pair them once.
Diagnostics.PAIR_SECONDS = 1
type Diagnostics = any

-- Truncate on a UTF-8 boundary; invalid UTF-8 is replaced, never forwarded.
function Diagnostics.clip(value: any, maximum: number): string?
	if type(value) ~= "string" then return nil end
	local text = value
	if utf8.len(text) == nil then text = string.gsub(text, "[\128-\255]", "?") end
	text = string.gsub(text, "%z", "")
	if #text > maximum then
		local cut = maximum
		while cut > 0 and utf8.len(string.sub(text, 1, cut)) == nil do cut -= 1 end
		text = string.sub(text, 1, cut)
	end
	return if #text > 0 then text else nil
end

function Diagnostics.new(gameModel: any, isActive: (() -> boolean)?, clock: (() -> number)?): Diagnostics
	return setmetatable({gameModel = gameModel, isActive = isActive, clock = clock or os.clock,
		entries = {}, order = {}, byKey = {}, nextId = 0, connections = {}, stopped = false}, Diagnostics)
end

-- "Path.To.Script:12: text" is the engine's error prefix for script errors.
function Diagnostics.parse(message: string): (string?, number?, string)
	local source, line, text = string.match(message, "^([%w_%.%s%-]+):(%d+): (.*)$")
	if source and line and text then return source, tonumber(line), text end
	return nil, nil, message
end

function Diagnostics:evict(): ()
	while #self.order > Diagnostics.MAX_ENTRIES do
		local oldest = table.remove(self.order, 1)
		local entry = self.entries[oldest]
		self.entries[oldest] = nil
		if entry and self.byKey[entry.key] == oldest then self.byKey[entry.key] = nil end
	end
end

function Diagnostics:record(kind: string, message: any, origin: string, scriptPath: any?, stack: any?): ()
	if self.stopped or (kind ~= "error" and kind ~= "warning") then return end
	if self.isActive and not self.isActive() then return end
	local raw = Diagnostics.clip(message, Diagnostics.MESSAGE_BYTES * 2)
	if not raw then return end
	local parsedSource, line, text = Diagnostics.parse(raw)
	local source = Diagnostics.clip(scriptPath, Diagnostics.SOURCE_BYTES) or Diagnostics.clip(parsedSource, Diagnostics.SOURCE_BYTES)
	if not line and type(stack) == "string" then
		local stackLine = string.match(stack, ":(%d+)")
		line = if stackLine then tonumber(stackLine) else nil
	end
	text = Diagnostics.clip(text, Diagnostics.MESSAGE_BYTES) or "(empty message)"
	local now = self.clock()
	local key = kind .. "\0" .. (source or "") .. "\0" .. text
	local id = self.byKey[key]
	local entry = if id then self.entries[id] else nil
	if entry and now - entry.lastClock <= Diagnostics.WINDOW_SECONDS then
		local paired = entry.pairOrigin and entry.pairOrigin ~= origin and now - entry.pairClock <= Diagnostics.PAIR_SECONDS
		if paired then entry.pairOrigin = nil
		else entry.count += 1; entry.pairOrigin, entry.pairClock = origin, now end
		entry.stack = entry.stack or Diagnostics.clip(stack, Diagnostics.STACK_BYTES)
		entry.line = entry.line or line
		entry.lastClock = now
		entry.version += 1
		local index = table.find(self.order, id)
		if index then table.remove(self.order, index) end
		table.insert(self.order, id)
		return
	end
	self.nextId += 1
	id = "d" .. tostring(self.nextId)
	self.entries[id] = {id = id, key = key, kind = kind, message = text, source = source, line = line,
		stack = Diagnostics.clip(stack, Diagnostics.STACK_BYTES), count = 1, lastClock = now,
		pairOrigin = origin, pairClock = now, version = 1, reported = 0}
	self.byKey[key] = id
	table.insert(self.order, id)
	self:evict()
end

-- Snapshot of changed entries for one poll, bounded by count and encoded bytes.
function Diagnostics:take(encode: (any) -> string): any
	local batch = {entries = {}, versions = {}}
	local bytes = 0
	for _, id in ipairs(self.order) do
		local entry = self.entries[id]
		if entry and entry.version > entry.reported then
			local wire: any = {id = entry.id, kind = entry.kind, message = entry.message, count = entry.count}
			if entry.source then wire.source = entry.source end
			if entry.line and entry.line >= 1 and entry.line <= 1000000 then wire.line = math.floor(entry.line) end
			if entry.stack then wire.stack = entry.stack end
			local size = #encode(wire) + 1
			if bytes + size > Diagnostics.MAX_REPORT_BYTES then break end
			bytes += size
			table.insert(batch.entries, wire)
			batch.versions[id] = entry.version
			if #batch.entries >= Diagnostics.MAX_PER_REPORT then break end
		end
	end
	return batch
end

-- Only an authenticated, accepted poll marks entries reported; a lost poll resends them.
function Diagnostics:ack(batch: any): ()
	for id, version in pairs(batch.versions) do
		local entry = self.entries[id]
		if entry and version > entry.reported then entry.reported = version end
	end
end

function Diagnostics:start(): boolean
	if self.stopped or #self.connections > 0 then return #self.connections > 0 end
	local ok = pcall(function()
		local log = self.gameModel:GetService("LogService")
		local errorType, warningType = Enum.MessageType.MessageError, Enum.MessageType.MessageWarning
		table.insert(self.connections, log.MessageOut:Connect(function(message: string, messageType: any)
			if messageType == errorType then self:record("error", message, "log")
			elseif messageType == warningType then self:record("warning", message, "log") end
		end))
	end)
	pcall(function()
		local context = self.gameModel:GetService("ScriptContext")
		table.insert(self.connections, context.Error:Connect(function(message: string, stack: string, origin: any)
			local path = nil
			if typeof(origin) == "Instance" then
				local named, value = pcall(function(): string return origin:GetFullName() end)
				if named then path = value end
			end
			self:record("error", message, "script", path, stack)
		end))
	end)
	return ok or #self.connections > 0
end

function Diagnostics:stop(): ()
	self.stopped = true
	for _, connection in ipairs(self.connections) do pcall(function() connection:Disconnect() end) end
	self.connections = {}
	self.entries, self.order, self.byKey = {}, {}, {}
end

return Diagnostics
