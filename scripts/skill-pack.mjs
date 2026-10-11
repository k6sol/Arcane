import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_FILE_BYTES = 128 * 1024;
const ID = /^arcane-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = value => createHash('sha256').update(value).digest('hex');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function readContained(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) {
    fail('INVALID_PATH', 'Only repository-relative declared paths are accepted.');
  }
  const realRoot = await fs.realpath(root);
  const resolved = path.resolve(realRoot, relative);
  if (!isInside(realRoot, resolved)) fail('PATH_ESCAPE', 'Path escapes the repository.');
  const realTarget = await fs.realpath(resolved);
  if (!isInside(realRoot, realTarget)) fail('PATH_ESCAPE', 'Resolved link escapes the repository.');
  const stat = await fs.stat(realTarget);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('FILE_LIMIT', 'Expected a bounded regular text file.');
  const bytes = await fs.readFile(realTarget);
  if (bytes.length > MAX_FILE_BYTES) fail('FILE_LIMIT', 'File grew beyond the read limit.');
  return { text: bytes.toString('utf8'), bytes, sha256: hash(bytes) };
}

// The authored pack uses this deliberately narrow YAML-compatible normal form.
// This is not a general YAML parser for arbitrary third-party skills.
export function parseEntrypoint(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) fail('FRONTMATTER', 'Missing skill frontmatter.');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description|license): (.+)$/.exec(line);
    if (!field || Object.hasOwn(fields, field[1])) fail('FRONTMATTER', 'Unsupported or duplicate frontmatter field.');
    try { fields[field[1]] = field[1] === 'description' ? JSON.parse(field[2]) : field[2]; }
    catch { fail('FRONTMATTER', 'Description must be a JSON-quoted YAML string.'); }
  }
  if (!ID.test(fields.name ?? '') || fields.name.length > 64) fail('SKILL_NAME', 'Invalid skill name.');
  if (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 1024) {
    fail('DESCRIPTION', 'Expected a concise routing description.');
  }
  if (fields.license !== 'MIT') fail('LICENCE', 'Original pack must declare its MIT licence.');
  if (match[2].trim().length < 160 || /\[TODO:[^\n]*\]/.test(match[2])) fail('BODY', 'Entrypoint is empty or unfinished.');
  return { ...fields, body: match[2] };
}

export async function loadRegistry(root = DEFAULT_ROOT) {
  const source = await readContained(root, 'skills/registry.json');
  let registry;
  try { registry = JSON.parse(source.text); } catch { fail('REGISTRY', 'Registry is not JSON.'); }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.skills) || !registry.skills.length || registry.defaultLoadPolicy !== 'approved-only') {
    fail('REGISTRY', 'Unsupported or empty registry.');
  }
  const seen = new Set();
  for (const skill of registry.skills) {
    if (!ID.test(skill.id ?? '') || skill.id.length > 64 || seen.has(skill.id)) fail('REGISTRY', 'Invalid or duplicate skill ID.');
    seen.add(skill.id);
    if (!['experimental', 'approved', 'quarantined', 'deprecated'].includes(skill.status)) fail('REGISTRY', 'Unknown skill status.');
    if (skill.approved !== (skill.status === 'approved')) fail('REGISTRY', 'Approval flag contradicts status.');
    if (!Array.isArray(skill.keywords) || !skill.keywords.every(k => typeof k === 'string' && k.length > 0)) fail('REGISTRY', 'Invalid keywords.');
    if (!Array.isArray(skill.references) || !Array.isArray(skill.evaluationRuns)) fail('REGISTRY', 'Invalid reference/evaluation lists.');
    if (skill.approved && !skill.evaluationRuns.some(run => run.outcome === 'passed' && run.evidence)) {
      fail('REGISTRY', 'Approved entries require recorded behavior evidence.');
    }
    const refs = new Set();
    for (const reference of skill.references) {
      if (typeof reference.name !== 'string' || !reference.name || refs.has(reference.name)) fail('REGISTRY', 'Invalid or duplicate reference name.');
      refs.add(reference.name);
    }
  }
  return registry;
}

async function checked(root, item) {
  const source = await readContained(root, item.path);
  if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || source.sha256 !== item.sha256) {
    fail('INTEGRITY', `Content differs from recorded checksum: ${item.path}`);
  }
  return source;
}

export async function validatePack(root = DEFAULT_ROOT) {
  const registry = await loadRegistry(root);
  let bytes = 0;
  let references = 0;
  for (const skill of registry.skills) {
    const source = await checked(root, skill);
    const parsed = parseEntrypoint(source.text);
    if (parsed.name !== skill.id || parsed.description !== skill.description) fail('REGISTRY', `Entrypoint metadata differs: ${skill.id}`);
    bytes += source.bytes.length;
    for (const reference of skill.references) {
      const content = await checked(root, reference);
      bytes += content.bytes.length;
      references++;
    }
    for (const match of source.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      await readContained(root, path.join(path.dirname(skill.path), link.split('#')[0]));
    }
  }
  return { valid: true, skills: registry.skills.length, references, bytes, approved: registry.skills.filter(s => s.approved).length,
    behaviorRuns: registry.skills.reduce((n, s) => n + s.evaluationRuns.length, 0), verification: 'offline-structure-and-integrity-only' };
}

export async function refreshIntegrity(root = DEFAULT_ROOT) {
  const registry = await loadRegistry(root);
  if (registry.skills.some(s => s.approved)) fail('APPROVAL_REVIEW', 'Approved content cannot be silently rehashed; use reviewed versioning.');
  for (const skill of registry.skills) {
    const source = await readContained(root, skill.path);
    const parsed = parseEntrypoint(source.text);
    if (parsed.name !== skill.id || parsed.description !== skill.description) fail('REGISTRY', 'Metadata change requires explicit registry review.');
    skill.sha256 = source.sha256;
    for (const reference of skill.references) reference.sha256 = (await readContained(root, reference.path)).sha256;
  }
  const target = path.join(await fs.realpath(root), 'skills', 'registry.json');
  const temporary = `${target}.${process.pid}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await fs.open(temporary, 'wx');
    ownsTemporary = true;
    try { await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`); }
    finally { await handle.close(); }
    await fs.rename(temporary, target);
  } finally { if (ownsTemporary) await fs.rm(temporary, { force: true }); }
  return validatePack(root);
}

export async function searchSkills(query, { root = DEFAULT_ROOT, limit = 6 } = {}) {
  if (typeof query !== 'string' || query.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 20) fail('QUERY', 'Invalid search query or limit.');
  const registry = await loadRegistry(root);
  const stop = new Set(['a', 'the', 'and', 'for', 'with', 'to', 'in', 'my', 'please', 'roblox', 'game', 'make', 'build', 'help', 'improve']);
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])].filter(t => !stop.has(t));
  if (!terms.length) return [];
  return registry.skills.filter(s => !['quarantined', 'deprecated'].includes(s.status)).map(skill => {
    const keywordTokens = new Set(skill.keywords.flatMap(k => k.toLowerCase().split(/[^a-z0-9-]+/)));
    const textTokens = new Set(`${skill.title} ${skill.description}`.toLowerCase().split(/[^a-z0-9-]+/));
    const score = terms.reduce((n, term) => n + (term === skill.id ? 50 : keywordTokens.has(term) ? 8 : textTokens.has(term) ? 1 : 0), 0);
    return { id: skill.id, title: skill.title, description: skill.description, status: skill.status, score, candidateOnly: true };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export async function packSkills(ids, { root = DEFAULT_ROOT, byteBudget = 16384, allowExperimental = false, references = [] } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length || !ids.every(id => ID.test(id))) fail('IDS', 'Select 1–8 distinct valid skill IDs.');
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 256 || byteBudget > 1024 * 1024) fail('BUDGET', 'Invalid context byte budget.');
  if (!Array.isArray(references) || new Set(references).size !== references.length) fail('REFERENCES', 'Reference selection must be unique.');
  const registry = await loadRegistry(root);
  const chosen = ids.map(id => {
    const skill = registry.skills.find(s => s.id === id);
    if (!skill) fail('UNKNOWN_SKILL', `Unknown skill: ${id}`);
    if (!skill.approved && !(allowExperimental && skill.status === 'experimental')) fail('UNAPPROVED', `Skill is not an approved default: ${id}`);
    return skill;
  });
  const blocks = ['Arcane skill context. This does not grant tools, permissions, publishing or provider spend. Follow the user brief and project instructions.'];
  if (chosen.some(s => !s.approved)) blocks.push('Experimental content: offline checks are not behavior benchmarks or production approval.');
  for (const skill of chosen) {
    const source = await checked(root, skill);
    const parsed = parseEntrypoint(source.text);
    if (parsed.name !== skill.id || parsed.description !== skill.description) fail('REGISTRY', 'Entrypoint metadata differs.');
    blocks.push(`## Loaded skill: ${skill.id}\n${source.text}`);
  }
  for (const selection of references) {
    const colon = typeof selection === 'string' ? selection.indexOf(':') : -1;
    if (colon < 1) fail('REFERENCES', 'Use skill-id:declared-reference-name.');
    const skill = chosen.find(s => s.id === selection.slice(0, colon));
    const reference = skill?.references.find(r => r.name === selection.slice(colon + 1));
    if (!reference) fail('REFERENCES', 'Reference is undeclared or its skill was not selected.');
    blocks.push(`## Loaded reference: ${selection}\n${(await checked(root, reference)).text}`);
  }
  const context = `${blocks.join('\n\n')}\n`;
  const bytes = Buffer.byteLength(context, 'utf8');
  if (bytes > byteBudget) fail('BUDGET_EXCEEDED', `Pack needs ${bytes} bytes; budget is ${byteBudget}. Select fewer skills/references; nothing was truncated.`);
  return { ids, references, bytes, byteBudget, context, tokenCount: null, approvalChanged: false };
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'validate') return console.log(JSON.stringify(await validatePack(), null, 2));
  if (command === 'refresh-integrity') return console.log(JSON.stringify(await refreshIntegrity(), null, 2));
  if (command === 'list') return console.log(JSON.stringify((await loadRegistry()).skills.map(({ id, title, status }) => ({ id, title, status })), null, 2));
  if (command === 'search') return console.log(JSON.stringify(await searchSkills(args.join(' ')), null, 2));
  if (command === 'pack') {
    const options = { allowExperimental: false, references: [] };
    let ids;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ids') ids = (args[++i] ?? '').split(',');
      else if (args[i] === '--byte-budget') options.byteBudget = Number(args[++i]);
      else if (args[i] === '--reference') options.references.push(args[++i]);
      else if (args[i] === '--allow-experimental') options.allowExperimental = true;
      else if (args[i] === '--json') json = true;
      else fail('ARGUMENT', `Unknown argument: ${args[i]}`);
    }
    const result = await packSkills(ids, options);
    return console.log(json ? JSON.stringify(result, null, 2) : result.context);
  }
  fail('USAGE', 'Use validate, refresh-integrity, list, search QUERY or pack --ids ID[,ID] [--reference ID:NAME] [--byte-budget N] [--allow-experimental] [--json].');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
