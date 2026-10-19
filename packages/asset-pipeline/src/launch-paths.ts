import { win32 } from 'node:path';

/** Windows CreateProcess rejects long cwd values before the worker can start.
 * The fixed worker already receives absolute input/output paths and isolated env. */
export function workerLaunchDirectory(executable: string, directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && directory.length >= 260 ? win32.dirname(executable) : directory;
}

/** Blender's CLI opens long Python filenames only with extended-length spelling. */
export function workerFileArgument(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && path.length >= 260 ? win32.toNamespacedPath(path) : path;
}

/** Child files may exceed MAX_PATH even when their containing job directory does not.
 * This changes only Windows path spelling; the owned job directory stays in place. */
export function workerDirectoryArgument(directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.toNamespacedPath(directory) : directory;
}
