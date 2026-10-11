import { z } from 'zod';
import { id, boundedText } from './schemas.js';

const taskKey = id.max(64).regex(/^[a-zA-Z0-9_-]+$/);
export const workScope = boundedText(300).refine(value => {
  const path = value.replaceAll('\\', '/');
  return path.split('/').every(part => part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part)
    && !['.git', '.codex', '.agents', '.aws', 'node_modules', '.env'].includes(part.toLowerCase()) && !part.toLowerCase().startsWith('.env.'));
}, 'Use a safe relative project file scope.');
export const workDefinition = {
  title: id.max(200), objective: boundedText(8000),
  tasks: z.array(z.strictObject({
    key: taskKey, title: id.max(200), instructions: boundedText(16000), acceptance: boundedText(4000),
    dependencies: z.array(taskKey).max(64), scope: z.array(workScope).min(1).max(20),
  })).min(1).max(64),
};
export const leaseToken = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const evidenceInput = z.strictObject({ path: workScope, note: boundedText(2000) });
export const workTask = z.object({
  id, key: taskKey, runId: id, title: id.max(200), instructions: boundedText(16000), acceptance: boundedText(4000),
  dependencies: z.array(taskKey).max(64), scope: z.array(workScope).min(1).max(20),
  state: z.enum(['pending', 'in_progress', 'needs_review', 'complete', 'failed', 'interrupted']), worker: id.max(200).nullable(),
  leaseUntil: id.nullable(), progress: z.string().max(4000),
  evidence: z.array(z.object({ path: workScope, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(0).max(16 * 1024 * 1024), note: boundedText(2000), addedAt: id })).max(20),
  reviewNote: boundedText(4000).nullable(), createdAt: id, updatedAt: id,
});
export const workRun = z.object({ id, title: id.max(200), objective: boundedText(8000), createdAt: id, tasks: z.array(workTask).min(1).max(64) })
  .refine(run => run.tasks.every(task => task.runId === run.id)
    && new Set(run.tasks.map(task => task.id)).size === run.tasks.length
    && new Set(run.tasks.map(task => task.key)).size === run.tasks.length, 'Tasks must belong to this exact run.');
