import { resolve } from 'node:path';
import { discoverProviders } from '../../../packages/model-adapters/src/discovery.js';
const connections = await discoverProviders(resolve(process.cwd()));
console.log(JSON.stringify({ kind: 'sanitized-native-metadata-only', connections, inferenceRuns: 0 }, null, 2));

