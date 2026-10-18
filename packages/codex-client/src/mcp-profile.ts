import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEnvironment, type InternalProcess } from './transport.js';
import { exact, fail, str } from './validation.js';
import type { ArcaneMcpLaunchProfile } from './types.js';
import { ARCANE_TOOL_NAMES } from '../../protocol/src/arcane-tools.js';

const BUNDLED_ENTRY = fileURLToPath(new URL('../../../apps/mcp/src/main.js', import.meta.url));
const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node';
function pathValue(value: unknown): string {
  const path = str(value, 4096);
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) fail('MCP_PROFILE', 'Arcane MCP paths must be absolute and contain no control characters.');
  return path;
}
async function regular(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('MCP_PROFILE', 'Arcane MCP requires direct regular executable/entry files.');
  return realpath(path);
}
/** Secret-free inventory launch; reset inherited Arcane settings using existing fields. */
export function prepareCodexDiscoveryProcess(command: string, cwd: string): InternalProcess {
  return {
    command, cwd, env: nativeEnvironment(),
    args: ['app-server', '--listen', 'stdio://', '-c',
      'mcp_servers.arcane={command=' + JSON.stringify(process.execPath) + ',args=["-e","process.exit(0)"],enabled=false,enabled_tools=[]}'],
  };
}

/**
 * Internal launch builder, never browser input or a public generic config API.
 * trustedEntry is a code-level test seam; the public factory always uses BUNDLED_ENTRY.
 */
export async function prepareCodexProcess(command: string, cwd: string, profile?: ArcaneMcpLaunchProfile, trustedEntry = BUNDLED_ENTRY): Promise<InternalProcess> {
  const args = ['app-server','--listen','stdio://'];
  const env = nativeEnvironment();
  if (profile === undefined) return { command, cwd, args, env };
  exact(profile, ['nodeExecutable','serverEntry','projectRoot','daemonUrl','agentToken']);
  const nodeInput = pathValue(profile.nodeExecutable);
  const entryInput = pathValue(profile.serverEntry);
  const rootInput = pathValue(profile.projectRoot);
  const daemonUrl = str(profile.daemonUrl, 64);
  const agentToken = str(profile.agentToken, 64);
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(daemonUrl);
  if (!port || Number(port[1]) > 65_535) fail('MCP_PROFILE', 'Arcane MCP daemon URL must be exactly http://127.0.0.1:PORT (1–65535).');
  if (!/^[a-fA-F0-9]{64}$/.test(agentToken)) fail('MCP_PROFILE', 'Arcane MCP requires a scoped 64-hex agent bearer.');
  if (basename(nodeInput).toLowerCase() !== NODE_NAME || basename(entryInput) !== 'main.js') fail('MCP_PROFILE', 'Arcane MCP requires the host Node executable and bundled main.js entry.');
  let node: string; let entry: string; let project: string;
  try {
    node = await regular(nodeInput);
    entry = await regular(entryInput);
    const hostNode = await realpath(process.execPath);
    const bundledEntry = await regular(trustedEntry);
    project = await realpath(rootInput);
    if (node !== hostNode || entry !== bundledEntry || basename(node).toLowerCase() !== NODE_NAME || !(await stat(project)).isDirectory()) fail('MCP_PROFILE', 'Arcane MCP profile does not match the trusted host runtime and bundle.');
    await access(node, constants.X_OK);
  } catch { fail('MCP_PROFILE', 'Arcane MCP runtime, bundled entry or project directory is unavailable or untrusted.'); }
  // Reset the whole Arcane entry first, so inherited url/env/remote settings cannot override this fixed profile.
  args.push(
    '-c', 'mcp_servers.arcane={}',
    '-c', 'mcp_servers.arcane.command=' + JSON.stringify(node),
    '-c', 'mcp_servers.arcane.args=' + JSON.stringify([entry, '--project', project]),
    '-c', 'mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN"]',
    '-c', 'mcp_servers.arcane.enabled=true',
    '-c', 'mcp_servers.arcane.required=true',
    // Arcane's daemon owns scoped write, asset and playtest admission. Do not add an inherited native MCP
    // prompt which this integration cannot render; shell/file approvals keep their separate on-request policy.
    '-c', 'mcp_servers.arcane.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.arcane.enabled_tools=' + JSON.stringify(ARCANE_TOOL_NAMES),
    '-c', 'mcp_servers.arcane.disabled_tools=[]',
  );
  if (command.includes(agentToken) || cwd.includes(agentToken) || args.some(arg => arg.includes(agentToken))) fail('MCP_PROFILE', 'The agent bearer cannot occur in launch paths or arguments.');
  env.ARCANE_DAEMON_URL = daemonUrl;
  env.ARCANE_LOCAL_TOKEN = agentToken;
  // The profile object and bearer are never returned as public metadata or persisted by the session.
  return { command, cwd, args, env };
}
