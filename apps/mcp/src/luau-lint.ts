/**
 * Advisory-only Luau checks run on script_update source before it is forwarded. Pure text heuristics:
 * no execution, no parsing guarantees, never blocks a write. Findings help the model fix common
 * gameplay-code mistakes (deprecated yields, busy loops, unprotected DataStore calls, client-trusted
 * remote values) on the first pass; a clean result does not prove the code is correct or secure.
 */

export type LuauAdvisorySeverity = 'warning' | 'info';
export interface LuauAdvisory { rule: string; severity: LuauAdvisorySeverity; line: number; message: string }

export const LUAU_LINT_LIMITS = Object.freeze({ advisories: 20, sourceBytes: 100 * 1024 });

/** Replace comments and string contents with spaces, keeping newlines and offsets. */
export function maskLuau(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => { for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '; };
  const longClose = (at: number): [number, number] | undefined => {
    const open = /^\[(=*)\[/.exec(source.slice(at, at + 260));
    if (!open) return undefined;
    const level = open[1] ?? '', close = source.indexOf(']' + level + ']', at + open[0].length);
    return [open[0].length, close < 0 ? source.length : close + level.length + 2];
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {
      const long = longClose(i + 2);
      const end = long ? long[1] : (source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i));
      blank(i, end); i = end; continue;
    }
    if (c === '[') {
      const long = longClose(i);
      if (long) { blank(i + long[0], Math.max(i + long[0], long[1] - long[0])); i = long[1]; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Index just after the `end`/`until` closing the block opened at `start` (which must be inside the block). */
function blockEnd(code: string, start: number): number {
  const keyword = /\b(function|if|do|repeat|end|until)\b/g;
  keyword.lastIndex = start;
  let depth = 1;
  for (let match = keyword.exec(code); match; match = keyword.exec(code)) {
    const word = match[1];
    if (word === 'end' || word === 'until') { if (--depth === 0) return match.index + word.length; }
    else depth++;
  }
  return code.length;
}

/** Index just after the parenthesis matching the `(` at `open`. */
function parenEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i + 1;
  }
  return code.length;
}

const YIELD = /\btask\.wait\s*\(|(?<![\w.:])wait\s*\(|:Wait\s*\(|:WaitForChild\s*\(|\bcoroutine\.yield\s*\(|Async\s*\(/;
const DATASTORE_CALL = /:(GetAsync|SetAsync|UpdateAsync|RemoveAsync|IncrementAsync|GetSortedAsync|ListKeysAsync)\s*\(/g;
const TRUSTED = /^(price|cost|amount|damage|dmg|reward|coins?|cash|money|gold|gems?|health|hp|xp|exp|points|score|speed|cooldown|multiplier|level|currency|balance|owned|won|win)$/i;
const VALIDATION = /\btypeof\s*\(|\btype\s*\(|\bt\.\w+|\b(?:is[A-Z]\w*|valid\w*|validate\w*|check\w*|assert\w*|allow\w*|guard\w*)\s*\(/;

/** Advisory findings for one Luau source. Never throws on odd input; returns at most LUAU_LINT_LIMITS.advisories items. */
export function lintLuau(source: string): LuauAdvisory[] {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > LUAU_LINT_LIMITS.sourceBytes) return [];
  const code = maskLuau(source);
  const found: LuauAdvisory[] = [];
  const add = (rule: string, severity: LuauAdvisorySeverity, index: number, message: string) => {
    const line = lineAt(code, index);
    if (!found.some(item => item.rule === rule && item.line === line)) found.push({ rule, severity, line, message });
  };

  if (!/^\s*--!strict\b/.test(source) && /\S/.test(code)) add('strict-mode', 'info', 0, 'Add --!strict on the first line and type module boundaries.');

  for (const match of code.matchAll(/(?<![\w.:])(?<!function\s+)(wait|spawn|delay)\s*\(/g))
    add('deprecated-scheduler', 'warning', match.index!, `Use task.${match[1]} instead of the deprecated global ${match[1]}().`);

  // Only unconditional loops: `while true do` and `repeat ... until false`. Finite loops may legitimately not yield.
  for (const match of code.matchAll(/\bwhile\s+(?:true|1)\s+do\b|\brepeat\b/g)) {
    const bodyStart = match.index! + match[0].length, end = blockEnd(code, bodyStart);
    const forever = match[0] !== 'repeat' || /^\s*false\b/.test(code.slice(end, end + 32));
    const body = code.slice(bodyStart, end);
    if (!forever || /\b(?:break|return)\b/.test(body)) continue;
    if (!YIELD.test(body)) add('busy-loop', 'warning', match.index!, 'Loop has no yield and will freeze the server or client; use task.wait, an event or a Heartbeat connection.');
    else if (/(?<![\w.:])wait\s*\(\s*\)/.test(body))
      add('polling-loop', 'info', match.index!, 'Polling with wait() runs at an unreliable rate; prefer events (Changed, AttributeChanged) or task.wait with an explicit interval.');
  }

  const protectedSpans: [number, number][] = [];
  // pcall/xpcall, or a retry/safe wrapper helper (which is expected to pcall internally).
  for (const match of code.matchAll(/\b(?:x?pcall|\w*[Rr]etry\w*|\w*[Ss]afe(?:ly)?(?:Call|Async)?\w*)\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    protectedSpans.push([open, parenEnd(code, open)]);
  }
  let writes = 0;
  for (const match of code.matchAll(DATASTORE_CALL)) {
    const at = match.index!, method = match[1];
    if (method !== 'GetAsync' && method !== 'GetSortedAsync' && method !== 'ListKeysAsync') writes++;
    if (!protectedSpans.some(([from, to]) => at > from && at < to))
      add('datastore-pcall', 'warning', at, `${method} can fail or throttle; call it inside pcall with bounded retries and a budget check (arcane-datastore-safety).`);
    if (method === 'SetAsync') add('datastore-setasync', 'warning', at, 'SetAsync overwrites blindly; use UpdateAsync for player data so a stale server cannot clobber newer saves.');
    if (method === 'RemoveAsync') add('datastore-remove', 'warning', at, 'RemoveAsync deletes saved data; only with an explicit user request, never as cleanup or migration.');
  }
  if (writes > 0 && !/\bBindToClose\b/.test(code))
    add('datastore-bindtoclose', 'warning', code.search(DATASTORE_CALL), 'DataStore writes without game:BindToClose; save loaded players on shutdown (max ~25 s).');

  for (const match of code.matchAll(/\.OnServer(Event|Invoke)\s*(?::\s*Connect\s*\(\s*function|=\s*function)\s*\(([^)]*)\)/g)) {
    const params = (match[2] ?? '').split(',').map(part => (part.split(':')[0] ?? '').trim()).filter(Boolean);
    for (const name of params.slice(1)) {
      if (TRUSTED.test(name.replace(/^(new|client|requested|req)_?/i, '')))
        add('client-trusted-value', 'warning', match.index!, `Remote parameter "${name}" looks like a value the server must decide; accept only ids or intent and look it up server-side (arcane-remote-security).`);
    }
    const bodyStart = match.index! + match[0].length;
    const body = code.slice(bodyStart, blockEnd(code, bodyStart));
    if (params.length > 1 && !VALIDATION.test(body))
      add('remote-unvalidated', 'warning', match.index!, 'Remote handler uses client arguments without runtime type checks (typeof) or a validator; also rate-limit per player.');
  }
  for (const match of code.matchAll(/:FireServer\s*\(([^)]*)\)/g)) {
    const args = (match[1] ?? '').split(',').map(arg => arg.trim()).filter(arg => /^[A-Za-z_]\w*$/.test(arg));
    const trusted = args.find(arg => TRUSTED.test(arg));
    if (trusted) add('client-trusted-value', 'warning', match.index!, `FireServer sends "${trusted}"; the server must derive it from its own state, not from the client.`);
  }
  for (const match of code.matchAll(/:InvokeClient\s*\(/g))
    add('invoke-client', 'warning', match.index!, 'Server InvokeClient can yield forever or error if the client misbehaves; use a RemoteEvent reply instead.');

  return found.sort((a, b) => a.line - b.line).slice(0, LUAU_LINT_LIMITS.advisories);
}
