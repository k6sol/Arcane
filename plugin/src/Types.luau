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
export type Outcome = {state: string, result: any?, error: string?, unsafe: boolean?}
return {}
