// Script change viewer for chat change cards (both providers): a bounded line diff of one script edit's recorded
// before/after source, rendered as plain text. Every string reaches the page through textContent; nothing is parsed as markup.

export type ScriptDiffLineKind = 'same' | 'add' | 'del';
export interface ScriptDiffLine { kind: ScriptDiffLineKind; text: string; oldNo: number | null; newNo: number | null }
export interface ScriptDiff {
  lines: ScriptDiffLine[];
  added: number;
  removed: number;
  /** The changed region was too large for a line-by-line match; it is shown as one removed block and one added block. */
  approximate: boolean;
}
export interface ScriptDiffSegment { kind: 'lines' | 'collapsed'; lines: ScriptDiffLine[] }
export interface ScriptDiffSource { path: string; before: string; after: string }
export interface ScriptDiffView { segments: ScriptDiffSegment[]; added: number; removed: number; approximate: boolean; truncated: boolean; identical: boolean }

/** Most changed lines (per side, after trimming the common start and end) matched line by line. */
export const SCRIPT_DIFF_MATCH_LINES = 2000;
/** Most rows a rendered diff shows; the rest is summarised so a huge rewrite cannot stall the chat. */
export const SCRIPT_DIFF_ROWS = 2000;
/** Unchanged lines kept around each change before the rest of an unchanged region collapses. */
export const SCRIPT_DIFF_CONTEXT = 3;

export function splitSourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Line diff: common start/end trimmed, then a longest-common-subsequence match of the middle when it is small enough. */
export function diffLines(before: string, after: string, limit = SCRIPT_DIFF_MATCH_LINES): ScriptDiff {
  const a = splitSourceLines(before), b = splitSourceLines(after);
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const lines: ScriptDiffLine[] = []; let oldNo = 0, newNo = 0, added = 0, removed = 0;
  const same = (text: string) => { lines.push({ kind: 'same', text, oldNo: ++oldNo, newNo: ++newNo }); };
  const del = (text: string) => { lines.push({ kind: 'del', text, oldNo: ++oldNo, newNo: null }); removed++; };
  const add = (text: string) => { lines.push({ kind: 'add', text, oldNo: null, newNo: ++newNo }); added++; };
  for (let i = 0; i < start; i++) same(a[i]!);
  const midA = a.slice(start, endA), midB = b.slice(start, endB), m = midA.length, n = midB.length;
  const approximate = m > limit || n > limit;
  if (approximate || !m || !n) { midA.forEach(del); midB.forEach(add); }
  else {
    // table[i*(n+1)+j] = LCS length of midA[i..] and midB[j..]; bounded to (limit+1)^2 cells.
    const width = n + 1, table = new Uint16Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
      table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) { same(midA[i]!); i++; j++; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) del(midA[i++]!);
      else add(midB[j++]!);
    }
    while (i < m) del(midA[i++]!); while (j < n) add(midB[j++]!);
  }
  for (let i = endA; i < a.length; i++) same(a[i]!);
  return { lines, added, removed, approximate };
}

/** Groups a diff into shown runs and collapsed unchanged regions, keeping `context` lines around every change. */
export function diffSegments(lines: readonly ScriptDiffLine[], context = SCRIPT_DIFF_CONTEXT): ScriptDiffSegment[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = 1;
  });
  const segments: ScriptDiffSegment[] = [];
  lines.forEach((line, index) => {
    const kind = keep[index] ? 'lines' : 'collapsed', last = segments.at(-1);
    if (last && last.kind === kind) last.lines.push(line); else segments.push({ kind, lines: [line] });
  });
  return segments;
}

/** Diff plus segments, bounded to `rows` shown rows (collapsed regions count as one row). */
export function scriptDiffView(before: string, after: string, rows = SCRIPT_DIFF_ROWS): ScriptDiffView {
  const diff = diffLines(before, after), all = diffSegments(diff.lines), segments: ScriptDiffSegment[] = [];
  let used = 0, truncated = false;
  for (const segment of all) {
    const cost = segment.kind === 'collapsed' ? 1 : segment.lines.length;
    if (used + cost > rows) {
      if (segment.kind === 'lines' && rows - used > 0) segments.push({ kind: 'lines', lines: segment.lines.slice(0, rows - used) });
      truncated = true; break;
    }
    segments.push(segment); used += cost;
  }
  return { segments, added: diff.added, removed: diff.removed, approximate: diff.approximate, truncated, identical: !diff.added && !diff.removed };
}

// ---- Luau colouring: a small line tokenizer (keywords, strings, comments, numbers). Long brackets carry across lines. ----
export type LuauTokenKind = 'keyword' | 'string' | 'comment' | 'number' | null;
export interface LuauToken { kind: LuauTokenKind; text: string }
export interface LuauLineState { close: string | null; kind: 'string' | 'comment' | null }
const LUAU_KEYWORDS = new Set(['and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export', 'false', 'for', 'function', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'type', 'typeof', 'until', 'while']);
/** Tokens for one line. `state` is updated in place so a long comment or string continues on the next line. */
export function tokenizeLuauLine(line: string, state: LuauLineState = { close: null, kind: null }): LuauToken[] {
  const tokens: LuauToken[] = [];
  const push = (kind: LuauTokenKind, text: string) => { if (!text) return; const last = tokens.at(-1); if (last && last.kind === kind) last.text += text; else tokens.push({ kind, text }); };
  let i = 0;
  if (state.close) {
    const end = line.indexOf(state.close);
    if (end < 0) { push(state.kind, line); return tokens; }
    push(state.kind, line.slice(0, end + state.close.length)); i = end + state.close.length; state.close = null; state.kind = null;
  }
  const longOpen = (at: number): string | null => { const match = /^\[(=*)\[/.exec(line.slice(at, at + 64)); return match ? ']' + match[1] + ']' : null; };
  while (i < line.length) {
    const rest = line.slice(i), ch = line[i]!;
    if (rest.startsWith('--')) {
      const close = longOpen(i + 2);
      if (close) {
        const end = line.indexOf(close, i + 2 + close.length);
        if (end < 0) { push('comment', rest); state.close = close; state.kind = 'comment'; return tokens; }
        push('comment', line.slice(i, end + close.length)); i = end + close.length; continue;
      }
      push('comment', rest); return tokens;
    }
    if (ch === '[') {
      const close = longOpen(i);
      if (close) {
        const end = line.indexOf(close, i + close.length);
        if (end < 0) { push('string', rest); state.close = close; state.kind = 'string'; return tokens; }
        push('string', line.slice(i, end + close.length)); i = end + close.length; continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1; while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      push('string', line.slice(i, Math.min(line.length, j + 1))); i = Math.min(line.length, j + 1); continue;
    }
    const number = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(rest);
    if (number && !/[A-Za-z0-9_]/.test(line[i - 1] ?? '')) { push('number', number[0]); i += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) { push(LUAU_KEYWORDS.has(word[0]) ? 'keyword' : null, word[0]); i += word[0].length; continue; }
    push(null, ch); i++;
  }
  return tokens;
}

// ---- Rendering ----
export interface ScriptDiffRenderOptions { rows?: number }
const TOKEN_CLASSES: Record<Exclude<LuauTokenKind, null>, string> = { keyword: 'script-diff-kw', string: 'script-diff-str', comment: 'script-diff-com', number: 'script-diff-num' };
const SIGNS: Record<ScriptDiffLineKind, string> = { same: ' ', add: '+', del: '-' };
const LABELS: Record<ScriptDiffLineKind, string> = { same: 'Unchanged line', add: 'Added line', del: 'Removed line' };

/** Plain-text unified diff of one script edit. Unchanged regions collapse behind a "Show N unchanged lines" button. */
export function renderScriptDiff(doc: Document, source: ScriptDiffSource, options: ScriptDiffRenderOptions = {}): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const view = scriptDiffView(source.before, source.after, options.rows ?? SCRIPT_DIFF_ROWS);
  const panel = make('section', undefined, 'script-diff'); panel.setAttribute('aria-label', 'Changes to ' + source.path);
  const head = make('div', undefined, 'script-diff-head');
  const counts = make('span', undefined, 'script-diff-counts');
  counts.append(make('span', '+' + view.added, 'script-diff-added'), make('span', '-' + view.removed, 'script-diff-removed'));
  counts.setAttribute('aria-label', view.added + ' line' + (view.added === 1 ? '' : 's') + ' added, ' + view.removed + ' removed');
  head.append(make('span', source.path, 'script-diff-path'), counts);
  panel.append(head);
  const note = view.identical ? 'No line changes: the new source matches the old one.' : view.approximate
    ? 'This change is too large to match line by line, so it is shown as the removed lines followed by the added lines.' : '';
  if (note) panel.append(make('p', note, 'script-diff-note'));
  const body = make('div', undefined, 'script-diff-body'); body.setAttribute('role', 'list');
  // Colouring follows the new source for added/unchanged lines and the old source for removed lines.
  const oldState: LuauLineState = { close: null, kind: null }, newState: LuauLineState = { close: null, kind: null };
  const advance = (line: ScriptDiffLine) => {
    const tokensOld = line.kind !== 'add' ? tokenizeLuauLine(line.text, oldState) : null;
    const tokensNew = line.kind !== 'del' ? tokenizeLuauLine(line.text, newState) : null;
    return line.kind === 'del' ? tokensOld! : tokensNew!;
  };
  const row = (line: ScriptDiffLine, tokens: LuauToken[]) => {
    const item = make('div', undefined, 'script-diff-row ' + line.kind); item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', LABELS[line.kind] + ' ' + (line.newNo ?? line.oldNo ?? ''));
    const code = make('span', undefined, 'script-diff-code');
    for (const token of tokens) code.append(token.kind ? make('span', token.text, TOKEN_CLASSES[token.kind]) : make('span', token.text));
    item.append(make('span', line.oldNo === null ? '' : String(line.oldNo), 'script-diff-no old'), make('span', line.newNo === null ? '' : String(line.newNo), 'script-diff-no new'),
      make('span', SIGNS[line.kind], 'script-diff-sign'), code);
    return item;
  };
  for (const segment of view.segments) {
    if (segment.kind === 'lines') { for (const line of segment.lines) body.append(row(line, advance(line))); continue; }
    // Collapsed lines are still tokenized in order so long comments/strings stay coloured correctly afterwards.
    const hidden = segment.lines.map(line => ({ line, tokens: advance(line) }));
    const count = hidden.length, holder = make('div', undefined, 'script-diff-fold'); holder.setAttribute('role', 'listitem');
    const button = make('button', 'Show ' + count + ' unchanged line' + (count === 1 ? '' : 's'), 'quiet script-diff-expand'); button.type = 'button';
    button.addEventListener('click', () => {
      // A generic wrapper is transparent to assistive technology, so its rows stay items of the outer list.
      const lines = make('div', undefined, 'script-diff-unfolded');
      for (const entry of hidden) lines.append(row(entry.line, entry.tokens));
      holder.replaceWith(lines);
      // Keep keyboard focus in place of the button that just disappeared.
      lines.tabIndex = -1; try { lines.focus({ preventScroll: true }); } catch { /* Focus is presentation only. */ }
    }, { once: true });
    holder.append(button); body.append(holder);
  }
  panel.append(body);
  if (view.truncated) panel.append(make('p', 'Only the first ' + (options.rows ?? SCRIPT_DIFF_ROWS) + ' lines of this change are shown. Copy the new source to see all of it.', 'script-diff-note'));
  return panel;
}
