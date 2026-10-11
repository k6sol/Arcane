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

test('all production/fixture Luau sources compile with the official compiler', { skip: !compile && 'Set ARCANE_LUAU_BIN to an official Luau runtime; no compiler is silently installed.' }, async () => {
  const filenames = [...PLUGIN_SOURCES.map(([, , name]) => `plugin/src/${name}`), 'plugin/fixtures/MockEngine.luau', 'plugin/fixtures/MockPlugin.luau', 'plugin/fixtures/Logic.spec.luau'];
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
    for (const module of ['Validation', 'Registry', 'Properties', 'Operations', 'Transport']) {
      const source = (await readFile(path.join(repository, `plugin/src/${module}.luau`), 'utf8'))
        .replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1');
      modules.push(`local ${module} = (function()\n${source}\nend)()\n`);
    }
    const checks = await readFile(path.join(repository, 'plugin/fixtures/Logic.spec.luau'), 'utf8');
    const filename = path.join(outDir, 'contract-harness.luau');
    await writeFile(filename, prelude + '\n' + modules.join('\n') + '\n' + checks);
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

test('generated native Lua compiles and executes the original Main, cached factories and full logic suite', { skip: !runtime || !compile }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-native-'));
  try {
    const sources = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) =>
      ({ filename, source: await readFile(path.join(repository, 'plugin/src', filename), 'utf8') })));
    const { lua } = renderPlugin(sources);
    const bundlePath = path.join(outDir, 'ArcaneLocalBridge.lua');
    await writeFile(bundlePath, lua);
    const compiled = spawnSync(compile, ['--null', bundlePath], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const prelude = await readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8');
    const gui = await readFile(path.join(repository, 'plugin/fixtures/MockPlugin.luau'), 'utf8');
    const checks = await readFile(path.join(repository, 'plugin/fixtures/Logic.spec.luau'), 'utf8');
    const factoryChecks = [
      'assert(fixture.toolbar.name == "Arcane" and fixture.widget.Title == "Arcane", "original Main initializes widget")',
      'assert(#fixture.workers == 1, "original Main starts one worker")',
      'fixture.button.Click:Fire()',
      'assert(fixture.widget.Enabled == true, "original toolbar toggles widget")',
      'fixture.widget:GetPropertyChangedSignal("Enabled"):Fire()',
      'assert(fixture.button.active == true, "original widget synchronizes toolbar")',
      "local inputs, controls = {}, {}",
      "for _, instance in ipairs(fixture.created) do if instance:IsA(\"TextBox\") then table.insert(inputs, instance) end; if instance.Name == \"Connect\" then table.insert(controls, instance) end end",
      "assert(#inputs == 1 and #controls == 1 and inputs[1].Name == \"ApiKey\", \"exactly one key field and connection control\")",
      "local keyInput, control = inputs[1], controls[1]",
      "assert(keyInput.TextTransparency == 1 and keyInput.MaxVisibleGraphemes == 0, \"raw key glyphs masked\")",
      "local mask, state, dot",
      "for _, instance in ipairs(fixture.created) do if instance.Name == \"MaskedKey\" then mask = instance elseif instance.Name == \"ConnectionStatus\" then state = instance elseif instance.Name == \"ConnectionDot\" then dot = instance end end",
      "local key = \"arcane_local_v1_45871_\" .. string.rep(\"a\", 64)",
      "keyInput.Text = key; keyInput:GetPropertyChangedSignal(\"Text\"):Fire()",
      "assert(mask.Text == \"••••••••\" and state.Text == \"Disconnected\", \"entry stays masked and never fakes connection\")",
      "control.Activated:Fire()",
      "assert(keyInput.Text == \"\" and control.Text == \"Disconnect\" and state.Text == \"Connecting…\", \"human click clears input before queued connection\")",
      "local worker = coroutine.create(fixture.workers[1])",
      "task.wait = function(seconds: number): () assert(seconds >= 2 and seconds <= 30); coroutine.yield() end",
      "http.RequestAsync = function(_self: any, request: any): any",
      "  if request.Url == \"http://127.0.0.1:45871/v1/plugin/connect\" then",
      "    assert(request.Headers.Authorization == nil and string.find(request.Body, '\"apiKey\":', 1, true), \"actual Main key exchange\")",
      "    return {StatusCode = 200, Success = true, Body = '{\"sessionId\":\"ui-session\",\"token\":\"ui-token\",\"protocolVersion\":1,\"allowedRoots\":[\"Workspace\"],\"allowWrites\":false}'}",
      "  end",
      "  if string.find(request.Url, \"/v1/plugin/disconnect\", 1, true) then return {StatusCode = 200, Success = true, Body = '{\"revoked\":true}'} end",
      "  error(\"unexpected GUI test request\")",
      "end",
      "local ok, err = coroutine.resume(worker); assert(ok, tostring(err))",
      "assert(state.Text == \"Connected\" and control.Text == \"Disconnect\" and dot.BackgroundColor3 == Color3.fromRGB(71, 203, 133), \"green follows successful daemon response\")",
      "control.Activated:Fire()",
      "assert(state.Text == \"Disconnecting…\" and dot.BackgroundColor3 ~= Color3.fromRGB(71, 203, 133), \"disconnect immediately removes green status\")",
      "ok, err = coroutine.resume(worker); assert(ok, tostring(err))",
      "assert(state.Text == \"Disconnected\" and control.Text == \"Connect\" and keyInput.Text == \"\", \"disconnect requires next human key entry\")",
      "http.RequestAsync = function(_self: any, request: any): any fixture.requests += 1; if fixture.httpHook then return fixture.httpHook(request) end; error(\"unexpected HTTP request\") end",
      'plugin.Unloading:Fire()',
      'assert(fixture.widget._destroyed and fixture.toolbar.destroyed, "original Main unload cleanup")',
      'assert(not fixture.button.Click.connections[1].Connected, "original Main disconnects signals")',
      'assert(table.isfrozen(__arcaneFactories), "factory table is private and frozen")',
      'local Validation = __arcaneRequire("Validation")',
      'local Registry = __arcaneRequire("Registry")',
      'local Properties = __arcaneRequire("Properties")',
      'local Operations = __arcaneRequire("Operations")',
      'local Transport = __arcaneRequire("Transport")',
      'assert(Validation == __arcaneRequire("Validation") and Operations == __arcaneRequire("Operations"), "same module cache")',
      'local accepted, err = pcall(function() __arcaneRequire("outside") end)',
      'assert(not accepted and string.find(err, "undeclared", 1, true), "unknown module refused")',
    ].join('\n');
    const harness = path.join(outDir, 'native-harness.luau');
    await writeFile(harness, prelude + '\n' + gui + '\n' + lua + '\n' + factoryChecks + '\n' + checks);
    const executed = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(executed.error);
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /Arcane logic checks passed: \d+/);
    process.stdout.write('Native bundle doubles: ' + executed.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(outDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(outDir).startsWith('arcane-plugin-native-'));
    await rm(outDir, { recursive: true, force: true });
  }
});
