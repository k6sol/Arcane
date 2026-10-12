import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ArcaneError, boundedString, efforts, object, type Connection, type Selection } from '../../protocol/src/providers.js';

export function validateSelection(value: unknown, connections: Connection[]): Selection {
  const input = object(value);
  if (input.provider !== 'codex' && input.provider !== 'claude') throw new ArcaneError('SELECTION', 'Choose a known provider.');
  const model = boundedString(input.model);
  const revision = boundedString(input.connectionRevision);
  const effort = efforts.find(item => item === input.effort);
  if (!effort) throw new ArcaneError('SELECTION', 'Choose a reported effort value.');
  const connection = connections.find(c => c.provider === input.provider);
  if (!connection?.installed || connection.revision !== revision) throw new ArcaneError('STALE_CONNECTION', 'Refresh the provider catalogue and reselect explicitly.');
  const option = connection.models.find(m => m.id === model);
  if (!option || !option.efforts.includes(effort)) throw new ArcaneError('SELECTION', 'This exact model/effort pair was not reported; no substitute was selected.');
  if (connection.auth !== 'subscription') throw new ArcaneError('BILLING_MODE', 'This subscription-first lab requires a native subscription status. API/cloud use is separate explicit future work.');
  return { provider: input.provider, model, effort, connectionRevision: revision, savedAt: new Date().toISOString(), applied: false };
}
/** Atomic rename only: never unlink the previous preference to work around locks. */
export async function atomicPreferenceReplace(source: string, target: string, move: typeof rename = rename, platform: NodeJS.Platform = process.platform, wait: (ms:number)=>Promise<void> = delay): Promise<void> {
  const backoff=[25,50,100,200,400,800];
  for(let attempt=0;;attempt++) {
    try { await move(source,target); return; }
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      if(platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes(code??'') || attempt>=backoff.length) throw error;
      await wait(backoff[attempt]!);
    }
  }
}
export class SelectionStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private directory: string, private replaceFile: typeof atomicPreferenceReplace = atomicPreferenceReplace) {}
  async read(): Promise<Selection | null> {
    try {
      const target = join(this.directory, 'selection.json');
      const info = await stat(target);
      if (!info.isFile() || info.size > 8192) throw new ArcaneError('STATE', 'Saved selection is oversized or not a regular file.');
      const text = await readFile(target, 'utf8');
      if (Buffer.byteLength(text) > 8192) throw new ArcaneError('STATE', 'Saved selection is oversized.');
      const input = object(JSON.parse(text));
      if ((input.provider !== 'codex' && input.provider !== 'claude') || !efforts.includes(input.effort as Selection['effort']) || input.applied !== false) throw new ArcaneError('STATE', 'Saved selection is invalid.');
      return { provider: input.provider, model: boundedString(input.model), effort: input.effort as Selection['effort'], connectionRevision: boundedString(input.connectionRevision), savedAt: boundedString(input.savedAt), applied: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ArcaneError('STATE', 'Saved preference is unreadable; it has not been overwritten.');
    }
  }
  async save(selection: Selection): Promise<void> {
    const payload = JSON.stringify(selection, null, 2) + '\n';
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, 'selection.json');
      const temporary = join(this.directory, 'selection-' + randomUUID() + '.tmp');
      let ownsTemporary = false;
      try {
        const handle = await open(temporary, 'wx', 0o600); ownsTemporary = true;
        try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
        await this.replaceFile(temporary, target);
      } finally { if (ownsTemporary) await rm(temporary, { force: true }); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

