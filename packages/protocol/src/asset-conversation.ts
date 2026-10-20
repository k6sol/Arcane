/** Attribution metadata only. These values never grant a tool, write or workflow capability. */
export const ASSET_CONVERSATION_PROVIDERS = Object.freeze(['codex', 'claude-code', 'arcane'] as const);
export type AssetConversationProvider = typeof ASSET_CONVERSATION_PROVIDERS[number];
export interface AssetConversation {
  provider: AssetConversationProvider;
  threadId: string;
  sessionId: string | null;
}
/** A durable app chat is distinct from an observed native runtime session. */
interface AppAssetConversationAnchor {
  kind: 'app-conversation';
  connectionId: string;
  conversationId: string;
}
export type AppAssetConversationBinding = AppAssetConversationAnchor & (
  | { provider: 'claude-code'; transport: { kind: 'claude-code-process'; incarnationId: string; nativeSessionId: string | null } }
  | { provider: 'arcane'; transport: { kind: 'arcane-gateway-loop'; incarnationId: string } }
);
