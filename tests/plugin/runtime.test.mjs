import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PLUGIN_SOURCES, renderPlugin } from '../../scripts/build-plugin.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const LOCAL_KEY_SETTING = 'Arcane.LocalApiKey.v1';
const LAST_CONNECTION_SETTING = 'Arcane.LastConnection.v1';

// Adapt the standalone fixture in memory: Color3 channels are float32 and a
// BasePart.Color setter stores RGB8. This models the supplied native probe;
// it never changes the production codec or quantizes GUI colour properties.
const colorEngineFixture = `
local colorScratch = buffer.create(4)
local function colorFloat32(value: number): number
  buffer.writef32(colorScratch, 0, value)
  return buffer.readf32(colorScratch, 0)
end
Color3.new = triple
Color3.fromRGB = function(r: number, g: number, b: number): any return Color3.new(r / 255, g / 255, b / 255) end
local function storedColor(value: any): any
  return Color3.fromRGB(math.floor(colorFloat32(value.R * 255)), math.floor(colorFloat32(value.G * 255)), math.floor(colorFloat32(value.B * 255)))
end
-- Independent Y-X-Z rotation double, including the nine float32 matrix cells.
local CFrame: any = {}
function CFrame.fromOrientation(x: number, y: number, z: number): any
  local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
  local components = {0, 0, 0, cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
  for index = 4, 12 do components[index] = colorFloat32(components[index]) end
  return {GetComponents = function(_self: any): ...number return table.unpack(components) end}
end
local colorOriginalIndex = instanceMetatable.__index
instanceMetatable.__index = function(self: any, key: string): any
  if key == "CFrame" and self:IsA("BasePart") then
    return CFrame.fromOrientation(math.rad(self.Orientation.X), math.rad(self.Orientation.Y), math.rad(self.Orientation.Z))
  end
  return colorOriginalIndex(self, key)
end
local colorOriginalSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if key == "Color" and self:IsA("BasePart") then value = storedColor(value) end
  if key == "Orientation" and self:IsA("BasePart") and fixture.orientationReadback then value = fixture.orientationReadback end
  colorOriginalSetter(self, key, value)
end
local colorOriginalNew = Instance.new
Instance.new = function(className: string): any
  local instance = colorOriginalNew(className)
  if instance:IsA("BasePart") then instance._properties.Color = storedColor(instance.Color) end
  return instance
end
`;

// Capture the real transport constructed by Main. All exchanges, status callbacks
// and worker cycles still run the production methods against the engine doubles.
const captureTransport = `
local fixturePrint = print
fixture.logs = {}
local print = function(...: any): ()
  local parts = {}
  for _, value in ipairs({...}) do table.insert(parts, tostring(value)) end
  table.insert(fixture.logs, table.concat(parts, " "))
end
local warn = print
local fixtureTransport = __arcaneRequire("Transport")
local originalTransportNew = fixtureTransport.new
fixture.transports = {}
fixture.statuses = {}
fixtureTransport.new = function(gameModel: any, onStatus: any): any
  local client = originalTransportNew(gameModel, function(status: any): ()
    table.insert(fixture.statuses, status)
    onStatus(status)
  end)
  table.insert(fixture.transports, client)
  return client
end
`;

const uiFixture = `
local keySetting, lastSetting = "${LOCAL_KEY_SETTING}", "${LAST_CONNECTION_SETTING}"
local key = "arcane_local_v1_45871_" .. string.rep("a", 64)
local otherKey = "arcane_local_v1_45872_" .. string.rep("b", 64)
local green = Color3.fromRGB(71, 203, 133)
local inputs, controls = {}, {}
local brand, header, inputPanel, mark, content
for _, instance in ipairs(fixture.created) do
  if instance:IsA("TextBox") then table.insert(inputs, instance) end
  if instance:IsA("TextButton") then table.insert(controls, instance) end
  assert(instance.Name ~= "MaskedKey", "no overlay can intercept native key entry")
  if instance.Name == "Brand" then brand = instance end
  if instance.Name == "Header" then header = instance end
  if instance.Name == "KeyInput" then inputPanel = instance end
  if instance.Name == "ArcaneMark" then mark = instance end
  if instance.Name == "Content" then content = instance end
  assert(not table.find({"WhiteStroke", "OrangeStroke", "Subtitle", "ConnectionStatus", "ConnectionDot", "Divider", "Footer", "Grants", "Detail"}, instance.Name), "only the requested minimal UI")
end
assert(#inputs == 1 and #controls == 1 and inputs[1].Name == "ApiKey", "exactly one key field and one connection control")
local keyInput, control = inputs[1], controls[1]
assert(control.Name == "Connect" and control.Text ~= "Disconnect", "connection control never toggles to Disconnect")
assert(keyInput.TextTransparency == 0 and keyInput.MaxVisibleGraphemes == -1 and not keyInput.RichText and not keyInput.MultiLine and not keyInput.ClearTextOnFocus, "ordinary editable textbox displays current and saved key text")
assert(keyInput.ZIndex == 3 and keyInput.TextEditable, "native input has its own unobstructed editing layer")
assert(keyInput.Active and keyInput.Selectable and keyInput.TextEditable, "key input accepts native focus and editing")
assert(keyInput.Position[1] == 0 and keyInput.Position[2] == 0 and keyInput.Position[3] == 0 and keyInput.Position[4] == 0 and keyInput.Size[1] == 1 and keyInput.Size[2] == 0 and keyInput.Size[3] == 1 and keyInput.Size[4] == 0, "the entire key entry is an editable hit area")
assert(fixture.widgetInfo[1] == Enum.InitialDockState.Float and fixture.widgetInfo[2] == true and fixture.widgetInfo[3] == true, "startup opens a floating popup even after a previously hidden session")
assert(fixture.widgetInfo[4] == 260 and fixture.widgetInfo[5] == 184 and fixture.widgetInfo[6] == 230, "compact default content area and minimum width")
assert(__arcaneRequire("Validation").VERSION == "0.1.9", "runtime advertises plugin 0.1.9")
local bottomPadding
for _, child in ipairs(control.Parent:GetChildren()) do
  if child:IsA("UIPadding") then bottomPadding = child.PaddingBottom.Offset end
end
assert(bottomPadding and bottomPadding >= 18, "comfortable bottom padding below connection and failure UI")
assert(header.Size[4] == 48 and inputPanel.Position[4] == 54 and control.Position[4] == 100, "fixed compact layout puts the key above Connect")
assert(brand and brand.Text == "Arcane" and brand.TextSize >= 16 and brand.TextSize <= 20, "compact Arcane brand")
assert(mark and #mark:GetChildren() > 64 and mark.BackgroundTransparency == 1, "the SVG mark is rendered as native scanline frames")
for _, strip in ipairs(mark:GetChildren()) do
  assert(strip:IsA("Frame") and strip.BackgroundColor3 == Color3.fromRGB(255, 51, 64), "all logo scanlines use the exact Arcane red")
  assert(strip.Position[1] >= 0 and strip.Position[3] >= 0 and strip.Position[1] + strip.Size[1] <= 1 and strip.Position[3] + strip.Size[3] <= 1, "scanlines remain inside the compact logo")
  assert(strip.Size[3] == 1 / 64 and strip.Size[1] > 0 and strip.Position[2] == 0 and strip.Position[4] == 0, "logo uses sixty-four bounded fractional rows")
  assert(strip.BackgroundTransparency == (if string.sub(strip.Name, 1, 9) == "LogoFacet" then 0.2 else 0), "scanline opacity preserves the desktop facet")
end
assert(fixture.widgetInfo[7] == 176, "compact minimum content height")
assert(fixture.widgetInfo[7] >= control.Position[4] + control.Size[4] + bottomPadding, "minimum content bounds fit the entire button and bottom padding without assuming host chrome height")
assert(content and header.Parent == content and inputPanel.Parent == content and control.Parent == content, "all controls share the centered content frame")
assert(content.Parent:IsA("Frame") and content.Size[3] == 0, "fixed content needs no scrolling canvas")
for _, height in ipairs({fixture.widgetInfo[7], fixture.widgetInfo[5], 240}) do
  local top = height * content.Position[3] + content.Position[4]
  local bottom = top + control.Position[4] + control.Size[4]
  assert(top >= 0 and top + content.Size[4] <= height, "entire content frame stays inside the widget")
  assert(bottom + bottomPadding <= height, "button and bottom padding are never cropped")
  assert(top + mark.Position[4] == height - bottom, "logo and button have balanced outer margins")
  assert(top + header.Size[4] <= top + inputPanel.Position[4] and inputPanel.Position[4] + inputPanel.Size[4] < control.Position[4], "header, key and button never overlap")
end
assert(#fixture.workers == 1 and #fixture.transports == 1, "exactly one transport worker")
local client = fixture.transports[1]
local worker = coroutine.create(fixture.workers[1])
task.wait = function(seconds: number): () assert(seconds == 0 or (seconds >= 2 and seconds <= 30), "original backoff bounds or an immediate post-dispatch continuation"); coroutine.yield() end
local function cycle(): () local ok, err = coroutine.resume(worker); assert(ok, tostring(err)) end
local function enter(value: any): () keyInput.Text = value; keyInput:GetPropertyChangedSignal("Text"):Fire() end
local function storageBoundaries(): ()
  for _, name in ipairs(fixture.getCalls) do assert(name == keySetting or name == lastSetting, "only Arcane-owned settings are read") end
  assert(#fixture.getCalls >= 2, "both owned settings are read")
  for _, call in ipairs(fixture.setCalls) do
    if call.key == keySetting then
      assert(type(call.value) == "string" and (call.value == "" or pcall(__arcaneRequire("Validation").keyOrigin, call.value)), "only validated Arcane local keys or an owned empty-key deletion are persisted")
    else
      assert(call.key == lastSetting and type(call.value) == "table" and type(call.value.connected) == "boolean", "only primitive last connection status is persisted")
      local count = 0
      for name in pairs(call.value) do count += 1; assert(name == "connected" or (name == "autoConnect" and call.value.autoConnect == false), "only transient health and explicit opt-out can be persisted") end
      assert(count == 1 or (count == 2 and call.value.autoConnect == false), "no session token, identity or grants are persisted")
    end
  end
  assert(fixture.pluginSettings["Provider.ApiKey"] == "unrelated-provider-secret", "unrelated provider key is untouched")
  assert(fixture.pluginSettings["Arcane.SessionToken.v1"] == "unrelated-session-secret", "unrelated session token is untouched")
  assert(fixture.pluginSettings["Arcane.Grants.v1"].allowWrites == true, "unrelated grants are untouched")
end
local function noSecretText(): ()
  for _, instance in ipairs(fixture.created) do
    if instance ~= keyInput and type(instance.Text) == "string" then
      for _, secret in ipairs({key, otherKey, "unrelated-provider-secret", "unrelated-session-secret", "ui-token"}) do
        assert(not string.find(instance.Text, secret, 1, true), "no credential is rendered as public text")
      end
    end
  end
  for _, line in ipairs(fixture.logs) do
    for _, secret in ipairs({key, otherKey, "unrelated-provider-secret", "unrelated-session-secret", "ui-token"}) do
      assert(not string.find(line, secret, 1, true), "no credential or user text is logged")
    end
  end
end
local connectCount, disconnectCount, pollCount, statusCount = 0, 0, 0, 0
local expectKey = key
http.RequestAsync = function(_self: any, request: any): any
  fixture.requests += 1
  if fixture.uiHttpHook then return fixture.uiHttpHook(request) end
  if string.find(request.Url, "/v1/plugin/status", 1, true) then
    statusCount += 1
    local v = __arcaneRequire("Validation")
    local payload = v.decode(request.Body, http)
    assert(request.Headers.Authorization == nil and payload.apiKey == expectKey, "status authenticates only the exact saved Arcane key")
    return {StatusCode = 200, Success = true, Body = v.encode({protocolVersion = 1, identity = payload.identity,
      state = if payload.sessionId then "lost" else "absent", sessionId = payload.sessionId}, http)}
  end
  if string.find(request.Url, "/v1/plugin/connect", 1, true) then
    connectCount += 1
    local payload = __arcaneRequire("Validation").decode(request.Body, http)
    assert(request.Headers.Authorization == nil and payload.apiKey == expectKey, "actual Main explicit key exchange")
    local v = __arcaneRequire("Validation")
    return {StatusCode = 200, Success = true, Body = v.encode({sessionId = if connectCount == 1 then "ui-session" else "ui-session-" .. tostring(connectCount),
      token = "ui-token", protocolVersion = 1, allowedRoots = v.array({"Workspace"}), allowWrites = false}, http)}
  end
  assert(request.Headers.Authorization == "Bearer ui-token", "live session token is transport-only")
  if string.find(request.Url, "/v1/plugin/disconnect", 1, true) then
    disconnectCount += 1
    return {StatusCode = 200, Success = true, Body = '{"revoked":true}'}
  end
  assert(string.find(request.Url, "/v1/plugin/poll", 1, true), "only owned fixture routes")
  pollCount += 1
  return {StatusCode = 200, Success = true, Body = '{"commands":[]}'}
end
local function idleMount(): ()
  assert(client.desiredPair == nil and client.pair == nil and fixture.requests == 0 and #fixture.setCalls == 0, "mount never connects, probes or writes settings")
  assert(control.BackgroundColor3 ~= green, "cached connection never makes restart green")
  assert(fixture.widget.Enabled and fixture.button.active, "startup shows the popup and synchronizes toolbar state without connecting")
  fixture.button.Click:Fire(); fixture.widget:GetPropertyChangedSignal("Enabled"):Fire()
  assert(not fixture.widget.Enabled and not fixture.button.active, "toolbar closes the popup without connecting")
  fixture.button.Click:Fire(); fixture.widget:GetPropertyChangedSignal("Enabled"):Fire()
  assert(fixture.widget.Enabled and fixture.button.active, "toolbar reopens the popup without connecting")
  cycle(); cycle()
  assert(fixture.requests == 0 and #fixture.setCalls == 0 and #fixture.workers == 1, "idle worker and toolbar do not probe or autoconnect")
end
local function clickConnect(): ()
  local submitted = keyInput.Text
  control.Activated:Fire()
  assert(keyInput.Text == submitted and control.Text == "Reconnect" and client.desiredPair ~= nil, "explicit click keeps the raw key visible and queues a reconnect intent")
  assert(control.BackgroundColor3 ~= green and #fixture.workers == 1, "intent alone cannot claim live green or spawn another worker")
end
local function ack(): ()
  cycle()
  assert(client.pair ~= nil and client.desiredPair == nil and not client.blocked, "actual ACK establishes a live transport")
  assert(control.Text == "Connected" and control.BackgroundColor3 == green, "Connected and green require current live ACK")
  assert(fixture.pluginSettings[lastSetting].connected == true, "only live ACK persists connected true")
end
local function unload(): ()
  local writes, requests = #fixture.setCalls, fixture.requests
  plugin.Unloading:Fire()
  assert(keyInput.Text == "" and client.stopped and client.desiredPair == nil and client.pair == nil, "unload clears raw text and transport secret memory")
  assert(#fixture.setCalls == writes and fixture.requests == requests, "unload never erases saved key or launches a request")
  assert(fixture.widget._destroyed and fixture.toolbar.destroyed and not fixture.button.Click.connections[1].Connected, "unload destroys UI and disconnects bindings")
  storageBoundaries(); noSecretText()
  for _, line in ipairs(fixture.logs) do assert(not string.find(line, "arbitrary-unsubmitted-user-text", 1, true), "user text is never logged") end
end
`;

const unrelatedSettings = `
fixture.pluginSettings = {
  ["Provider.ApiKey"] = "unrelated-provider-secret",
  ["Arcane.SessionToken.v1"] = "unrelated-session-secret",
  ["Arcane.Grants.v1"] = {allowWrites = true, allowedRoots = {"Workspace"}},
}
`;

async function runLuauFixture({ setup = '', checks, core = false, format = 'generated', editingCase, reconnectCase }) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-luau-ui-'));
  try {
    const sources = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) =>
      ({ filename, source: await readFile(path.join(repository, 'plugin/src', filename), 'utf8') })));
    const { lua } = renderPlugin(sources);
    const bundlePath = path.join(outDir, 'ArcaneLocalBridge.lua');
    await writeFile(bundlePath, lua);
    const compiled = spawnSync(compile, ['--null', bundlePath], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const [prelude, gui, logic, editing, reconnect] = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      // Adapt only the GUI double's old identity assertion to the compact widget.
      readFile(path.join(repository, 'plugin/fixtures/MockPlugin.luau'), 'utf8')
        .then(source => source.replace('id == "ArcaneLocalBridgeFloatingV2"', 'id == "ArcaneLocalBridgeFloatingV3"')),
      core ? readFile(path.join(repository, 'plugin/fixtures/Logic.spec.luau'), 'utf8') : Promise.resolve(''),
      editingCase ? readFile(path.join(repository, 'plugin/fixtures/KeyInput.spec.luau'), 'utf8') : Promise.resolve(''),
      reconnectCase ? readFile(path.join(repository, 'plugin/fixtures/Reconnect.spec.luau'), 'utf8') : Promise.resolve(''),
    ]);
    let instrumented;
    if (format === 'source') {
      // Resolve the real, unchanged script-relative imports with standalone VM
      // module doubles; this path never executes renderPlugin's module wrappers.
      instrumented = `
local sourceModules, sourceCache = {}, {}
local function __arcaneRequire(name: string): any
  if sourceCache[name] == nil then sourceCache[name] = sourceModules[name]() end
  return sourceCache[name]
end
local function require(module: any): any return __arcaneRequire(module.Name) end
local script: any = {Parent = {}}
` + PLUGIN_SOURCES.slice(1).map(([name]) => `script.${name} = {Name = "${name}"}; script.Parent.${name} = script.${name}\n`).join('')
        + PLUGIN_SOURCES.slice(1).map(([name, , filename]) => `sourceModules["${name}"] = function()\n${sources.find(file => file.filename === filename).source}\nend\n`).join('')
        + captureTransport + '\nlocal function fixtureMain(): ()\n' + sources.find(file => file.filename === 'Main.server.luau').source + '\nend\nfixtureMain()\nfixture.reloadMain = fixtureMain\n';
    } else {
      assert.equal(format, 'generated');
      instrumented = lua.replace('-- BEGIN Main.server.luau\n', captureTransport + '\n-- BEGIN Main.server.luau\n');
      assert.notEqual(instrumented, lua, 'Only the fixture captures transport construction before the unchanged Main body.');
      instrumented += '\nfixture.reloadMain = __arcaneMain\n';
    }
    const harness = path.join(outDir, 'ui-harness.luau');
    await writeFile(harness, prelude + '\n' + unrelatedSettings + setup + '\n' + gui + '\n' + colorEngineFixture + '\n' + instrumented + '\n' + uiFixture + checks + (editingCase ? `\nfixture.keyInputCase = "${editingCase}"\n${editing}\n` : '') + (reconnectCase ? `\nfixture.reconnectCase = "${reconnectCase}"\n${reconnect}\n` : '') + `
fixtureTransport.new = originalTransportNew
print = fixturePrint
` + logic + '\nprint("Arcane minimal UI fixture passed")\n');
    const executed = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(executed.error);
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /Arcane minimal UI fixture passed/);
    if (core) { assert.match(executed.stdout, /Arcane logic checks passed: \d+/); process.stdout.write('Official Luau VM with engine doubles: ' + executed.stdout); }
    assert.doesNotMatch(executed.stdout + executed.stderr, /arcane_local_v1_|ui-token|unrelated-provider-secret|unrelated-session-secret|arbitrary-unsubmitted-user-text/);
  } finally {
    assert.equal(path.dirname(path.resolve(outDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(outDir).startsWith('arcane-plugin-luau-ui-'));
    await rm(outDir, { recursive: true, force: true });
  }
}

test('all production/fixture Luau sources compile with the official compiler', { skip: !compile && 'Set ARCANE_LUAU_BIN to an official Luau runtime; no compiler is silently installed.' }, async () => {
  const filenames = [...PLUGIN_SOURCES.map(([, , name]) => `plugin/src/${name}`), 'plugin/fixtures/MockEngine.luau', 'plugin/fixtures/MockPlugin.luau', 'plugin/fixtures/Logic.spec.luau', 'plugin/fixtures/KeyInput.spec.luau'];
  for (const filename of filenames) {
    const result = spawnSync(compile, ['--null', path.join(repository, filename)], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${filename}\n${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau executes validation, mutation, restoration and transport failure tests against explicit engine doubles', { skip: !runtime && 'Standalone Luau runtime not configured; native Studio is not used by this test.' }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-luau-'));
  try {
    const prelude = await readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8');
    const modules = [];
    for (const module of ['Validation', 'Registry', 'Properties', 'Sha256Stream', 'AssetMesh', 'AssetTransfer', 'TestProof', 'Operations', 'Transport']) {
      const source = (await readFile(path.join(repository, `plugin/src/${module}.luau`), 'utf8'))
        .replace(/require\(script\.Parent\.(\w+)\)/g, '$1');
      modules.push(`local ${module} = (function()\n${source}\nend)()\n`);
    }
    const checks = await readFile(path.join(repository, 'plugin/fixtures/Logic.spec.luau'), 'utf8');
    const filename = path.join(outDir, 'contract-harness.luau');
    await writeFile(filename, prelude + '\n' + colorEngineFixture + '\n' + modules.join('\n') + '\n' + checks);
    const result = spawnSync(runtime, [filename], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Arcane logic checks passed: \d+/);
    process.stdout.write(result.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(outDir)), path.resolve(tmpdir()), 'cleanup stays in the selected temporary directory');
    assert.ok(path.basename(outDir).startsWith('arcane-plugin-luau-'), 'cleanup targets only this generated test directory');
    await rm(outDir, { recursive: true, force: true });
  }
});

for (const format of ['source', 'generated']) {
  test(`${format} runtime records RGB8 and equivalent Orientation readbacks and restores exact after-state`, { skip: !runtime || !compile }, async () => {
    await runLuauFixture({ format, checks: `
idleMount()
local codec = __arcaneRequire("Validation").geometryProperties(__arcaneRequire("Properties"))
local assignmentOps = __arcaneRequire("Operations").new({sessionId = "runtime-assignment", allowedRoots = {"Workspace"}}, game, http)
local assignmentSerial = 0
local function assignmentRun(method: string, args: any): (any, string)
  assignmentSerial += 1
  local id = "runtime-assignment-" .. assignmentSerial
  return assignmentOps:execute({id = id, method = method, args = args}, function() end), id
end
local colorInput = {type = "Color3", value = {0.15, 0.45, 0.8}}
fixture.orientationReadback = Vector3.new(0, 0, 0)
local created, createId = assignmentRun("scene.create", {parent = assignmentOps.registry:ref(game:GetService("Workspace")), className = "Part", name = "RuntimeAssignment", properties = {Color = colorInput, Orientation = {type = "Vector3", value = {360, 0, 0}}}})
fixture.orientationReadback = nil
local instance = assignmentOps.registry:resolve(created.ref)
local stored = created.mutation.after.properties.Color.value
assert(stored[1] == 0.14901961386203766 and stored[2] == 0.4470588266849518 and stored[3] == 0.800000011920929, "runtime receipt contains native-probe RGB8 float32 values")
assert(instance.Color == Color3.fromRGB(38, 114, 204) and instance.Orientation == Vector3.new(0, 0, 0), "runtime setter stores canonical Colour and wrapped Orientation")
assert(not codec.compare(instance, {Color = colorInput}, {"Color"}) and not codec.compare(instance, {Orientation = {type = "Vector3", value = {360, 0, 0}}}, {"Orientation"}), "runtime baselines remain strict despite equivalent post-writes")
local inspected = assignmentRun("scene.inspect", {ref = created.ref})
assert(__arcaneRequire("Validation").equal(inspected.properties, created.mutation.after.properties), "runtime inspection reflects the exact actual receipt")
fixture.orientationReadback = Vector3.new(90, -30, 0)
local updated, updateId = assignmentRun("scene.update", {ref = created.ref,
  expected = {Color = inspected.properties.Color, Orientation = inspected.properties.Orientation},
  properties = {Color = {type = "Color3", value = {0.1, 0.5, 0.9}}, Orientation = {type = "Vector3", value = {90, 30, 60}}}})
fixture.orientationReadback = nil
stored = updated.mutation.after.properties.Color.value
assert(stored[1] == colorFloat32(25 / 255) and stored[2] == colorFloat32(127 / 255) and stored[3] == colorFloat32(229 / 255), "runtime update returns RGB8 readback")
assert(instance.Orientation == Vector3.new(90, -30, 0) and codec.assignedMatches(instance, "Orientation", Vector3.new(90, 30, 60)), "runtime update verifies actual gimbal-equivalent matrix")
assert(codec.compare(instance, updated.mutation.after.properties, {"Color", "Orientation"}), "runtime restore uses exact canonical expected-after")
local restored = assignmentRun("scene.restore", {receiptCommandId = updateId, mutation = updated.mutation})
assert(restored.restored and instance.Color == Color3.fromRGB(38, 114, 204) and instance.Orientation == Vector3.new(0, 0, 0), "runtime update restores exact before-state")
restored = assignmentRun("scene.restore", {receiptCommandId = createId, mutation = created.mutation})
assert(restored.restored and instance._destroyed and instance.Parent == nil, "runtime unchanged create is destroyed after restoration")
unload()
` });
  });
}

test('generated Luau bundle compiles and executes cold Main, reconnects, cached factories and the extended logic suite', { skip: !runtime || !compile }, async () => {
  await runLuauFixture({ core: true, checks: `
assert(fixture.toolbar.name == "Arcane" and fixture.widget.Title == "Arcane", "original Main initializes widget")
assert(keyInput.Text == "" and keyInput.PlaceholderText == "Arcane API key" and control.Text == "Connect", "cold start offers only Connect")
assert(#fixture.getCalls == 2, "mount reads exactly the two owned keys")
idleMount()
enter(key)
assert(keyInput.Text == key and keyInput.TextTransparency == 0 and control.BackgroundColor3 ~= green, "typing visibly edits the current key without claiming a connection")
assert(#fixture.setCalls == 0, "typing does not persist a credential")
clickConnect()
assert(fixture.pluginSettings[keySetting] == key and fixture.pluginSettings[lastSetting] == nil, "explicit click saves only the validated local key before ACK")
ack(); storageBoundaries(); noSecretText()
assert(connectCount == 1 and disconnectCount == 0, "first click connects exactly once")
clickConnect()
assert(connectCount == 1 and client.disconnectRequested, "live click queues requestConnect rather than toggling disconnect UI")
ack()
assert(connectCount == 2 and disconnectCount == 1, "same worker revokes old session and connects again")
expectKey = otherKey
enter(otherKey); clickConnect()
local superseded = client.desiredPair
enter(key); clickConnect()
assert(superseded.apiKey == nil and #fixture.workers == 1, "new explicit intent clears superseded key without another worker")
expectKey = key
ack()
assert(connectCount == 3 and disconnectCount == 2 and fixture.pluginSettings[keySetting] == key, "only latest explicit intent connects")
unload()
assert(fixture.pluginSettings[keySetting] == key, "unload retains the user-requested saved local key")
assert(table.isfrozen(__arcaneFactories), "factory table is private and frozen")
local Validation = __arcaneRequire("Validation")
local Registry = __arcaneRequire("Registry")
local Properties = __arcaneRequire("Properties")
local Operations = __arcaneRequire("Operations")
local Transport = __arcaneRequire("Transport")
assert(Validation == __arcaneRequire("Validation") and Operations == __arcaneRequire("Operations"), "same module cache")
local accepted, err = pcall(function() __arcaneRequire("outside") end)
assert(not accepted and string.find(err, "undeclared", 1, true), "unknown module refused")
http.RequestAsync = function(_self: any, request: any): any fixture.requests += 1; if fixture.httpHook then return fixture.httpHook(request) end; error("unexpected HTTP request") end
` });
});

test('any valid saved key queues status recovery regardless of transient connected history and remains red until ACK', { skip: !runtime || !compile }, async t => {
  for (const connected of [true, false]) await t.test('cached connected=' + connected, async () => {
    await runLuauFixture({
      setup: `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = "arcane_local_v1_45871_" .. string.rep("a", 64)
fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = {connected = ${connected}}`,
      checks: `
assert(keyInput.Text == key and keyInput.PlaceholderText == "Arcane API key" and control.Text == "Reconnect", "saved key appears as raw editable textbox text")
assert(control.BackgroundColor3 == Color3.fromRGB(255, 51, 64), "cached true or false is red until current ACK")
assert(#fixture.getCalls == 2, "reload reads exactly the two owned keys")
  assert(client.recovery ~= nil and client.desiredPair == nil and client.pair == nil and fixture.requests == 0 and #fixture.setCalls == ${connected ? 1 : 0}, "saved key queues status recovery and clears cached connected state")
  assert(fixture.pluginSettings[lastSetting].connected == false, "restart truth stays disconnected until the new exchange ACK")
  ack(); cycle()
  assert(statusCount == 1 and connectCount == 1 and pollCount == 1 and client.desiredPair == nil, "auto resume reads status before one exchange on the one worker")
storageBoundaries(); noSecretText()
assert(connectCount == 1 and fixture.pluginSettings[keySetting] == key, "both paths establish one actual connection and retain the raw key")
unload()
assert(fixture.pluginSettings[keySetting] == key, "reload/unload retains the saved key")
`,
    });
  });
});

test('malformed saved keys and connection records are ignored without probes, saves or credential fallback', { skip: !runtime || !compile }, async t => {
  const cases = [
    ['provider credential', '"unrelated-provider-secret"', '{connected = true}'],
    ['table key', '{token = "unrelated-session-secret"}', '{connected = true}'],
    ['boolean key', 'true', '{connected = true}'],
    ['out of range port', '"arcane_local_v1_65536_" .. string.rep("a", 64)', '{connected = true}'],
    ['uppercase key', '"arcane_local_v1_45871_" .. string.rep("A", 64)', '{connected = true}'],
    ['trailing whitespace', '"arcane_local_v1_45871_" .. string.rep("a", 64) .. " "', '{connected = true}'],
    ['nonboolean status', 'nil', '{connected = "true"}'],
    ['extra status credentials', 'nil', '{connected = true, token = "unrelated-session-secret", allowWrites = true}'],
    ['primitive status', 'nil', 'true'],
  ];
  for (const [name, keyValue, stateValue] of cases) await t.test(name, async () => {
    await runLuauFixture({
      setup: `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = ${keyValue}
fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = ${stateValue}`,
      checks: `
assert(keyInput.Text == "" and keyInput.PlaceholderText == "Arcane API key" and control.Text == "Connect", "malformed settings cannot prefill a credential or advertise a connection")
idleMount()
enter("arbitrary-unsubmitted-user-text"); control.Activated:Fire()
assert(keyInput.Text == "" and client.desiredPair == nil and fixture.requests == 0, "invalid explicit input is cleared and never dispatched")
local keyWrites = {}
for _, call in ipairs(fixture.setCalls) do if call.key == keySetting then table.insert(keyWrites, call) end end
assert(fixture.pluginSettings[keySetting] == "" and #keyWrites == 1 and keyWrites[1].value == "", "invalid input clears only the owned key setting")
assert(control.Text == "Failed" and keyInput.PlaceholderText == "Enter a new API key" and control.BackgroundColor3 ~= green, "invalid input visibly requests a replacement key")
enter(key); clickConnect(); ack(); unload()
`,
    });
  });
});

for (const format of ['source', 'generated']) {
  test(`${format} pinned Luau VM recovery observes status, exact key, hidden panel and lifecycle fences`, { skip: (!runtime || !compile) && 'Pinned standalone Luau tools are not configured; no Studio or runtime is installed.' }, async t => {
    const saved = `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = "arcane_local_v1_45871_" .. string.rep("a", 64)\n`;
    const cases = [
      ['hidden connection'], ['explicit disconnect'], ['loss during play'],
      ['receipt never crosses session'], ['unsafe receipt'], ['receipt conflict'], ['wrong lost session'], ['late revoked poll'],
      ['unknown handshake active'], ['unknown handshake absent'],
      ['bootstrap absent history', saved], ['bootstrap play', saved + 'fixture.edit = false\n'],
      ['saved opt-out', saved + `fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = {connected = false, autoConnect = false}\n`],
      ['status network bound', saved],
      ...[400, 401, 403, 404, 405].map(code => ['status unsupported', saved + `fixture.reconnectCode = ${code}\n`, String(code)]),
      ...[401, 403].map(code => ['status key rejected', saved + `fixture.reconnectCode = ${code}\n`, String(code)]),
      ...['identity', 'bearer', 'commands'].map(fault => ['status malformed', saved + `fixture.reconnectMalformed = "${fault}"\n`, fault]),
      ...['edit', 'deferred edit', 'new click', 'disconnect', 'identity', 'play', 'unload'].map(action => ['late status ' + action, saved]),
      ...[[401, 'AUTH'], [403, 'AUTH'], [404, 'NOT_FOUND'], [410, 'GONE'], [409, 'REVOKED'], [409, 'EXPIRED'], [400, 'SESSION']]
        .map(([code, error]) => ['definitive loss', `fixture.reconnectCode = ${code}; fixture.reconnectError = "${error}"\n`, `${code} ${error}`]),
      ...[404, 410].map(code => ['definitive loss', `fixture.reconnectCode = ${code}; fixture.reconnectError = "SESSION"; fixture.reconnectPending = true\n`, `${code} pending receipt`]),
    ];
    for (const [reconnectCase, setup = '', label = ''] of cases) await t.test(`${reconnectCase} ${label}`.trim(), () =>
      runLuauFixture({ format, setup, checks: '', reconnectCase }));
  });

  test(`${format} official Luau GUI fixtures fence connected editing and genuinely yielding old work`, { skip: !runtime || !compile }, async t => {
    for (const editingCase of ['select all delete', 'select all replace', 'queued edit', 'late connect ACK', 'deferred text ACK', 'late poll replacement', 'editor replacement', 'deferred editor replacement', 'late receipt ACK', 'saved key reload', 'unload in-flight ACK', 'play refuses reconnect']) {
      await t.test(editingCase, async () => runLuauFixture({ format, checks: '', editingCase }));
    }
  });

  test(`${format} VM GUI recovers from a rejected wellformed key only after a new explicit key and ACK`, { skip: !runtime || !compile }, async t => {
    for (const status of [401, 403]) for (const saved of [false, true]) await t.test(`HTTP ${status}, ${saved ? 'saved' : 'entered'} bad key`, async () => {
      await runLuauFixture({ format,
        setup: saved ? `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = "arcane_local_v1_45871_" .. string.rep("a", 64)
fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = {connected = true}` : '',
        checks: `
if ${saved} then
  assert(client.recovery ~= nil and client.pair == nil and fixture.requests == 0 and control.Text == "Reconnect" and control.BackgroundColor3 ~= green, "saved key queues only safe recovery, without cached green")
else idleMount(); enter(key); clickConnect() end
assert(fixture.pluginSettings[keySetting] == key, "save-before-click exchange contract remains in force")
local rejected = client.desiredPair or client.recovery
fixture.uiHttpHook = function(request: any): any
  assert(string.find(request.Url, "/v1/plugin/${saved ? 'status' : 'connect'}", 1, true) and __arcaneRequire("Validation").decode(request.Body, http).apiKey == key, "only the exact wellformed bad key is authenticated")
  connectCount += 1 -- Count this rejected authentication, including read-only status.
  return {StatusCode = ${status}, Success = false, Body = ${saved ? `' {"error":"KEY_REJECTED","message":"untrusted unrelated-session-secret"}'` : '"untrusted rejection body unrelated-session-secret"'}}
end
cycle()
assert(rejected.apiKey == nil and client.desiredPair == nil and client.pair == nil and client.operations == nil and client.identityFence == nil, "rejection clears queued key and transport session state")
assert(control.Text == "Failed" and control.BackgroundColor3 ~= green and keyInput.PlaceholderText == "Enter a new API key" and keyInput.Text == "", "rejected key visibly requests replacement")
assert(fixture.statuses[#fixture.statuses].state == "failed", "401/403 on connect reports key rejection")
assert(fixture.pluginSettings[keySetting] == "" and ${saved ? 'fixture.pluginSettings[lastSetting].connected == false' : 'fixture.pluginSettings[lastSetting] == nil'}, "known rejected saved value is deleted and no connected history remains")
local requests, writes = fixture.requests, #fixture.setCalls
cycle(); cycle(); fixture.button.Click:Fire(); cycle()
assert(fixture.requests == requests and #fixture.setCalls == writes and control.Text == "Failed", "rejected key never retries on idle cycles or toolbar clicks")
storageBoundaries(); noSecretText()
fixture.uiHttpHook = nil; expectKey = otherKey
enter(otherKey)
assert(control.Text == "Connect" and keyInput.Text == otherKey and keyInput.PlaceholderText == "Arcane API key" and control.BackgroundColor3 ~= green, "typing resets Failed to Connect without claiming ACK")
assert(fixture.pluginSettings[keySetting] == "", "typing alone never saves the new key")
clickConnect()
assert(fixture.pluginSettings[keySetting] == otherKey and ${saved ? 'fixture.pluginSettings[lastSetting].connected == false' : 'fixture.pluginSettings[lastSetting] == nil'}, "explicit replacement saves before ACK without claiming connected history")
ack()
assert(connectCount == 2 and disconnectCount == 0 and #fixture.workers == 1 and #fixture.transports == 1, "correct replacement ACK uses the original single worker")
unload()
assert(fixture.pluginSettings[keySetting] == otherKey, "only the accepted replacement survives unload")
` });
    });
  });

  test(`${format} VM GUI malformed replacement fences old intent and recovers with a new key`, { skip: !runtime || !compile }, async t => {
    for (const initial of ['cold', 'queued', 'live']) await t.test(initial, async () => {
      await runLuauFixture({ format, checks: `
idleMount()
${initial === 'cold' ? '' : 'enter(key); clickConnect()'}
${initial === 'live' ? 'ack()' : ''}
local oldDesired, oldPair = client.desiredPair, client.pair
local requests, connects = fixture.requests, connectCount
enter("unrelated-provider-secret"); control.Activated:Fire()
assert(keyInput.Text == "" and control.Text == "Failed" and keyInput.PlaceholderText == "Enter a new API key" and control.BackgroundColor3 ~= green, "malformed input is cleared with visible replacement guidance")
assert(fixture.pluginSettings[keySetting] == "" and client.desiredPair == nil and client.disconnectRequested, "malformed replacement deletes only owned key and requests internal disconnect")
assert(fixture.requests == requests and #fixture.workers == 1, "invalid click never launches HTTP or another worker")
if oldDesired then assert(oldDesired.apiKey == nil, "malformed replacement forgets an older queued key") end
if oldPair then assert(oldPair.generation ~= client.generation, "malformed replacement immediately fences an older live session") end
cycle(); cycle()
assert(client.pair == nil and client.operations == nil and connectCount == connects and pollCount == 0, "single worker clears old session without polling or retrying a malformed key")
assert(control.Text == "Failed" and keyInput.PlaceholderText == "Enter a new API key" and disconnectCount == ${initial === 'live' ? 1 : 0}, "only an old live bearer is revoked internally and failure guidance persists")
storageBoundaries(); noSecretText()
expectKey = otherKey; enter(otherKey)
assert(control.Text == "Connect", "new text resets failure")
clickConnect(); ack()
assert(connectCount == connects + 1 and #fixture.workers == 1, "new correct key gets one ACK on the same worker")
unload()
` });
    });
  });

  test(`${format} VM GUI late old rejection preserves newer desired key and unsubmitted text`, { skip: !runtime || !compile }, async t => {
    for (const status of [401, 403]) for (const clicked of [true, false]) await t.test(`HTTP ${status}, newer ${clicked ? 'click' : 'typing'}`, async () => {
      await runLuauFixture({ format, checks: `
idleMount(); enter(key); clickConnect()
fixture.uiHttpHook = function(request: any): any
  connectCount += 1
  assert(__arcaneRequire("Validation").decode(request.Body, http).apiKey == key, "old key is already in flight")
  coroutine.yield()
  return {StatusCode = ${status}, Success = false, Body = ""}
end
cycle()
assert(client.inFlight and control.BackgroundColor3 ~= green, "old exchange is genuinely suspended before rejection")
enter(otherKey)
${clicked ? 'clickConnect()' : ''}
local newer, generation, rawText, writes = client.desiredPair, client.generation, keyInput.Text, #fixture.setCalls
cycle()
assert(not client.inFlight and keyInput.Text == rawText and keyInput.TextTransparency == 0, "old rejection preserves the newer visibly editable input")
${clicked ? `assert(client.desiredPair == newer and newer.apiKey == otherKey and client.generation == generation, "old rejection preserves exact newer desired key and generation")
assert(fixture.pluginSettings[keySetting] == otherKey and #fixture.setCalls == writes and control.Text == "Reconnect", "stale rejection cannot delete the newer saved key or overwrite its UI status")
for _, status in ipairs(fixture.statuses) do assert(status.state ~= "failed", "stale rejection never emits current failure") end` : `assert(client.desiredPair == nil and fixture.pluginSettings[keySetting] == "" and control.Text == "Connect" and client.generation == generation and #fixture.setCalls == writes, "typing alone invalidates old rejection and preserves the unsubmitted replacement")
for _, status in ipairs(fixture.statuses) do assert(status.state ~= "failed", "typed replacement fences old key failure") end
clickConnect()`}
fixture.uiHttpHook = nil; expectKey = otherKey
ack()
${clicked ? 'assert(keyInput.Text == rawText, "replacement ACK also preserves newer unsubmitted text")' : ''}
assert(connectCount == 2 and disconnectCount == 0 and #fixture.workers == 1, "new correct intent reaches ACK in the original worker after stale rejection")
unload()
` });
    });
  });

  test(`${format} VM GUI distinguishes unknown connect outcomes and poll revocation from rejected keys`, { skip: !runtime || !compile }, async t => {
    for (const failure of ['timeout', 'HTTP 500']) await t.test(failure, async () => {
      await runLuauFixture({ format, checks: `
idleMount(); enter(key); clickConnect()
fixture.uiHttpHook = function(_request: any): any
  ${failure === 'timeout' ? 'error("network fault unrelated-session-secret")' : 'return {StatusCode = 500, Success = false, Body = ""}'}
end
cycle()
assert(client.pair == nil and client.desiredPair == nil and control.Text == "Reconnect" and control.BackgroundColor3 ~= green and keyInput.PlaceholderText == "Arcane API key" and keyInput.Text == key, "uncertain exchange retains visible saved-key reconnect UI")
assert(fixture.pluginSettings[keySetting] == key and fixture.statuses[#fixture.statuses].state == "disconnected", "uncertainty retains the saved key and is not KEY_REJECTED")
local requests = fixture.requests; cycle(); cycle()
assert(fixture.requests == requests + 2 and client.pair == nil, "uncertain exchange only retries read-only status while unavailable")
fixture.uiHttpHook = nil; clickConnect(); ack(); unload()
` });
    });
    for (const status of [401, 403]) await t.test(`poll HTTP ${status}`, async () => {
      await runLuauFixture({ format, checks: `
idleMount(); enter(key); clickConnect(); ack()
local pair = client.pair
fixture.uiHttpHook = function(request: any): any
  assert(string.find(request.Url, "/v1/plugin/poll", 1, true), "only the live poll is revoked")
  return {StatusCode = ${status}, Success = false, Body = ""}
end
cycle()
assert(pair.token == nil and client.pair == nil and fixture.statuses[#fixture.statuses].state == "disconnected", "poll 401/403 remains REVOKED and clears only the session bearer")
assert(control.Text == "Reconnect" and control.BackgroundColor3 ~= green and keyInput.PlaceholderText == "Arcane API key" and keyInput.Text == key and fixture.pluginSettings[keySetting] == key and fixture.pluginSettings[lastSetting].connected == false, "poll revocation retains the saved human key and never displays Failed")
fixture.uiHttpHook = nil
ack()
assert(statusCount == 1 and connectCount == 2 and #fixture.workers == 1, "revoked poll reads status and reconnects through the original worker")
unload()
` });
    });
  });
}

test('settings read/write faults do not leak credentials, broaden persistence or block the explicit single-worker connection', { skip: !runtime || !compile }, async t => {
  for (const setting of [LOCAL_KEY_SETTING, LAST_CONNECTION_SETTING]) await t.test('read fault: ' + setting, async () => {
    await runLuauFixture({
      setup: `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = "arcane_local_v1_45871_" .. string.rep("a", 64)
fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = {connected = true}
fixture.getSettingFaults = {["${setting}"] = "settings fault unrelated-provider-secret"}`,
      checks: `
${setting === LOCAL_KEY_SETTING ? 'idleMount()' : 'assert(client.recovery ~= nil and fixture.requests == 0, "failed health read still queues recovery from the independently valid key")'}; noSecretText()
assert(control.BackgroundColor3 ~= green, "failed settings reads never authenticate a credential")
${setting === LOCAL_KEY_SETTING ? 'assert(control.Text == "Connect" and keyInput.PlaceholderText == "Arcane API key", "failed key read has no fallback to another credential")' : 'assert(control.Text == "Reconnect" and keyInput.PlaceholderText == "Arcane API key" and keyInput.Text == key, "status read failure does not discard an independently valid local key")'}
enter(key); clickConnect(); ack(); unload()
`,
    });
  });
  await t.test('both writes throw', async () => {
    await runLuauFixture({
      setup: 'fixture.setSettingError = "settings fault unrelated-session-secret"',
      checks: `
idleMount(); enter(key); clickConnect(); cycle()
assert(client.pair and not client.blocked and control.BackgroundColor3 == green and control.Text == "Connected", "current official-Luau fixture ACK remains live when local persistence fails")
assert(fixture.pluginSettings[keySetting] == nil and fixture.pluginSettings[lastSetting] == nil, "failed writes cannot invent saved settings")
assert(#fixture.setCalls == 2, "only owned key and primitive live status writes are attempted")
clickConnect(); cycle()
assert(connectCount == 2 and disconnectCount == 1 and #fixture.workers == 1, "current valid intent can reconnect through the same worker despite failed storage")
unload()
`,
    });
  });
});

test('failed live exchanges and identity scope changes persist only connected false and never display cached green', { skip: !runtime || !compile }, async t => {
  const saved = `fixture.pluginSettings["${LOCAL_KEY_SETTING}"] = "arcane_local_v1_45871_" .. string.rep("a", 64)
fixture.pluginSettings["${LAST_CONNECTION_SETTING}"] = {connected = true}`;
  await t.test('failed initial exchange', async () => {
    await runLuauFixture({ setup: saved, checks: `
assert(client.recovery ~= nil and client.pair == nil and fixture.requests == 0 and control.BackgroundColor3 ~= green, "auto resume only queues fresh status")
fixture.uiHttpHook = function(_request: any): any error("network fault unrelated-session-secret") end
cycle()
assert(client.pair == nil and client.desiredPair == nil and control.BackgroundColor3 ~= green, "failed exchange cannot establish live green")
assert(fixture.pluginSettings[lastSetting].connected == false and fixture.pluginSettings[keySetting] == key, "failure saves only connected false and retains local key")
local requests = fixture.requests
cycle(); cycle()
assert(fixture.requests == requests + 2 and #fixture.workers == 1 and connectCount == 0, "unavailable status never sends a handshake")
fixture.uiHttpHook = nil
clickConnect(); ack(); unload()
` });
  });
  for (const field of ['PlaceId', 'GameId', 'Name']) await t.test('identity fence: ' + field, async () => {
    await runLuauFixture({ setup: saved, checks: `
assert(client.recovery ~= nil and client.pair == nil and fixture.requests == 0 and control.BackgroundColor3 ~= green, "auto resume only queues fresh status")
clickConnect() -- Exercise the direct exchange identity fence separately from status.
fixture.uiHttpHook = function(request: any): any
  assert(string.find(request.Url, "/v1/plugin/connect", 1, true), "only the explicit exchange is pending")
  local original = game["${field}"]
  game["${field}"] = ${field === 'Name' ? '"OtherFixture"' : '42'}
  game["${field}"] = original
  return {StatusCode = 200, Success = true, Body = '{"sessionId":"ui-session","token":"ui-token","protocolVersion":1,"allowedRoots":["Workspace"],"allowWrites":true}'}
end
cycle()
assert(client.pair and client.blocked and client.identityFence.changed and client.operations == nil, "changed scope fences even an otherwise successful ACK")
assert(control.BackgroundColor3 ~= green and control.Text == "Reconnect" and fixture.pluginSettings[lastSetting].connected == false, "blocked identity never becomes green or remains cached connected true")
local requests = fixture.requests
cycle(); cycle()
assert(fixture.requests == requests and #fixture.workers == 1, "blocked scope never polls or reconnects automatically")
fixture.uiHttpHook = nil
clickConnect(); ack(); unload()
` });
  });
  await t.test('live scope changes and poll failure', async () => {
    await runLuauFixture({ checks: `
idleMount(); enter(key); clickConnect(); ack()
fixture.uiHttpHook = function(_request: any): any error("poll fault unrelated-session-secret") end
cycle()
assert(control.BackgroundColor3 ~= green and fixture.pluginSettings[lastSetting].connected == false, "live request failure removes green and persists false")
fixture.uiHttpHook = nil
cycle()
assert(control.BackgroundColor3 == green and fixture.pluginSettings[lastSetting].connected == true, "green returns only after a new current poll ACK")
game.Name = "OtherFixture"; game.Name = "ArcaneDisposableFixture"
assert(client.blocked and control.BackgroundColor3 ~= green and fixture.pluginSettings[lastSetting].connected == false, "live identity invalidation immediately removes green and saves false")
local requests = fixture.requests
cycle(); assert(fixture.requests == requests, "fenced live scope performs no further poll")
unload()
` });
  });
});

test('mock plugin settings are isolated deep copies with observable read/write faults', { skip: !runtime }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-settings-'));
  try {
    const [prelude, gui] = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      readFile(path.join(repository, 'plugin/fixtures/MockPlugin.luau'), 'utf8'),
    ]);
    const checks = `
local keySetting, lastSetting = fixture.settingNames.apiKey, fixture.settingNames.lastConnection
fixture.pluginSettings[lastSetting] = {connected = true, malformed = {nested = {"original"}}}
local observed = plugin:GetSetting(lastSetting)
observed.connected = false; observed.malformed.nested[1] = "changed"
assert(fixture.pluginSettings[lastSetting].connected and fixture.pluginSettings[lastSetting].malformed.nested[1] == "original", "GetSetting recursively isolates stored values")
local value = {connected = true}
plugin:SetSetting(lastSetting, value)
value.connected = false
assert(fixture.pluginSettings[lastSetting].connected and fixture.setCalls[1].value.connected, "SetSetting isolates its caller and call record")
fixture.setCalls[1].value.connected = false
assert(fixture.pluginSettings[lastSetting].connected, "mutating a captured call cannot mutate storage")
fixture.getSettingError = "injected read fault"
assert(not pcall(function() plugin:GetSetting(keySetting) end) and #fixture.getCalls == 2, "read faults still record the requested key")
fixture.setSettingError = "injected write fault"
assert(not pcall(function() plugin:SetSetting(lastSetting, {connected = false}) end) and #fixture.setCalls == 2, "write faults record attempts")
assert(fixture.pluginSettings[lastSetting].connected, "write faults preserve previous settings")
print("Arcane mock settings isolation passed")
`;
    const harness = path.join(outDir, 'settings-harness.luau');
    await writeFile(harness, prelude + '\n' + gui + '\n' + checks);
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Arcane mock settings isolation passed/);
  } finally {
    assert.equal(path.dirname(path.resolve(outDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(outDir).startsWith('arcane-plugin-settings-'));
    await rm(outDir, { recursive: true, force: true });
  }
});
