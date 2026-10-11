import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeStudioError } from './index.js';
import { captureNativeStudioChecks } from './observations.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--studio-id' || !args[1])) {
    process.stderr.write('Usage: check.js [--studio-id EXACT_ID]\n'); process.exitCode = 1;
  } else {
    try { process.stdout.write(JSON.stringify(await captureNativeStudioChecks(args[1]), null, 2) + '\n'); }
    catch (error) {
      process.stderr.write(JSON.stringify({ error: error instanceof NativeStudioError ? error.code : 'STUDIO_CHECK_FAILED' }) + '\n');
      process.exitCode = 1;
    }
  }
}
