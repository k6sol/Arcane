import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARCANE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
test('MCP acceptance initializes the production entrypoint and reads bundled guidance without daemon effects', async t => {
  const project = await mkdtemp(join(tmpdir(), 'arcane-mcp-runtime-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  // A project-local decoy cannot replace integrity-checked bundled guidance.
  await mkdir(join(project, 'skills')); await writeFile(join(project, 'skills/registry.json'), 'project decoy');
  const { checkMcpRuntime } = await import(pathToFileURL(join(root, 'scripts/check-mcp-runtime.mjs')).href);
  const { default: policy } = await import(pathToFileURL(join(root, 'apps/desktop/electron/policy.cjs')).href);
  const env = policy.daemonEnvironment(process.env, { productRoot: root, stateRoot: join(project, 'state'), projectPath: project });
  const proof = await checkMcpRuntime({ nodeExecutable: process.execPath, productRoot: root, workingDirectory: project, env, expectedTools: ARCANE_TOOL_NAMES });
  assert.equal(proof.tools, ARCANE_TOOL_NAMES.length); assert.equal(proof.guidanceRead, true);
  assert.equal(proof.shutdownVerified, true); assert.equal(proof.code, 0); assert.equal(proof.signal, null);
  assert.equal(proof.daemonRequests, 0); assert.equal(proof.diagnosticBytes, 0);
  assert.equal(proof.inferenceStarted, false); assert.equal(proof.studioOperations, 0);
});
