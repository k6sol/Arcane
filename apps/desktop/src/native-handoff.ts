/// <reference lib="dom" />
import type { ClaudeSetupChoices, ProviderSetupController } from './provider-setup.js';

interface NativeHandoffBridge {
  version: 1;
  launch(profile: { model: string; effort: string }): Promise<unknown>;
  list(): Promise<unknown>;
  revoke(handoffId: string): Promise<unknown>;
}
interface HandoffRow {
  handoffId: string; state: string; createdAt: string; expiresAt: string;
  sealedAt: string | null; endedAt: string | null; owned: boolean;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Handoff metadata unavailable.');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) || required.some(key => !keys.includes(key))) throw Error('Handoff metadata unavailable.');
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw Error('Handoff metadata unavailable.');
  }
  return value as Record<string, unknown>;
}
export function readHandoffList(value: unknown): readonly HandoffRow[] {
  const reply = fields(value, ['state', 'projectId', 'handoffs']);
  if (reply.state !== 'listed' || typeof reply.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(reply.projectId) ||
      !Array.isArray(reply.handoffs) || Object.getPrototypeOf(reply.handoffs) !== Array.prototype || reply.handoffs.length > 256 ||
      Reflect.ownKeys(reply.handoffs).length !== reply.handoffs.length + 1) throw Error('Handoff list unavailable.');
  const ids = new Set<string>(), output: HandoffRow[] = [];
  for (let i = 0; i < reply.handoffs.length; i++) {
    const item = Object.getOwnPropertyDescriptor(reply.handoffs, String(i));
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw Error('Handoff list unavailable.');
    const row = fields(item.value, ['handoffId', 'state', 'createdAt', 'expiresAt', 'sealedAt', 'endedAt', 'owned']);
    if (!id(row.handoffId) || ids.has(row.handoffId) || typeof row.state !== 'string' || !['pending', 'sealed', 'expired', 'revoked', 'project_changed', 'closed'].includes(row.state) ||
        !time(row.createdAt) || !time(row.expiresAt) || !(row.sealedAt === null || time(row.sealedAt)) ||
        !(row.endedAt === null || time(row.endedAt)) || typeof row.owned !== 'boolean') throw Error('Handoff list unavailable.');
    ids.add(row.handoffId); output.push(Object.freeze({ ...row }) as unknown as HandoffRow);
  }
  return Object.freeze(output);
}
export function readHandoffOutcome(value: unknown): { state: string; revocation?: string; cleanup?: string; expiresAt?: string } {
  const reply = fields(value, ['state', 'reason', 'message'], ['handoffId', 'expiresAt', 'revocation', 'cleanup']);
  if (typeof reply.state !== 'string' || !['opened', 'cancelled', 'refused', 'unknown', 'revoked'].includes(reply.state) ||
      !(reply.reason === null || typeof reply.reason === 'string' && /^[a-z_]{1,64}$/.test(reply.reason)) ||
      typeof reply.message !== 'string' || reply.message.length > 512 || /[\x00-\x1f\x7f]/.test(reply.message) ||
      (Object.hasOwn(reply, 'handoffId') && !id(reply.handoffId)) || (Object.hasOwn(reply, 'expiresAt') && !time(reply.expiresAt)) ||
      (Object.hasOwn(reply, 'revocation') && (typeof reply.revocation !== 'string' || !['revoked', 'unknown'].includes(reply.revocation))) ||
      (Object.hasOwn(reply, 'cleanup') && (typeof reply.cleanup !== 'string' || !['removed', 'retained', 'not_owned'].includes(reply.cleanup))) ||
      (reply.state === 'opened' && (!id(reply.handoffId) || !time(reply.expiresAt))) || (reply.state === 'revoked' && !id(reply.handoffId))) throw Error('Handoff outcome unavailable.');
  return Object.freeze({ state: reply.state, ...(typeof reply.revocation === 'string' ? { revocation: reply.revocation } : {}),
    ...(typeof reply.cleanup === 'string' ? { cleanup: reply.cleanup } : {}), ...(typeof reply.expiresAt === 'string' ? { expiresAt: reply.expiresAt } : {}) });
}
function nativeBridge(doc: Document, supplied: unknown, explicit: boolean): NativeHandoffBridge | null {
  try {
    let value = supplied;
    if (!explicit) {
      const root = Object.getOwnPropertyDescriptor(doc.defaultView ?? {}, 'arcaneDesktop');
      if (!root || !Object.hasOwn(root, 'value')) return null;
      const field = Object.getOwnPropertyDescriptor(root.value, 'nativeHandoff');
      if (!field || !Object.hasOwn(field, 'value')) return null;
      value = field.value;
    }
    const bridge = fields(value, ['version', 'launch', 'list', 'revoke']);
    return bridge.version === 1 && Object.isFrozen(value) && ['launch', 'list', 'revoke'].every(key => typeof bridge[key] === 'function') ? value as NativeHandoffBridge : null;
  } catch { return null; }
}
export interface NativeHandoffController { stop(): void; resume(): void; cleanup(): void }
/** Explicit human intents only. No credentials, paths or launch environment enter this controller. */
export function startNativeHandoff(doc: Document, options: {
  provider: Pick<ProviderSetupController, 'handoffChoices' | 'subscribeHandoffChoices'>; nativeBridge?: unknown;
}): NativeHandoffController {
  const root = doc.getElementById('native-handoff-panel'), model = doc.getElementById('native-handoff-model') as HTMLSelectElement | null,
    effort = doc.getElementById('native-handoff-effort') as HTMLSelectElement | null, launch = doc.getElementById('native-handoff-launch') as HTMLButtonElement | null,
    refresh = doc.getElementById('native-handoff-refresh') as HTMLButtonElement | null, notice = doc.getElementById('native-handoff-status'),
    list = doc.getElementById('native-handoff-list'), choicesNotice = doc.getElementById('native-handoff-choices');
  if (!root || !model || !effort || !launch || !refresh || !notice || !list || !choicesNotice) return { stop() {}, resume() {}, cleanup() {} };
  const native = nativeBridge(doc, options.nativeBridge, Object.hasOwn(options, 'nativeBridge'));
  let choices: ClaudeSetupChoices | null = null, choiceKey = '', busy = false, stopped = false, disposed = false, generation = 0;
  let rows: readonly HandoffRow[] = [];
  const removers: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, handler: (event: Event) => void) => { target.addEventListener(name, handler); removers.push(() => target.removeEventListener(name, handler)); };
  const trusted = (event: Event) => { const key = event as MouseEvent; return event.isTrusted && !event.defaultPrevented && !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey; };
  const fill = (select: HTMLSelectElement, values: readonly string[], placeholder: string) => {
    select.replaceChildren();
    for (const value of ['', ...values]) { const item = doc.createElement('option'); item.value = value; item.textContent = value || placeholder; select.append(item); }
    select.value = '';
  };
  const render = () => {
    const blocked = stopped || disposed || busy || !native;
    root.setAttribute('aria-busy', String(busy));
    model.disabled = effort.disabled = blocked || !choices;
    launch.disabled = blocked || !choices || !choices.aliases.includes(model.value) || !choices.efforts.includes(effort.value);
    refresh.disabled = blocked;
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.disabled = blocked;
  };
  const renderChoices = () => {
    choices = stopped || disposed ? null : options.provider.handoffChoices();
    const key = JSON.stringify(choices);
    if (key !== choiceKey) { choiceKey = key; fill(model, choices?.aliases ?? [], 'Choose model'); fill(effort, choices?.efforts ?? [], 'Choose effort'); }
    choicesNotice.textContent = !native ? 'Project handoffs require the Arcane desktop app.' : choices ?
      'Choices reported by Claude Code ' + choices.cliVersion + '. Select both values. Model access is confirmed in the native terminal.' :
      'Check Claude Code sign-in in General to read its current model and effort choices.';
    render();
  };
  const renderRows = () => {
    list.replaceChildren();
    if (!rows.length) { const empty = doc.createElement('p'); empty.className = 'hint'; empty.textContent = 'No recorded project handoffs.'; list.append(empty); }
    for (const row of rows) {
      const line = doc.createElement('div'); line.className = 'native-handoff-row';
      const label = doc.createElement('span'); label.textContent = row.handoffId.slice(0, 8) + ' · ' + row.state.replaceAll('_', ' ') + ' · expires ' + row.expiresAt;
      line.append(label);
      if (row.state === 'pending' || row.state === 'sealed') {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Revoke';
        button.setAttribute('aria-label', 'Revoke handoff ' + row.handoffId.slice(0, 8));
        button.addEventListener('click', event => { if (trusted(event) && !button.disabled) void act('revoke', row.handoffId); }); line.append(button);
      }
      list.append(line);
    }
    render();
  };
  const act = async (action: 'launch' | 'list' | 'revoke', handoffId?: string) => {
    if (!native || busy || stopped || disposed) return;
    const profile = { model: model.value, effort: effort.value };
    if (action === 'launch') {
      choices = options.provider.handoffChoices();
      if (!choices || !choices.aliases.includes(profile.model) || !choices.efforts.includes(profile.effort)) { renderChoices(); return; }
    }
    const epoch = generation; busy = true; render();
    try {
      const reply = action === 'launch' ? await native.launch(profile) : action === 'revoke' ? await native.revoke(handoffId!) : await native.list();
      if (stopped || disposed || epoch !== generation) return;
      if (action === 'list') { rows = readHandoffList(reply); notice.textContent = 'Project handoffs updated.'; renderRows(); }
      else {
        const outcome = readHandoffOutcome(reply);
        notice.textContent = outcome.state === 'opened' ? 'Terminal opened with Arcane tools configured. Confirm the connection in the terminal. Credential expires ' + outcome.expiresAt + '.' :
          outcome.state === 'cancelled' ? 'Handoff cancelled.' : outcome.state === 'revoked' ? 'Handoff revoked.' :
          outcome.state === 'unknown' ? 'The handoff outcome is unknown. Check project handoffs before opening another terminal.' : 'Handoff unavailable. Check provider status and project handoffs.';
        if (outcome.revocation === 'unknown') notice.textContent += ' Revocation could not be confirmed; check project handoffs.';
        if (outcome.cleanup === 'retained') notice.textContent += ' Modified configuration was retained.';
        // The read follows the same explicit human action; it never renews or launches a handoff.
        try {
          const listed = await native.list();
          if (!stopped && !disposed && epoch === generation) { rows = readHandoffList(listed); renderRows(); }
        } catch { if (!stopped && !disposed && epoch === generation) notice.textContent += ' Use Check handoffs to refresh the list.'; }
      }
    } catch { if (!stopped && !disposed && epoch === generation) { rows = []; renderRows(); notice.textContent = 'Handoff status unavailable. Check provider status and project handoffs.'; } }
    finally { if (!stopped && !disposed && epoch === generation) { busy = false; renderChoices(); } }
  };
  listen(model, 'change', render); listen(effort, 'change', render);
  listen(launch, 'click', event => { if (trusted(event) && !launch.disabled) void act('launch'); });
  listen(refresh, 'click', event => { if (trusted(event) && !refresh.disabled) void act('list'); });
  removers.push(options.provider.subscribeHandoffChoices(renderChoices)); renderChoices();
  return {
    stop() { if (disposed) return; stopped = true; generation++; busy = false; rows = []; renderRows(); renderChoices(); notice.textContent = 'Project handoff view paused.'; },
    resume() { if (disposed || !stopped) return; stopped = false; generation++; renderChoices(); notice.textContent = 'Choose a profile or check project handoffs.'; },
    cleanup() { if (disposed) return; stopped = true; disposed = true; generation++; for (const remove of removers.splice(0)) remove(); rows = []; renderRows(); renderChoices(); },
  };
}
