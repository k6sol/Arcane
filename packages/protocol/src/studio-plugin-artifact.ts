/** Ordered source identity shared by the builder and the daemon. */
export const STUDIO_PLUGIN_IDENTITY_SCHEME = 'arcane-plugin-source-v1';
export const STUDIO_PLUGIN_SOURCES = Object.freeze([
  ['ArcaneLocalBridge', 'Script', 'Main.server.luau'],
  ['Types', 'ModuleScript', 'Types.luau'],
  ['Validation', 'ModuleScript', 'Validation.luau'],
  ['Registry', 'ModuleScript', 'Registry.luau'],
  ['Properties', 'ModuleScript', 'Properties.luau'],
  ['Operations', 'ModuleScript', 'Operations.luau'],
  ['Transport', 'ModuleScript', 'Transport.luau'],
  ['TestProof', 'ModuleScript', 'TestProof.luau'],
  ['Sha256', 'ModuleScript', 'Sha256.luau'],
  ['AssetMesh', 'ModuleScript', 'AssetMesh.luau'],
  ['Sha256Stream', 'ModuleScript', 'Sha256Stream.luau'],
  ['AssetTransfer', 'ModuleScript', 'AssetTransfer.luau'],
  ['AssetMaterials', 'ModuleScript', 'AssetMaterials.luau'],
  ['AssetUpload', 'ModuleScript', 'AssetUpload.luau'],
] as const);
