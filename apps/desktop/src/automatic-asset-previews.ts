/** The caller must verify the exact project/chat/session receipt before observing.
 * This coordinator only chooses IDs; it grants no authority and performs no I/O.
 */
export interface AutomaticAssetPreviewJob {
  readonly jobId: string;
  readonly startedAt: string;
  readonly state: string;
  readonly manifestAvailable: boolean;
}

type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
type SnapshotJob = {
  jobId: string; startedAt: string; started: number;
  state: JobState; manifestAvailable: boolean;
};
type ObservedJob = SnapshotJob & {
  eligible: boolean; noticed: boolean; attempted: boolean; muted: boolean;
};
const MAX_IDENTITIES = 256;
const STATES: readonly string[] = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'];

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9_-]/u.test(value);
}

// Require an explicit timezone so parsing never depends on the local timezone.
// Date.parse supplies ordering; calendar checks also reject normalized bad dates.
function startedInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts || parts[0] !== value) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function snapshotJob(value: unknown): SnapshotJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { jobId, startedAt, state, manifestAvailable } = value as AutomaticAssetPreviewJob;
  if (!validId(jobId) || typeof state !== 'string' || !STATES.includes(state) || typeof manifestAvailable !== 'boolean') return null;
  const started = startedInstant(startedAt);
  return started === null ? null : { jobId, startedAt, started, state: state as JobState, manifestAvailable };
}

/**
 * One bounded epoch per verified conversation. The first valid HEAD is the
 * baseline, including an empty HEAD. MORE records identities/updates but cannot
 * admit jobs. Malformed or duplicate batches are ignored atomically. Identity
 * conflicts, terminal-to-running resurrection and capacity overflow quarantine the epoch:
 * both selectors stay null until reset, without forgetting/replaying history.
 */
export class AutomaticAssetPreviews {
  private readonly jobs = new Map<string, ObservedJob>();
  private hasBaseline = false;
  private baselineMax = -Infinity;
  private selectedStarted = -Infinity;
  private quarantined = false;

  observe(jobs: readonly AutomaticAssetPreviewJob[], more = false): void {
    if (this.quarantined || typeof more !== 'boolean' || !Array.isArray(jobs)) return;
    const length = jobs.length;
    if (length > MAX_IDENTITIES) { this.quarantined = true; return; }

    // Copy primitive fields and validate the entire bounded batch before any
    // admission or update. Caller mutation cannot rewrite a stored snapshot.
    const batch: SnapshotJob[] = [], ids = new Set<string>();
    let conflict = false, additions = 0;
    try {
      for (let i = 0; i < length; i++) {
        const job = snapshotJob(jobs[i]);
        if (!job || ids.has(job.jobId)) return;
        ids.add(job.jobId);
        const known = this.jobs.get(job.jobId);
        if (known) {
          // Recovery may revise a terminal outcome using a retained manifest.
          // Only returning to running would resurrect the same job identity.
          if (known.startedAt !== job.startedAt || (known.state !== 'running' && job.state === 'running')) conflict = true;
        } else additions++;
        batch.push(job);
      }
    } catch { return; }
    if (conflict || this.jobs.size + additions > MAX_IDENTITIES) { this.quarantined = true; return; }

    const baseline = !more && !this.hasBaseline;
    if (baseline) {
      for (const job of batch) this.baselineMax = Math.max(this.baselineMax, job.started);
    }
    for (const job of batch) {
      const known = this.jobs.get(job.jobId);
      const eligible = known
        ? known.eligible || (baseline && job.state === 'running')
        : !more && (job.state === 'running' || (!baseline && job.state === 'succeeded' && job.started > this.baselineMax));
      this.jobs.set(job.jobId, {
        ...job, eligible, noticed: known?.noticed ?? false,
        attempted: known?.attempted ?? false, muted: known?.muted ?? false,
      });
    }
    if (baseline) this.hasBaseline = true;
  }

  pending(): string | null { return this.newest(false)?.jobId ?? null; }
  ready(): string | null { return this.newest(true)?.jobId ?? null; }

  markPending(id: string): void {
    const job = this.jobs.get(id);
    if (job && this.selectable(job) && job.state === 'running') job.noticed = true;
  }

  /** Call before loading: a failed load still consumes this automatic attempt. */
  markReady(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !this.selectable(job) || job.attempted || job.state !== 'succeeded' || !job.manifestAvailable) return;
    job.attempted = true;
    this.selectedStarted = Math.max(this.selectedStarted, job.started);
  }

  /** Manual selection also mutes admitted jobs still waiting for a manifest. */
  muteObserved(): void {
    for (const job of this.jobs.values()) if (job.eligible) job.muted = true;
  }

  reset(): void {
    this.jobs.clear();
    this.hasBaseline = false;
    this.baselineMax = -Infinity;
    this.selectedStarted = -Infinity;
    this.quarantined = false;
  }

  private selectable(job: ObservedJob): boolean {
    return !this.quarantined && job.eligible && !job.muted && job.started >= this.selectedStarted;
  }

  private newest(ready: boolean): ObservedJob | null {
    if (this.quarantined) return null;
    let selected: ObservedJob | null = null;
    for (const job of this.jobs.values()) {
      if (!this.selectable(job) || (ready
        ? job.state !== 'succeeded' || !job.manifestAvailable || job.attempted
        : job.state !== 'running' || job.noticed)) continue;
      // IDs only break presentation ties. Baseline admission and the preview
      // watermark compare instants strictly, never ID order or the local clock.
      if (!selected || job.started > selected.started || (job.started === selected.started && job.jobId > selected.jobId)) selected = job;
    }
    return selected;
  }
}
