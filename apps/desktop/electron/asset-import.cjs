'use strict';

// Importing local 3D models and effects (docs: apps/daemon/src/imported-assets.ts), owned by the main process.
// The workspace renderer never sees a path or reads a file. It can only:
//   - ask for the native file picker (zero arguments), or
//   - hand over files the person dropped on the preview; the preload turns each File into its path with
//     webUtils.getPathForFile, which only works for real files from a drop or a file input.
// This host then checks each path (absolute local path, no links, junctions, UNC or device paths, a regular file with
// one link), the extension and the first bytes, reads it within a size limit, inlines a .gltf's sibling buffers and
// textures (same folder or below only), and posts the bytes to the daemon's import store together with a single-use
// consent it first sent over the private child IPC channel. The reply names each import by an opaque id only.
// Nothing is uploaded to Roblox and nothing reaches Roblox Studio.
const { randomBytes } = require('node:crypto');
const { open } = require('node:fs/promises');
const { basename, dirname, extname, resolve, relative, isAbsolute, sep } = require('node:path');
const { constants } = require('node:fs');
const policy = require('./policy.cjs');

const PICK = 'arcane:asset-import-pick', FILES = 'arcane:asset-import-files';
const UNAVAILABLE = 'Importing is unavailable.';
const LIMITS = Object.freeze({ files: 8, glbBytes: 64 * 1024 * 1024, gltfJsonBytes: 4 * 1024 * 1024, gltfTotalBytes: 72 * 1024 * 1024,
  resources: 128, effectBytes: 8 * 1024 * 1024, requestMs: 60000, pathLength: 4096 });
const FORMATS = Object.freeze({ '.glb': 'glb', '.gltf': 'gltf', '.rbxmx': 'rbxmx' });
const CONVERT = Object.freeze({
  '.fbx': 'FBX files need converting first. In Blender, choose File › Import › FBX, then File › Export › glTF 2.0 and pick the GLB format.',
  '.obj': 'OBJ files need converting first. In Blender, choose File › Import › Wavefront (.obj), then File › Export › glTF 2.0 and pick the GLB format.',
  '.blend': 'Blender files need exporting first. In Blender, choose File › Export › glTF 2.0 and pick the GLB format.',
  '.dae': 'Collada files need converting first. Export the model as a GLB (glTF 2.0 binary) and import that.',
  '.stl': 'STL files need converting first. Export the model as a GLB (glTF 2.0 binary) and import that.',
  '.3ds': '3DS files need converting first. Export the model as a GLB (glTF 2.0 binary) and import that.',
  '.rbxm': 'Binary .rbxm files can’t be read yet. In Roblox Studio, right-click the effect, choose Save to File and pick the .rbxmx format.',
});
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;
const plain = (value, max) => typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ImportRefusal extends Error {}
const refuse = message => { throw new ImportRefusal(message); };

/** Path admission: syntactic (policy.localPath) and physical (policy.directPath: no link, junction or hard link on the way). */
async function admittedFile(path, missing = 'That file is no longer there.') {
  if (typeof path !== 'string' || !path || path.length > LIMITS.pathLength) refuse('That file can’t be opened.');
  let direct;
  try { direct = await policy.directPath(path, 'file'); }
  catch (error) { if (error && error.code === 'ENOENT') refuse(missing); refuse('Arcane only imports ordinary files on this computer, not shortcuts, linked folders or network paths.'); }
  return direct;
}
/** Bounded read of an admitted file; the opened file must be the one that was checked and must not change while read. */
async function readAdmitted(path, limit, tooLarge) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) refuse('Arcane only imports ordinary files.');
    if (stat.size < 1) refuse('This file is empty.');
    if (stat.size > limit) refuse(tooLarge);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) refuse('The file changed while Arcane was reading it. Try again.');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset), after = await handle.stat();
    if (extra.bytesRead || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) refuse('The file changed while Arcane was reading it. Try again.');
    return bytes;
  } finally { await handle.close(); }
}
const MB = bytes => Math.round(bytes / 1024 / 1024) + ' MB';
/** First-byte checks, so a renamed file is refused before anything is sent. */
function checkMagic(format, bytes) {
  if (format === 'glb' && !(bytes.length >= 12 && bytes.readUInt32LE(0) === 0x46546c67)) refuse('This file has a .glb name but isn’t a GLB model.');
  if (format === 'gltf') { const head = bytes.subarray(0, 64).toString('utf8').replace(/^﻿/, '').trimStart(); if (!head.startsWith('{')) refuse('This file has a .gltf name but isn’t a glTF model.'); }
  if (format === 'rbxmx') {
    if (bytes.subarray(0, 8).toString('latin1') === '<roblox!') refuse(CONVERT['.rbxm']);
    const head = bytes.subarray(0, 512).toString('utf8').replace(/^﻿/, '');
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<roblox[\s>]/.test(head)) refuse('This file has a .rbxmx name but isn’t a Roblox model file.');
  }
}
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' });
/** .gltf: inline sibling buffers and textures as data URIs. A reference may only name a file in the same folder or below. */
async function inlineGltf(path, bytes) {
  if (bytes.length > LIMITS.gltfJsonBytes) refuse('This .gltf file is larger than 4 MB. Export it as a GLB instead.');
  let json;
  try { json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { refuse('This .gltf file is not valid JSON.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) refuse('This .gltf file is not a glTF model.');
  const folder = dirname(path), rows = [...(Array.isArray(json.buffers) ? json.buffers : []).map(row => [row, 'buffer']), ...(Array.isArray(json.images) ? json.images : []).map(row => [row, 'image'])];
  if (rows.length > LIMITS.resources) refuse('This .gltf references more files than Arcane imports.');
  let total = bytes.length;
  for (const [row, kind] of rows) {
    if (!row || typeof row !== 'object' || typeof row.uri !== 'string' || /^data:/i.test(row.uri)) continue;
    let name;
    try { name = decodeURIComponent(row.uri); } catch { refuse('This .gltf references a file with a damaged name.'); }
    if (!name || name.length > 1024 || /^[a-z][a-z0-9+.-]*:/i.test(name) || name.startsWith('/') || name.startsWith('\\') || name.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')) refuse('This .gltf references a file outside its folder. Export it as a GLB instead.');
    const target = resolve(folder, name), inside = relative(folder, target);
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) refuse('This .gltf references a file outside its folder. Export it as a GLB instead.');
    const mime = kind === 'buffer' ? 'application/octet-stream' : IMAGE_TYPES[extname(target).toLowerCase()];
    if (!mime) refuse('This .gltf uses a texture format Arcane can’t preview. Use PNG or JPEG textures.');
    let resource;
    try { resource = await readAdmitted(await admittedFile(target, 'A file this .gltf uses is missing: ' + plain(basename(target), 80) + '.'), LIMITS.glbBytes, 'A file this .gltf uses is larger than 64 MB.'); }
    catch (error) { if (error instanceof ImportRefusal) throw error; refuse('A file this .gltf uses is missing: ' + plain(basename(target), 80) + '.'); }
    total += resource.length * 4 / 3; if (total > LIMITS.gltfTotalBytes) refuse('This .gltf and its files are larger than 64 MB together.');
    row.uri = 'data:' + mime + ';base64,' + resource.toString('base64');
  }
  return Buffer.from(JSON.stringify(json), 'utf8');
}
/** One path -> { format, name, body } ready for the daemon, or an ImportRefusal with a plain message. */
async function prepareImport(path) {
  const extension = typeof path === 'string' ? extname(path).toLowerCase() : '';
  if (CONVERT[extension]) refuse(CONVERT[extension]);
  const format = FORMATS[extension];
  if (!format) refuse('Arcane imports GLB and glTF models and Roblox .rbxmx effects.');
  const file = await admittedFile(path);
  const limit = format === 'rbxmx' ? LIMITS.effectBytes : format === 'gltf' ? LIMITS.gltfJsonBytes : LIMITS.glbBytes;
  const bytes = await readAdmitted(file, limit, format === 'rbxmx' ? 'Effect files can be up to ' + MB(LIMITS.effectBytes) + '.' : format === 'gltf' ? 'This .gltf file is larger than 4 MB. Export it as a GLB instead.' : 'Models can be up to ' + MB(LIMITS.glbBytes) + '.');
  checkMagic(format, bytes);
  return { format, name: plain(basename(file), 160), body: format === 'gltf' ? await inlineGltf(file, bytes) : bytes };
}

function createAssetImportHost(options) {
  if (!options || typeof options.getSession !== 'function' || !options.dialog || typeof options.dialog.showOpenDialog !== 'function') throw new Error(UNAVAILABLE);
  const enabled = options.enabled !== false, transport = options.fetch ?? ((...args) => fetch(...args)), random = options.randomBytes ?? randomBytes;
  let busy = false;
  async function upload(session, prepared) {
    const consent = random(32).toString('hex');
    session.send({ type: 'arcane-asset-import-consent', protocolVersion: 1, consent });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), LIMITS.requestMs);
    try {
      const url = session.origin + '/v1/imports/upload?format=' + prepared.format + '&name=' + encodeURIComponent(prepared.name);
      const response = await transport(url, { method: 'POST', body: prepared.body, signal: controller.signal, redirect: 'error', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/octet-stream', 'X-Arcane-Import-Consent': consent } });
      let payload = null; try { payload = await response.json(); } catch { payload = null; }
      const record = payload && payload.import;
      if (!response.ok || !record || typeof record.id !== 'string' || !UUID.test(record.id) || !['model', 'effect'].includes(record.kind)) refuse(plain(payload && payload.message, 300) || 'Arcane couldn’t save this file.');
      return Object.freeze({ id: record.id, name: plain(record.name, 80), kind: record.kind, duplicate: payload.duplicate === true });
    } finally { clearTimeout(timer); }
  }
  /** Paths the person chose -> fixed-shape reply. Never throws for valid input. */
  async function importPaths(paths) {
    const session = enabled ? options.getSession() : null;
    if (!session) return Object.freeze({ state: 'unavailable', message: UNAVAILABLE, imported: Object.freeze([]), refused: Object.freeze([]) });
    const imported = [], refused = [];
    for (const path of paths.slice(0, LIMITS.files)) {
      const name = plain(typeof path === 'string' ? basename(path) : '', 120) || 'File';
      try {
        const prepared = await prepareImport(path);
        const current = options.getSession();
        if (!current || current.window !== session.window || current.origin !== session.origin || current.token !== session.token) refuse('The project changed before the import finished. Nothing was imported.');
        imported.push(await upload(current, prepared));
      } catch (error) {
        refused.push(Object.freeze({ name, message: error instanceof ImportRefusal ? error.message : 'Arcane couldn’t read this file. Nothing was imported.' }));
      }
    }
    if (paths.length > LIMITS.files) refused.push(Object.freeze({ name: (paths.length - LIMITS.files) + ' more', message: 'Import up to ' + LIMITS.files + ' files at a time.' }));
    return Object.freeze({ state: imported.length ? 'imported' : 'refused', message: '', imported: Object.freeze(imported), refused: Object.freeze(refused) });
  }
  async function exclusive(work) {
    if (busy) return Object.freeze({ state: 'busy', message: 'Another import is still running.', imported: Object.freeze([]), refused: Object.freeze([]) });
    busy = true; try { return await work(); } finally { busy = false; }
  }
  function pick() {
    return exclusive(async () => {
      const session = enabled ? options.getSession() : null;
      if (!session) return Object.freeze({ state: 'unavailable', message: UNAVAILABLE, imported: Object.freeze([]), refused: Object.freeze([]) });
      const result = await options.dialog.showOpenDialog(session.window, { title: 'Import a 3D model or effect', buttonLabel: 'Import',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [{ name: '3D models and effects', extensions: ['glb', 'gltf', 'rbxmx', 'fbx', 'obj', 'rbxm'] }, { name: '3D models', extensions: ['glb', 'gltf', 'fbx', 'obj'] }, { name: 'Roblox effects', extensions: ['rbxmx', 'rbxm'] }] });
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) return Object.freeze({ state: 'cancelled', message: '', imported: Object.freeze([]), refused: Object.freeze([]) });
      return importPaths(result.filePaths.filter(path => typeof path === 'string'));
    });
  }
  function importFiles(paths) { return exclusive(() => importPaths(paths)); }
  function installIpc(ipcMain, { trusted }) {
    ipcMain.handle(PICK, async (event, ...args) => { if (args.length || !trusted(event)) throw new Error(UNAVAILABLE); return pick(); });
    ipcMain.handle(FILES, async (event, ...args) => {
      const paths = args.length === 1 && Array.isArray(args[0]) && Object.getPrototypeOf(args[0]) === Array.prototype ? args[0] : null;
      if (!paths || !paths.length || paths.length > 64 || paths.some(path => typeof path !== 'string' || !path || path.length > LIMITS.pathLength) || !trusted(event)) throw new Error(UNAVAILABLE);
      return importFiles(paths.slice());
    });
  }
  return Object.freeze({ pick, importFiles, installIpc });
}

module.exports = { createAssetImportHost, prepareImport, ASSET_IMPORT_LIMITS: LIMITS, ASSET_IMPORT_CHANNELS: Object.freeze({ pick: PICK, files: FILES }) };
