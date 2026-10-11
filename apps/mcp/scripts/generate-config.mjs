import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function inside(root, target) {
  const difference = relative(root, target);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}
function tomlString(value) {
  // JSON's basic string escaping is TOML compatible for these bounded, ordinary filesystem paths.
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Control characters are not supported in paths.');
  return JSON.stringify(value);
}

export async function generateConfig({ projectRoot = DEFAULT_ROOT, outputDirectory = 'apps/mcp/generated', nodePath = process.execPath } = {}) {
  const project = await realpath(projectRoot);
  if (project === await realpath(homedir()) || !isAbsolute(nodePath)) throw new Error('Choose an Arcane project and an absolute Node executable path.');
  for (const marker of ['skills/registry.json', 'scripts/skill-pack.mjs']) {
    if (!(await stat(join(project, marker))).isFile()) throw new Error('Expected an Arcane project with its skill registry.');
  }
  const output = resolve(project, outputDirectory);
  if (!inside(project, output)) throw new Error('Config output must remain inside this project.');
  // Check the nearest existing ancestor before mkdir, including junctions/symlinks.
  let ancestor = output;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  if (!inside(project, ancestor)) throw new Error('Config output link escapes the project.');
  await mkdir(output, { recursive: true });
  const destination = await realpath(output);
  if (!inside(project, destination)) throw new Error('Config output link escapes the project.');
  const entry = join(project, 'dist/apps/mcp/src/main.js');
  const args = [entry, '--project', project];
  const claude = { mcpServers: { arcane: { type: 'stdio', command: nodePath, args,
    env: { ARCANE_DAEMON_URL: '${ARCANE_DAEMON_URL}', ARCANE_LOCAL_TOKEN: '${ARCANE_LOCAL_TOKEN}' } } } };
  const codex = [
    '# Project-local fragment. Merge into this project’s .codex/config.toml after review.',
    '# Secrets are forwarded by name from the launcher process environment; no literal token is stored.',
    '# ARCANE_LOCAL_TOKEN is the launcher agent bearer; never use browser control, plugin or provider tokens.',
    '[mcp_servers.arcane]', `command = ${tomlString(nodePath)}`,
    `args = [${args.map(tomlString).join(', ')}]`, `cwd = ${tomlString(project)}`,
    'env_vars = ["ARCANE_DAEMON_URL", "ARCANE_LOCAL_TOKEN"]',
    'startup_timeout_sec = 10', 'tool_timeout_sec = 70', '',
  ].join('\n');
  const files = [['claude.mcp.json', JSON.stringify(claude, null, 2) + '\n'], ['codex.mcp.toml', codex]];
  const handles = [];
  try {
    // Exclusive creation prevents replacing existing settings or following file links.
    for (const [name] of files) handles.push(await open(join(destination, name), 'wx', 0o600));
    for (let index = 0; index < files.length; index++) await handles[index].writeFile(files[index][1]);
  } finally { for (const handle of handles) await handle.close(); }
  return { projectRoot: project, files: files.map(([name]) => join(destination, name)), tokenWritten: false, installed: false };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--project': 'projectRoot', '--output': 'outputDirectory', '--node': 'nodePath' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('Use [--project DIRECTORY] [--output PROJECT_RELATIVE_DIRECTORY] [--node ABSOLUTE_EXECUTABLE].');
    if (Object.hasOwn(options, key)) throw new Error('Duplicate config argument.');
    options[key] = args[index + 1];
  }
  console.log(JSON.stringify(await generateConfig(options), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('Arcane config generation failed: check the project, output containment and existing files. No settings were installed.'); process.exitCode = 1; });
}
