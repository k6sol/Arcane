import { resolve, join } from 'node:path';
import { createConnectionLab } from './lab-server.js';
const cwd = resolve(process.cwd());
const lab = await createConnectionLab({ cwd, stateDirectory: join(cwd, 'runtime', 'connection-lab') });
console.log('Arcane connection lab — read-only provider metadata; no inference or Studio execution.');
console.log('Open locally: ' + lab.url);
console.log('This session link controls metadata probes and preference saving only. Keep it local.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void lab.close().then(() => process.exit(0)); });

