import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { CodexSession } from './session.js';
import { prepareCodexProcess } from './mcp-profile.js';
import { arcaneIsolationOverrides } from './mcp-isolation.js';
import { exact, fail, limits, str } from './validation.js';
import type { ConnectOptions } from './types.js';
export { CODEX_LIMITS, CodexClientError } from './types.js';
export type { Account, ArcaneMcpLaunchProfile, Approval, ConnectOptions, FileChangePreview, HumanAction, LimitOptions, LocalUse, Model, Operation, Selection, SessionEvent, SessionEventValue, Snapshot, ThreadState } from './types.js';
export type CodexClient = CodexSession;

/** Host-code API only. Never map executable paths or lifecycle actions directly from an unauthenticated request. */
export async function connectCodexClient(options: ConnectOptions): Promise<CodexClient> {
  exact(options, ['command','cwd','use','limits','arcaneMcp']);
  if (!['personal-local','open-source-local'].includes(options.use)) fail('LOCAL_USE_ONLY', 'This client supports only personal local or eligible open-source local use.');
  const command = str(options.command, 4096);
  const cwd = str(options.cwd, 4096);
  if (!isAbsolute(command) || !isAbsolute(cwd)) fail('PROCESS_PATH', 'Installed executable and workspace must be absolute.');
  if (basename(command).toLowerCase() !== (process.platform === 'win32' ? 'codex.exe' : 'codex')) fail('PROCESS_PATH', 'Select the installed native Codex executable.');
  const bounds = limits(options.limits);
  let executable: string; let workspace: string;
  try {
    executable = await realpath(command); workspace = await realpath(cwd);
    if (!(await stat(executable)).isFile() || !(await stat(workspace)).isDirectory()) fail('PROCESS_PATH', 'Invalid installed executable or workspace.');
    await access(executable, constants.X_OK);
  } catch { fail('PROCESS_PATH', 'Installed executable or workspace is unavailable.'); }
  const processSpec = await prepareCodexProcess(executable, workspace, options.arcaneMcp);
  let session = new CodexSession(processSpec, bounds, 'installed-cli');
  await session.initialize();
  if(options.arcaneMcp) {
    // An Arcane token cannot constrain inherited third-party MCP tools. Isolate
    // this embedded child, leaving the user's native CLI configuration untouched.
    try { const inventory=await session.inspectMcpServers({initiatedBy:'human'});const overrides=arcaneIsolationOverrides(inventory,options.arcaneMcp.nodeExecutable,options.arcaneMcp.agentToken);
      await session.close();processSpec.args.push(...overrides);session=new CodexSession(processSpec,bounds,'installed-cli','arcane-only');await session.initialize();
    }catch(error){await session.close();throw error;}
  }
  return session;
}
