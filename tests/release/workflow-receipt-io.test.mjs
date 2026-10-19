import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// COMPONENT PROOF ONLY: filesystem/native ACL boundary DOUBLES.
// Only source reads and an owned Node helper use the real operating system.
// No native ACL subprocess, provider, Studio, compiler, or product is started.
const HOST_URL = new URL('../../apps/daemon/src/workflow-host.ts', import.meta.url);
const ACL_URL = new URL('../../apps/daemon/src/workflow-private-storage.ts', import.meta.url);
const hostSource = readFileSync(HOST_URL, 'utf8');
const begin = hostSource.indexOf('class ReceiptKey {');
const end = hostSource.indexOf('/** Fixed domain and private storage only.', begin);
const authorityBegin = hostSource.indexOf('export function createAssetReviewReceiptAuthority(', end);
const authorityEnd = hostSource.indexOf('function representation(', authorityBegin);
assert.ok(authorityBegin > end && authorityEnd > authorityBegin, 'exact fixed-domain authority extraction boundaries must exist');
assert.equal(hostSource.indexOf('export function createAssetReviewReceiptAuthority(', authorityBegin + 1), -1);
const authoritySource = hostSource.slice(authorityBegin, authorityEnd);
assert.ok(begin >= 0 && end > begin, 'exact private class extraction boundaries must exist');
assert.equal(hostSource.indexOf('class ReceiptKey {', begin + 1), -1);
const classSource = hostSource.slice(begin, end);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourcePin = Object.freeze({
  host: sha256(hostSource), receiptClass: sha256(classSource), reviewAuthority: sha256(authoritySource),
  privateStorage: sha256(readFileSync(ACL_URL)),
});
const HELPER_DEADLINE_MS = 3000;
const HELPER_OPTIONS = Object.freeze({
  encoding: 'utf8', timeout: HELPER_DEADLINE_MS, killSignal: 'SIGKILL',
  maxBuffer: 64 * 1024, shell: false, windowsHide: true, env: {},
});

// This is a boundary harness, not an alternative ReceiptKey implementation.
// The exact extracted class uses Node 24's type stripper. The separately pinned
// adjacent authority drops only its module export keyword for VM evaluation.
async function receiptBoundaryWorker(input) {
  const { default: assert } = await import('node:assert/strict');
  const { createHash, createHmac, timingSafeEqual } = await import('node:crypto');
  const { stripTypeScriptTypes } = await import('node:module');
  const { Script } = await import('node:vm');
  const { win32, posix } = await import('node:path');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(input.classSource), input.sourcePin.receiptClass, 'immutable helper source pin');
  assert.equal(hash(input.authoritySource), input.sourcePin.reviewAuthority, 'immutable fixed-domain authority pin');
  const source = input.classSource + '\n' + input.authoritySource.replace(/^export (?=function createAssetReviewReceiptAuthority\()/, '');
  const compiled = new Script(stripTypeScriptTypes(source, { mode: 'strip' }) + '\n({ReceiptKey,createAssetReviewReceiptAuthority});',
    { filename: 'workflow-host.ts:exact-private-ReceiptKey' });
  const path = input.platform === 'win32' ? win32 : posix;
  const parent = input.platform === 'win32' ? 'C:\\receipt-boundary-fixture' : '/receipt-boundary-fixture';
  const directory = path.join(parent, 'workflow-human-receipts');
  const file = path.join(directory, 'key-v1');
  const unrelated = path.join(parent, 'unrelated-sentinel');
  const refusal = (code = 'WORKFLOW_RECEIPT_STORAGE') => Object.assign(new Error('synthetic storage refusal'), { code });
  const ioError = () => Object.assign(new Error('synthetic I/O refusal'), { code: 'EIO' });
  const invalidNames = ['zero', 'negative', 'nan', 'infinity', 'negative-infinity',
    'fractional', 'oversized', 'unsafe-integer', 'string', 'undefined'];
  const invalidCount = (name, remaining) => ({
    zero: 0, negative: -1, nan: NaN, infinity: Infinity, 'negative-infinity': -Infinity,
    fractional: 0.5, oversized: remaining + 1, 'unsafe-integer': Number.MAX_SAFE_INTEGER + 1,
    string: '1', undefined: undefined,
  })[name];
  const initialBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i));
  const freshBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
  const cases = [];

  function fixture(options = {}) {
    let nextInode = 10, nextFd = 100;
    const nodes = new Map(), descriptors = new Map(), events = [], randomBuffers = [], readBuffers = [];
    const directDenied = new Set(options.directDenied ?? []);
    const state = { writeCalls: 0, readCalls: 0, statCalls: 0, adversarialStore: null, options };
    // Flag values belong to the filesystem double; Windows also exercises absent O_NOFOLLOW.
    const constants = { O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128,
      ...(input.platform === 'win32' ? {} : { O_NOFOLLOW: 131072 }) };
    const node = (kind, bytes = Buffer.alloc(0), overrides = {}) => ({
      kind, bytes: Buffer.from(bytes), dev: 1, ino: nextInode++, mode: kind === 'directory' ? 0o700 : 0o600,
      uid: 1000, nlink: 1, mtimeMs: 10, ctimeMs: 20, ...overrides,
    });
    nodes.set(parent, node('directory'));
    nodes.set(unrelated, node('file', Buffer.from('unchanged synthetic sentinel')));
    if (options.existing !== false) {
      nodes.set(directory, node('directory', Buffer.alloc(0), options.directoryOverrides));
      if (!options.missingKey) nodes.set(file, node(options.keyKind ?? 'file',
        options.bytes ?? initialBytes, options.keyOverrides));
    }
    // A foreign descriptor proves cleanup touches only descriptors owned by ReceiptKey.
    descriptors.set(99, { node: nodes.get(unrelated), path: unrelated, closed: false, foreign: true });
    const store = () => JSON.stringify([...nodes].map(([name, entry]) => ({
      name, ...entry, bytes: entry.bytes.toString('hex'),
    })));
    const initialStore = store();
    const record = (op, facts = {}) => { const event = { op, ...facts }; events.push(event); return event; };
    const requiredNode = name => {
      const entry = nodes.get(name);
      if (!entry) throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
      return entry;
    };
    const stat = entry => ({
      dev: entry.dev, ino: entry.ino, size: entry.bytes.length, mode: entry.mode, uid: entry.uid,
      nlink: entry.nlink, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
      isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file',
      isSymbolicLink: () => entry.kind === 'link',
    });
    const owned = fd => {
      const entry = descriptors.get(fd);
      assert.ok(entry && !entry.foreign && !entry.closed, 'operation requires an owned live descriptor');
      return entry;
    };
    const planned = (steps, call, remaining) => {
      const step = steps?.[call - 1];
      if (step?.invalid) return invalidCount(step.invalid, remaining);
      if (step?.throws) throw ioError();
      return step;
    };
    const context = {
      Buffer, process: { platform: input.platform, getuid: () => 1000 }, constants,
      join: path.join, dirname: path.dirname, createHmac, timingSafeEqual,
      HASH: /^[a-f0-9]{64}$/, DOMAIN: 'synthetic-receipt-test-domain\0',
      canonical: value => JSON.stringify(value),
      fail: code => { assert.ok(['WORKFLOW_RECEIPT_STORAGE','WORKFLOW_CLOSED'].includes(code)); throw refusal(code); },
      workflowReceiptParent: (selected, projectId) => {
        record('receiptParent', { selected, projectId }); assert.equal(selected, parent); return parent;
      },
      // Controlled path/directPath seam: explicit denials simulate unsafe direct paths.
      directPath: selected => {
        record('directPath', { path: selected });
        assert.ok([parent, directory, file].includes(selected), 'fixed child paths only');
        if (directDenied.has(selected)) throw refusal();
        return selected;
      },
      existsSync: selected => { record('exists', { path: selected }); return nodes.has(selected); },
      lstatSync: selected => { record('lstat', { path: selected }); return stat(requiredNode(selected)); },
      // Controlled stat-contract seam; this does not certify real modes or ACLs.
      privateMode: (selected, isDirectory) => {
        record('privateMode', { directory: isDirectory });
        if (!(isDirectory ? selected.isDirectory() : selected.isFile() && selected.nlink === 1)) throw refusal();
        if (input.platform !== 'win32' &&
            ((selected.mode & 0o777) !== (isDirectory ? 0o700 : 0o600) || selected.uid !== 1000)) throw refusal();
      },
      sameFile: (a, b) => {
        record('sameFile');
        return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(name => a[name] === b[name]);
      },
      // Explicit native ACL boundary DOUBLE: no PowerShell/native operation exists here.
      privateWorkflowReceiptStorage: (selected, prepare, key) => {
        record('acl', { parent: selected, prepare, key,
          boundary: 'native-ACL-double', nativeProcess: false });
        assert.equal(selected, parent);
        assert.equal(typeof prepare, 'boolean'); assert.equal(typeof key, 'boolean');
        if (input.platform !== 'win32') { assert.equal(prepare, false); return null; }
        assert.ok((prepare && !key) || (!prepare && key), 'only exact preparation or full validation');
        if (prepare) {
          if (options.prepareThrows) throw refusal();
          const result = Object.hasOwn(options, 'prepareResult') ? options.prepareResult :
            { version: 1, created: true, directoryPrivate: true, keyPrivate: false, ancestorsSafe: true };
          if (result?.created === true && !options.omitPreparedDirectory) nodes.set(directory, node('directory'));
          return result;
        }
        if (options.fullAclDenied || state.fullAclDenied) throw refusal();
        return { version: 1, created: false, directoryPrivate: true, keyPrivate: true, ancestorsSafe: true };
      },
      mkdirSync: (selected, settings) => {
        record('mkdir', { path: selected, settings });
        assert.equal(input.platform, 'linux'); assert.equal(selected, directory);
        assert.equal(settings.mode, 0o700); assert.deepEqual(Object.keys(settings), ['mode']);
        assert.equal(nodes.has(selected), false); nodes.set(selected, node('directory'));
      },
      openSync: (selected, flags, mode) => {
        const writing = (flags & constants.O_WRONLY) !== 0;
        const event = record('open', { path: selected, flags, mode, writing });
        if (options.openThrows) throw ioError();
        if (writing) {
          assert.equal(selected, file);
          assert.equal(flags, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
          assert.equal(mode, 0o600);
          requiredNode(directory);
          if (options.exclusiveCollision) {
            nodes.set(file, node('file', Buffer.from('raced synthetic bytes')));
            state.adversarialStore = store();
          }
          if (nodes.has(selected)) throw Object.assign(new Error('synthetic exclusive collision'), { code: 'EEXIST' });
          nodes.set(selected, node('file'));
        } else {
          assert.equal(flags, constants.O_RDONLY | (selected === file ? (constants.O_NOFOLLOW ?? 0) : 0));
        }
        if (state.onOpen) state.onOpen(selected, writing);
        const fd = nextFd++; event.fd = fd;
        descriptors.set(fd, { node: requiredNode(selected), path: selected, writing, closed: false, closes: 0 });
        return fd;
      },
      randomBytes: length => {
        if (length === 8) { record('nonce', { length }); return Buffer.alloc(8, 0xab); }
        record('random', { length }); assert.equal(length, 32);
        const bytes = Buffer.from(freshBytes); randomBuffers.push(bytes); return bytes;
      },
      writeSync: (fd, bytes, offset, remaining) => {
        const entry = owned(fd); assert.equal(entry.writing, true);
        state.writeCalls++;
        const event = record('write', { fd, offset, remaining });
        const result = options.writePlan && state.writeCalls <= options.writePlan.length ?
          planned(options.writePlan, state.writeCalls, remaining) : remaining;
        event.result = String(result); event.type = typeof result;
        if (Number.isSafeInteger(result) && result > 0 && result <= remaining) {
          const end = offset + result;
          const updated = Buffer.alloc(Math.max(end, entry.node.bytes.length));
          entry.node.bytes.copy(updated); bytes.copy(updated, offset, offset, end); entry.node.bytes = updated;
        }
        return result;
      },
      readSync: (fd, bytes, offset, remaining, position) => {
        const entry = owned(fd); assert.equal(entry.writing, false);
        state.readCalls++; readBuffers.push(bytes);
        const event = record('read', { fd, offset, remaining, position });
        assert.equal(position, offset); assert.equal(remaining, bytes.length - offset);
        if (state.beforeRead) state.beforeRead(entry, state.readCalls);
        const available = Math.max(0, entry.node.bytes.length - position);
        const result = options.readPlan && state.readCalls <= options.readPlan.length ?
          planned(options.readPlan, state.readCalls, remaining) : Math.min(remaining, available);
        event.result = String(result); event.type = typeof result;
        if (Number.isSafeInteger(result) && result > 0 && result <= remaining) {
          assert.ok(result <= available, 'valid synthetic reads cannot invent bytes');
          entry.node.bytes.copy(bytes, offset, position, position + result);
          state.partialRead = Buffer.from(bytes.subarray(0, offset + result));
        }
        if (state.afterRead) state.afterRead(entry, state.readCalls);
        return result;
      },
      fsyncSync: fd => {
        const entry = owned(fd); record('fsync', { fd, path: entry.path });
        if (options.fsyncThrows === (entry.path === file ? 'key' : 'directory')) throw ioError();
      },
      fstatSync: fd => {
        const entry = owned(fd); state.statCalls++; record('fstat', { fd });
        if (state.statCalls === options.fstatThrowsAt) throw ioError();
        return stat(entry.node);
      },
      closeSync: fd => { const entry = owned(fd); entry.closed = true; entry.closes++; record('close', { fd }); },
    };
    const {ReceiptKey,createAssetReviewReceiptAuthority} = compiled.runInNewContext(context);
    const construct = () => new ReceiptKey(parent, 'synthetic-project-id');
    const authority = () => createAssetReviewReceiptAuthority(parent, 'synthetic-project-id');
    const operations = name => events.filter(event => event.op === name);
    const untouched = expected => assert.equal(store(), expected ?? initialStore, 'all synthetic storage bytes/metadata retained');
    const closed = () => {
      assert.equal(descriptors.get(99).closed, false, 'foreign descriptor retained');
      for (const [fd, entry] of descriptors) if (fd !== 99) {
        assert.equal(entry.closed, true, 'owned descriptor closed');
        assert.equal(entry.closes, 1, 'owned descriptor closed exactly once');
      }
      for (const bytes of [...randomBuffers, ...readBuffers]) assert.ok(bytes.every(value => value === 0), 'temporary bytes erased');
    };
    const noRegeneration = () => {
      for (const op of ['write', 'mkdir', 'random', 'fsync']) assert.equal(operations(op).length, 0, 'no ' + op + ' on existing storage');
      assert.equal(operations('open').some(event => event.writing), false, 'existing key is never opened for writing');
      assert.equal(operations('acl').some(event => event.prepare), false, 'no preparation for existing storage');
    };
    const noKeyIo = () => {
      assert.equal(operations('open').filter(event => event.path === file).length, 0);
      assert.equal(operations('read').length, 0);
    };
    const rejects = (run = construct, code = 'WORKFLOW_RECEIPT_STORAGE') =>
      assert.throws(run, error => error.code === code);
    const summary = name => {
      closed();
      const item = { name, aclCalls: operations('acl').length,
        keyOpens: operations('open').filter(event => event.path === file).length,
        reads: state.readCalls, writes: state.writeCalls,
        ownedCloses: operations('close').length, keyBytes: nodes.get(file)?.bytes.length ?? null };
      if (input.group === 'existing' || input.group === 'new-success') item.trace = events;
      cases.push(item);
    };
    return { state, nodes, node, descriptors, events, directDenied, store, initialStore, construct,
      operations, untouched, closed, noRegeneration, noKeyIo, rejects, summary, constants, authority };
  }
  const fullBeforeOpen = f => {
    const acl = f.operations('acl');
    assert.equal(acl.length, 1, 'one full ACL call, no redundant directory-only check');
    assert.deepEqual([acl[0].parent, acl[0].prepare, acl[0].key], [parent, false, true]);
    const firstOpen = f.events.findIndex(event => event.op === 'open' && event.path === file);
    assert.ok(firstOpen > f.events.indexOf(acl[0]), 'full ACL validation before the first key descriptor/byte');
    assert.ok(f.events.findIndex(event => event.op === 'read') > firstOpen);
  };

  switch (input.group) {
    case 'existing': {
      for (const readPlan of [undefined, [1, 7, 24, 0]]) {
        const f = fixture({ readPlan }); const key = f.construct();
        assert.deepEqual(key.key, initialBytes); fullBeforeOpen(f);
        f.untouched(); f.noRegeneration(); key.close(); assert.ok(key.key.every(byte => byte === 0));
        f.summary(readPlan ? 'fragmented-existing-key' : 'existing-key');
      }
      break;
    }
    case 'acl-denial': {
      for (const domain of ['directory', 'key', 'ancestor']) {
        const f = fixture({ fullAclDenied: domain }); f.rejects();
        assert.deepEqual(f.operations('acl').map(e => [e.parent, e.prepare, e.key]), [[parent, false, true]]);
        f.noKeyIo(); f.noRegeneration(); f.untouched(); f.summary(domain + '-full-acl-denial');
      }
      break;
    }
    case 'existing-damage': {
      const variants = [
        ['missing-key', { missingKey: true }], ['empty-key', { bytes: Buffer.alloc(0) }],
        ['short-key', { bytes: Buffer.alloc(31) }], ['oversized-key', { bytes: Buffer.alloc(33) }],
        ['key-is-directory', { keyKind: 'directory' }],
        ['symbolic-key', { keyKind: 'link', directDenied: [file] }],
        ['hardlinked-key', { keyOverrides: { nlink: 2 } }],
        ['linked-receipt-directory', { directDenied: [directory] }],
        ['linked-ancestor', { directDenied: [parent] }],
        ['receipt-path-is-file', { directoryOverrides: { kind: 'file' } }],
        ...(input.platform === 'linux' ? [
          ['nonprivate-key-mode', { keyOverrides: { mode: 0o644 } }],
          ['wrong-key-owner', { keyOverrides: { uid: 1001 } }],
          ['nonprivate-directory-mode', { directoryOverrides: { mode: 0o755 } }],
          ['wrong-directory-owner', { directoryOverrides: { uid: 1001 } }],
        ] : []),
      ];
      for (const [name, options] of variants) {
        const f = fixture(options); f.rejects(undefined, options.missingKey ? 'ENOENT' : 'WORKFLOW_RECEIPT_STORAGE'); f.noKeyIo(); f.noRegeneration(); f.untouched(); f.summary(name);
      }
      break;
    }
    case 'replacement-races': {
      for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
        const f = fixture();
        f.state.onOpen = (selected, writing) => {
          assert.equal(writing, false); assert.equal(selected, file);
          const entry = f.nodes.get(file);
          if (field === 'size') entry.bytes = Buffer.concat([entry.bytes, Buffer.from([1])]);
          else entry[field]++;
          f.state.adversarialStore = f.store();
        };
        f.rejects(); assert.equal(f.state.readCalls, 0); f.noRegeneration();
        f.untouched(f.state.adversarialStore); f.summary('open-identity-change-' + field);
      }
      for (const name of ['path-replacement', 'in-place-change', 'extra-byte', 'linked-after-read']) {
        const f = fixture();
        f.state.afterRead = (entry, call) => {
          if (call !== 1) return;
          if (name === 'path-replacement') f.nodes.set(file, f.node('file', initialBytes));
          if (name === 'in-place-change') { entry.node.bytes[0] ^= 1; entry.node.mtimeMs++; }
          if (name === 'extra-byte') entry.node.bytes = Buffer.concat([entry.node.bytes, Buffer.from([0xff])]);
          if (name === 'linked-after-read') f.directDenied.add(file);
          f.state.adversarialStore = f.store();
        };
        f.rejects(); f.noRegeneration(); f.untouched(f.state.adversarialStore); f.summary(name);
      }
      break;
    }
    case 'new-success': {
      for (const fragmented of [false, true]) {
        const f = fixture({ existing: false,
          ...(fragmented ? { writePlan: [3, 5, 24], readPlan: [7, 12, 13, 0] } : {}) });
        const key = f.construct(); assert.deepEqual(key.key, freshBytes);
        assert.deepEqual(f.nodes.get(file).bytes, freshBytes);
        const expectedAcl = input.platform === 'win32' ? [[parent, true, false], [parent, false, true]] : [[parent, false, true]];
        assert.deepEqual(f.operations('acl').map(e => [e.parent, e.prepare, e.key]), expectedAcl);
        assert.equal(f.operations('mkdir').length, input.platform === 'win32' ? 0 : 1);
        assert.equal(f.operations('random').length, 1);
        const writeOpen = f.operations('open').find(e => e.writing), readOpen = f.operations('open').find(e => e.path === file && !e.writing);
        const full = f.operations('acl').find(e => e.key);
        assert.ok(f.events.indexOf(full) > f.events.findIndex(e => e.op === 'close' && e.fd === writeOpen.fd));
        assert.ok(f.events.indexOf(full) < f.events.indexOf(readOpen), 'full check after creation and before reading');
        assert.deepEqual(f.operations('fsync').map(e => e.path), input.platform === 'win32' ? [file] : [file, directory]);
        assert.equal(f.nodes.get(unrelated).bytes.toString(), 'unchanged synthetic sentinel');
        key.close(); f.summary(fragmented ? 'fragmented-new-key' : 'new-key');
      }
      break;
    }
    case 'prepare-denial': {
      const variants = [
        ['null', { prepareResult: null }], ['undefined', { prepareResult: undefined }],
        ['false', { prepareResult: false }], ['missing-created', { prepareResult: {} }],
        ['created-false', { prepareResult: { created: false } }],
        ['created-number', { prepareResult: { created: 1 } }],
        ['created-string', { prepareResult: { created: 'true' } }],
        ['prepare-throws', { prepareThrows: true }],
      ];
      for (const [name, options] of variants) {
        const f = fixture({ existing: false, ...options }); f.rejects(); f.noKeyIo(); f.untouched();
        assert.equal(f.operations('random').length, 0); assert.equal(f.operations('write').length, 0);
        assert.deepEqual(f.operations('acl').map(e => [e.parent, e.prepare, e.key]), [[parent, true, false]]);
        f.summary(name);
      }
      const missing = fixture({ existing: false, omitPreparedDirectory: true });
      missing.rejects(undefined, 'ENOENT'); missing.noKeyIo(); missing.untouched(); missing.summary('approved-descriptor-with-missing-directory');
      break;
    }
    case 'new-full-denial': {
      for (const domain of ['directory', 'key', 'ancestor']) {
        const f = fixture({ existing: false, fullAclDenied: domain }); f.rejects();
        assert.deepEqual(f.operations('acl').map(e => [e.parent, e.prepare, e.key]), [[parent, true, false], [parent, false, true]]);
        assert.equal(f.state.readCalls, 0); assert.equal(f.operations('open').filter(e => !e.writing).length, 0);
        assert.deepEqual(f.nodes.get(file).bytes, freshBytes, 'created bytes retained after denied full check');
        assert.equal(f.operations('random').length, 1); assert.equal(f.state.writeCalls, 1);
        f.summary(domain + '-new-key-full-acl-denial');
      }
      break;
    }
    case 'write-counts': {
      for (const name of invalidNames) for (const prefix of [0, 5]) {
        const f = fixture({ existing: false, writePlan: [...(prefix ? [prefix] : []), { invalid: name }] });
        f.rejects(); assert.equal(f.state.writeCalls, prefix ? 2 : 1, 'no retry after invalid write count');
        assert.deepEqual(f.nodes.get(file).bytes, freshBytes.subarray(0, prefix), 'exact partial bytes retained');
        assert.deepEqual(f.operations('write').map(e => [e.offset, e.remaining]), prefix ? [[0, 32], [5, 27]] : [[0, 32]]);
        assert.equal(f.state.readCalls, 0); assert.equal(f.operations('fsync').length, 0);
        assert.equal(f.operations('acl').filter(e => e.key).length, 0);
        assert.equal(f.operations('random').length, 1); f.closed();
        const retained = f.store(), writes = f.state.writeCalls;
        f.rejects(); assert.equal(f.state.writeCalls, writes, 'reopening partial storage never regenerates');
        f.untouched(retained); assert.equal(f.operations('random').length, 1);
        f.summary(name + '-after-' + prefix + '-bytes');
      }
      break;
    }
    case 'read-counts': {
      for (const name of invalidNames) for (const prefix of [0, 5]) {
        const f = fixture({ readPlan: [...(prefix ? [prefix] : []), { invalid: name }] });
        f.rejects(); assert.equal(f.state.readCalls, prefix ? 2 : 1, 'no retry after invalid count/early EOF');
        assert.deepEqual(f.operations('read').map(e => [e.offset, e.remaining]), prefix ? [[0, 33], [5, 28]] : [[0, 33]]);
        if (prefix) assert.deepEqual(f.state.partialRead, initialBytes.subarray(0, prefix));
        if (name !== 'zero') {
          assert.equal(f.state.statCalls, 1, 'invalid counts refuse before any post-read identity check');
          const lastRead = f.events.findLastIndex(event => event.op === 'read');
          assert.deepEqual(f.events.slice(lastRead + 1).map(event => event.op), ['close'], 'invalid read closes immediately');
        }
        f.noRegeneration(); f.untouched(); f.summary(name + '-after-' + prefix + '-bytes');
      }
      break;
    }
    case 'eof': {
      for (const readPlan of [[32, 0], Array(32).fill(1).concat(0)]) {
        const f = fixture({ readPlan }); const key = f.construct();
        assert.deepEqual(key.key, initialBytes); f.untouched(); f.noRegeneration(); key.close();
        assert.equal(f.operations('read').at(-1).result, '0', 'zero is valid EOF after exactly 32 bytes');
        assert.equal(f.operations('read').at(-1).remaining, 1);
        f.summary(readPlan.length === 2 ? 'zero-at-exact-eof' : 'one-byte-progress-to-eof');
      }
      break;
    }
    case 'io-errors': {
      const variants = [
        ['write-throws-after-partial', { existing: false, writePlan: [5, { throws: true }] }, 5],
        ['key-fsync-throws', { existing: false, fsyncThrows: 'key' }, 32],
        ['read-throws-after-partial', { readPlan: [5, { throws: true }] }, 32],
        ['before-fstat-throws', { fstatThrowsAt: 1 }, 32],
        ['after-fstat-throws', { fstatThrowsAt: 2 }, 32],
        ['open-throws', { openThrows: true }, 32],
        ...(input.platform === 'linux' ? [['directory-fsync-throws', { existing: false, fsyncThrows: 'directory' }, 32]] : []),
      ];
      for (const [name, options, bytes] of variants) {
        const f = fixture(options); f.rejects(undefined, 'EIO');
        assert.equal(f.nodes.get(file).bytes.length, bytes);
        if (options.existing !== false) { f.noRegeneration(); f.untouched(); }
        else assert.deepEqual(f.nodes.get(file).bytes, freshBytes.subarray(0, bytes));
        f.summary(name);
      }
      const collision = fixture({ existing: false, exclusiveCollision: true });
      collision.rejects(undefined, 'EEXIST'); collision.untouched(collision.state.adversarialStore);
      assert.equal(collision.state.writeCalls, 0); assert.equal(collision.operations('random').length, 0);
      collision.summary('exclusive-creation-collision');
      break;
    }
    case 'snapshot': {
      const f = fixture(); const key = f.construct(); fullBeforeOpen(f); f.events.length = 0;
      const prepared = { synthetic: 'request' };
      const signed = key.sign(prepared); assert.equal(signed.length, 64);
      assert.equal(key.verify(prepared, signed), true);
      assert.equal(f.operations('acl').length, 2, 'each independent sign/verify rechecks full ACL');
      assert.deepEqual(f.operations('acl').map(e => [e.prepare, e.key]), [[false, true], [false, true]]);
      f.events.length = 0;
      const result = key.withSnapshot(() => {
        assert.equal(f.operations('acl').length, 1, 'full check before evaluation');
        const token = key.sign(prepared); assert.equal(key.verify(prepared, token), true);
        return 'synchronous-result';
      });
      assert.equal(result, 'synchronous-result'); assert.equal(f.operations('acl').length, 2, 'full checks bracket assessment');
      assert.equal(f.operations('open').length, 4, 'all four key assessments still reopen/pin bytes');
      f.noRegeneration(); f.untouched(); key.close(); f.summary('uncached-full-checks-and-bracketed-snapshot');
      const changed = fixture(); const changedKey = changed.construct();
      changed.nodes.get(file).bytes[0] ^= 1; const changedStore = changed.store();
      changed.rejects(() => changedKey.sign(prepared));
      changed.noRegeneration(); changed.untouched(changedStore); changedKey.close(); changed.summary('changed-key-never-regenerated');
      if (input.platform === 'win32') {
        const denied = fixture(); const deniedKey = denied.construct(); denied.events.length = 0;
        denied.rejects(() => deniedKey.withSnapshot(() => { denied.state.fullAclDenied = true; return 'must-refuse'; }));
        assert.equal(denied.operations('acl').length, 2); assert.equal(denied.operations('open').length, 1);
        denied.noRegeneration(); denied.untouched(); deniedKey.close(); denied.summary('post-assessment-full-acl-denial');
      }
      break;
    }
    case 'model-domain': {
      const value = {subjectDigest: 'a'.repeat(64), decision: 'approved', revision: 2};
      const f = fixture(); const key = f.construct(); f.events.length = 0;
      const workflow = key.sign(value), model = key.signModelReview(value);
      const nonce = Buffer.alloc(8, 0xab).toString('hex');
      const expected = nonce + createHmac('sha256', initialBytes).update('arcane.asset-model-review.human-decision.v1\0')
        .update(nonce).update('\0').update(JSON.stringify(value)).digest('hex').slice(0,48);
      assert.equal(model, expected, 'exact fixed model-review domain/nonce/canonical bytes');
      assert.notEqual(model, workflow, 'workflow and model decisions cannot share a MAC domain');
      assert.equal(key.verifyModelReview(value, model), true); assert.equal(key.verify(value, workflow), true);
      assert.equal(key.verifyModelReview(value, workflow), false); assert.equal(key.verify(value, model), false);
      assert.equal(key.verifyModelReview({...value, decision: 'rejected'}, model), false);
      assert.equal(key.verifyModelReview({...value, revision: 3}, model), false);
      assert.equal(key.signModelReview(value, 'caller-selected-domain'), expected, 'no caller-selectable signing domain');
      assert.equal(f.operations('acl').length, 9, 'every independent model/workflow MAC retains a full ACL check');
      f.noRegeneration(); f.untouched(); key.close(); f.summary('fixed-review-domain-and-cross-domain-refusal');
      const closed = fixture(); const closedKey = closed.construct(); closedKey.close();
      closed.rejects(() => closedKey.signModelReview(value));
      closed.rejects(() => closedKey.verifyModelReview(value, model));
      closed.noRegeneration(); closed.untouched(); closed.summary('closed-private-key-refuses-model-sign-and-verify');
      const changed = fixture(); const changedKey = changed.construct(); changed.nodes.get(file).bytes[0] ^= 1;
      const retained = changed.store(); changed.rejects(() => changedKey.signModelReview(value));
      changed.rejects(() => changedKey.verifyModelReview(value, model));
      changed.noRegeneration(); changed.untouched(retained); changedKey.close(); changed.summary('changed-key-refuses-model-mac');
      break;
    }
    case 'model-authority': {
      const f = fixture(); const authority = f.authority(), value = {reviewId:'fixture',revision:1};
      assert.ok(Object.isFrozen(authority)); assert.equal(authority.directory, directory);
      assert.deepEqual(Object.keys(authority).sort(), ['close','directory','sign','verify','withSnapshot']);
      f.events.length = 0;
      const result = authority.withSnapshot(() => {
        const token = authority.sign(value); assert.equal(authority.verify(value, token), true); return 'model-snapshot';
      });
      assert.equal(result, 'model-snapshot'); assert.equal(f.operations('acl').length, 2, 'full ACL checks bracket model assessment');
      assert.equal(f.operations('open').length, 4, 'every assessment still pins exact key bytes');
      const token = authority.sign(value); authority.close(); authority.close(); f.events.length = 0;
      for (const run of [() => authority.sign(value), () => authority.verify(value, token), () => authority.withSnapshot(() => {throw new Error('closed callback ran');})])
        f.rejects(run, 'WORKFLOW_CLOSED');
      assert.equal(f.events.length, 0, 'closed authority refuses before callbacks or filesystem/native ACL access');
      f.noRegeneration(); f.untouched(); f.summary('opaque-authority-snapshot-and-durable-close');
      break;
    }
    default: throw new Error('Unknown synthetic boundary group: ' + input.group);
  }
  return { kind: 'filesystem/native ACL boundary DOUBLES', platform: input.platform, group: input.group,
    sourcePin: input.sourcePin, cases, scenarioCount: cases.length };
}

const helperProgram = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);" +
  "process.stdin.on('end',()=>(" + receiptBoundaryWorker.toString() + ")(JSON.parse(input))" +
  ".then(report=>process.stdout.write(JSON.stringify(report))).catch(error=>{console.error(error);process.exitCode=1}));";

function boundedGroup(platform, group) {
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', helperProgram], {
    ...HELPER_OPTIONS, input: JSON.stringify({ platform, group, classSource, authoritySource, sourcePin }),
  });
  assert.equal(child.error, undefined, group + ': external helper deadline/error: ' + child.error);
  assert.equal(child.signal, null, group + ': helper unexpectedly terminated');
  assert.equal(child.status, 0, group + ': ' + child.stderr);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(report.sourcePin, sourcePin, 'helper tested the exact parent source bytes');
  assert.equal(report.kind, 'filesystem/native ACL boundary DOUBLES');
  assert.equal(report.platform, platform); assert.equal(report.group, group);
  return report;
}

test('receipt source pin: exact private class, no production exports or compiler', t => {
  assert.ok(classSource.startsWith('class ReceiptKey {'));
  assert.doesNotMatch(classSource, /export function|createAssetReviewReceiptAuthority/);
  assert.ok(authoritySource.startsWith('export function createAssetReviewReceiptAuthority('));
  assert.match(classSource, /close\(\): void \{ this\.key\.fill\(0\); \}\s*\}\s*$/);
  t.diagnostic('SHA-256 pins: ' + JSON.stringify(sourcePin));
});

test('receipt loop watchdog: owned helper is killed at the fixed external deadline', () => {
  const child = spawnSync(process.execPath, ['-e', 'while (true) {}'], HELPER_OPTIONS);
  assert.equal(child.error?.code, 'ETIMEDOUT');
  assert.notEqual(child.status, 0, 'watchdog must not report a successful helper');
  assert.equal(child.stdout, '');
});

const groups = [
  ['existing', 2, 2], ['acl-denial', 3, null], ['existing-damage', 10, 14],
  ['replacement-races', 9, 9], ['new-success', 2, 2], ['prepare-denial', 9, null],
  ['new-full-denial', 3, null], ['write-counts', 20, 20], ['read-counts', 20, 20],
  ['eof', 2, 2], ['io-errors', 7, 8], ['snapshot', 3, 2], ['model-domain', 3, 3], ['model-authority', 1, 1],
];
for (const [group, windowsCases, posixCases] of groups) for (const platform of ['win32', 'linux']) {
  const expectedCases = platform === 'win32' ? windowsCases : posixCases;
  if (expectedCases === null) continue; // Real POSIX boundary returns null; no native ACL preparation.
  test('filesystem/native ACL boundary DOUBLES: ' + platform + ' / ' + group, t => {
    const report = boundedGroup(platform, group);
    assert.equal(report.scenarioCount, expectedCases);
    t.diagnostic(report.scenarioCount + ' source-pinned scenarios; external helper deadline ' + HELPER_DEADLINE_MS + 'ms');
    if (group === 'existing' || group === 'new-success') {
      t.diagnostic('Exact boundary call trace: ' + JSON.stringify(report.cases[0]));
    }
  });
}
