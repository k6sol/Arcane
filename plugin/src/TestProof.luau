--!strict
-- Construct against the plugin's Edit DataModel, before starting a playtest.
-- StudioTestService.EditModeActive is true while Edit is idle, false during a
-- play/Team Test session, and true again on stop (PluginSecurity read):
-- https://create.roblox.com/docs/reference/engine/classes/StudioTestService#EditModeActive
-- https://create.roblox.com/docs/reference/engine/classes/Object#GetPropertyChangedSignal
-- Each EditModeActive notification advances the epoch, including deferred ones.
-- Pause/resume within the same test does not change EditModeActive or the epoch.
-- Edit RunService.RunState stays Stopped during play; it cannot prove continuity.
-- Native notification delivery and Edit DataModel persistence need Studio QA.
-- Runtime ServerStorage receives a CLONE: its attributes are an identity witness,
-- never an authoritative epoch. Use the authenticated plugin HTTP snapshot for that.
local TestProof = {}

export type Snapshot = {
	read sessionId: string, read clientLifetimeId: string, read pluginArtifactHash: string, read markerName: string,
	read placeId: number, read universeId: number, read placeName: string,
	read playEpoch: number, read mode: "Edit" | "Play", read connected: boolean, read continuitySupported: boolean,
}
export type State = {
	bind: (self: State, sessionId: string, allowWrites: boolean) -> Snapshot?,
	snapshot: (self: State) -> Snapshot?,
	disconnect: (self: State) -> (),
	stop: (self: State) -> (),
}
type Attributes = {[string]: string | number | boolean}

local MAX_NAME_ATTEMPTS = 4
local MAX_COUNTER = 9007199254740991 -- Never wrap or lose monotonicity in a double.

local function publicId(value: any): boolean
	return type(value) == "string" and #value > 0 and #value <= 256 and not string.find(value, "%c")
end

function TestProof.new(gameModel: any, clientLifetimeId: string, pluginArtifactHash: string): State
	assert(publicId(clientLifetimeId), "TestProof requires a public client lifetime ID.")
	assert(type(pluginArtifactHash) == "string" and #pluginArtifactHash == 64
		and not string.find(pluginArtifactHash, "[^%x]"), "TestProof requires the loaded artifact SHA-256.")
	-- Keep exact Edit service references; never resolve a runtime copy by name.
	local serviceAvailable, testService = pcall(function(): any return gameModel:GetService("StudioTestService") end)
	if not serviceAvailable then testService = nil end
	local storage = gameModel:GetService("ServerStorage")
	local http = gameModel:GetService("HttpService")
	local sessionId: string? = nil
	local connected, allowWrites, stopped, fenced = false, false, false, false
	local continuitySupported = false
	local playEpoch = 0
	local mode: "Edit" | "Play" = "Edit"
	local observer: any = nil
	local marker: any = nil
	local markerName: string? = nil
	local expected: Attributes? = nil
	local state: State

	local function readMode(): "Edit" | "Play"
		assert(testService ~= nil, "StudioTestService is unavailable.")
		local editModeActive = testService.EditModeActive
		assert(type(editModeActive) == "boolean", "StudioTestService.EditModeActive must be a boolean.")
		return if editModeActive then "Edit" else "Play"
	end

	local function dropObserver(): ()
		continuitySupported, connected = false, false
		local connection = observer
		observer = nil
		if connection then pcall(function(): () connection:Disconnect() end) end
	end

	local function observeMode(): ()
		local ok, value = pcall(readMode)
		if ok then
			mode = value
		else
			dropObserver()
			-- Retain the last known mode only as unavailable metadata. RunService
			-- in the Edit model cannot provide a valid fallback during a test.
		end
		if observer then
			local live, isConnected = pcall(function(): boolean return observer.Connected == true end)
			if not live or not isConnected then dropObserver() end
		end
	end

	local function attributes(): Attributes
		return {
			SessionId = sessionId or "", ClientLifetimeId = clientLifetimeId,
			PluginArtifactHash = pluginArtifactHash, MarkerName = markerName or "", PlaceId = gameModel.PlaceId,
			UniverseId = gameModel.GameId, PlaceName = gameModel.Name,
			PlayEpoch = playEpoch, Mode = mode, Connected = connected,
			ContinuitySupported = continuitySupported,
		}
	end

	local function unchanged(): boolean
		if not marker or not expected then return false end
		local ok, matches = pcall(function(): boolean
			if marker.ClassName ~= "Folder" or marker.Name ~= markerName or marker.Parent ~= storage
				or marker.Archivable ~= true or storage.Parent ~= gameModel
				or marker:FindFirstChildWhichIsA("Instance") ~= nil or #marker:GetTags() ~= 0 then
				return false
			end
			local actual: Attributes = marker:GetAttributes()
			for key, value in pairs(expected :: Attributes) do if actual[key] ~= value then return false end end
			for key in pairs(actual) do if (expected :: Attributes)[key] == nil then return false end end
			return true
		end)
		return ok and matches
	end

	local function invalidate(): ()
		-- Sticky: retain at most one contested marker and never create replacements.
		-- Only these revocation attributes may change after a foreign edit. Everything
		-- else (including foreign children, tags, names and attributes) is preserved.
		fenced, connected, allowWrites = true, false, false
		if marker then
			pcall(function(): () marker:SetAttribute("Connected", false) end)
			pcall(function(): () marker:SetAttribute("Invalid", true) end)
		end
	end

	local function publish(): ()
		if not marker or fenced then return end
		if not unchanged() then invalidate(); return end
		local values = attributes()
		local ownedAttributes = expected :: Attributes
		local ok = pcall(function(): ()
			for key, value in pairs(values) do
				if ownedAttributes[key] ~= value then
					assert(unchanged(), "TestProof witness changed during publication.")
					marker:SetAttribute(key, value)
					ownedAttributes[key] = value
					-- Attribute listeners can edit another field synchronously. Detect
					-- that before a subsequent planned write could overwrite it.
					assert(unchanged(), "TestProof witness changed during publication.")
				end
			end
		end)
		if not ok then invalidate(); return end
		expected = values
		if not unchanged() then invalidate() end
	end

	local function retire(): ()
		if not marker then return end
		if fenced or not unchanged() then invalidate(); return end
		-- Revoke before removal. If any operation/readback fails, keep the witness
		-- invalid rather than deleting a marker whose contents are now uncertain.
		publish()
		if fenced then return end
		local ok = pcall(function(): () marker:Destroy() end)
		if not ok then invalidate(); return end
		marker, markerName, expected = nil, nil, nil
	end

	local function install(): ()
		if marker or fenced then return end
		local chosen: string? = nil
		local ok = pcall(function(): ()
			assert(storage.Parent == gameModel, "Edit ServerStorage is unavailable.")
			for _ = 1, MAX_NAME_ATTEMPTS do
				local guid = http:GenerateGUID(false)
				assert(type(guid) == "string" and #guid == 36 and not string.find(guid, "[^%x%-]"), "Invalid GUID.")
				local name = "ArcaneTestProof_" .. guid
				-- Keep a public candidate even if installation fails, so a bound
				-- unavailable proof still satisfies the host's eleven-field schema.
				markerName = name
				if not storage:FindFirstChild(name) then chosen = name; break end
			end
			assert(chosen ~= nil, "TestProof name capacity reached.")
		end)
		if not ok then invalidate(); return end
		markerName = chosen
		-- A helper loaded during play can report an unavailable witness, but cannot
		-- install into a runtime DataModel and mistake that clone for Edit ownership.
		if mode ~= "Edit" then connected = false; return end
		ok = pcall(function(): ()
			marker = Instance.new("Folder")
			marker.Name = chosen
			marker.Archivable = true -- Allow native runtime identity witnesses to clone.
			expected = attributes()
			for key, value in pairs(expected :: Attributes) do marker:SetAttribute(key, value) end
			marker.Parent = storage
		end)
		if not ok or not unchanged() then invalidate() end
	end

	state = {
		snapshot = function(_self: State): Snapshot?
			observeMode()
			-- Sampling reports the current mode; it NEVER manufactures an epoch.
			publish()
			local boundSessionId, boundMarkerName = sessionId, markerName
			if not boundSessionId or not boundMarkerName then return nil end
			local result: Snapshot = {
				sessionId = boundSessionId, clientLifetimeId = clientLifetimeId, pluginArtifactHash = pluginArtifactHash,
				markerName = boundMarkerName,
				placeId = gameModel.PlaceId, universeId = gameModel.GameId, placeName = gameModel.Name,
				playEpoch = playEpoch, mode = mode, connected = connected,
				continuitySupported = continuitySupported,
			}
			table.freeze(result)
			return result
		end,
		bind = function(_self: State, nextSessionId: string, nextAllowWrites: boolean): Snapshot?
			assert(publicId(nextSessionId), "TestProof requires a public session ID.")
			assert(type(nextAllowWrites) == "boolean", "TestProof requires a boolean write grant.")
			if stopped or fenced then return state:snapshot() end
			observeMode()
			if sessionId ~= nextSessionId or allowWrites ~= nextAllowWrites then
				connected, allowWrites = false, false
				retire()
				if fenced then return state:snapshot() end
				sessionId, connected, allowWrites = nextSessionId, continuitySupported, nextAllowWrites
			end
			-- This bounded internal witness exists for read-only sessions too.
			-- Grant changes replace it; they never authorize writes to game content.
			if not marker and mode == "Edit" then connected = continuitySupported end
			install()
			return state:snapshot()
		end,
		disconnect = function(_self: State): ()
			connected, allowWrites = false, false
			retire()
			sessionId = nil
			-- Keep the one lifetime observer across disconnect/re-pair gaps.
		end,
		stop = function(_self: State): ()
			if stopped then return end
			stopped = true -- Ignore callbacks already queued before Disconnect().
			dropObserver()
			state:disconnect()
		end,
	}

	-- Fail closed if this genuine property observer cannot be installed. One
	-- notification counts even if all deferred callbacks see the same boolean.
	local ok = pcall(function(): ()
		mode = readMode()
		observer = testService:GetPropertyChangedSignal("EditModeActive"):Connect(function(): ()
			if stopped or not continuitySupported then return end
			if playEpoch >= MAX_COUNTER then dropObserver(); invalidate(); return end
			playEpoch += 1
			observeMode()
			publish()
		end)
		assert(observer and observer.Connected == true, "EditModeActive observer is unavailable.")
	end)
	if ok then continuitySupported = true else dropObserver() end
	observeMode()
	return state
end

return TestProof
