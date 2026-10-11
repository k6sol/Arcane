import { isAbsolute, join } from 'node:path';
import { validateSelection } from '../../core/src/selection.js';
import { ArcaneError, type Connection, type Selection } from '../../protocol/src/providers.js';
export interface NativeLaunchPlan {
  provider: Selection['provider']; model: string; effort: Selection['effort']; applied: false;
  command: string; args: string[]; cwd: string; environmentNames: string[];
  ownsInterface: 'native-client'; inferenceStarted: false; warnings: string[];
}
/** A handoff to the genuine interactive vendor client; not an OAuth/API proxy. */
export function nativeLaunchPlan(input: unknown, connections: Connection[], options: {
  executable: string; projectPath: string; arcanePath: string; nodePath: string; claudeConfigPath?: string;
}): NativeLaunchPlan {
  const selection = validateSelection(input, connections);
  for (const path of [options.executable, options.projectPath, options.arcanePath, options.nodePath]) {
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new ArcaneError('PATH', 'Native handoff requires explicit absolute paths.');
  }
  const entry = join(options.arcanePath, 'dist/apps/mcp/src/main.js');
  const args = selection.provider === 'codex' ? [
    '--model', selection.model, '--config', 'model_reasoning_effort=' + JSON.stringify(selection.effort),
    '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--cd', options.projectPath,
    '--config', 'mcp_servers.arcane.command=' + JSON.stringify(options.nodePath),
    '--config', 'mcp_servers.arcane.args=' + JSON.stringify([entry, '--project', options.arcanePath]),
    '--config', 'mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN"]',
    '--config', 'mcp_servers.arcane.tool_timeout_sec=70',
  ] : (() => {
    if (!options.claudeConfigPath || !isAbsolute(options.claudeConfigPath)) throw new ArcaneError('PATH', 'Claude handoff requires the reviewed project-local MCP config.');
    return ['--mcp-config', options.claudeConfigPath, '--model', selection.model, '--effort', selection.effort, '--permission-mode', 'default'];
  })();
  return { provider: selection.provider, model: selection.model, effort: selection.effort, applied: false,
    command: options.executable, args, cwd: options.projectPath,
    environmentNames: ['ARCANE_DAEMON_URL', 'ARCANE_LOCAL_TOKEN'], ownsInterface: 'native-client', inferenceStarted: false,
    warnings: [
      'Native CLI owns login, inference, approvals, images/design and its own tools. Availability still depends on that client and account.',
      'Requested model/effort is not proof of the applied runtime model/effort; confirm the native session display.',
      'No automatic model fallback, sandbox/approval bypass or provider credential extraction is configured.',
      ...(selection.provider === 'claude' ? ['Included consumer subscription use remains in the genuine Claude Code interface, not an embedded third-party OAuth proxy.'] : []),
    ] };
}
