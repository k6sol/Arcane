import type { Json, StudioCommand, StudioImportContextObservation, StudioSession } from '../../packages/protocol/src/studio.js';

// Synthetic receipt data only. These IDs are fixture values, never Studio evidence.
export function importContextFixture() {
  const session: StudioSession = { id: 'context-session', clientSessionId: 'context-client', protocolVersion: 1,
    placeId: 12, universeId: 34, name: 'Synthetic context', pluginVersion: '0.1.7',
    allowedRoots: ['Workspace'], allowWrites: false, capabilities: ['scene.import_context'],
    connectedAt: '2026-10-14T00:00:00.000Z', lastSeenAt: '2026-10-14T00:00:01.000Z', revokedAt: null };
  const observation: StudioImportContextObservation = { sessionId: session.id, root: 'Workspace',
    parentRef: { instanceId: 'opaque-workspace', sessionId: session.id, root: 'Workspace', pathSegments: [], className: 'Workspace' },
    placeId: 12, universeId: 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
    creator: { status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId' },
    studioUser: { status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId' } };
  const command: StudioCommand = { protocolVersion: 1, id: 'context-command', requestId: 'context-request',
    sessionId: session.id, clientSessionId: session.clientSessionId, method: 'scene.import_context', args: {},
    allowedRoots: ['Workspace'], allowWrites: false, leaseEpoch: 1, expiresAt: '2026-10-14T00:01:00.000Z',
    state: 'succeeded', createdAt: '2026-10-14T00:00:01.000Z', finishedAt: '2026-10-14T00:00:02.000Z',
    result: observation as unknown as Json, error: null };
  return { session, observation, command };
}
