import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createWorkflowHost, workflowReceiptParent } from '../../apps/daemon/src/workflow-host.js';
import { workflowRoutes } from '../../apps/daemon/src/workflow-routes.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';

// Exercise native Windows owner/ancestor ACLs and real signing-key preparation.
// No replacement native checker, fabricated descriptor, home override or model is used.
const windows = { skip: process.platform !== 'win32', timeout: 30_000 };
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-normal-owner-'));
  const profile = join(root, 'Roaming', 'Arcane');
  const projectPath = join(profile, 'projects', 'Untitled');
  mkdirSync(projectPath, { recursive: true });
  const identity = workflowProjectIdentity(projectPath);
  const state = join(profile, 'runtime', 'projects', identity.projectId);
  const directory = join(state, 'connection-lab', 'workflows');
  mkdirSync(directory, { recursive: true });
  const work = new WorkStore({ directory: state, projectPath });
  const associations = new ConversationWorkStore({ directory: join(state, 'conversation-work'), projectPath });
  const parent = workflowReceiptParent(directory, identity.projectId);
  const keyDirectory = join(parent, 'workflow-human-receipts');
  const key = join(keyDirectory, 'key-v1');
  const hosts: ReturnType<typeof createWorkflowHost>[] = [];
  const open = (borrowedProject = projectPath) => {
    const host = createWorkflowHost({ directory, projectPath,
      workStore: { store: work, projectPath: borrowedProject },
      workAssociations: associations, conversation: () => null });
    hosts.push(host); return host;
  };
  t.after(() => {
    for (const host of hosts) host.close();
    associations.close(); work.close();
    // Delete only the fresh, exact project/state-bound receipt scope we created.
    assert.equal(dirname(parent).toLowerCase(), join(homedir(), '.arcane-private-receipts-v1').toLowerCase());
    assert.match(basename(parent), /^[a-f0-9]{64}$/);
    assert.equal(lstatSync(parent).isSymbolicLink(), false);
    rmSync(parent, { recursive: true, force: true });
    const part = relative(resolve(tmpdir()), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, projectPath, directory, identity, parent, keyDirectory, key, open };
}
function keyIdentity(key: string) {
  const s = lstatSync(key);
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}

test('normal Untitled/project-state layout opens with real owner permissions; HTTP authority precedes key preparation', windows, async t => {
  const f = fixture(t);
  let host = f.open();
  const human = randomUUID(), agent = randomUUID();
  let origin = '';
  const server = createServer((req, res) => {
    void workflowRoutes(host)(req, res, new URL(req.url!, origin), human, origin, agent);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const get = (path: string, token?: string, requestOrigin = origin) => new Promise<{ status: number; body: unknown }>((done, reject) => {
    const req = request(origin + path, { headers: { Origin: requestOrigin,
      ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', text => { raw += text; });
      res.on('end', () => { try { done({ status: res.statusCode!, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(12_000, () => req.destroy(Error('Owned workflow GET deadline')));
    req.on('error', reject); req.end();
  });
  assert.equal((await get('/v1/workflows')).status, 401);
  assert.equal((await get('/v1/workflows', agent)).status, 403);
  assert.equal((await get('/v1/workflows', human, 'http://127.0.0.1:1')).status, 403);
  assert.equal((await get('/v1/workflows?project=other', human)).status, 400);
  assert.equal(existsSync(f.key), false);
  assert.deepEqual(await get('/v1/workflows', human), { status: 200, body: { projectId: f.identity.projectId, workflows: [] } });
  assert.equal(lstatSync(f.key).nlink, 1);
  const before = keyIdentity(f.key);
  assert.equal(before.size, 32);
  assert.deepEqual(await get('/v1/workflows/current-flow', human), { status: 200, body: null });
  host.close(); host = f.open();
  assert.deepEqual(await get('/v1/workflows', human), { status: 200, body: { projectId: f.identity.projectId, workflows: [] } });
  assert.deepEqual(keyIdentity(f.key), before);
});

test('normal owner storage rejects a hardlinked signing key and a mismatched borrowed project without replacement', windows, t => {
  const f = fixture(t);
  const first = f.open(); assert.deepEqual(first.list().workflows, []); first.close();
  const before = keyIdentity(f.key);
  const alias = join(f.root, 'owned-key-hardlink');
  linkSync(f.key, alias);
  try { assert.throws(() => f.open().list(), { code: 'WORKFLOW_RECEIPT_STORAGE' }); }
  finally { unlinkSync(alias); }
  assert.deepEqual(keyIdentity(f.key), before);
  const other = join(f.root, 'other-project'); mkdirSync(other);
  assert.throws(() => f.open(other).list(), { code: 'WORKFLOW_PROJECT' });
  assert.deepEqual(keyIdentity(f.key), before);
  assert.deepEqual(f.open().list(), { projectId: f.identity.projectId, workflows: [] });
});

test('native ACL refusal keeps an existing owned receipt directory and key unchanged', windows, t => {
  const f = fixture(t);
  const first = f.open(); first.list(); first.close();
  const before = keyIdentity(f.key);
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // This script can only mutate this test's already created fixed receipt child.
  // Add Everyone Read, which must be refused even though it grants no write.
  const script = String.raw`
    $ErrorActionPreference='Stop'
    $dir=$env:ARCANE_OWNED_TEST_RECEIPT_DIR
    if([IO.Path]::GetFileName($dir) -cne 'workflow-human-receipts'){exit 1}
    $acl=[IO.Directory]::GetAccessControl($dir)
    if($env:ARCANE_OWNED_TEST_ADD_RULE -eq '1'){
      $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      [IO.Directory]::SetAccessControl($dir,$acl)
      $acl=[IO.Directory]::GetAccessControl($dir)
    }
    [Console]::Write($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
  `;
  const acl = (add: boolean) => {
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ARCANE_OWNED_TEST_RECEIPT_DIR: f.keyDirectory, ARCANE_OWNED_TEST_ADD_RULE: add ? '1' : '0' },
      shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8',
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0); return result.stdout;
  };
  const refusedAcl = acl(true);
  assert.throws(() => f.open().list(), { code: 'WORKFLOW_RECEIPT_STORAGE' });
  assert.equal(acl(false), refusedAcl);
  assert.deepEqual(keyIdentity(f.key), before);
});
