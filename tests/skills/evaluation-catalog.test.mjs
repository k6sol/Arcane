import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../../scripts/skill-pack.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const catalogue = JSON.parse(await fs.readFile(new URL('./evaluations.json', import.meta.url), 'utf8'));

test('behavior catalogue covers every authored skill without claiming runs', async () => {
  const registry = await loadRegistry(ROOT);
  assert.equal(catalogue.definitionOnly, true);
  assert.equal(catalogue.runStatus, 'not-run');
  assert.deepEqual(catalogue.runs, []);
  assert.equal(catalogue.cases.length, 69);
  // Every skill has a primary task; gameplay-code skills carry extra primary tasks for realistic briefs.
  assert.deepEqual([...new Set(catalogue.cases.map(c => c.primarySkill))].sort(), registry.skills.map(s => s.id).sort());
  for (const id of ['arcane-gameplay-systems', 'arcane-datastore-safety', 'arcane-remote-security'])
    assert.ok(catalogue.cases.filter(c => c.primarySkill === id).length >= 2, id);
});

test('case identifiers and primary/guard skill references are well formed', async () => {
  const ids = new Set((await loadRegistry(ROOT)).skills.map(s => s.id));
  const cases = [...catalogue.cases, ...catalogue.guardCases];
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const item of cases) {
    assert.match(item.id, /^(behavior|guard)-[a-z0-9-]+$/);
    assert.equal(item.runStatus, 'not-run');
    assert.ok(item.skills.length > 0 && item.skills.every(id => ids.has(id)));
    assert.equal(new Set(item.skills).size, item.skills.length);
  }
});

test('catalogue distinguishes worker fixtures from reviewer-only behavior assertions', () => {
  assert.deepEqual(catalogue.workerPayloadFields, ['id', 'workerRequest', 'fixtureRequirements']);
  assert.ok(catalogue.reviewerOnlyFields.includes('reviewerOracle'));
  assert.ok(!catalogue.workerPayloadFields.includes('primarySkill'));
  for (const item of [...catalogue.cases, ...catalogue.guardCases]) {
    assert.ok(item.workerRequest.length > 25);
    assert.ok(item.fixtureRequirements.length > 0);
    assert.ok(item.reviewerOracle.observableAssertions.length >= 2);
    assert.ok(item.reviewerOracle.evidence.length > 0);
  }
});

test('behaviors span genres and include negative/interrupt/recovery definitions', () => {
  assert.ok(new Set(catalogue.cases.map(c => c.genre)).size >= 10);
  assert.equal(catalogue.guardCases.length, 10);
  for (const id of ['guard-genre-leak', 'guard-quota-and-model-choice', 'guard-cancel-during-test', 'guard-uncertain-paid-upload']) {
    assert.ok(catalogue.guardCases.some(c => c.id === id));
  }
});

test('routing cases pin realistic gameplay-code briefs to declared skills and references', async () => {
  const registry = await loadRegistry(ROOT), byId = new Map(registry.skills.map(s => [s.id, s]));
  const routing = catalogue.routingCases;
  assert.ok(Array.isArray(routing) && routing.length >= 10);
  assert.equal(new Set(routing.map(r => r.id)).size, routing.length);
  assert.equal(new Set(routing.map(r => r.request.toLowerCase())).size, routing.length);
  for (const item of routing) {
    assert.match(item.id, /^routing-[a-z0-9-]+$/);
    assert.ok(item.request.length >= 15 && item.request.length <= 2000, item.id);
    assert.ok(byId.has(item.firstSkill), item.id);
    assert.ok(!item.alsoIncluded.includes(item.firstSkill) && item.alsoIncluded.every(id => byId.has(id)), item.id);
    for (const reference of item.references) {
      const [skill, name] = reference.split(':');
      assert.ok(byId.get(skill)?.references.some(r => r.name === name), `${item.id}: ${reference}`);
    }
  }
  for (const brief of ['round system', 'shop with datastore saving', 'sprint and stamina bar', 'checkpoint obby', 'enemy that chases', 'shopkeeper npc with dialogue', 'pet that follows'])
    assert.ok(routing.some(r => r.request.toLowerCase().includes(brief)), brief);
});
