import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  constructor(projectRoot: string) { this.#root = resolve(projectRoot); }
  private async module(): Promise<SkillPackModule> {
    // Reuse the existing registry parser, checksum verification and contained-file reader.
    const url = pathToFileURL(join(this.#root, 'scripts', 'skill-pack.mjs')).href;
    return await import(url) as SkillPackModule;
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
