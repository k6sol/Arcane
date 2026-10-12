import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_BITMAP_PATH, validateBrandBitmap } from './create-local-release.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function productDoctor({ repository = REPOSITORY, nodeVersion = process.versions.node } = {}) {
  repository = resolve(repository); const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  add('node', Number(nodeVersion.split('.')[0]) >= 24 ? 'pass' : 'fail', 'Node ' + nodeVersion + '; Node 24+ is required.');
  for (const [id, path] of [
    ['daemon-entry', 'dist/apps/daemon/src/product-main.js'], ['mcp-entry', 'dist/apps/mcp/src/main.js'],
    ['workbench-entry', 'dist/apps/desktop/src/studio.js'], ['codex-chat-entry', 'dist/apps/desktop/src/codex-chat.js'],
    ['workspace-shell-source', 'apps/desktop/src/workspace-shell.ts'], ['workspace-shell-entry', 'dist/apps/desktop/src/workspace-shell.js'],
    ['workspace-shell-map', 'dist/apps/desktop/src/workspace-shell.js.map'],
    ['asset-downloads-source', 'apps/desktop/src/asset-downloads.ts'], ['asset-downloads-entry', 'dist/apps/desktop/src/asset-downloads.js'], ['asset-downloads-map', 'dist/apps/desktop/src/asset-downloads.js.map'], ['codex-controller-entry', 'dist/apps/daemon/src/codex-service.js'],
    ['workbench-html', 'apps/desktop/public/studio.html'], ['workbench-css', 'apps/desktop/public/studio.css'],
    ['workbench-brand-bitmap', BRAND_BITMAP_PATH], ['blender-worker', 'workers/blender/asset_worker.py'], ['skills', 'skills/registry.json'],
  ]) {
    try {
      const stat = await lstat(join(repository, path));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      if (path === BRAND_BITMAP_PATH) {
        if (stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error();
        validateBrandBitmap(await readFile(join(repository, path)));
      }
      add(id, 'pass', path);
    } catch { add(id, 'fail', 'Missing or invalid ' + path + '. Install dependencies and build from this package.'); }
  }
  const require = createRequire(join(repository, 'package.json'));
  for (const module of ['@modelcontextprotocol/sdk/client/index.js', 'zod']) {
    try { const location = require.resolve(module); const local = relative(join(repository, 'node_modules'), location); if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) throw new Error(); add('dependency:' + module, 'pass', 'Installed inside this package, not inherited from a parent checkout.'); }
    catch { add('dependency:' + module, 'fail', 'Run npm ci --ignore-scripts --no-audit --no-fund.'); }
  }
  try {
    const manifest = JSON.parse(await readFile(join(repository, 'plugin/build/manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.preferredArtifact !== 'ArcaneLocalBridge.lua') throw new Error();
    const artifact = manifest.artifacts.find(item => item.name === manifest.preferredArtifact);
    const bytes = await readFile(join(repository, 'plugin/build', manifest.preferredArtifact));
    if (!artifact || bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error();
    for (const source of manifest.sources) {
      if (!/^src\/[A-Za-z]+(?:\.server)?\.luau$/.test(source.path)) throw new Error();
      const text = (await readFile(join(repository, 'plugin', source.path), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (sha256(Buffer.from(text)) !== source.sha256) throw new Error();
    }
    add('plugin-artifact', 'pass', 'Native plugin bundle matches the manifest and current source. Installation and loading are separate.');
  } catch { add('plugin-artifact', 'fail', 'Run npm run build:plugin; plugin artifact is missing, stale, or invalid.'); }
  add('studio-runtime', 'unverified', 'No Studio connection/mutation is performed by this checker. Verify the key-only plugin from the workbench.');
  add('provider-runtime', 'unverified', 'No login/inference/client configuration is performed. The native provider owns its session.');
  add('blender-runtime', 'unverified', 'Worker files are present; installed Blender must still pass the workbench runtime probe.');
  add('release-signature', 'unverified', 'Local source packages are integrity-checked, not signed Windows installers.');
  return { schemaVersion: 1, observedAt: new Date().toISOString(), readyToLaunch: checks.every(check => check.status !== 'fail'),
    scope: 'local-runtime-files-and-dependencies', credentialsRead: false, networkUsed: false, installsPerformed: false, checks };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/product-doctor.mjs');
  const report = await productDoctor(); console.log(JSON.stringify(report, null, 2));
  if (!report.readyToLaunch) process.exitCode = 1;
}

