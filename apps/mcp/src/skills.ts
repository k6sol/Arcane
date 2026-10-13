import { basename, dirname, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The source tree and both existing TS output layouts retain apps/mcp/src.
// Production releases retain dist beside scripts/ and skills/ (including under
// resources/product on Windows). Never search cwd, --project or parent bundles.
const modulePath = fileURLToPath(import.meta.url);
const treeRoot = resolve(dirname(modulePath), '../../..');
const mcpTestBuild = basename(treeRoot) === '.test-build'
  && basename(dirname(treeRoot)) === 'mcp' && basename(dirname(dirname(treeRoot))) === 'apps';
const BUNDLE_ROOT = modulePath.endsWith('.ts') ? treeRoot
  : basename(treeRoot) === 'dist' ? dirname(treeRoot)
  : mcpTestBuild ? resolve(treeRoot, '../../..') : treeRoot;
const SKILL_PACK_PATH = join(BUNDLE_ROOT, 'scripts', 'skill-pack.mjs');
const SKILL_PACK_URL = pathToFileURL(SKILL_PACK_PATH).href;

async function directBundledFile(path: string): Promise<void> {
  // Match the release's direct-path/single-link design. Check each ancestor too:
  // canonical containment alone would miss an internal symlink or junction.
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current), actual = await realpath(current);
    const same = process.platform === 'win32' ? actual.toLowerCase() === current.toLowerCase() : actual === current;
    if (stat.isSymbolicLink() || !same || (current === path
      ? !stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024
      : !stat.isDirectory())) {
      throw Object.assign(new Error('Bundled skill code requires direct paths and bounded single-link files.'), { code: 'BUNDLE_INTEGRITY' });
    }
    if (dirname(current) === current) return;
  }
}

interface SkillEntry {
  id: string; title: string; description: string;
  status: 'approved' | 'experimental' | 'quarantined' | 'deprecated'; approved: boolean;
  keywords: string[]; references: { name: string }[];
}
interface SkillPackModule {
  loadRegistry(root: string): Promise<{ defaultLoadPolicy: 'approved-only'; skills: SkillEntry[] }>;
  packSkills(ids: string[], options: { root: string; byteBudget: number; allowExperimental: boolean; references: string[] }): Promise<{
    ids: string[]; references: string[]; bytes: number; byteBudget: number; context: string; tokenCount: null; approvalChanged: false;
  }>;
}

export class SkillRegistry {
  readonly #root: string;
  // Code-only data fixture seam. Even fixtures execute the same bundled parser;
  // main.ts and MCP tool inputs cannot select this root or an executable module.
  constructor(options?: { fixtureRoot: string }) { this.#root = resolve(options?.fixtureRoot ?? BUNDLE_ROOT); }
  private async module(): Promise<SkillPackModule> {
    // Reuse the existing registry parser, checksum verification and contained-file reader.
    await directBundledFile(modulePath);
    await directBundledFile(SKILL_PACK_PATH);
    await directBundledFile(join(this.#root, 'skills', 'registry.json'));
    return await import(SKILL_PACK_URL) as SkillPackModule;
  }
  async list(options: { query?: string | undefined; limit: number; allowExperimental: boolean }) {
    const registry = await (await this.module()).loadRegistry(this.#root);
    const query = options.query?.trim().toLowerCase() ?? '';
    const eligible = registry.skills.filter(skill => skill.approved || (options.allowExperimental && skill.status === 'experimental'))
      .filter(skill => !query || `${skill.id} ${skill.title} ${skill.description} ${skill.keywords.join(' ')}`.toLowerCase().includes(query));
    return { defaultLoadPolicy: registry.defaultLoadPolicy, allowExperimental: options.allowExperimental,
      items: eligible.slice(0, options.limit).map(skill => ({ id: skill.id, title: skill.title, description: skill.description,
        status: skill.status, approved: skill.approved, references: skill.references.map(reference => reference.name) })),
      truncated: eligible.length > options.limit };
  }
  async get(options: { ids: string[]; byteBudget: number; allowExperimental: boolean; references: string[] }) {
    return (await this.module()).packSkills(options.ids, { ...options, root: this.#root });
  }
}
