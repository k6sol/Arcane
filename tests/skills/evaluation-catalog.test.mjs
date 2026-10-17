import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../../scripts/skill-pack.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const catalogue = JSON.parse(await fs.readFile(new URL('./evaluations.json', import.meta.url), 'utf8'));

test('behavior catalogue covers each authored skill exactly once without claiming runs', async () => {
  const registry = await loadRegistry(ROOT);
  assert.equal(catalogue.definitionOnly, true);
  assert.equal(catalogue.runStatus, 'not-run');
  assert.deepEqual(catalogue.runs, []);
  assert.equal(catalogue.cases.length, 55);
  assert.deepEqual(catalogue.cases.map(c => c.primarySkill).sort(), registry.skills.map(s => s.id).sort());
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
