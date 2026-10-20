// Trusted build helper. A batch owns at most four active input descriptors.
export const COPY_BATCH_FILES = 4;
export const COPY_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 32768, MAX_FILE_BYTES = 512 * 1024 * 1024;

export async function copyInBatches(descriptors, visit) {
  if (!Array.isArray(descriptors) || descriptors.length > MAX_FILES || typeof visit !== 'function') {
    throw new TypeError('Invalid bounded dependency copy.');
  }
  for (const descriptor of descriptors) {
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > MAX_FILE_BYTES) {
      throw new TypeError('Invalid dependency copy descriptor.');
    }
  }
  let next = 0, completed = 0, batches = 0;
  while (next < descriptors.length) {
    let end = next, bytes = 0;
    while (end < descriptors.length && end - next < COPY_BATCH_FILES) {
      const size = descriptors[end].bytes;
      if (end > next && bytes + size > COPY_BATCH_BYTES) break;
      bytes += size;
      end++;
      if (bytes > COPY_BATCH_BYTES) break; // A permitted oversize input runs alone.
    }
    let failed = false, firstFailure;
    const active = [];
    for (let index = next; index < end; index++) {
      if (failed) break;
      // An async callback starts here. A synchronous failure closes admission
      // immediately; an asynchronous failure closes it when observed below.
      active.push((async () => {
        try { await visit(descriptors[index]); completed++; }
        catch (error) { if (!failed) { failed = true; firstFailure = error; } }
      })());
    }
    await Promise.allSettled(active);
    if (failed) throw firstFailure;
    batches++;
    next = end;
  }
  return { completed, batches };
}
