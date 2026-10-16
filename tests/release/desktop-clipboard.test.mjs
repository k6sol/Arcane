import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const policyPath = fileURLToPath(new URL('../../apps/desktop/electron/policy.cjs', import.meta.url));
const { installClipboardPermissions, protectConsolePipes } = require(policyPath);
const origin = 'http://127.0.0.1:45871';

function fixture() {
  const handlers = {}, frame = { url: origin + '/studio#owned-fixture' };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const owner = { origin, active: true, window: { webContents: contents, isDestroyed: () => false } };
  installClipboardPermissions({
    setPermissionCheckHandler: fn => { handlers.check = fn; },
    setPermissionRequestHandler: fn => { handlers.request = fn; },
  }, () => owner);
  const details = { isMainFrame: true, requestingUrl: frame.url };
  return { handlers, contents, owner, details };
}

test('desktop clipboard writes belong only to the current owned main frame; read and unrelated permissions stay denied', () => {
  const f = fixture();
  assert.equal(f.handlers.check(f.contents, 'clipboard-sanitized-write', origin, f.details), true);
  assert.equal(f.handlers.check(f.contents, 'clipboard-sanitized-write', origin + '/', f.details), true, 'Electron supplies an origin URL with a trailing slash');
  let requested;
  f.handlers.request(f.contents, 'clipboard-sanitized-write', result => { requested = result; }, f.details);
  assert.equal(requested, true);
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications', 'unknown']) {
    assert.equal(f.handlers.check(f.contents, permission, origin, f.details), false, permission);
    f.handlers.request(f.contents, permission, result => { requested = result; }, f.details);
    assert.equal(requested, false, permission);
  }
  for (const [contents, source, details] of [
    [null, origin, f.details], [{ ...f.contents }, origin, f.details], [f.contents, 'https://example.com', f.details], [f.contents, origin + '/studio', f.details],
    [f.contents, origin, { ...f.details, isMainFrame: false }], [f.contents, origin, undefined],
    [f.contents, origin, { ...f.details, requestingUrl: origin + '/other' }],
    [f.contents, origin, { ...f.details, requestingUrl: origin + '/studio#other-frame' }],
  ]) assert.equal(f.handlers.check(contents, 'clipboard-sanitized-write', source, details), false);
  f.owner.active = false;
  assert.equal(f.handlers.check(f.contents, 'clipboard-sanitized-write', origin, f.details), false);
  f.owner.active = true; f.owner.window.isDestroyed = () => true;
  assert.equal(f.handlers.check(f.contents, 'clipboard-sanitized-write', origin, f.details), false);
});

test('disconnected console streams do not suppress unrelated stream errors', () => {
  const output = new EventEmitter(); protectConsolePipes([output]);
  assert.doesNotThrow(() => output.emit('error', Object.assign(new Error('Owned broken pipe fixture.'), { code: 'EPIPE' })));
  const error = Object.assign(new Error('Owned unrelated fixture.'), { code: 'EIO' });
  assert.throws(() => output.emit('error', error), actual => actual === error);
});

test('an actual child stays alive when both inherited console readers close before an IPC reply', async () => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp'].includes(name.toLowerCase())));
  const script = `const policy = require(${JSON.stringify(policyPath)});
    policy.protectConsolePipes([process.stdout, process.stderr]);
    process.on('message', message => {
      if (message === 'write') {
        let pending = 2;
        for (const [name, output] of [['stdout', process.stdout], ['stderr', process.stderr]])
          output.write('Owned desktop reply fixture.\\n', error => {
            process.send({ pipe: name, code: error?.code ?? null });
            if (--pending === 0) process.send({ alive: true });
          });
      } else if (message === 'finish') process.exit(0);
    }); process.send({ ready: true });`;
  const child = spawn(process.execPath, ['-e', script], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const rows = [];
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', async row => {
      rows.push(row);
      if (row.ready) {
        await Promise.all([child.stdout, child.stderr].map(output => new Promise(done => { output.once('close', done); output.destroy(); })));
        child.send('write');
      }
      if (row.alive) child.send('finish');
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(rows.filter(row => row.pipe).map(row => [row.pipe, row.code]).sort(), [['stderr', 'EPIPE'], ['stdout', 'EPIPE']]);
  assert.equal(rows.some(row => row.alive), true);
});
