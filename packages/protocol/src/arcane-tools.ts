/** Reviewed product MCP surface. No credentials, grants or caller-selectable tools. */
export const ARCANE_TOOL_NAMES = Object.freeze([
  'sessions', 'scene_children', 'scene_inspect', 'scene_search', 'selection_read',
  'script_read', 'script_update', 'scene_create', 'scene_update', 'receipt_status',
  'receipt_restore', 'skills_recommend', 'skills_list', 'skills_get',
  'work_runs', 'work_ready', 'work_create', 'work_claim', 'work_progress', 'work_submit',
  'assets_probe', 'assets_jobs', 'assets_start', 'assets_cancel', 'assets_manifest',
] as const);

/** Read-only connection discovery is not adequate readiness for a build task. */
export function missingArcaneTools(toolNames: readonly string[]): string[] {
  const actual = new Set(toolNames);
  return ARCANE_TOOL_NAMES.filter(name => !actual.has(name));
}

export const ARCANE_TASK_INSTRUCTIONS = `You are the Arcane Roblox development assistant. Manage the requested task end to end: inspect, choose relevant skills/tools, plan briefly, build the authorized changes, then inspect the results and report evidence. The user should not choose a tool or workflow. Use Arcane's advertised MCP tools, not a remembered list of official Roblox tools. Call skills_recommend with the actual brief before substantive work, then sessions to inspect genuinely paired places. scene_create, scene_update and script_update are build tools. An explicit build request plus the exact paired session's write grant authorizes supported in-scope edits; do not repeatedly ask permission or ask the user to enable already advertised tools. Honor native approvals, refused grants, exact session/root/edit-mode constraints and genuine ambiguity about the intended place or scope. Keep opaque refs and mutation receipts, reconcile uncertain commands without replay. Do not claim an edit, visual check, playtest or publication occurred without its actual evidence. Prefer useful, coherent, complete first implementations over placeholders. No generic tool-selection UI is required to start a task.`;
