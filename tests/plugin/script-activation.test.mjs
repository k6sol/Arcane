import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const modules = ['Validation', 'Registry', 'Properties', 'AssetMesh', 'Sha256Stream', 'AssetTransfer', 'AssetUpload', 'AssetPlacement', 'TerrainGen', 'Operations', 'Transport', 'TestProof'];
const runtimeOptions = { skip: !runtime && 'Standalone Luau runtime not configured; native Studio is not used by this test.' };
const marker = 'Arcane script activation fixture passed';

// Extend the existing doubles only in memory. Hooks simulate another editor or
// a mismatched engine readback; no production operation or guard is replaced.
const activationEngineFixture = `
fixture.disabledAssignments, fixture.editorUpdates, fixture.recordings = 0, 0, 0
local originalActivationSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(instance: any, key: string, value: any): ()
  local executionWrite = key == "Disabled" and instance:IsA("BaseScript")
  if executionWrite then fixture.disabledAssignments += 1 end
  originalActivationSetter(instance, key, value)
  if executionWrite and fixture.afterDisabledWrite then fixture.afterDisabledWrite(instance, value) end
end
local originalEditorUpdate = editor.UpdateSourceAsync
editor.UpdateSourceAsync = function(self: any, instance: any, callback: any): ()
  fixture.editorUpdates += 1
  originalEditorUpdate(self, instance, callback)
end
local history = game:GetService("ChangeHistoryService")
local originalBeginRecording = history.TryBeginRecording
history.TryBeginRecording = function(self: any, name: string, display: string): string?
  fixture.recordings += 1
  return originalBeginRecording(self, name, display)
end
`;

const helpers = `
local V = require(script.Parent.Validation)
local Transport = require(script.Parent.Transport)
fixture.encode = function(value: any): string return V.encode(value, http) end
local serial = 0
local source = "print('verified activation source')"
local laterSource = "print('later human source')"

local function client(writable: boolean?): any
  fixture.edit = true
  fixture.historyHook, fixture.afterDisabledWrite = nil, nil
  local transport = Transport.new(game, function(_status: any): () end)
  fixture.httpHook = function(request: any): any
    assert(request.Url == "http://127.0.0.1:45871/v1/plugin/pair", "only the mocked pairing route is used")
    return response({sessionId = "activation-session", token = "fixture-memory-token", protocolVersion = 1,
      allowedRoots = {"Workspace"}, allowWrites = writable ~= false})
  end
  transport:requestPair("http://127.0.0.1:45871", "fixture-pairing-code")
  transport:tick()
  assert(transport.pair ~= nil and transport.operations ~= nil, "production transport paired against the double")
  return transport
end

local function attached(transport: any, className: string, text: string, enabled: boolean): (any, any)
  local instance = Instance.new(className)
  instance.Name, instance.Source = className .. "ActivationFixture", text
  if instance:IsA("BaseScript") then instance.Disabled = not enabled end
  instance.Parent = game:GetService("Workspace")
  -- Editor and persisted storage remain independently observable.
  fixture.sources[instance] = text
  return instance, transport.operations.registry:ref(instance)
end

local function executionArgs(ref: any, text: string, before: boolean, after: boolean): any
  return {ref = ref, expectedSource = text, expectedEnabled = before, enabled = after}
end

local function run(transport: any, method: string, args: any): (any, any)
  serial += 1
  local command = {protocolVersion = 1, id = "activation-command-" .. serial, requestId = "activation-request-" .. serial,
    sessionId = transport.pair.sessionId, clientSessionId = transport.clientSessionId, method = method, args = args,
    allowedRoots = {"Workspace"}, allowWrites = transport.pair.allowWrites, leaseEpoch = serial,
    expiresAt = "2099-01-01T00:00:00.000Z", state = "dispatched"}
  transport:dispatch(command)
  local payload = transport.pending.body
  assert(payload.commandId == command.id and payload.sessionId == command.sessionId, "receipt targets the dispatched command")
  return payload, command
end

local function succeeds(transport: any, method: string, args: any): (any, any)
  local payload, command = run(transport, method, args)
  assert(payload.state == "succeeded", tostring(payload.error))
  return payload.result, command
end

local function refuses(transport: any, method: string, args: any, code: string): (any, any)
  local payload, command = run(transport, method, args)
  assert(payload.state == "failed" and string.sub(payload.error, 1, #code + 1) == code .. ":", tostring(payload.error))
  assert(transport.operations.mutations[command.id] == nil, "failed commands cannot issue restoration receipts")
  if code ~= "PARTIAL" then
    assert(payload.result == nil and not transport.pending.unsafe and not transport.blocked, "untouched refusals do not claim a partial outcome")
  end
  return payload, command
end

local function counters(): any
  return {writes = fixture.writes, assignments = fixture.disabledAssignments, updates = fixture.editorUpdates,
    recordings = fixture.recordings, committed = fixture.committed, cancelled = fixture.cancelled}
end

local function unchanged(before: any): ()
  assert(V.equal(counters(), before), "refused operation made no assignments, editor writes or undo recording")
end

local function receipt(transport: any, result: any, command: any, ref: any, before: boolean, after: boolean): ()
  assert(V.equal(result, {ref = ref, mutation = {kind = "script.set_enabled", ref = ref,
    before = {source = source, enabled = before}, after = {source = source, enabled = after}}}), "exact execution-state receipt")
  assert(V.equal(transport.operations.mutations[command.id], result.mutation), "receipt is registered for restoration")
  assert(table.isfrozen(result.mutation) and table.isfrozen(result.mutation.before) and table.isfrozen(result.mutation.after), "receipt snapshots are immutable")
end

local function partial(transport: any, payload: any, command: any, ref: any, reason: string): ()
  assert(string.find(payload.error, reason .. ":", 1, true), "partial result preserves the failure reason")
  assert(V.equal(payload.result, {partial = true, needsReconciliation = true, rollbackVerified = false,
    commandId = command.id, ref = ref}), "partial result identifies the ambiguous mutation and instance")
  local entry = transport.pending
  assert(entry.unsafe and transport.blocked and table.isfrozen(payload.result), "partial outcome fences the session and caches immutable recovery")
  local before = counters()
  transport:dispatch(command)
  assert(transport.pending == entry, "duplicate command resends the partial receipt")
  unchanged(before)
  local denied = run(transport, "script.set_enabled", executionArgs(ref, source, true, false))
  assert(denied.state == "failed" and string.sub(denied.error, 1, 8) == "SESSION:", "reconciliation blocks subsequent writes")
  unchanged(before)
end
`;

async function runActivationFixture(checks) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-script-activation-fixture-'));
  try {
    const [engine, ...sources] = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(name => readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')),
    ]);
    // Resolve script-relative imports exactly as in the source runtime tests.
    // Module bodies are unchanged; only their standalone require environment is supplied.
    const loader = `
local sourceModules, sourceCache = {}, {}
local script: any = {Parent = {}}
local function require(module: any): any
  if sourceCache[module.Name] == nil then sourceCache[module.Name] = sourceModules[module.Name]() end
  return sourceCache[module.Name]
end
` + modules.map((name, index) => `script.Parent.${name} = {Name = "${name}"}\nsourceModules["${name}"] = function()\n${sources[index]}\nend\n`).join('\n');
    const harness = path.join(directory, 'script-activation.luau');
    await writeFile(harness, engine + '\n' + activationEngineFixture + '\n' + loader + '\n' + helpers + '\n' + checks + `\nprint("${marker}")\n`);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.ifError(compiled.error);
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(marker), 'production Luau activation checks completed');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()), 'cleanup stays in the selected temporary directory');
    assert.ok(path.basename(directory).startsWith('arcane-script-activation-fixture-'), 'cleanup targets only this generated fixture');
    await rm(directory, { recursive: true, force: true });
  }
}

for (const className of ['Script', 'LocalScript']) {
  test(`${className} activation, disable and restoration issue exact immutable receipts`, runtimeOptions, async () => {
    await runActivationFixture(`
local transport = client()
local instance, ref = attached(transport, "${className}", source, false)
local before = counters()
local read = succeeds(transport, "script.read", {ref = ref})
assert(V.equal(read, {ref = ref, source = source, enabled = false}), "read includes the disabled execution state")
unchanged(before)
local activated, activateCommand = succeeds(transport, "script.set_enabled", executionArgs(ref, source, false, true))
receipt(transport, activated, activateCommand, ref, false, true)
assert(not instance.Disabled and succeeds(transport, "script.read", {ref = ref}).enabled == true, "activation is observable")
local afterActivation = counters()
transport:dispatch(activateCommand)
assert(transport.pending == transport.cache[activateCommand.id], "duplicate activation uses the original receipt")
unchanged(afterActivation)
local disabled, disableCommand = succeeds(transport, "script.set_enabled", executionArgs(ref, source, true, false))
receipt(transport, disabled, disableCommand, ref, true, false)
assert(instance.Disabled and succeeds(transport, "script.read", {ref = ref}).enabled == false, "disable is observable")
local tampered = {kind = disabled.mutation.kind, ref = ref,
  before = {source = source, enabled = false}, after = disabled.mutation.after}
before = counters()
refuses(transport, "scene.restore", {receiptCommandId = disableCommand.id, mutation = tampered}, "RECEIPT")
unchanged(before)
local restored = succeeds(transport, "scene.restore", {receiptCommandId = disableCommand.id, mutation = disabled.mutation})
assert(V.equal(restored, {restored = true, ref = ref}) and not instance.Disabled, "disable receipt restores activation")
assert(transport.operations.restored[disableCommand.id], "successful restore consumes its receipt")
restored = succeeds(transport, "scene.restore", {receiptCommandId = activateCommand.id, mutation = activated.mutation})
assert(V.equal(restored, {restored = true, ref = ref}) and instance.Disabled, "activation receipt restores disabled state")
assert(transport.operations.restored[activateCommand.id], "activation receipt is consumed only after restoration")
before = counters()
refuses(transport, "scene.restore", {receiptCommandId = activateCommand.id, mutation = activated.mutation}, "RECEIPT")
unchanged(before)
assert(instance.Source == source and fixture.sources[instance] == source and fixture.editorUpdates == 0, "execution-state changes preserve both source stores")
assert(fixture.disabledAssignments == afterActivation.assignments + 3 and fixture.committed == 4 and fixture.cancelled == 0, "each activation, disable and inverse writes once and commits")
`);
  });

  test(`${className} rejects wrong source or enabled baselines before activation and disable`, runtimeOptions, async () => {
    await runActivationFixture(`
for _, desired in ipairs({true, false}) do
  for _, baseline in ipairs({"source", "enabled"}) do
    local transport = client()
    local instance, ref = attached(transport, "${className}", source, not desired)
    local args = executionArgs(ref, source, not desired, desired)
    if baseline == "source" then args.expectedSource = laterSource else args.expectedEnabled = desired end
    local before = counters()
    refuses(transport, "script.set_enabled", args, "CONFLICT")
    unchanged(before)
    assert(instance.Disabled == desired and instance.Source == source and fixture.sources[instance] == source, "exact-baseline refusal preserves script")
  end
end
`);
  });

  test(`${className} rechecks source, enabled and persisted source inside the undo recording`, runtimeOptions, async () => {
    await runActivationFixture(`
for _, desired in ipairs({true, false}) do
  for _, changed in ipairs({"source", "enabled", "persistedSource"}) do
    if changed == "persistedSource" and not desired then continue end
    local transport = client()
    local instance, ref = attached(transport, "${className}", source, not desired)
    fixture.historyHook = function(): ()
      fixture.historyHook = nil
      if changed == "source" then fixture.sources[instance] = laterSource
      elseif changed == "enabled" then instance._properties.Disabled = not desired
      else instance._properties.Source = laterSource end
    end
    local before = counters()
    refuses(transport, "script.set_enabled", executionArgs(ref, source, not desired, desired),
      if changed == "persistedSource" then "UNSAVED_SOURCE" else "CONFLICT")
    assert(fixture.disabledAssignments == before.assignments and fixture.editorUpdates == before.updates and fixture.writes == before.writes, "no execution assignment after the second baseline check fails")
    assert(fixture.recordings == before.recordings + 1 and fixture.cancelled == before.cancelled + 1 and fixture.committed == before.committed, "untouched recording is cancelled")
    assert(instance.Disabled == (if changed == "enabled" then not desired else desired), "later human state is preserved")
    assert(fixture.sources[instance] == (if changed == "source" then laterSource else source), "later editor source is preserved")
    assert(instance.Source == (if changed == "persistedSource" then laterSource else source), "later persisted source is preserved")
  end
end
`);
  });

  test(`${className} refuses dirty editor activation and dirty-source reactivation by restore`, runtimeOptions, async () => {
    await runActivationFixture(`
local transport = client()
local instance, ref = attached(transport, "${className}", laterSource, false)
fixture.sources[instance] = source
local read = succeeds(transport, "script.read", {ref = ref})
assert(read.source == source and read.enabled == false and instance.Source == laterSource, "read reports the editor baseline independently of persisted source")
local before = counters()
refuses(transport, "script.set_enabled", executionArgs(ref, source, false, true), "UNSAVED_SOURCE")
unchanged(before)
assert(instance.Disabled and instance.Source == laterSource and fixture.sources[instance] == source, "dirty activation is untouched")
-- A running script can still be disabled even while its editor buffer is dirty.
instance.Disabled = false
local disabled, command = succeeds(transport, "script.set_enabled", executionArgs(ref, source, true, false))
receipt(transport, disabled, command, ref, true, false)
before = counters()
refuses(transport, "scene.restore", {receiptCommandId = command.id, mutation = disabled.mutation}, "UNSAVED_SOURCE")
unchanged(before)
assert(instance.Disabled and not transport.operations.restored[command.id], "refused reactivation does not consume the disable receipt")
assert(instance.Source == laterSource and fixture.sources[instance] == source and fixture.editorUpdates == 0, "dirty buffers are never implicitly saved")
`);
  });

  test(`${className} refuses empty and whitespace-only activation`, runtimeOptions, async () => {
    await runActivationFixture(`
local transport = client()
for _, text in ipairs({"", " \\t\\r\\n"}) do
  local instance, ref = attached(transport, "${className}", text, false)
  local before = counters()
  refuses(transport, "script.set_enabled", executionArgs(ref, text, false, true), "SOURCE_EMPTY")
  unchanged(before)
  assert(instance.Disabled and instance.Source == text and fixture.sources[instance] == text, "placeholder remains disabled")
end
`);
  });

  test(`${className} restore refuses later source and enabled-state changes`, runtimeOptions, async () => {
    await runActivationFixture(`
for _, desired in ipairs({true, false}) do
  for _, changed in ipairs({"source", "enabled"}) do
    local transport = client()
    local instance, ref = attached(transport, "${className}", source, not desired)
    local result, command = succeeds(transport, "script.set_enabled", executionArgs(ref, source, not desired, desired))
    if changed == "source" then fixture.sources[instance] = laterSource else instance.Disabled = desired end
    local before = counters()
    refuses(transport, "scene.restore", {receiptCommandId = command.id, mutation = result.mutation}, "CONFLICT")
    unchanged(before)
    assert(not transport.operations.restored[command.id], "conflicting restore does not consume its receipt")
    assert(instance.Disabled == (if changed == "enabled" then desired else not desired), "restore preserves later state")
    assert(fixture.sources[instance] == (if changed == "source" then laterSource else source) and instance.Source == source, "restore preserves later source")
  end
end
`);
  });

  test(`${className} created-instance restore preserves a later human enabled state`, runtimeOptions, async () => {
    await runActivationFixture(`
local transport = client()
local ops = transport.operations
local created, command = succeeds(transport, "scene.create", {parent = ops.registry:ref(game:GetService("Workspace")), className = "${className}", name = "OwnedActivationFixture"})
local instance = ops.registry:resolve(created.ref)
assert(instance.Disabled and ops.registry.owned[instance].enabled == false, "creation owns the disabled execution baseline")
instance.Disabled = false
local before = counters()
refuses(transport, "scene.restore", {receiptCommandId = command.id, mutation = created.mutation}, "CONFLICT")
unchanged(before)
assert(not instance.Disabled and not instance._destroyed and instance.Parent == game:GetService("Workspace"), "human enabled instance is retained")
assert(not ops.restored[command.id], "conflicting create restore remains unconsumed")
instance.Disabled = true
local restored = succeeds(transport, "scene.restore", {receiptCommandId = command.id, mutation = created.mutation})
assert(restored.restored and instance._destroyed and instance.Parent == nil and ops.restored[command.id], "unchanged owned baseline remains restorable")
`);
  });

  test(`${className} production edit guard refuses before writing and reports partial after writing`, runtimeOptions, async () => {
    await runActivationFixture(`
for _, desired in ipairs({true, false}) do
  for _, phase in ipairs({"dispatch", "recording", "afterAssignment"}) do
    local transport = client()
    local instance, ref = attached(transport, "${className}", source, not desired)
    if phase == "dispatch" then fixture.edit = false
    elseif phase == "recording" then
      fixture.historyHook = function(): () fixture.edit = false; fixture.historyHook = nil end
    else
      fixture.afterDisabledWrite = function(_instance: any, _value: boolean): () fixture.edit = false end
    end
    local before = counters()
    local payload, command = refuses(transport, "script.set_enabled", executionArgs(ref, source, not desired, desired),
      if phase == "afterAssignment" then "PARTIAL" else "PLAY")
    if phase == "dispatch" then unchanged(before)
    elseif phase == "recording" then
      assert(fixture.disabledAssignments == before.assignments and fixture.writes == before.writes, "recording guard prevents assignment")
      assert(fixture.recordings == before.recordings + 1 and fixture.cancelled == before.cancelled + 1 and fixture.committed == before.committed, "pre-write edit guard cancels the untouched recording")
    else
      assert(fixture.disabledAssignments == before.assignments + 1 and fixture.writes == before.writes + 1, "only the requested state was assigned")
      assert(fixture.committed == before.committed + 1 and fixture.cancelled == before.cancelled, "post-write edit guard retains the touched recording")
      partial(transport, payload, command, ref, "PLAY")
    end
    assert(instance.Disabled == (if phase == "afterAssignment" then not desired else desired), "guard preserves the observed outcome without broad rollback")
    assert(instance.Source == source and fixture.sources[instance] == source and fixture.editorUpdates == 0, "edit guard never writes source")
  end
end
`);
  });

  test(`${className} post-write state or source mismatch yields partial recovery`, runtimeOptions, async () => {
    await runActivationFixture(`
for _, desired in ipairs({true, false}) do
  for _, mismatch in ipairs({"enabled", "editorSource", "persistedSource"}) do
    if mismatch == "persistedSource" and not desired then continue end
    local transport = client()
    local instance, ref = attached(transport, "${className}", source, not desired)
    fixture.afterDisabledWrite = function(target: any, value: boolean): ()
      assert(target == instance, "hook targets the requested script")
      if mismatch == "enabled" then target._properties.Disabled = not value
      elseif mismatch == "editorSource" then fixture.sources[target] = laterSource
      else target._properties.Source = laterSource end
    end
    local before = counters()
    local payload, command = refuses(transport, "script.set_enabled", executionArgs(ref, source, not desired, desired), "PARTIAL")
    assert(fixture.disabledAssignments == before.assignments + 1 and fixture.writes == before.writes + 1 and fixture.editorUpdates == before.updates, "one execution assignment and no compensating write")
    assert(fixture.recordings == before.recordings + 1 and fixture.committed == before.committed + 1 and fixture.cancelled == before.cancelled, "mismatched touched recording is retained")
    assert(instance.Disabled == (if mismatch == "enabled" then desired else not desired), "partial retains actual execution state")
    assert(fixture.sources[instance] == (if mismatch == "editorSource" then laterSource else source), "partial retains actual editor source")
    assert(instance.Source == (if mismatch == "persistedSource" then laterSource else source), "partial retains actual persisted source")
    partial(transport, payload, command, ref, "VERIFY")
  end
end
`);
  });
}

test('prospective expanded execution receipt is refused before any state/history write', runtimeOptions, async () => {
  await runActivationFixture(`
local transport = client()
local expanded = string.rep(string.char(1), 50000)
local instance, ref = attached(transport, "Script", expanded, true)
local before = counters()
local ok, err = pcall(function()
  return transport.operations:execute({id = "receipt-size-direct-core", method = "script.set_enabled", args = executionArgs(ref, expanded, true, false)}, function() end)
end)
assert(not ok and type(err) == "table" and err.code == "BODY_LIMIT", "source fits 100 KiB but escaped before/after receipt exceeds 512 KiB")
unchanged(before)
assert(not instance.Disabled, "the rejected disable never changed engine state")
`);
});

test('global active play fences edits even when the Edit RunService context reports IsEdit', runtimeOptions, async () => {
  await runActivationFixture(`
local transport=client()
local instance,ref=attached(transport,"Script",source,false)
fixture.edit=true
game:GetService("StudioTestService").EditModeActive=false
assert(game:GetService("RunService"):IsEdit(),"the Edit context stays idle")
local before=counters()
refuses(transport,"script.set_enabled",executionArgs(ref,source,false,true),"PLAY")
unchanged(before)
assert(instance.Disabled,"no mutation during a globally active test")
`);
});

test('ModuleScript read has no enabled state and rejects activation and disable', runtimeOptions, async () => {
  await runActivationFixture(`
local transport = client()
local instance, ref = attached(transport, "ModuleScript", source, false)
local before = counters()
local read = succeeds(transport, "script.read", {ref = ref})
assert(V.equal(read, {ref = ref, source = source}) and read.enabled == nil, "module read omits execution state")
unchanged(before)
for _, desired in ipairs({true, false}) do
  refuses(transport, "script.set_enabled", executionArgs(ref, source, not desired, desired), "CLASS")
  unchanged(before)
end
assert(instance.Source == source and fixture.sources[instance] == source, "module source is preserved")
local created, command = succeeds(transport, "scene.create", {parent = transport.operations.registry:ref(game:GetService("Workspace")), className = "ModuleScript", name = "OwnedModuleFixture"})
local owned = transport.operations.registry:resolve(created.ref)
assert(transport.operations.registry.owned[owned].enabled == nil, "modules have no owned execution-state baseline")
assert(succeeds(transport, "scene.restore", {receiptCommandId = command.id, mutation = created.mutation}).restored and owned._destroyed, "module creation remains restorable")
`);
});

test('script activation requires boolean states and a transport write grant', runtimeOptions, async () => {
  await runActivationFixture(`
for _, className in ipairs({"Script", "LocalScript"}) do
  local transport = client()
  local instance, ref = attached(transport, className, source, false)
  local before = counters()
  for _, args in ipairs({{ref = ref, expectedSource = source, expectedEnabled = 0, enabled = true},
    {ref = ref, expectedSource = source, expectedEnabled = false, enabled = "true"},
    {ref = ref, expectedSource = source, enabled = true},
    {ref = ref, expectedSource = source, expectedEnabled = false}}) do
    refuses(transport, "script.set_enabled", args, "INPUT")
    unchanged(before)
  end
  transport = client(false)
  instance, ref = attached(transport, className, source, false)
  before = counters()
  refuses(transport, "script.set_enabled", executionArgs(ref, source, false, true), "GRANT")
  unchanged(before)
  assert(instance.Disabled, "read-only grant cannot activate a script")
end
`);
});
