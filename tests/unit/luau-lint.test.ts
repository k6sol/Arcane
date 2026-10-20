import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lintLuau, maskLuau, LUAU_LINT_LIMITS } from '../../apps/mcp/src/luau-lint.js';

const ROOT = resolve(process.cwd());
const rules = (source: string) => lintLuau(source).map(item => item.rule);

test('flags deprecated global schedulers but not task.* or user-defined helpers', () => {
  const found = lintLuau('--!strict\nwait(1)\nspawn(function() end)\ndelay(2, print)\ntask.wait(1)\ntask.spawn(print)\nlocal function wait(n) return n end\n');
  assert.deepEqual(found.map(item => [item.rule, item.line]), [['deprecated-scheduler', 2], ['deprecated-scheduler', 3], ['deprecated-scheduler', 4]]);
  assert.match(found[0]!.message, /task\.wait/);
});

test('busy loops without a yield are flagged; yielding, breaking and finite loops are not', () => {
  assert.deepEqual(rules('--!strict\nwhile true do\n\tx += 1\nend\n'), ['busy-loop']);
  assert.deepEqual(rules('--!strict\nrepeat\n\tx += 1\nuntil false\n'), ['busy-loop']);
  assert.deepEqual(rules('--!strict\nwhile true do\n\ttask.wait(1)\nend\n'), []);
  assert.deepEqual(rules('--!strict\nwhile true do\n\tif x then break end\nend\n'), []);
  assert.deepEqual(rules('--!strict\nrepeat\n\ti += 1\nuntil i > 10\n'), []);
  assert.deepEqual(rules('--!strict\nwhile true do\n\tlocal ok = pcall(function() return 1 end)\n\tevent:Wait()\nend\n'), []);
  assert.ok(rules('--!strict\nwhile true do\n\twait()\nend\n').includes('polling-loop'));
});

test('DataStore calls need pcall; SetAsync/RemoveAsync and missing BindToClose are called out', () => {
  const unsafe = lintLuau('--!strict\nlocal data = store:GetAsync(key)\nstore:SetAsync(key, data)\nstore:RemoveAsync(key)\n');
  assert.deepEqual([...new Set(unsafe.map(item => item.rule))].sort(),
    ['datastore-bindtoclose', 'datastore-pcall', 'datastore-remove', 'datastore-setasync']);
  assert.equal(unsafe.filter(item => item.rule === 'datastore-pcall').length, 3);
  const safe = rules(`--!strict
local ok, value = pcall(function()
	return store:UpdateAsync(key, function(old) return old end)
end)
local ok2, got = pcall(store.GetAsync, store, key)
game:BindToClose(function() end)
`);
  assert.deepEqual(safe, []);
});

test('client-trusted remote values and unvalidated handlers are flagged; validated intent is not', () => {
  const bad = lintLuau(`--!strict
buy.OnServerEvent:Connect(function(player, itemId, price)
	coins[player] -= price
end)
remote:FireServer(itemId, damage)
fn.OnServerInvoke = function(player, amount) return amount end
other:InvokeClient(player)
`);
  const byRule = (rule: string) => bad.filter(item => item.rule === rule).map(item => item.line);
  assert.deepEqual(byRule('client-trusted-value'), [2, 5, 6]);
  assert.deepEqual(byRule('remote-unvalidated'), [2, 6]);
  assert.deepEqual(byRule('invoke-client'), [7]);
  assert.match(bad.find(item => item.rule === 'client-trusted-value')!.message, /"price"/);
  assert.deepEqual(rules(`--!strict
buy.OnServerEvent:Connect(function(player: Player, itemId: unknown)
	if not Net.allow(player, "BuyItem", 2, 4) or typeof(itemId) ~= "string" then return end
end)
remote:FireServer(itemId)
`), []);
});

test('comments and strings never produce findings, and line numbers survive masking', () => {
  const source = '--!strict\n-- wait(1) while true do end\n--[[ store:SetAsync(k, v)\nspawn(f) ]]\nlocal s = "wait(1) :InvokeClient("\nlocal l = [==[\nwhile true do end ]==]\nprint(`delay(1)`)\n';
  assert.deepEqual(lintLuau(source), []);
  const masked = maskLuau(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
});

test('advisories are bounded, sorted, deduplicated per line and never throw on odd input', () => {
  assert.deepEqual(lintLuau(''), []);
  assert.deepEqual(lintLuau('   \n'), []);
  assert.deepEqual(lintLuau('x'.repeat(LUAU_LINT_LIMITS.sourceBytes + 1)), []);
  assert.deepEqual(lintLuau(undefined as unknown as string), []);
  const many = lintLuau(Array.from({ length: 40 }, () => 'wait(1) wait(2)').join('\n'));
  assert.equal(many.length, LUAU_LINT_LIMITS.advisories);
  assert.ok(many.every((item, i) => i === 0 || many[i - 1]!.line <= item.line));
  assert.equal(lintLuau('wait(1)')[0]!.rule, 'strict-mode');
  assert.equal(lintLuau('wait(1)')[0]!.severity, 'info');
  assert.doesNotThrow(() => lintLuau('--[[ unterminated\nwhile true do'));
  assert.doesNotThrow(() => lintLuau('x.OnServerEvent:Connect(function(p, a'));
});

test('bundled gameplay and DataStore code templates pass the advisory lint', async () => {
  for (const file of ['skills/arcane/arcane-gameplay-systems/references/recipes.md', 'skills/arcane/arcane-datastore-safety/references/template.md',
    'skills/arcane/arcane-luau-architecture/references/patterns.md']) {
    const text = await readFile(join(ROOT, file), 'utf8');
    const blocks = [...text.matchAll(/```lua\n([\s\S]*?)```/g)].map(match => match[1] ?? '');
    assert.ok(blocks.length > 0, file);
    for (const block of blocks) {
      const warnings = lintLuau(block).filter(item => item.severity === 'warning');
      assert.deepEqual(warnings, [], `${file}: ${block.slice(0, 80)}`);
    }
  }
});
