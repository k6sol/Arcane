import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every ```lua/```luau block in the skill pack is code the model copies into games, so it must compile.
// ```luau-fragment blocks are deliberately partial and skipped; each must say why in a comment.
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const compile = process.env.ARCANE_LUAU_COMPILE;

async function* markdown(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdown(full);
    else if (entry.name.endsWith('.md')) yield full;
  }
}

async function blocks() {
  const found = [];
  for await (const file of markdown(path.join(ROOT, 'skills'))) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm)) {
      const where = `${path.relative(ROOT, file).split(path.sep).join('/')}:${text.slice(0, match.index).split('\n').length}`;
      found.push({ tag: match[1].toLowerCase(), code: match[2], where });
    }
  }
  return found;
}

test('fragment blocks explain why they are not standalone', async () => {
  for (const block of (await blocks()).filter(b => b.tag === 'luau-fragment'))
    assert.match(block.code, /--.*\S/, `${block.where} needs a comment justifying the skip`);
});

test('every Luau block in the skill pack compiles with the official compiler', { skip: !compile }, async t => {
  const luau = (await blocks()).filter(b => b.tag === 'lua' || b.tag === 'luau');
  assert.ok(luau.length >= 40, `expected the skill pack's Luau blocks, found ${luau.length}`);
  const temp = await fs.mkdtemp(path.join(ROOT, 'tests', 'skills', '.luau-snippets-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const files = await Promise.all(luau.map(async (block, i) => {
    const file = path.join(temp, `block${i}.luau`);
    await fs.writeFile(file, block.code);
    return file;
  }));
  // One compiler run for all blocks; on failure, recompile each to name the offending block.
  const all = spawnSync(compile, ['--null', ...files], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(all.error);
  if (all.status === 0) return;
  const failures = luau.flatMap((block, i) => {
    const one = spawnSync(compile, ['--null', files[i]], { encoding: 'utf8', timeout: 10000 });
    return one.status === 0 ? [] : [`${block.where}: ${`${one.stdout}${one.stderr}`.replaceAll(files[i], 'block').trim()}`];
  });
  assert.deepEqual(failures, []);
});
