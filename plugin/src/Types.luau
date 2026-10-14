--!strict
-- Wire definitions mirror packages/protocol/src/studio.ts (protocol v1).
export type InstanceRef = {
	instanceId: string, sessionId: string, root: string,
	pathSegments: {string}, className: string,
}
export type PairResult = {
	sessionId: string, token: string, protocolVersion: number,
	allowedRoots: {string}, allowWrites: boolean,
}
export type Command = {
	protocolVersion: number, id: string, requestId: string, sessionId: string,
	clientSessionId: string, method: string, args: {[string]: any},
	allowedRoots: {string}, allowWrites: boolean, leaseEpoch: number,
	expiresAt: string, state: string,
}
export type MutationReceipt = {
	kind: string, ref: InstanceRef, before: any, after: {[string]: any},
}
-- Observation only; the host ledger selects a target and preserves provenance.
export type StudioPlaceCreatorObservation = {
	status: "available", kind: "user" | "group", id: number,
	provenance: "game.CreatorType/CreatorId",
} | {
	status: "unavailable", kind: nil, id: number,
	provenance: "game.CreatorType/CreatorId",
}
export type StudioUserObservation = {
	status: "available", id: number,
	provenance: "StudioService:GetUserId",
} | {
	status: "unavailable" | "not_applicable", id: nil,
	provenance: "StudioService:GetUserId",
}
export type StudioImportContextObservation = {
	sessionId: string, root: "Workspace", parentRef: InstanceRef,
	placeId: number, universeId: number, mode: "Edit" | "Play",
	modeProvenance: "StudioTestService.EditModeActive",
	creator: StudioPlaceCreatorObservation, studioUser: StudioUserObservation,
}
export type Outcome = {state: string, result: any?, error: string?, unsafe: boolean?}
return {}
