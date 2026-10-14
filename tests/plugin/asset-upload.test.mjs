import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const modulePath = join(root, 'plugin/src/AssetUpload.luau');
const runtime = process.env.ARCANE_LUAU_BIN;
const compiler = process.env.ARCANE_LUAU_COMPILE ?? (runtime
  ? join(dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const options = {skip: (!runtime || !compiler) && 'Configure existing standalone Luau compiler and VM; no tools are installed or Studio used.'};

const doubles = String.raw`
local unexpected = 0
local function forbidden(): never unexpected += 1; error("forbidden engine/global access") end
local blocked = setmetatable({}, {__index = forbidden, __newindex = forbidden})
local game, workspace, plugin, Instance, Enum, AssetService, task, require = blocked, blocked, blocked, blocked, blocked, blocked, blocked, forbidden
local nativeTypeof = typeof
local enumItems = setmetatable({}, {__mode = "k"})
local function typeof(value: any): string
  if type(value) == "table" and enumItems[value] then return "EnumItem" end
  return nativeTypeof(value)
end
local function category(family: string, names: {string}): any
  local result = setmetatable({}, {__tostring = function() return "Enum." .. family end})
  for _, name in ipairs(names) do
    local item = table.freeze({Name = name, EnumType = result})
    enumItems[item] = true; result[name] = item
  end
  return table.freeze(result)
end
local function enums(): any
  return {AssetType = category("AssetType", {"Mesh", "Image", "Model", "MeshPart"}),
    AssetCreatorType = category("AssetCreatorType", {"User", "Group"}),
    -- SyntheticRejected is only a VM enum double, not an invented SDK constant.
    CreateAssetResult = category("CreateAssetResult", {"Success", "SyntheticRejected"})}
end
local function ticket(id: string, changes: any?): any
  local value: any = {attemptId = id, assetType = "Mesh", name = "Owned mesh", description = "Host-admitted reconstruction",
    creator = table.freeze({kind = "group", id = 456}),
    source = table.freeze({jobId = "11111111-1111-4111-8111-111111111111", resourceId = "mesh-1", sha256 = string.rep("a", 64)}),
    uploader = table.freeze({status = "available", id = 123, provenance = "StudioService:GetUserId"}),
    continuity = table.freeze({sessionId = "session-1", clientLifetimeId = "lifetime-1", pluginArtifactHash = string.rep("b", 64),
      playEpoch = 3, placeId = 1234, universeId = 5678})}
  for field, item in pairs(changes or {}) do value[field] = item end
  return table.freeze(value)
end
local function change(input: any, path: string, value: any): any
  local copy = table.clone(input)
  local outer, inner = string.match(path, "^([^%.]+)%.(.+)$")
  if outer then local nested = table.clone(copy[outer]); nested[inner] = value; copy[outer] = table.freeze(nested)
  else copy[path] = value end
  return table.freeze(copy)
end
local function ack(phase: string, input: any, id: number?): any return table.freeze({phase = phase, ticket = input, assetId = id}) end
local function setup(settings: any?): (any, any, any, any)
  settings = settings or {}
  local e = enums()
  local nativeAssetTypes, nativeCreatorTypes, nativeSuccess = e.AssetType, e.AssetCreatorType, e.CreateAssetResult.Success
  local state: any = {uploads = 0, intents = 0, results = 0, admissions = 0, guards = 0,
    live = true, admitted = true, destroyed = 0, events = {}, resourceReads = {}, intentFacts = {}, resultFacts = {}}
  local function event(value: string): () table.insert(state.events, value) end
  local service = {}
  function service:CreateAssetAsync(resource: any, assetType: any, parameters: any): (any, any)
    state.uploads += 1; event("upload")
    assert(state.intents == 1 and state.intentAckReturned, "durable exact intent ACK must precede engine entry")
    assert(resource == state.resource and assetType == nativeAssetTypes[state.input.assetType])
    local fields = 0
    for field in pairs(parameters) do
      assert(field == "CreatorId" or field == "CreatorType" or field == "Name" or field == "Description"); fields += 1
    end
    assert(fields == 4 and parameters.CreatorId == state.input.creator.id
      and parameters.CreatorType == (if state.input.creator.kind == "user" then nativeCreatorTypes.User else nativeCreatorTypes.Group))
    assert(parameters.Name == state.input.name and parameters.Description == state.input.description)
    state.parameters, state.assetType = parameters, assetType
    if settings.onUpload then settings.onUpload(state) end
    if settings.engineThrows then error(settings.engineError or "private-engine-detail") end
    local result = if settings.overrideResult then settings.engineResult else nativeSuccess
    local id = if settings.overrideId then settings.engineId else 987654
    return result, id
  end
  local callbacks: any = {}
  callbacks.assertAdmission = function(input: any, resource: any): any
    state.admissions += 1; event("admission")
    assert(table.isfrozen(input) and table.isfrozen(input.creator) and table.isfrozen(input.source)
      and table.isfrozen(input.uploader) and table.isfrozen(input.continuity))
    assert(input ~= state.input and input.creator ~= state.input.creator and resource == state.resource, "metadata is copied; the resource is borrowed")
    state.snapshot = input
    if settings.onAdmission then settings.onAdmission(state, input) end
    assert(state.admitted, "private-admission-detail")
    if settings.admissionBoolean then return true end
  end
  callbacks.liveGuard = function(input: any, resource: any): any
    state.guards += 1; event("guard")
    assert(input == state.snapshot and resource == state.resource)
    if settings.onGuard then settings.onGuard(state) end
    assert(state.live, "private-scope-detail")
    if settings.guardBoolean then return true end
  end
  callbacks.recordIntent = function(input: any): any
    state.intents += 1; event("intent")
    state.intentFacts[input.attemptId] = input -- A mock durable ledger, NOT actual disk durability.
    if settings.onIntent then settings.onIntent(state, input) end
    if settings.intentThrows then error("private-intent-ack-detail") end
    state.intentAckReturned = true
    return if settings.intentAck then settings.intentAck(input) else ack("intent", input)
  end
  callbacks.recordResult = function(input: any, observed: any): any
    state.results += 1; event("result")
    assert(table.isfrozen(observed) and observed.attemptId == input.attemptId
      and observed.assetId == (if settings.overrideId then settings.engineId else 987654))
    assert(state.uploads == 1 and state.snapshot == input)
    state.resultFacts[input.attemptId] = observed
    if settings.onResult then settings.onResult(state, input, observed) end
    if settings.resultThrows then error("private-result-ack-detail") end
    return if settings.resultAck then settings.resultAck(input, observed) else ack("result", input, observed.assetId)
  end
  state.enums, state.settings = e, settings
  return service, e, callbacks, state
end
local function borrow(state: any, input: any): any
  state.input = input
  local class = if input.assetType == "Image" then "EditableImage" else "EditableMesh"
  local resource = setmetatable({}, {__index = function(_self: any, field: string): any
    state.resourceReads[field] = (state.resourceReads[field] or 0) + 1
    if state.resourceUnavailable then error("private-resource-detail") end
    if field == "ClassName" then return state.resourceClass or class end
    if field == "IsA" then return function(_self: any, wanted: string): boolean
      if state.onIsA then state.onIsA() end
      return wanted == (state.resourceClass or class)
    end end
    if field == "Destroy" then return function() state.destroyed += 1; forbidden() end end
    forbidden()
  end, __newindex = forbidden})
  state.resource = resource; return resource
end
local function rejects(callback: any, code: string): any
  local ok, value = pcall(callback)
  assert(not ok and type(value) == "table" and value.code == code, "expected " .. code)
  assert(table.isfrozen(value) and not string.find(value.message, "private-", 1, true))
  return value
end
local function safe(value: any, state: any): ()
  assert(table.isfrozen(value) and value.retryable == false and state.destroyed == 0 and state.resourceReads.Destroy == nil)
  assert(value.reason == nil or not string.find(value.reason, "private-", 1, true))
end
`;

function execute(binary, args) {
  const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function vm(t, checks) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-asset-upload-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('arcane-asset-upload-'));
    await rm(directory, {recursive: true, force: true});
  });
  const filename = join(directory, 'upload.luau');
  const source = await readFile(modulePath, 'utf8');
  // Exact production source; no builder, protocol, service lookup or real upload.
  await writeFile(filename, doubles + '\nlocal AssetUpload = (function()\n' + source + '\nend)()\n' + checks
    + '\nassert(unexpected == 0)\nprint("AssetUpload fixture passed")\n');
  execute(compiler, ['--null', filename]);
  assert.match(execute(runtime, [filename]), /AssetUpload fixture passed/);
}

test('AssetUpload production source compiles with the actual offline Luau compiler', options, () => execute(compiler, ['--null', modulePath]));

for (const assetType of ['Mesh', 'Image']) for (const creator of ['user', 'group']) {
  test(`${assetType}/${creator} uses exact engine enum items and journals before success without destroying the borrowed resource`, options, t => vm(t, String.raw`
local service, e, callbacks, state = setup()
local input = ticket("success", {assetType = "${assetType}", creator = table.freeze({kind = "${creator}", id = 456})})
local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
assert(table.isfrozen(uploader) and uploader:status(input.attemptId) == nil)
local result = uploader:upload(input, resource)
safe(result, state)
assert(result.state == "succeeded" and result.assetId == 987654 and result.uploadStarted
  and result.intentAcknowledged and result.resultAcknowledged and not result.scopeLost)
assert(result.intentJournalState == "acknowledged" and result.resultJournalState == "acknowledged")
assert(table.concat(state.events, ",") == "admission,guard,intent,admission,guard,upload,result,guard")
local before = state.uploads
rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
local another = AssetUpload.new(service, e, callbacks)
rejects(function() another:upload(input, resource) end, "ATTEMPT")
assert(state.uploads == before and another:status(input.attemptId).assetId == result.assetId)
assert(not pcall(function() result.state = "running" end))
`));
}

test('constructor requires explicit host callbacks, actual enum identities and an injected engine method', options, t => vm(t, String.raw`
for _, field in ipairs({"assertAdmission", "liveGuard", "recordIntent", "recordResult"}) do
  for _, replacement in ipairs({false, true, "rights", {authorized = true}}) do
    local service, e, callbacks, state = setup(); callbacks[field] = replacement
    rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
    assert(state.uploads == 0 and state.intents == 0)
  end
  local service, e, callbacks = setup(); callbacks[field] = nil
  rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
end
local service, e, callbacks = setup(); callbacks.authorized = true
rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
service, e, callbacks = setup(); e.AssetType = {Mesh = "Mesh", Image = "Image"}
rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
service, e, callbacks = setup(); e.AssetCreatorType = category("CreatorType", {"User", "Group"})
rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
service, e, callbacks = setup(); e.CreateAssetResult = category("UploadCaptureResult", {"Success"})
rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
service, e, callbacks = setup(); service.CreateAssetAsync = nil
rejects(function() AssetUpload.new(service, e, callbacks) end, "INPUT")
`));

test('frozen ticket schema rejects raw JSON, rights flags, missing metadata, invalid creators and unavailable uploader observations', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup()
local uploader = AssetUpload.new(service, e, callbacks)
local base = ticket("invalid")
local invalid = {"{rights:true}", true, table.clone(base), change(base, "rights", true), change(base, "assetType", "Model"),
  change(base, "creator", {kind = "user", id = 123}), change(base, "creator.kind", "organization"),
  change(base, "creator.id", "123"), change(base, "creator.id", 0), change(base, "creator.id", math.huge),
  change(base, "uploader.status", "unavailable"), change(base, "uploader.id", 0),
  change(base, "uploader.provenance", "game.CreatorId"), change(base, "continuity.playEpoch", -1),
  change(base, "continuity.pluginArtifactHash", "rights-hash"), change(base, "source.sha256", "rights-hash"),
  change(base, "source.resourceId", ""), change(base, "attemptId", string.rep("a", 129))}
for _, input in ipairs(invalid) do rejects(function() uploader:upload(input, {}) end, "INPUT") end
for _, field in ipairs({"attemptId", "assetType", "creator", "source", "uploader", "continuity", "name", "description"}) do
  rejects(function() uploader:upload(change(base, field, nil), {}) end, "INPUT")
end
assert(state.uploads == 0 and state.admissions == 0 and state.intents == 0 and uploader:status(base.attemptId) == nil)
`));

test('metadata validates UTF-8, local text bounds, controls and exact positive numeric IDs without truncation', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup()
local uploader = AssetUpload.new(service, e, callbacks)
local base = ticket("metadata")
for _, path in ipairs({"name", "description"}) do
  for _, value in ipairs({true, string.char(255), "null" .. string.char(0), "control" .. string.char(127)}) do
    rejects(function() uploader:upload(change(base, path, value), {}) end, "INPUT")
  end
end
for _, value in ipairs({"", "   ", "name\n", string.rep("a", 51), string.rep("é", 51)}) do
  rejects(function() uploader:upload(change(base, "name", value), {}) end, "INPUT")
end
rejects(function() uploader:upload(change(base, "description", string.rep("a", 1001)), {}) end, "INPUT")
for _, id in ipairs({-1, 1.5, 0/0, math.huge, 9007199254740992}) do
  rejects(function() uploader:upload(change(base, "creator.id", id), {}) end, "INPUT")
end
local input = ticket("boundary", {name = string.rep("é", 50), description = string.rep("é", 998) .. "\n\t",
  creator = table.freeze({kind = "user", id = 9007199254740991})})
local resource = borrow(state, input)
local result = uploader:upload(input, resource); safe(result, state)
assert(result.state == "succeeded" and state.parameters.Name == input.name and state.parameters.Description == input.description)
`));

test('resource class validation consumes its attempt without admission, upload or lifetime cleanup', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup()
local input, resource = ticket("wrong-resource")
resource = borrow(state, input); state.resourceClass = "MeshPart"
local uploader = AssetUpload.new(service, e, callbacks)
rejects(function() uploader:upload(input, resource) end, "INPUT")
assert(uploader:status(input.attemptId).state == "failed" and uploader:status(input.attemptId).reason == "INVALID_RESOURCE")
rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
assert(state.uploads == 0 and state.intents == 0 and state.admissions == 0 and state.destroyed == 0)
`));

test('intent ACK must echo every exact frozen ticket field and cannot create admission', options, t => vm(t, String.raw`
local base = ticket("ack-base")
local changes = {attemptId = "other-attempt", assetType = "Image", ["source.jobId"] = "other-job", ["source.resourceId"] = "other-resource",
  ["source.sha256"] = string.rep("c", 64), ["creator.kind"] = "user", ["creator.id"] = 999,
  ["uploader.id"] = 999, ["uploader.provenance"] = "game.CreatorId", ["continuity.sessionId"] = "other-session",
  ["continuity.clientLifetimeId"] = "other-lifetime", ["continuity.pluginArtifactHash"] = string.rep("c", 64),
  ["continuity.playEpoch"] = 4, ["continuity.placeId"] = 999, ["continuity.universeId"] = 999,
  name = "changed", description = "changed"}
local index = 0
for path, value in pairs(changes) do
  index += 1
  local service, e, callbacks, state = setup({intentAck = function(input) return ack("intent", change(input, path, value)) end})
  local input = change(base, "attemptId", "ack-" .. index)
  local resource = borrow(state, input); local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.state == "reconciliation" and result.reason == "INTENT_ACK_LOST" and not result.uploadStarted and state.uploads == 0)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
end
local service, e, callbacks, state = setup({onIntent = function(s) s.admitted = false end})
local input = ticket("ack-not-authority"); local resource = borrow(state, input)
local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
assert(result.intentAcknowledged and result.reason == "ADMISSION_CHANGED" and state.uploads == 0)
`));

test('missing, malformed or lost intent ACK leaves explicit reconciliation and never starts an upload', options, t => vm(t, String.raw`
local replacements = {
  function() return nil end, function() return true end, function() return "{ack:true}" end,
  function(input) return {phase = "intent", ticket = input} end,
  function(input) return ack("result", input) end,
  function(input) return table.freeze({phase = "intent", ticket = input, authorized = true}) end,
  function(input) return ack("intent", table.clone(input)) end,
}
for index, replace in ipairs(replacements) do
  local service, e, callbacks, state = setup({intentAck = replace})
  local input = ticket("missing-ack-" .. index); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.reason == "INTENT_ACK_LOST" and not result.intentAcknowledged and not result.uploadStarted and state.uploads == 0)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
end
local service, e, callbacks, state = setup({intentThrows = true})
local input = ticket("lost-intent-ack"); local resource = borrow(state, input)
local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
assert(result.state == "reconciliation" and result.reason == "INTENT_ACK_LOST" and state.intentFacts[input.attemptId] and state.uploads == 0)
`));

test('admission and guard assertions are separate and boolean or denied assertions cannot upload', options, t => vm(t, String.raw`
for index, settings in ipairs({{admissionBoolean = true}, {guardBoolean = true},
  {onAdmission = function(s) s.admitted = false end}, {onGuard = function(s) s.live = false end}}) do
  local service, e, callbacks, state = setup(settings)
  local input = ticket("denied-" .. index); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.state == "reconciliation" and not result.uploadStarted and state.intents == 0 and state.uploads == 0)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
end
`));

test('post-intent scope or resource changes refuse upload after the durable ACK', options, t => vm(t, String.raw`
for index, mutate in ipairs({function(s) s.live = false end, function(s) s.resourceUnavailable = true end}) do
  local service, e, callbacks, state = setup({onIntent = mutate})
  local input = ticket("retired-before-upload-" .. index); local resource = borrow(state, input)
  local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
  assert(result.state == "reconciliation" and result.intentAcknowledged and not result.uploadStarted and state.uploads == 0)
  assert(result.reason == (if index == 1 then "SCOPE_CHANGED" else "RESOURCE_CHANGED"))
end
`));

test('unknown thrown SDK outcomes are non-replayable and do not expose arbitrary error details', options, t => vm(t, String.raw`
for index, errorValue in ipairs({"private-engine-detail", table.freeze({code = "SCOPE", message = "private-engine-detail", unsafe = false})}) do
  local service, e, callbacks, state = setup({engineThrows = true, engineError = errorValue})
  local input = ticket("engine-exception-" .. index); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.state == "reconciliation" and result.reason == "ENGINE_OUTCOME_UNKNOWN" and result.uploadStarted and result.assetId == nil)
  assert(result.intentAcknowledged and not result.resultAcknowledged and state.results == 0)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT"); assert(state.uploads == 1)
end
`));

test('only the exact success enum with a finite positive safe integer ID is a known success', options, t => vm(t, String.raw`
local invalidIds = {0, -1, 1.5, 0/0, math.huge, -math.huge, 9007199254740992, "123", true}
for index, id in ipairs(invalidIds) do
  local service, e, callbacks, state = setup({overrideId = true, engineId = id})
  local input = ticket("invalid-id-" .. index); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.reason == "INVALID_ASSET_ID" and result.state == "reconciliation" and result.assetId == nil and state.results == 0)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
end
local service, e, callbacks, state = setup({overrideId = true})
local input = ticket("nil-id"); local resource = borrow(state, input)
assert(AssetUpload.new(service, e, callbacks):upload(input, resource).reason == "INVALID_ASSET_ID")
for index, value in ipairs({true, false, "Success", table.freeze({Name = "Success"}), category("UploadCaptureResult", {"Success"}).Success}) do
  service, e, callbacks, state = setup({overrideResult = true, engineResult = value})
  input = ticket("invalid-enum-" .. index); resource = borrow(state, input)
  local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
  assert(result.reason == "INVALID_ENGINE_RESULT" and result.state == "reconciliation" and state.results == 0)
end
`));

test('a definitive SDK rejection stays failed and consumed, without a result journal or inferred ID', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup({overrideResult = true, overrideId = true, engineId = "private-rejection-detail"})
state.settings.engineResult = e.CreateAssetResult.SyntheticRejected
local input = ticket("rejected"); local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
local result = uploader:upload(input, resource); safe(result, state)
assert(result.state == "failed" and result.reason == "ENGINE_REJECTED" and result.assetId == nil and state.results == 0)
rejects(function() uploader:upload(input, resource) end, "ATTEMPT"); assert(state.uploads == 1)
`));

test('observed success is recorded before the final guard even when SDK completion retires admission', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup({onUpload = function(s) s.live = false end,
  onResult = function(s, input, observed)
    assert(not s.live and s.guards == 2, "fact logging precedes the final execution guard")
    assert(observed.assetId == 987654 and input.uploader.id ~= input.creator.id, "uploader is not inferred from the group creator")
  end})
local input = ticket("late-scope"); local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
local result = uploader:upload(input, resource); safe(result, state)
assert(result.state == "reconciliation" and result.reason == "LATE_SCOPE_CHANGED" and result.assetId == 987654
  and result.resultAcknowledged and result.scopeLost and state.resultFacts[input.attemptId].assetId == 987654)
rejects(function() uploader:upload(input, resource) end, "ATTEMPT"); assert(state.uploads == 1)
`));

test('lost result ACK retains the exact known asset ID and unknown journal state without any upload replay', options, t => vm(t, String.raw`
local replacements = {function() return nil end, function() return true end,
  function(input, observed) return ack("result", input, observed.assetId + 1) end,
  function(input, observed) return ack("result", change(input, "source.resourceId", "other-resource"), observed.assetId) end,
  function(input, observed) return {phase = "result", ticket = input, assetId = observed.assetId} end}
for index, replace in ipairs(replacements) do
  local service, e, callbacks, state = setup({resultAck = replace})
  local input = ticket("result-ack-" .. index); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result = uploader:upload(input, resource); safe(result, state)
  assert(result.state == "reconciliation" and result.reason == "RESULT_ACK_LOST" and result.assetId == 987654 and not result.resultAcknowledged)
  assert(result.resultJournalState == "unknown")
  assert(uploader:status(input.attemptId).assetId == 987654)
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT"); assert(state.uploads == 1 and state.results == 1)
end
local service, e, callbacks, state = setup({resultThrows = true, onUpload = function(s) s.live = false end})
local input = ticket("known-id-unknown-journal"); local resource = borrow(state, input)
local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
assert(result.reason == "RESULT_ACK_LOST" and result.assetId == 987654 and result.scopeLost and not result.resultAcknowledged)
assert(result.resultJournalState == "unknown")
assert(state.resultFacts[input.attemptId].assetId == 987654 and state.uploads == 1)
`));

test('snapshotting preserves immutable ticket data, enum items, callbacks and SDK method across real coroutine yields', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup({onIntent = function(s, input)
  assert(table.isfrozen(input) and not pcall(function() input.source.resourceId = "changed" end))
  coroutine.yield("intent-awaiting-ack")
end, onUpload = function() coroutine.yield("engine-awaiting-result") end,
onResult = function() coroutine.yield("result-awaiting-ack") end})
local input = ticket("yielding"); local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
local result
local worker = coroutine.create(function() result = uploader:upload(input, resource) end)
local ok, phase = coroutine.resume(worker); assert(ok and phase == "intent-awaiting-ack" and state.uploads == 0)
local before = uploader:status(input.attemptId)
assert(before.state == "running" and before.phase == "intent" and not before.intentAcknowledged)
rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
service.CreateAssetAsync = forbidden
callbacks.assertAdmission, callbacks.liveGuard, callbacks.recordIntent, callbacks.recordResult = forbidden, forbidden, forbidden, forbidden
e.AssetType, e.AssetCreatorType, e.CreateAssetResult = blocked, blocked, blocked
ok, phase = coroutine.resume(worker); assert(ok and phase == "engine-awaiting-result" and state.uploads == 1)
assert(uploader:status(input.attemptId).uploadStarted and uploader:status(input.attemptId).assetId == nil)
ok, phase = coroutine.resume(worker); assert(ok and phase == "result-awaiting-ack")
assert(uploader:status(input.attemptId).assetId == 987654 and not uploader:status(input.attemptId).resultAcknowledged)
ok = coroutine.resume(worker); assert(ok and coroutine.status(worker) == "dead")
safe(result, state); assert(result.state == "succeeded" and before.state == "running" and not before.intentAcknowledged)
`));

test('reentrant resource validation cannot start another upload for the latched attempt', options, t => vm(t, String.raw`
local service, e, callbacks, state = setup()
local input = ticket("reentrant-resource"); local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
state.onIsA = function() rejects(function() uploader:upload(input, resource) end, "ATTEMPT") end
local result = uploader:upload(input, resource); safe(result, state)
assert(result.state == "succeeded" and state.uploads == 1 and state.intents == 1)
`));

test('scope retirement across each actual yielding boundary preserves facts while refusing continuation', options, t => vm(t, String.raw`
for _, boundary in ipairs({"intent", "upload", "result"}) do
  local settings: any = {}
  if boundary == "intent" then settings.onIntent = function() coroutine.yield("await") end
  elseif boundary == "upload" then settings.onUpload = function() coroutine.yield("await") end
  else settings.onResult = function() coroutine.yield("await") end end
  local service, e, callbacks, state = setup(settings)
  local input = ticket("yield-retirement-" .. boundary); local resource = borrow(state, input)
  local uploader = AssetUpload.new(service, e, callbacks)
  local result
  local worker = coroutine.create(function() result = uploader:upload(input, resource) end)
  local ok, reason = coroutine.resume(worker); assert(ok and reason == "await")
  local before = uploader:status(input.attemptId)
  assert(before.state == "running")
  if boundary == "intent" then assert(before.intentJournalState == "unknown" and state.uploads == 0)
  elseif boundary == "result" then assert(before.assetId == 987654 and before.resultJournalState == "unknown") end
  state.live = false
  ok = coroutine.resume(worker); assert(ok and coroutine.status(worker) == "dead")
  safe(result, state)
  assert(result.state == "reconciliation" and result.scopeLost and result.intentAcknowledged)
  if boundary == "intent" then assert(result.reason == "SCOPE_CHANGED" and state.uploads == 0 and state.results == 0)
  else assert(result.reason == "LATE_SCOPE_CHANGED" and result.assetId == 987654 and result.resultJournalState == "acknowledged"
    and state.resultFacts[input.attemptId].assetId == 987654 and state.uploads == 1) end
  rejects(function() uploader:upload(input, resource) end, "ATTEMPT")
end
`));

test('positive asset ID boundaries are retained exactly in the success result journal', options, t => vm(t, String.raw`
for index, id in ipairs({1, 9007199254740991}) do
  local service, e, callbacks, state = setup({overrideId = true, engineId = id})
  local input = ticket("valid-id-" .. index); local resource = borrow(state, input)
  local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
  assert(result.state == "succeeded" and result.assetId == id and state.resultFacts[input.attemptId].assetId == id)
end
`));

test('attempt capacity fails closed without eviction, reset or replay after a new uploader instance', options, t => vm(t, String.raw`
for index = 1, AssetUpload.LIMITS.attempts do
  local service, e, callbacks, state = setup({admissionBoolean = true})
  local input = ticket("capacity-" .. index); local resource = borrow(state, input)
  local result = AssetUpload.new(service, e, callbacks):upload(input, resource); safe(result, state)
  assert(result.reason == "ADMISSION_FAILED" and state.uploads == 0)
end
local service, e, callbacks, state = setup()
local input = ticket("capacity-extra"); local resource = borrow(state, input)
local uploader = AssetUpload.new(service, e, callbacks)
rejects(function() uploader:upload(input, resource) end, "CAPACITY")
assert(uploader:status("capacity-1").state == "reconciliation" and uploader:status(input.attemptId) == nil)
rejects(function() uploader:upload(ticket("capacity-1"), resource) end, "ATTEMPT")
assert(state.uploads == 0 and state.intents == 0 and state.admissions == 0)
`));
