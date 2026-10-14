import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = path.join(repository, 'plugin/src/TestProof.luau');
const runtime = process.env.ARCANE_LUAU_BIN;
const analyze = process.env.ARCANE_LUAU_ANALYZE;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime
  ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile')
  : undefined);
const vmOptions = { skip: !runtime && 'Set ARCANE_LUAU_BIN for standalone VM fixtures; these tests never contact Studio.' };
const completion = 'Arcane TestProof fixture passed';

// Independent, standalone engine doubles. Queue notifications separately from
// EditModeActive reads to exercise stop/play/stop with identical callback values.
// Edit RunService intentionally stays Stopped while the runtime server runs.
// These fixtures cannot certify native notification delivery or Edit persistence.
const engine = `
local fixture: any = {created = {}, destroyed = {}, deferred = {}, serviceCalls = {},
  signalCalls = {}, guid = 0, failConnect = false, failSignal = false, failRead = false}
local runStates = {Stopped = {Name = "Stopped"}, Running = {Name = "Running"}, Paused = {Name = "Paused"}}
local signal: any = {connections = {}}
function signal:Connect(callback: any): any
  assert(not fixture.failConnect, "injected connection failure")
  if fixture.nilObserver then return nil end
  local connection: any = {Connected = if fixture.invalidConnectionFlag ~= nil then fixture.invalidConnectionFlag else not fixture.deadConnection, callback = callback}
  function connection:Disconnect(): () self.Connected = false end
  table.insert(self.connections, connection)
  return connection
end
function signal:Fire(deferred: boolean?): ()
  for _, connection in ipairs(table.clone(self.connections)) do
    if connection.Connected then
      if deferred then table.insert(fixture.deferred, connection.callback) else connection.callback() end
    end
  end
end
local testMethods: any = {}
function testMethods:GetPropertyChangedSignal(property: string): any
  table.insert(fixture.signalCalls, property)
  assert(property == "EditModeActive", "only the documented EditModeActive property may be observed")
  assert(not fixture.failSignal, "injected unavailable property signal")
  return signal
end
local testService: any = setmetatable({_active = true}, {__index = function(self: any, key: string): any
  if key == "EditModeActive" then assert(not fixture.failRead, "injected inaccessible EditModeActive"); return rawget(self, "_active") end
  assert(testMethods[key], "undocumented StudioTestService member: " .. key)
  return testMethods[key]
end})
local editRun: any = {RunState = runStates.Stopped}
function editRun:IsEdit(): boolean return true end
function editRun:IsRunning(): boolean return false end
function editRun:GetPropertyChangedSignal(property: string): any
  assert(property == "RunState", "native regression RunService property")
  -- Available but dormant: Edit RunState never changes during this playtest.
  return {Connect = function(_self: any, callback: any): any
    local connection: any = {Connected = true, callback = callback}
    function connection:Disconnect(): () self.Connected = false end
    return connection
  end}
end
local runtimeRun: any = {RunState = runStates.Stopped}
local function transition(editModeActive: boolean, deferred: boolean?): ()
  assert(type(editModeActive) == "boolean", "fixture EditModeActive")
  runtimeRun.RunState = if editModeActive then runStates.Stopped else runStates.Running
  if testService._active ~= editModeActive then testService._active = editModeActive; signal:Fire(deferred) end
end
local function flush(): ()
  local queued = fixture.deferred
  fixture.deferred = {}
  for _, callback in ipairs(queued) do callback() end
end
local function activeObservers(): number
  local count = 0
  for _, connection in ipairs(signal.connections) do if connection.Connected then count += 1 end end
  return count
end

local instanceMethods: any = {}
local instanceMetatable: any = {
  __index = function(self: any, key: string): any return instanceMethods[key] or self._properties[key] end,
  __newindex = function(self: any, key: string, value: any): ()
    if string.sub(key, 1, 1) == "_" then rawset(self, key, value); return end
    assert(not self._destroyed, "cannot edit destroyed instance")
    if key == "Parent" then
      assert(not fixture.failParent, "injected parent failure")
      local old = self._properties.Parent
      if old then
        for index, child in ipairs(old._children) do
          if child == self then table.remove(old._children, index); break end
        end
      end
      if value then table.insert(value._children, self) end
    end
    self._properties[key] = value
    if key == "Parent" and fixture.afterParent then fixture.afterParent(self, value) end
  end,
}
local function instance(className: string): any
  return setmetatable({_properties = {Name = className, ClassName = className, Archivable = true},
    _attributes = {}, _children = {}, _tags = {}, _destroyed = false}, instanceMetatable)
end
function instanceMethods:SetAttribute(key: string, value: any): ()
  assert(not self._destroyed, "cannot write destroyed attributes")
  assert(not fixture.failAttribute, "injected attribute failure")
  assert(type(value) == "string" or type(value) == "number" or type(value) == "boolean" or value == nil, "primitive attributes only")
  self._attributes[key] = value
  if fixture.afterAttribute then fixture.afterAttribute(self, key, value) end
end
function instanceMethods:GetAttribute(key: string): any return self._attributes[key] end
function instanceMethods:GetAttributes(): any return table.clone(self._attributes) end
function instanceMethods:GetTags(): any return table.clone(self._tags) end
function instanceMethods:GetChildren(): any return table.clone(self._children) end
function instanceMethods:FindFirstChild(name: string): any
  for _, child in ipairs(self._children) do if child.Name == name then return child end end
  return nil
end
function instanceMethods:FindFirstChildWhichIsA(className: string): any
  assert(className == "Instance", "bounded direct child existence query")
  return self._children[1]
end
function instanceMethods:Destroy(): ()
  assert(not fixture.failDestroy, "injected destroy failure")
  table.insert(fixture.destroyed, {instance = self, attributes = self:GetAttributes()})
  self.Parent = nil
  self._destroyed = true
end
local Instance: any = {new = function(className: string): any
  assert(className == "Folder", "proof cannot create executable scripts or unrelated content")
  assert(not fixture.failNew, "injected instance creation failure")
  local created = instance(className)
  table.insert(fixture.created, created)
  return created
end}
local game: any = instance("DataModel")
game.Name, game.PlaceId, game.GameId = "Fixture Place", 101, 202
game.ApiKey, game.SessionToken = "fixture-api-key-secret", "fixture-session-token-secret"
local storage = instance("ServerStorage")
storage.Parent = game
local http: any = {GenerateGUID = function(_self: any, braces: boolean): string
  assert(braces == false, "public names use GUIDs without braces")
  fixture.guid += 1
  if fixture.guidOverride then return fixture.guidOverride end
  return string.format("00000000-0000-4000-8000-%012x", fixture.guid)
end}
local services: any = {StudioTestService = testService, RunService = editRun, ServerStorage = storage, HttpService = http}
function instanceMethods:GetService(name: string): any
  assert(self == game and services[name], "only the supplied model's three proof services")
  table.insert(fixture.serviceCalls, name)
  if name == "StudioTestService" then
    assert(not fixture.failService, "injected unavailable StudioTestService")
    if fixture.nilService then return nil end
  end
  return services[name]
end
`;

const helpers = `
local fieldAttributes = {
  sessionId = "SessionId", clientLifetimeId = "ClientLifetimeId", pluginArtifactHash = "PluginArtifactHash",
  markerName = "MarkerName", placeId = "PlaceId", universeId = "UniverseId", placeName = "PlaceName",
  mode = "Mode", playEpoch = "PlayEpoch", continuitySupported = "ContinuitySupported", connected = "Connected",
}
local function proof(): any return TestProof.new(game, "public-client-lifetime", artifactHash) end
local function assertPublic(snapshot: any): ()
  assert(type(snapshot) == "table" and table.isfrozen(snapshot), "fresh frozen public mapping")
  local count = 0
  for key, value in pairs(snapshot) do
    count += 1
    assert(fieldAttributes[key], "strict host schema rejects unexpected field: " .. key)
    assert(type(value) ~= "table" and type(value) ~= "function", "snapshot contains no service references")
    if type(value) == "string" then
      assert(not string.find(value, game.ApiKey, 1, true) and not string.find(value, game.SessionToken, 1, true), "no API key or session token")
    end
  end
  assert(count == 11, "host requires exactly eleven fields, including markerName")
  assert(snapshot.mode == "Edit" or snapshot.mode == "Play", "host Mode enum")
  assert(type(snapshot.playEpoch) == "number" and snapshot.playEpoch >= 0 and snapshot.playEpoch % 1 == 0, "integer epoch")
  assert(type(snapshot.connected) == "boolean" and type(snapshot.continuitySupported) == "boolean", "boolean flags")
  assert(string.match(snapshot.markerName, "^ArcaneTestProof_[A-Za-z0-9_-]+$") and #snapshot.markerName <= #"ArcaneTestProof_" + 128, "native witness name schema")
end
local function assertWitness(snapshot: any, witness: any): ()
  assertPublic(snapshot)
  assert(witness and witness.ClassName == "Folder" and witness.Parent == storage, "owned Edit folder")
  assert(witness.Name == snapshot.markerName and witness.Archivable == true, "runtime clones retain witness identity")
  local count = 0
  for _ in pairs(witness:GetAttributes()) do count += 1 end
  assert(count == 11, "marker has the eleven PascalCase public attributes")
  for key, attribute in pairs(fieldAttributes) do
    assert(witness:GetAttribute(attribute) == snapshot[key], "snapshot/attribute mapping: " .. key)
  end
end
local function bound(state: any, session: string?, writes: boolean?): (any, any)
  local snapshot = state:bind(session or "public-session", writes == true)
  local witness = storage:FindFirstChild(snapshot.markerName)
  assertWitness(snapshot, witness)
  return snapshot, witness
end
local function cloneWitness(witness: any, destination: any): any
  -- Independent simulation of a cloned runtime witness, never production code.
  local clone = instance("Folder")
  clone.Name, clone.Archivable = witness.Name, witness.Archivable
  clone._attributes = witness:GetAttributes()
  clone.Parent = destination
  return clone
end
`;

async function runFixture(checks) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-test-proof-fixture-'));
  try {
    const source = await readFile(sourcePath, 'utf8');
    const artifactHash = createHash('sha256').update(source).digest('hex');
    const harness = path.join(directory, 'test-proof.luau');
    await writeFile(harness, `--!strict\n${engine}\nlocal artifactHash = "${artifactHash}"\nlocal TestProof = (function()\n${source}\nend)()\n${helpers}\n${checks}\nprint("${completion}")\n`);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.ifError(compiled.error);
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(completion), 'production module completed the standalone Luau checks');
  } finally {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()), 'cleanup stays inside the temporary root');
    assert.ok(path.basename(target).startsWith('arcane-test-proof-fixture-'), 'cleanup targets only this generated fixture');
    await rm(target, { recursive: true, force: true });
  }
}

test('TestProof is a standalone strict module without transport credentials or active Studio operations', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.ok(source.startsWith('--!strict'));
  assert.doesNotMatch(source, /require\(|RequestAsync|GetAsync|SetSetting|GetSetting|sessionToken|apiKey|Authorization|task\.|RunStateChanged\s*[:.]/);
  assert.doesNotMatch(source, /GetService\("RunService"\)|GetPropertyChangedSignal\("RunState"\)|:IsEdit\(|:IsRunning\(/);
});

test('TestProof passes strict Luau analysis with only the native Instance global declared', {
  skip: !analyze && 'Set ARCANE_LUAU_ANALYZE for optional strict analysis.',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-test-proof-fixture-'));
  try {
    const source = await readFile(sourcePath, 'utf8');
    const harness = path.join(directory, 'analyze-test-proof.luau');
    await writeFile(harness, `--!strict\nlocal Instance: {new: (string) -> any} = {new = function(_className: string): any error("Analysis only") end}\nreturn (function()\n${source}\nend)()\n`);
    const result = spawnSync(analyze, [harness], { encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()), 'cleanup stays inside the temporary root');
    assert.ok(path.basename(target).startsWith('arcane-test-proof-fixture-'), 'cleanup targets only this generated fixture');
    await rm(target, { recursive: true, force: true });
  }
});

test('bound proof has exactly eleven public fields and one native identity witness, even for read-only grants', vmOptions, async () => {
  await runFixture(`
local state = proof()
assert(state:snapshot() == nil and #fixture.created == 0 and activeObservers() == 1, "construction only observes")
local first, witness = bound(state)
assert(first.connected and first.continuitySupported and first.mode == "Edit" and first.playEpoch == 0, "supported fresh binding")
assert(first.clientLifetimeId == "public-client-lifetime" and first.sessionId == "public-session" and first.pluginArtifactHash == artifactHash, "caller-supplied public provenance")
assert(first.placeId == 101 and first.universeId == 202 and first.placeName == "Fixture Place", "native model metadata")
for _ = 1, 100 do
  local nextSnapshot = state:bind("public-session", false)
  assertWitness(nextSnapshot, witness)
  assert(nextSnapshot ~= first and nextSnapshot.markerName == first.markerName, "fresh mapping and stable folder")
end
assert(#fixture.created == 1 and #storage:GetChildren() == 1 and activeObservers() == 1, "repeated bind/snapshot cannot accumulate witnesses or observers")
assert(#fixture.signalCalls == 1 and fixture.signalCalls[1] == "EditModeActive" and #fixture.serviceCalls == 3 and fixture.serviceCalls[1] == "StudioTestService", "only one genuine property observer and fixed Edit references")
state:stop()
assert(activeObservers() == 0 and witness._destroyed and state:snapshot() == nil, "stop releases owned resources")
`);
});

test('each EditModeActive transition advances the epoch; pause/resume remains Play without advancing', vmOptions, async () => {
  await runFixture(`
local state = proof()
local initial, witness = bound(state, "public-session", true)
for _, step in ipairs({{active = false, epoch = 1}, {active = false, epoch = 1, paused = true},
    {active = false, epoch = 1}, {active = true, epoch = 2}, {active = false, epoch = 3}, {active = true, epoch = 4}}) do
  transition(step.active)
  if step.paused then runtimeRun.RunState = runStates.Paused end
  local snapshot = state:snapshot()
  assert(snapshot.playEpoch == step.epoch and snapshot.mode == (if step.active then "Edit" else "Play"), "test lifecycle transitions count; pause/resume within one test does not")
  assertWitness(snapshot, witness)
end
transition(true)
assert(state:snapshot().playEpoch == 4 and initial.playEpoch == 0, "same-state requests do not advance and prior mappings never mutate")
state:stop()
`);
});

test('deferred stop/play/stop notifications latch even when every callback sees the original booleans', vmOptions, async () => {
  await runFixture(`
local state = proof()
local _, witness = bound(state)
transition(false, true)
transition(true, true)
assert(testService.EditModeActive == true and #fixture.deferred == 2, "the boolean returns to its initial value before callbacks run")
assert(state:snapshot().playEpoch == 0, "sampling before signal delivery never manufactures continuity")
flush()
assert(state:snapshot().playEpoch == 2 and state:snapshot().mode == "Edit", "each queued EditModeActive notification is retained")
for _ = 1, 1000 do transition(false, true); transition(true, true) end
flush()
assert(state:snapshot().playEpoch == 2002 and #fixture.created == 1 and activeObservers() == 1, "bounded state stores a counter, not transition history")
assertWitness(state:snapshot(), witness)
state:stop()
`);
});

test('native context regression: Edit RunState stays Stopped while EditModeActive tracks play and stop', vmOptions, async () => {
  await runFixture(`
local state = proof()
local initial, witness = bound(state)
assert(editRun.RunState.Name == "Stopped" and testService.EditModeActive == true, "idle Edit context")
transition(false)
assert(editRun.RunState.Name == "Stopped" and editRun:IsEdit() and not editRun:IsRunning(), "Edit RunService stays idle during a native playtest")
assert(runtimeRun.RunState.Name == "Running" and testService.EditModeActive == false, "runtime server runs while the Edit StudioTestService signals an active test")
local playing = state:snapshot()
assertWitness(playing, witness)
assert(playing.connected and playing.continuitySupported and playing.mode == "Play" and playing.playEpoch == 1, "the Edit owner reports play despite its dormant RunState")
transition(true)
local stopped = state:snapshot()
assertWitness(stopped, witness)
assert(stopped.mode == "Edit" and stopped.playEpoch == 2 and stopped.markerName == initial.markerName, "play then stop advances twice in the same Edit lifetime")
assert(editRun.RunState.Name == "Stopped" and #fixture.signalCalls == 1 and fixture.signalCalls[1] == "EditModeActive", "no RunState subscription or context fallback")
state:stop()
`);
});

test('cloned runtime markers stay identity witnesses while the Edit HTTP snapshot keeps advancing', vmOptions, async () => {
  await runFixture(`
local state = proof()
local initial, witness = bound(state)
local runtimeModel, runtimeStorage = instance("DataModel"), instance("ServerStorage")
runtimeStorage.Parent = runtimeModel
local clone = cloneWitness(witness, runtimeStorage)
services.ServerStorage = runtimeStorage -- A later lookup would resolve the wrong model.
transition(false)
local playing = state:snapshot()
assertWitness(playing, witness)
assert(playing.playEpoch == 1 and playing.mode == "Play", "HTTP proof advances in the lifetime owner")
assert(clone:GetAttribute("PlayEpoch") == initial.playEpoch and clone:GetAttribute("Mode") == "Edit", "cloned epoch/mode cannot prove runtime continuity")
for _, field in ipairs({"SessionId", "ClientLifetimeId", "PluginArtifactHash", "MarkerName"}) do
  assert(clone:GetAttribute(field) == witness:GetAttribute(field), "native correlation identity survives cloning")
end
transition(true)
assert(state:snapshot().playEpoch == 2 and state:snapshot().markerName == initial.markerName, "same Edit witness survives stop")
state:stop()
assert(witness._destroyed and not clone._destroyed and clone.Parent == runtimeStorage, "cleanup removes only the exact owned Edit object")
assert(#fixture.serviceCalls == 3, "no service lookup retargets the runtime copy")
`);
});

test('re-pair, grant changes, disconnect and stop revoke only exact unchanged owned markers', vmOptions, async () => {
  await runFixture(`
local unrelated = instance("Folder")
unrelated.Name, unrelated.Parent = "ArcaneTestProof_human", storage
unrelated:SetAttribute("HumanNote", "keep")
local state = proof()
local old, first = bound(state, "session-a")
transition(false); transition(true)
local changed, second = bound(state, "session-b", true)
assert(first._destroyed and fixture.destroyed[1].attributes.Connected == false and changed.markerName ~= old.markerName, "re-pair revokes the old witness before replacement")
assert(changed.playEpoch == 2 and activeObservers() == 1, "re-pair preserves the monotonic lifetime epoch and observer")
local _, third = bound(state, "session-b", false)
assert(second._destroyed and third ~= second, "changed grant cannot reuse a former scope witness")
state:disconnect(); state:disconnect()
assert(third._destroyed and state:snapshot() == nil and activeObservers() == 1, "idempotent disconnect clears pairing but observes the lifetime gap")
transition(false); transition(true)
local nextSnapshot, fourth = bound(state, "session-c")
assert(nextSnapshot.playEpoch == 4, "transitions during a disconnected gap cannot reset the epoch")
state:stop(); state:stop(); state:disconnect()
assert(fourth._destroyed and activeObservers() == 0 and state:bind("session-d", true) == nil, "stopped lifetime cannot be revived")
assert(not unrelated._destroyed and unrelated:GetAttribute("HumanNote") == "keep" and #storage:GetChildren() == 1, "unrelated marker-shaped content is untouched")
`);
});

for (const failure of ['failSignal', 'failConnect', 'deadConnection', 'failRead']) {
  test(`unavailable EditModeActive observer (${failure}) fails continuity closed without sampling an epoch`, vmOptions, async () => {
    await runFixture(`
fixture.${failure} = true
local state = proof()
local snapshot, witness = bound(state)
assert(not snapshot.connected and not snapshot.continuitySupported and snapshot.playEpoch == 0, "host accepts an unavailable proof, never invented continuity")
fixture.failRead = false -- Later readable samples cannot recover the missing observer.
testService._active = false
assert(state:snapshot().mode == "Play" and state:snapshot().playEpoch == 0, "current mode is informational without a signal")
testService._active = true
assertWitness(state:bind("public-session", false), witness)
assert(#fixture.created == 1 and activeObservers() == 0, "unsupported repeat binds cannot create observers or markers")
state:stop()
`);
  });
}

test('EditModeActive must be an actual boolean; truthy values never enable continuity', vmOptions, async () => {
  await runFixture(`
for _, bad in ipairs({{value = 0}, {value = 1}, {value = "true"}, {value = "false"}, {value = {}}, {}}) do
  testService._active = bad.value
  local state = proof()
  local snapshot, witness = bound(state)
  assert(not snapshot.connected and not snapshot.continuitySupported and snapshot.playEpoch == 0 and activeObservers() == 0, "non-boolean or missing EditModeActive fails before installing an observer")
  assert(#fixture.signalCalls == 0, "invalid property type cannot subscribe")
  testService._active = false
  local later = state:snapshot()
  assertWitness(later, witness)
  assert(later.mode == "Play" and later.playEpoch == 0 and not later.continuitySupported, "later valid property samples cannot fill the missing observer gap")
  testService._active = true
  state:stop()
end
`);
});

test('missing StudioTestService fails closed without using the dormant Edit RunService', vmOptions, async () => {
  await runFixture(`
for _, failure in ipairs({"failService", "nilService"}) do
  fixture[failure] = true
  local state = proof()
  local snapshot, witness = bound(state)
  assert(not snapshot.connected and not snapshot.continuitySupported and snapshot.playEpoch == 0 and activeObservers() == 0, "missing service produces an unavailable proof instead of throwing")
  fixture[failure] = false
  transition(false); transition(true)
  assertWitness(state:snapshot(), witness)
  assert(state:snapshot().playEpoch == 0 and not state:snapshot().connected, "no service reacquisition or sampled counter fallback")
  for _, name in ipairs(fixture.serviceCalls) do assert(name ~= "RunService", "dormant RunService is never consulted") end
  state:stop()
end
`);
});

test('observer must exist and report Connected equal to boolean true', vmOptions, async () => {
  await runFixture(`
for _, invalidFlag in ipairs({1, "true", {}}) do
  fixture.invalidConnectionFlag = invalidFlag
  local state = proof()
  local snapshot, witness = bound(state)
  assert(not snapshot.connected and not snapshot.continuitySupported and activeObservers() == 0, "truthy Connected values cannot certify a live observer")
  transition(false); transition(true)
  assertWitness(state:snapshot(), witness)
  assert(state:snapshot().playEpoch == 0, "invalid observer cannot publish an epoch")
  state:stop()
end
fixture.invalidConnectionFlag, fixture.nilObserver = nil, true
local state = proof()
local snapshot = bound(state)
assert(not snapshot.connected and not snapshot.continuitySupported and activeObservers() == 0, "nil observer fails closed")
state:stop()
`);
});

test('lost observer capability is sticky and never regains continuity through sampled mode', vmOptions, async () => {
  await runFixture(`
local state = proof()
local _, witness = bound(state)
transition(false)
fixture.failRead = true
local failed = state:snapshot()
assert(not failed.continuitySupported and not failed.connected and failed.playEpoch == 1 and activeObservers() == 0, "lost permission tears down the observer")
fixture.failRead = false
transition(true); transition(false)
local later = state:snapshot()
assert(later.playEpoch == 1 and not later.continuitySupported and not later.connected, "sampling cannot fill an observation gap")
assertWitness(later, witness)
state:stop()
`);
});

const foreignChanges = {
  attribute: 'witness:SetAttribute("HumanNote", "keep")',
  provenance: 'witness:SetAttribute("PluginArtifactHash", string.rep("b", 64))',
  child: 'local child = instance("Folder"); child.Name, child.Parent = "HumanChild", witness',
  name: 'witness.Name = "HumanRenamedWitness"',
  parent: 'local elsewhere = instance("Folder"); elsewhere.Parent = game; witness.Parent = elsewhere',
  archivable: 'witness.Archivable = false',
  tag: 'table.insert(witness._tags, "HumanTag")',
};
for (const [name, change] of Object.entries(foreignChanges)) {
  test(`foreign ${name} changes retain and invalidate the owned witness without overwriting human content`, vmOptions, async () => {
    await runFixture(`
local state = proof()
local _, witness = bound(state)
${change}
local foreignAttributes, foreignChildren, foreignTags = witness:GetAttributes(), witness:GetChildren(), witness:GetTags()
local foreignName, foreignParent, foreignArchivable = witness.Name, witness.Parent, witness.Archivable
local invalid = state:snapshot()
assertPublic(invalid)
assert(not invalid.connected and witness:GetAttribute("Connected") == false and witness:GetAttribute("Invalid") == true, "contested proof is explicitly revoked")
state:bind("another-session", true)
assert(#fixture.created == 1 and not state:snapshot().connected, "sticky fence prevents accumulating contested replacement folders")
state:disconnect(); state:stop()
assert(not witness._destroyed and #fixture.destroyed == 0, "foreign changes are never deleted")
assert(witness.Name == foreignName and witness.Parent == foreignParent and witness.Archivable == foreignArchivable, "foreign structural edits remain")
for key, value in pairs(foreignAttributes) do
  if key ~= "Connected" and key ~= "Invalid" then assert(witness:GetAttribute(key) == value, "foreign public attributes remain") end
end
assert(#witness:GetChildren() == #foreignChildren and #witness:GetTags() == #foreignTags, "foreign children and tags remain")
`);
  });
}

test('disconnect and stop detect foreign changes without a preceding heartbeat', vmOptions, async () => {
  await runFixture(`
for _, operation in ipairs({"disconnect", "stop", "rebind"}) do
  local state = proof()
  local _, witness = bound(state)
  witness:SetAttribute("HumanNote", "keep")
  if operation == "rebind" then state:bind("new-session", true) else state[operation](state) end
  assert(not witness._destroyed and witness:GetAttribute("HumanNote") == "keep" and witness:GetAttribute("Connected") == false and witness:GetAttribute("Invalid") == true, "cleanup validates before any metadata overwrite or deletion")
  state:stop()
end
assert(#fixture.destroyed == 0 and activeObservers() == 0, "only exact unchanged objects can be destroyed")
`);
});

test('same-name replacement and runtime clones are never adopted or removed', vmOptions, async () => {
  await runFixture(`
local state = proof()
local snapshot, witness = bound(state)
witness.Parent = nil
local replacement = cloneWitness(witness, storage)
state:stop()
assert(not witness._destroyed and witness:GetAttribute("Invalid") == true, "moved exact object is retained invalid")
assert(not replacement._destroyed and replacement.Parent == storage and replacement:GetAttribute("Connected") == true and replacement:GetAttribute("Invalid") == nil, "same-name foreign clone is untouched")
assert(#fixture.destroyed == 0, "cleanup never resolves ownership by a name")
`);
});

test('name collisions are retried within a fixed bound without touching existing folders', vmOptions, async () => {
  await runFixture(`
local existing = instance("Folder")
existing.Name, existing.Parent = "ArcaneTestProof_00000000-0000-4000-8000-000000000001", storage
existing:SetAttribute("HumanNote", "keep")
local firstState, secondState = proof(), proof()
local first, firstWitness = bound(firstState)
local second, secondWitness = bound(secondState)
assert(first.markerName ~= second.markerName and firstWitness ~= secondWitness and fixture.guid == 3, "one colliding GUID is skipped; lifetimes never share ownership")
firstState:stop(); secondState:stop()
assert(not existing._destroyed and existing:GetAttribute("HumanNote") == "keep", "collision occupant is untouched")
fixture.guidOverride = "00000000-0000-4000-8000-000000000001"
local before = fixture.guid
local state = proof()
local unavailable = state:bind("public-session", false)
assertPublic(unavailable)
assert(not unavailable.connected and fixture.guid == before + 4, "repeated collisions terminate with a schema-valid unavailable proof")
state:stop()
assert(not existing._destroyed, "even exhausted collision retries cannot modify an occupant")
`);
});

test('cleanup failure retains a revoked witness and stop ignores queued callbacks', vmOptions, async () => {
  await runFixture(`
local state = proof()
local _, witness = bound(state)
transition(false, true); transition(true, true)
fixture.failDestroy = true
state:stop()
local before = witness:GetAttributes()
assert(not witness._destroyed and before.Connected == false and before.Invalid == true and activeObservers() == 0, "failed deletion retains an invalid witness and still stops observing")
flush()
assert(witness:GetAttribute("PlayEpoch") == before.PlayEpoch and state:snapshot() == nil, "already queued callbacks cannot advance or publish after stop")
fixture.failDestroy = false
state:stop(); state:bind("later-session", true)
assert(not witness._destroyed and #fixture.created == 1, "a contested failed cleanup is not retried destructively")
`);
});

test('partial writes and foreign changes during publication fence the witness', vmOptions, async () => {
  await runFixture(`
local state = proof()
local _, witness = bound(state)
fixture.afterAttribute = function(target: any, key: string, _value: any): ()
  if target == witness and key == "PlayEpoch" then target._attributes.HumanNote = "keep" end
end
transition(false)
assert(not state:snapshot().connected and witness:GetAttribute("Invalid") == true and witness:GetAttribute("HumanNote") == "keep", "post-write readback catches a concurrent foreign edit")
state:stop()
assert(not witness._destroyed, "concurrently changed object cannot be cleaned up")
fixture.afterAttribute = nil
local nextState = proof()
transition(true)
local _, nextWitness = bound(nextState, "second-session")
fixture.failAttribute = true
transition(false)
assert(not nextState:snapshot().connected, "attribute write failure cannot remain connected")
fixture.failAttribute = false
nextState:stop()
assert(not nextWitness._destroyed and nextWitness:GetAttribute("Invalid") == true and nextWitness:GetAttribute("Connected") == false, "best-effort revocation resumes without deleting uncertain contents")
`);
});

test('a reentrant foreign edit to the next planned attribute is retained before that write', vmOptions, async () => {
  await runFixture(`
local state = proof()
local _, witness = bound(state)
local editedAttribute, editedValue
fixture.afterAttribute = function(target: any, key: string, _value: any): ()
  if target ~= witness or editedAttribute then return end
  if key == "Mode" then editedAttribute, editedValue = "PlayEpoch", 12345 end
  if key == "PlayEpoch" then editedAttribute, editedValue = "Mode", "HumanEditedMode" end
  if editedAttribute then target._attributes[editedAttribute] = editedValue end
end
transition(false)
assert(editedAttribute and witness:GetAttribute(editedAttribute) == editedValue, "foreign edit to another pending public field cannot be overwritten")
assert(not state:snapshot().connected and witness:GetAttribute("Invalid") == true, "reentrant edit fences the binding")
state:stop()
assert(not witness._destroyed and witness:GetAttribute(editedAttribute) == editedValue, "cleanup preserves the reentrant edit")
`);
});

test('invalid input fails with fixed diagnostics without leaking credentials or creating markers', vmOptions, async () => {
  await runFixture(`
for _, hash in ipairs({"", "not-a-sha", game.ApiKey, string.rep("x", 64)}) do
  local ok, message = pcall(TestProof.new, game, "public-client", hash)
  assert(not ok and not string.find(tostring(message), game.ApiKey, 1, true), "invalid provenance is never echoed")
end
local ok = pcall(TestProof.new, game, {}, artifactHash)
assert(not ok and #fixture.created == 0 and activeObservers() == 0, "invalid public metadata causes no side effects")
local state = proof()
assert(not pcall(function(): () state:bind({}, false) end), "binding accepts public session IDs, never a pair table with secrets")
assert(not pcall(function(): () state:bind("public-session", "yes") end), "write grant must be boolean")
assert(state:snapshot() == nil and #fixture.created == 0, "invalid bindings do not create witnesses")
state:stop()
`);
});
