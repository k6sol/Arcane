import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { CodexSession } from './session.js';
import { prepareCodexDiscoveryProcess, prepareCodexProcess } from './mcp-profile.js';
import { arcaneIsolationOverrides } from './mcp-isolation.js';
import { exact, fail, limits, str } from './validation.js';
import { validateNativeAssetHooks, type ConnectOptions, type Limits, type NativeAssetHooks } from './types.js';
import type { InternalProcess } from './transport.js';
import type { LocalUse, LimitOptions, Selection, Snapshot, ThreadState } from './types.js';
import { nativeEnvironment } from './transport.js';
export { CODEX_LIMITS, CodexClientError } from './types.js';
export type { Account, ArcaneMcpLaunchProfile, Approval, ConnectOptions, FileChangePreview, HumanAction, LimitOptions, LocalUse, Model, NativeAssetHooks, NativeAssetIntent, Operation, Selection, SessionEvent, SessionEventValue, Snapshot, ThreadState } from './types.js';
export type CodexClient = CodexSession;
export type { NativeRateLimits, NativeRateLimitBucket, NativeRateLimitWindow, NativeLimitReason } from './rate-limits.js';
export type { NativeTaskContinuation, ManagedTaskStart } from './types.js';

export interface ProposalWorker {
  snapshot(): Snapshot;
  /** One task-scoped dispatch. The worker has no write grant or approval API. */
  propose(text: string): Promise<ThreadState>;
  close(): Promise<void>;
}
/** Trusted host input only. Capture identity and selection from the original task,
 * never from a model tool argument or a browser-supplied account identifier. */
export interface ProposalWorkerOptions {
  command: string; cwd: string; use: LocalUse; limits?: LimitOptions;
  accountIdentity: string; selection: Selection;
}
const PROPOSAL_FLAGS = [
  '-c','agents.enabled=false','-c','features.shell_tool=false','-c','features.apps=false',
  '-c','features.plugins=false','-c','features.memories=false','-c','features.request_permissions_tool=false',
  '-c','web_search="disabled"','-c','features.skill_mcp_dependency_install=false',
];

async function installedPaths(commandInput: unknown, cwdInput: unknown, use: unknown) {
  if (!['personal-local','open-source-local'].includes(use as string)) fail('LOCAL_USE_ONLY', 'This client supports only personal local or eligible open-source local use.');
  const command = str(commandInput,4096), cwd = str(cwdInput,4096);
  if (!isAbsolute(command) || !isAbsolute(cwd)) fail('PROCESS_PATH', 'Installed executable and workspace must be absolute.');
  if (basename(command).toLowerCase() !== (process.platform === 'win32' ? 'codex.exe' : 'codex')) fail('PROCESS_PATH', 'Select the installed native Codex executable.');
  try {
    const executable = await realpath(command), workspace = await realpath(cwd);
    if (!(await stat(executable)).isFile() || !(await stat(workspace)).isDirectory()) fail('PROCESS_PATH', 'Invalid installed executable or workspace.');
    await access(executable,constants.X_OK);return {executable,workspace};
  } catch { fail('PROCESS_PATH','Installed executable or workspace is unavailable.'); }
}

/** Owned, fresh subscription worker. Discovery never receives a bearer or sends
 * a model turn; the final child disables every discovered MCP server. */
export async function connectCodexProposalWorker(options: ProposalWorkerOptions): Promise<ProposalWorker> {
  exact(options,['command','cwd','use','limits','accountIdentity','selection']);
  const identity = str(options.accountIdentity,64);
  if(!/^[a-f0-9]{64}$/.test(identity))fail('ACCOUNT_IDENTITY','The original task account identity is required.');
  exact(options.selection,['model','effort']);
  const selection={model:str(options.selection.model),effort:str(options.selection.effort,64)};
  const bounds=limits(options.limits),{executable,workspace}=await installedPaths(options.command,options.cwd,options.use);
  const discovery=prepareCodexDiscoveryProcess(executable,workspace);
  discovery.args.push(...PROPOSAL_FLAGS);
  let session=new CodexSession(discovery,bounds,'installed-cli','proposal');
  try {
    await session.initialize();
    if(session.taskAccountIdentity()!==identity)fail('ACCOUNT_IDENTITY','The worker account differs from the original task.');
    const rows=await session.inspectMcpServers({initiatedBy:'human'});
    const overrides=arcaneIsolationOverrides(rows,process.execPath,'');
    await session.close();
    // Discovery already resets Arcane to disabled. No Arcane credential, endpoint
    // or tool allowlist is ever added to the worker environment or arguments.
    session=new CodexSession({command:executable,cwd:workspace,env:nativeEnvironment(),args:[...discovery.args,...overrides]},bounds,'installed-cli','proposal');
    await session.initialize();
    if(session.taskAccountIdentity()!==identity)fail('ACCOUNT_IDENTITY','The final worker account differs from the original task.');
    session.selectModel({initiatedBy:'human',...selection});
    const thread=await session.startThread({initiatedBy:'human'});
    return Object.freeze({snapshot:()=>session.snapshot(),propose:async(text:string)=>{
      if(session.taskAccountIdentity()!==identity)fail('ACCOUNT_IDENTITY','The worker account changed before dispatch.');
      return session.startTurn({initiatedBy:'human',threadId:thread.threadId,text});
    },close:()=>session.close()});
  }catch(error){await session.close();throw error;}
}

/** Embedded history uses only the separate, secret-free isolated launch template. */
class ArcaneCodexSession extends CodexSession {
  readonly #historySpec: { readonly command: string; readonly cwd: string; readonly args: readonly string[]; readonly env: Readonly<NodeJS.ProcessEnv> };
  constructor(spec: InternalProcess, bounds: Limits, historySpec: InternalProcess, hooks?: NativeAssetHooks) {
    super(spec, bounds, 'installed-cli', 'arcane-only', hooks);
    this.#historySpec = Object.freeze({
      ...historySpec, args: Object.freeze([...historySpec.args]), env: Object.freeze({ ...historySpec.env }),
    });
  }
  protected override historyProcessSpec(): InternalProcess {
    return { ...this.#historySpec, args: [...this.#historySpec.args], env: { ...this.#historySpec.env } };
  }
}

/** Host-code API only. Never map executable paths or lifecycle actions directly from an unauthenticated request. */
export async function connectCodexClient(options: ConnectOptions): Promise<CodexClient> {
  exact(options, ['command','cwd','use','limits','arcaneMcp','nativeAssetHooks']);
  const hookField = Object.getOwnPropertyDescriptor(options, 'nativeAssetHooks');
  if (hookField && !Object.hasOwn(hookField, 'value') || !hookField && 'nativeAssetHooks' in options) fail('ARGUMENTS', 'Native asset hooks must be an own data option.');
  const hooks = hookField?.value === undefined ? undefined : validateNativeAssetHooks(hookField.value);
  if (hooks && !options.arcaneMcp) fail('MCP_PROFILE', 'Native asset hooks require the trusted Arcane MCP profile.');
  const bounds = limits(options.limits);
  const {executable,workspace}=await installedPaths(options.command,options.cwd,options.use);
  // Snapshot the trusted profile before asynchronous discovery or host callbacks can mutate it.
  if (hooks) exact(options.arcaneMcp, ['nodeExecutable','serverEntry','projectRoot','daemonUrl','agentToken']);
  const profile = hooks ? { ...options.arcaneMcp! } : options.arcaneMcp;
  let processSpec = await prepareCodexProcess(executable, workspace, profile);
  const discoverySpec = profile ? prepareCodexDiscoveryProcess(executable, workspace) : processSpec;
  let session = new CodexSession(discoverySpec, bounds, 'installed-cli', profile ? 'arcane-only' : 'native-config');
  let hooksAttached = false;
  try {
    await session.initialize();
    if (profile) {
      // Discovery may inventory inherited servers, but never receives Arcane authority.
      // Isolate only the final child, leaving the user's native configuration untouched.
      const inventory = await session.inspectMcpServers({ initiatedBy: 'human' });
      const arcane = inventory.find(server => server.name === 'arcane');
      // Connection-level inventory has no thread runtime in the real CLI, so null
      // means unavailable, not enabled. This launch is host-constructed, secret-free
      // and explicitly disabled. No authority/turn is granted here; configured
      // thread inventory below still requires concrete runtime isolation.
      if (!arcane || !['disabled', null].includes(arcane.runtimeStatus) || arcane.plugin || arcane.toolsError || arcane.toolNames.length !== 0)
        fail('MCP_ISOLATION', 'Secret-free discovery must expose no Arcane tools or plugin authority.');
      let overrides = arcaneIsolationOverrides(inventory, profile.nodeExecutable, profile.agentToken);
      const historySpec = { ...discoverySpec, args: [...discoverySpec.args, ...overrides], env: { ...discoverySpec.env } };
      await session.close();
      if (hooks) {
        const validatedSpec = processSpec;
        let credential: unknown;
        try { credential = hooks.finalCredential(); }
        catch { fail('ASSET_HOOK', 'Final native asset credential acquisition failed.'); }
        const agentToken = str(credential, 64);
        if (agentToken === profile.agentToken) fail('MCP_PROFILE', 'Native asset hooks require a fresh final bearer.');
        // Rebuild through the same trusted validator; never reuse the generic profile's bearer.
        processSpec = await prepareCodexProcess(executable, workspace, { ...profile, agentToken });
        if (['mcp_servers.arcane.command=', 'mcp_servers.arcane.args='].some(key =>
            processSpec.args.find(arg => arg.startsWith(key)) !== validatedSpec.args.find(arg => arg.startsWith(key))) ||
            processSpec.env.ARCANE_DAEMON_URL !== validatedSpec.env.ARCANE_DAEMON_URL) {
          fail('MCP_PROFILE', 'Validated Arcane paths or URL changed before the final launch.');
        }
        overrides = arcaneIsolationOverrides(inventory, profile.nodeExecutable, agentToken);
        const envVars = 'mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN"]';
        const position = processSpec.args.indexOf(envVars);
        if (position < 0) fail('MCP_PROFILE', 'The fixed Arcane environment allowlist is unavailable.');
        processSpec.args[position] = 'mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN","ARCANE_ASSET_AUDIENCE"]';
        processSpec.env.ARCANE_ASSET_AUDIENCE = 'native-session';
      }
      processSpec.args.push(...overrides);
      session = new ArcaneCodexSession(processSpec, bounds, historySpec, hooks);
      hooksAttached = true;
      await session.initialize();
    }
  } catch (error) {
    if (hooks && !hooksAttached) { try { hooks.retired(); } catch { /* Preserve the original failure and close discovery. */ } }
    await session.close(); throw error;
  }
  return session;
}
