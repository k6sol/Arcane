export class AssetError extends Error {
  constructor(public readonly code: string, message: string, public readonly diagnostic?: AssetFailureDiagnostic) { super(message); this.name = 'AssetError'; }
}
/** Bounded, host-decoded evidence. Never contains raw worker output or exception text. */
export interface AssetFailureDiagnostic {
  schemaVersion: 1;
  stage: string;
  reasonCode: string;
  reason: string;
  exceptionType: string | null;
  metrics?: Record<string, number>;
  artifactPath?: string;
  auditPath?: 'audit.json';
  logPath?: 'failure.json';
}
export interface AssetJobError { code: string; message: string; diagnostic?: AssetFailureDiagnostic }
export type AssetTemplate = 'hero-prop' | 'environment-kit' | 'custom-assembly' | 'procedural';
/** Typed parameters for the bundled Blender generators (see procedural.ts). */
export type ProceduralSpec =
  | { kind: 'tree'; species: 'pine' | 'oak' | 'birch' | 'palm'; height: number; trunkTaper: number; branchLevels: number; leafDensity: number; trunkRadius: number | null; secondaryColor: Vec3 }
  | { kind: 'rock'; size: Vec3; roughness: number }
  | { kind: 'column'; radius: number; height: number; flutes: number; base: 'none' | 'plinth' | 'attic'; capital: 'none' | 'doric' | 'ionic' | 'corinthian' }
  | { kind: 'foliage'; style: 'bush' | 'grass' | 'fern'; radius: number; height: number; density: number };
export interface AssetInput {
  template: AssetTemplate;
  name: string;
  seed?: number | undefined;
  sizeMeters?: [number, number, number] | undefined;
  color?: [number, number, number] | undefined;
  triangleBudget?: number | undefined;
  renderResolution?: number | undefined;
  renderSamples?: number | undefined;
  recipe?: AssemblyRecipe | undefined;
  procedural?: unknown;
}
export interface AssetRequest extends Required<{ [K in keyof Omit<AssetInput, 'recipe' | 'procedural'>]: Exclude<AssetInput[K], undefined> }> { schemaVersion: 1; recipe?: AssemblyRecipe; procedural?: ProceduralSpec }
export interface RuntimeEvidence {
  executable: string;
  version: string;
  pythonVersion: string;
  background: boolean;
  capabilities: { glbExport: boolean; glbImport: boolean; fbxExport: boolean; fbxImport: boolean; cycles: boolean };
}
export interface PythonEvidence { executable: string; version: string }
export interface AssetProbe {
  observedAt: string;
  available: boolean;
  blender: RuntimeEvidence | null;
  python: PythonEvidence | null;
  attempts: { executable: string; code: string }[];
}
export interface MeshMetrics {
  name: string; role: 'render' | 'lod1' | 'collision';
  vertices: number; edges: number; faces: number; triangles: number;
  nonManifoldEdges: number; looseVertices: number; looseEdges: number;
  duplicateVertices: number; duplicateFaces: number; degenerateFaces: number;
  inconsistentNormals: number; invertedComponents: number; finitePositions: boolean;
  geometrySha256?: string; bounds?: { min: Vec3; max: Vec3 }; position?: Vec3; materialProperties?: MaterialEvidence[];
  uvLayers: number; uvLoops: number; invalidUVs: number; degenerateUVFaces: number;
  dimensions: number[]; scale: number[]; rotation: number[]; materials: string[];
  errors: string[];
}
export interface RenderMetrics {
  path: string; width: number; height: number; finitePixels: boolean;
  minLuminance: number; maxLuminance: number; meanLuminance: number; standardDeviation: number;
}
export interface ExportMetrics { sockets?: SocketEvidence[]; path: string; objects: number; triangles: number; materials: number; finitePositions: boolean }
export interface AssetAudit {
  schemaVersion: 1; template: AssetTemplate; meshes: MeshMetrics[];
  totals: { renderTriangles: number; lod1Triangles: number; collisionTriangles: number; materials: number };
  renders: RenderMetrics[]; exports: ExportMetrics[];
  assembly?: AssemblyEvidence;
  /** Optional for old jobs. Import preparation requires this producer evidence. */
  studioImport?: WorkerStudioImportEvidence;
  savedSceneReopened: boolean; errors: string[]; warnings: string[];
}
/** Emitted by the bundled worker from actual exported GLB nodes, never host-guessed names.
 * Semantic IDs persist for the same template/name/part; renames are new identities. */
export interface WorkerStudioImportEvidence {
  schemaVersion: 1;
  identityScheme: 'arcane-semantic-v1';
  assetId: string;
  blenderVersion: string;
  requestSha256: string;
  models: {
    path: 'asset.glb' | 'collision.glb'; sha256: string; byteLength: number; generator: string;
    objects: { sourceObjectId: string; sourceKey: string; nodeIndex: number; role: 'render' | 'collision'; pivot: Vec3; collisionFor: string[] }[];
    anchors: { sourceAnchorId: string; sourceKey: string; sourceObjectId: string; nodeIndex: number; kind: 'socket' | 'attachment'; transform: number[] }[];
  }[];
}
export interface Artifact {
  path: string; role: 'scene' | 'checkpoint' | 'export' | 'preview' | 'audit' | 'request' | 'worker'; bytes: number; sha256: string;
}
export interface AssetManifest {
  schemaVersion: 1; jobId: string; createdAt: string; request: AssetRequest;
  runtime: RuntimeEvidence; templateSha256: string;
  sourceRequestSha256?: string; assembly?: AssemblyEvidence;
  coordinateSystem: { units: 'meters'; sceneUp: 'Z'; glbUp: 'Y'; fbxUp: 'Y'; pivot: 'floor'; robloxScaleVerified: false };
  validation: AssetAudit; artifacts: Artifact[];
  limitations: string[];
}
export type AssetJobState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface AssetJobEvent { jobId: string; at: string; stage: string; state: AssetJobState }
export interface AssetJobResult {
  jobId: string; directory: string; state: Exclude<AssetJobState, 'running'>;
  manifestPath: string | null; error: AssetJobError | null;
}
export interface AssetJob { id: string; directory: string; completion: Promise<AssetJobResult>; cancel(): void }
export interface OperationOptions { signal?: AbortSignal; deadlineMs?: number }
export interface JobOptions extends OperationOptions { onEvent?: (event: AssetJobEvent) => void }
export interface PipelineOptions {
  /** Trusted host configuration, never browser input. Must already exist. */
  workspaceRoot: string;
  /** Must lie in workspaceRoot or the OS temporary directory. Created without links. */
  outputRoot: string;
  /** Defaults to workspaceRoot/workers/blender. Only the fixed bundled scripts are executed. */
  workerRoot?: string;
  blenderExecutable?: string;
  pythonExecutable?: string;
}

export type Vec3 = [number, number, number];
export type AssemblyRole = 'render' | 'collision' | 'lod1';
export interface AssemblyMaterial { id: string; color: Vec3; metallic?: number; roughness?: number; emission?: { color: Vec3; strength: number } }
export type AssemblyGeometry =
  | { kind: 'box' }
  | { kind: 'cylinder' | 'cone'; segments?: number }
  | { kind: 'sphere'; segments?: number; rings?: number }
  | { kind: 'mesh'; vertices: Vec3[]; indices: number[] };
export interface AssemblyPart {
  name: string; role: AssemblyRole; geometry: AssemblyGeometry;
  dimensions: Vec3; position: Vec3; rotationDegrees?: Vec3;
  material?: string; bevel?: { width: number; segments?: number };
}
export interface AssemblySocket { name: string; kind: 'socket' | 'attachment'; part: string; position: Vec3; rotationDegrees?: Vec3 }
export interface AssemblyRecipe {
  schemaVersion: 1; materials: AssemblyMaterial[]; parts: AssemblyPart[]; sockets?: AssemblySocket[];
  collisionTriangleBudget?: number; lodTriangleBudget?: number;
}
export interface MaterialEvidence { name: string; color: Vec3; metallic: number; roughness: number; emission: { color: Vec3; strength: number } }
export interface SocketEvidence { name: string; kind: 'socket' | 'attachment'; part: string; nodeName: string; matrix: number[] }
export interface AssemblyEvidence {
  recipeSha256: string; estimatedTriangles: { render: number; collision: number; lod1: number };
  bounds: { min: Vec3; max: Vec3 }; sockets: SocketEvidence[];
  artisticFidelity: 'unverified'; robloxImport: 'unverified';
}
