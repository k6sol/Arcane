import type { Selection } from './providers.js';
/** Host projection only. This catalogue evidence grants no native action or entitlement. */
export interface NativeWorkflowModelProof {
  version: 1; source: 'active-native-thread-catalogue'; projectPath: string;
  connectionId: string; threadId: string; sessionId: string | null;
  provenance: 'installed-cli' | 'spawned-node-fixture';
  selection: Pick<Selection, 'provider' | 'model' | 'effort' | 'connectionRevision'>;
  entitlement: 'unverified';
}
