// Fixed build diagnostics. Callers await returned observations and their writes.
const PHASES = new Set(['validate-inputs', 'resolve-dependencies', 'prepare-source-release',
  'create-output', 'copy-electron', 'copy-host', 'copy-node', 'copy-product',
  'copy-dependencies', 'recheck-sources', 'brand-executable', 'write-manifest', 'verify-output']);
const MIN_FILES = 64, MIN_INTERVAL_MS = 1000;

// The clock is internal test injection, never a packageWindows option.
export function createPackageProgress(onProgress, now = () => performance.now()) {
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('Expected a trusted progress callback.');
  let phase = null, completedFiles = 0, completedBytes = 0, relativePath = null;
  let lastFiles = 0, lastAt = now(), failed = false, firstFailure, pending = Promise.resolve();
  async function observe() {
    const record = Object.freeze({ phase, completedFiles, completedBytes, relativePath });
    const previous = pending;
    pending = (async () => {
      await previous;
      if (!onProgress || failed) return;
      try { await onProgress(record); }
      catch (error) { if (!failed) { failed = true; firstFailure = error; } }
    })();
    await pending;
  }
  return {
    async phase(value) {
      if (!PHASES.has(value)) throw new TypeError('Unknown package progress phase.');
      if (phase === value) return;
      phase = value; lastFiles = completedFiles; lastAt = now();
      await observe();
    },
    async copied(path, bytes) {
      if (typeof path !== 'string' || path.length > 1024 || !/^[A-Za-z0-9_@.+\-/]+$/.test(path) ||
          path.split('/').some(part => !part || part === '.' || part === '..') ||
          !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 512 * 1024 * 1024) {
        throw new TypeError('Invalid bounded package progress.');
      }
      completedFiles++; completedBytes += bytes; relativePath = path;
      const at = now();
      if (completedFiles - lastFiles >= MIN_FILES && at - lastAt >= MIN_INTERVAL_MS) {
        lastFiles = completedFiles; lastAt = at;
        await observe();
      }
    },
    async finish(packageFailed, packageError) {
      await pending;
      if (packageFailed) throw packageError;
      if (failed) throw firstFailure;
    },
  };
}
