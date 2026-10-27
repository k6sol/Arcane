import {types} from 'node:util';
import { ArcaneError } from '../../protocol/src/providers.js';
import { MESH_KEEP_LIMITS, object, type Json, type StudioSession } from '../../protocol/src/studio.js';

/** Wire validation for asset.keep_mesh ("Keep this mesh"). Only the host mesh-keep service can enqueue it (store admission);
 * the plugin (AssetPlacement.keep) re-validates every field, re-checks the signed-in Studio user and owns the engine calls.
 * Nothing here is consent: consent is the trusted desktop dialog recorded by the host before this command exists. */
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIFETIME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON = /^[A-Za-z0-9_:]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export const MESH_KEEP_STATES = ['kept', 'uploaded', 'partial', 'failed'] as const;
export type MeshKeepState = typeof MESH_KEEP_STATES[number];
export const MESH_KEEP_UPLOADS = ['succeeded', 'failed', 'reconciliation', 'skipped', 'reused'] as const;

function exact(value: unknown, fields: string[], label: string): Record<string, unknown> {
  const a = object(value, label), prototype = Object.getPrototypeOf(a);
  if ((prototype !== Object.prototype && prototype !== null) || Object.keys(a).some(key => !fields.includes(key))) throw new ArcaneError('INPUT', `Unexpected ${label} field.`);
  return a;
}
function id(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ArcaneError('INPUT', `Invalid ${label}.`);
  return value;
}
/** Asset name: what the user sees in the dialog and in their Roblox inventory. */
export function meshKeepName(value: unknown): string {
  if (typeof value !== 'string' || CONTROL.test(value) || !/\S/u.test(value) || [...value].length > MESH_KEEP_LIMITS.nameChars) throw new ArcaneError('INPUT', `Asset names are 1..${MESH_KEEP_LIMITS.nameChars} visible characters.`);
  return value;
}
export function meshKeepDescription(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || [...value].length > MESH_KEEP_LIMITS.descriptionChars) throw new ArcaneError('INPUT', 'Invalid asset description.');
  return value;
}

export function validateMeshKeep(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  exact(a, ['source', 'attemptId', 'name', 'description', 'creatorId', 'continuity', 'finish', 'assetIds'], 'keep-mesh arguments');
  if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Keeping a mesh swaps parts in Workspace; it requires the Workspace grant.');
  if (typeof a.source !== 'string' || !a.source.startsWith('editable-') || !DIGEST.test(a.source.slice(9))) throw new ArcaneError('INPUT', 'Expected an editable-<transfer digest> source.');
  if (typeof a.attemptId !== 'string' || !UUID.test(a.attemptId)) throw new ArcaneError('INPUT', 'Expected a host upload attempt ID.');
  meshKeepName(a.name); meshKeepDescription(a.description); id(a.creatorId, 'creator ID');
  const continuity = exact(a.continuity, ['clientLifetimeId', 'pluginArtifactHash', 'playEpoch'], 'keep-mesh continuity');
  if (typeof continuity.clientLifetimeId !== 'string' || !LIFETIME.test(continuity.clientLifetimeId) || typeof continuity.pluginArtifactHash !== 'string'
    || !DIGEST.test(continuity.pluginArtifactHash) || !Number.isSafeInteger(continuity.playEpoch) || (continuity.playEpoch as number) < 0) throw new ArcaneError('INPUT', 'Invalid keep-mesh continuity.');
  if (typeof a.finish !== 'boolean') throw new ArcaneError('INPUT', 'finish must be a boolean.');
  if (a.finish) {
    if (!Array.isArray(a.assetIds) || a.assetIds.length < 1 || a.assetIds.length > MESH_KEEP_LIMITS.meshes) throw new ArcaneError('INPUT', 'Finishing needs the recorded asset IDs.');
    a.assetIds.forEach(value => id(value, 'asset ID'));
  } else if (a.assetIds !== undefined) throw new ArcaneError('INPUT', 'A new keep never carries asset IDs.');
  return a;
}

export interface MeshKeepMeshReceipt { index: number; name: string; assetId: number | null; upload: typeof MESH_KEEP_UPLOADS[number]; reason: string | null; swapped: boolean }
export interface LegacyMeshKeepReceipt { state: MeshKeepState; meshes: MeshKeepMeshReceipt[]; uploadsStarted: number; swapped: number; persistence: 'saved-asset' | 'studio-session-only'; creatorId: number; ref: Json | null }

/** Closed check of the plugin's keep receipt against the exact command. The receipt is evidence of what Studio reported,
 * never proof that Roblox finished processing or moderation. */
function validateLegacyMeshKeepReceipt(args: Record<string, Json>, value: unknown): LegacyMeshKeepReceipt {
  const r = exact(value, ['state', 'meshes', 'uploadsStarted', 'swapped', 'persistence', 'creatorId', 'ref'], 'keep-mesh receipt');
  if (!(MESH_KEEP_STATES as readonly unknown[]).includes(r.state) || !Array.isArray(r.meshes) || r.meshes.length < 1 || r.meshes.length > MESH_KEEP_LIMITS.meshes
    || r.creatorId !== args.creatorId || !Number.isSafeInteger(r.uploadsStarted) || (r.uploadsStarted as number) < 0 || (r.uploadsStarted as number) > r.meshes.length
    || !Number.isSafeInteger(r.swapped) || (r.swapped as number) < 0 || (r.swapped as number) > r.meshes.length) throw new ArcaneError('RECEIPT', 'Keep-mesh receipt is malformed.');
  const meshes = r.meshes.map((raw, index) => {
    const m = exact(raw, ['index', 'name', 'assetId', 'upload', 'reason', 'swapped'], 'kept mesh');
    if (m.index !== index + 1 || typeof m.name !== 'string' || m.name.length > 100 || !(MESH_KEEP_UPLOADS as readonly unknown[]).includes(m.upload)
      || !(m.assetId === null || Number.isSafeInteger(m.assetId) && (m.assetId as number) > 0) || !(m.reason === null || typeof m.reason === 'string' && REASON.test(m.reason))
      || typeof m.swapped !== 'boolean' || (m.swapped && m.assetId === null) || ((m.upload === 'succeeded' || m.upload === 'reused') !== (m.assetId !== null))) throw new ArcaneError('RECEIPT', 'Kept mesh entry is malformed.');
    return { index: m.index as number, name: m.name, assetId: m.assetId as number | null, upload: m.upload as MeshKeepMeshReceipt['upload'], reason: m.reason as string | null, swapped: m.swapped };
  });
  const ids = meshes.filter(m => m.assetId !== null).length, swapped = meshes.filter(m => m.swapped).length;
  if (swapped !== r.swapped) throw new ArcaneError('RECEIPT', 'Keep-mesh swap count differs from its entries.');
  if (args.finish === true) {
    const expected = args.assetIds as number[];
    if (meshes.length !== expected.length || meshes.some((m, i) => m.upload !== 'reused' || m.assetId !== expected[i]) || r.uploadsStarted !== 0) throw new ArcaneError('RECEIPT', 'Finishing must reuse exactly the recorded asset IDs and upload nothing.');
  } else if (meshes.some(m => m.upload === 'reused')) throw new ArcaneError('RECEIPT', 'A new keep cannot report reused assets.');
  const expectedState: MeshKeepState = ids === 0 ? 'failed' : ids < meshes.length ? 'partial' : swapped === meshes.length ? 'kept' : 'uploaded';
  if (r.state !== expectedState || r.persistence !== (expectedState === 'kept' ? 'saved-asset' : 'studio-session-only')) throw new ArcaneError('RECEIPT', 'Keep-mesh state differs from its entries.');
  if (r.ref !== null && (typeof r.ref !== 'object' || Array.isArray(r.ref))) throw new ArcaneError('RECEIPT', 'Keep-mesh model reference is malformed.');
  return { state: expectedState, meshes, uploadsStarted: r.uploadsStarted as number, swapped, persistence: r.persistence as LegacyMeshKeepReceipt['persistence'], creatorId: r.creatorId as number, ref: r.ref as Json | null };
}

export interface ConvertedMeshKeepChildObservation { readonly instanceRef:string; readonly kind:'script'|'attachment'|'constraint'; readonly stateSha256:string }
export interface ConvertedMeshKeepNodeObservation { readonly nodeKey:string; readonly instanceRef:string; readonly ownedStateSha256:string; readonly authoredChildren:readonly ConvertedMeshKeepChildObservation[] }
export interface ConvertedMeshKeepObjectObservation { readonly sourceObjectId:string; readonly instanceRef:string; readonly ownedStateSha256:string; readonly authoredChildren:readonly ConvertedMeshKeepChildObservation[]; readonly meshAssetId:string }
export interface ConvertedMeshKeepObservation {
  readonly formatVersion:2; readonly receiptScope:'studio-session-observation'; readonly imported:false; readonly engineVerification:'pending';
  readonly graphDigest:string; readonly conversionRequestDigest:string;
  readonly nodes:readonly ConvertedMeshKeepNodeObservation[]; readonly objects:readonly ConvertedMeshKeepObjectObservation[];
}
export interface ConvertedMeshKeepReceipt extends LegacyMeshKeepReceipt { readonly converted:ConvertedMeshKeepObservation }
export type MeshKeepReceipt=LegacyMeshKeepReceipt|ConvertedMeshKeepReceipt;
/** Exact sealed graph metadata supplied by a host reader; this conveys no permission. */
export interface ConvertedMeshKeepExpected {
  readonly transferDigest:string; readonly graphDigest:string; readonly conversionRequestDigest:string;
  readonly nodes:readonly {readonly nodeKey:string;readonly parentKey:string|null}[];
  readonly meshes:readonly {readonly sourceObjectId:string;readonly nodeKey:string|null}[];
}
const KEEP_NODE=/^node(?:0|[1-9][0-9]*)(?:_primitive(?:0|[1-9][0-9]*))?$/;
const KEEP_OBJECT=/^arcane_[a-f0-9]{64}$/;
const KEEP_INSTANCE=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function convertedKeepFailure():never {throw new ArcaneError('RECEIPT','Converted keep observations do not match the reported saved meshes.');}
/** Descriptor-only snapshot before reading any converted receipt field. */
function convertedKeepData(value:unknown):unknown {
  let values=0,bytes=0;const seen=new Set<object>();
  const walk=(v:unknown,depth:number):unknown=>{
    if(++values>30000||depth>8)convertedKeepFailure();
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isFinite(v))convertedKeepFailure();return v;}
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>256*1024)convertedKeepFailure();return v;}
    if(typeof v!=='object'||types.isProxy(v)||seen.has(v))convertedKeepFailure();
    seen.add(v);
    try{
      const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
      if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)convertedKeepFailure();
      const keys=Reflect.ownKeys(v);
      if(array){
        const length=Object.getOwnPropertyDescriptor(v,'length');
        if(!length||!Object.hasOwn(length,'value')||!Number.isSafeInteger(length.value)||length.value<0||length.value>128||keys.length!==length.value+1)convertedKeepFailure();
        const result:unknown[]=[];
        for(let i=0;i<length.value;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))convertedKeepFailure();result.push(walk(d.value,depth+1));}
        return Object.freeze(result);
      }
      if(keys.length>32)convertedKeepFailure();const result:Record<string,unknown>=Object.create(null);
      for(const key of keys){if(typeof key!=='string')convertedKeepFailure();const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))convertedKeepFailure();result[key]=walk(d.value,depth+1);}
      return Object.freeze(result);
    }finally{seen.delete(v);}
  };const result=walk(value,0);if(Buffer.byteLength(JSON.stringify(result))>256*1024)convertedKeepFailure();return result;
}
function keepFields(value:unknown,fields:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))convertedKeepFailure();
  const r=value as Record<string,unknown>;if(Object.keys(r).length!==fields.length||fields.some(key=>!Object.hasOwn(r,key)))convertedKeepFailure();return r;
}
/** Detached historical observations, never cloud Model IDs or current upload authority. */
export function snapshotConvertedMeshKeepObservation(value:unknown,meshes:readonly {assetId:number|null;swapped:boolean}[],expected?:ConvertedMeshKeepExpected):ConvertedMeshKeepObservation {
  const r=keepFields(convertedKeepData(value),['formatVersion','receiptScope','imported','engineVerification','graphDigest','conversionRequestDigest','nodes','objects']);
  if(r.formatVersion!==2||r.receiptScope!=='studio-session-observation'||r.imported!==false||r.engineVerification!=='pending'||typeof r.graphDigest!=='string'||!DIGEST.test(r.graphDigest)
    ||typeof r.conversionRequestDigest!=='string'||!DIGEST.test(r.conversionRequestDigest)||!Array.isArray(r.nodes)||r.nodes.length<1||r.nodes.length>128
    ||!Array.isArray(r.objects)||r.objects.length!==meshes.length||meshes.length<1||meshes.length>MESH_KEEP_LIMITS.meshes||meshes.some(m=>!m.swapped||m.assetId===null))convertedKeepFailure();
  const nodeKeys=new Set<string>(),nodeRefs=new Set<string>(),objectIds=new Set<string>(),objectRefs=new Set<string>();
  const observation=(raw:Record<string,unknown>)=>{
    if(typeof raw.instanceRef!=='string'||raw.instanceRef.length!==36||!KEEP_INSTANCE.test(raw.instanceRef)||typeof raw.ownedStateSha256!=='string'||raw.ownedStateSha256.length!==64||!DIGEST.test(raw.ownedStateSha256)||!Array.isArray(raw.authoredChildren)||raw.authoredChildren.length>128)convertedKeepFailure();
    const childRefs=new Set<string>();
    const authoredChildren:ConvertedMeshKeepChildObservation[]=raw.authoredChildren.map(value=>{
      const child=keepFields(value,['instanceRef','kind','stateSha256']);
      if(typeof child.instanceRef!=='string'||child.instanceRef.length!==36||!KEEP_INSTANCE.test(child.instanceRef)||childRefs.has(child.instanceRef)||
        child.kind!=='script'&&child.kind!=='attachment'&&child.kind!=='constraint'||typeof child.stateSha256!=='string'||child.stateSha256.length!==64||!DIGEST.test(child.stateSha256))convertedKeepFailure();
      childRefs.add(child.instanceRef);return Object.freeze({instanceRef:child.instanceRef,kind:child.kind,stateSha256:child.stateSha256});
    });
    return {instanceRef:raw.instanceRef,ownedStateSha256:raw.ownedStateSha256,authoredChildren:Object.freeze(authoredChildren)};
  };
  const nodes=r.nodes.map(raw=>{
    const n=keepFields(raw,['nodeKey','instanceRef','ownedStateSha256','authoredChildren']);
    if(typeof n.nodeKey!=='string'||!KEEP_NODE.test(n.nodeKey)||nodeKeys.has(n.nodeKey))convertedKeepFailure();
    const observed=observation(n);if(nodeRefs.has(observed.instanceRef))convertedKeepFailure();nodeKeys.add(n.nodeKey);nodeRefs.add(observed.instanceRef);return Object.freeze({nodeKey:n.nodeKey,...observed});
  });
  const objects=r.objects.map((raw,index)=>{
    const o=keepFields(raw,['sourceObjectId','instanceRef','ownedStateSha256','authoredChildren','meshAssetId']);
    if(typeof o.sourceObjectId!=='string'||!KEEP_OBJECT.test(o.sourceObjectId)||objectIds.has(o.sourceObjectId)||o.meshAssetId!==String(meshes[index]!.assetId))convertedKeepFailure();
    const observed=observation(o);if(objectRefs.has(observed.instanceRef))convertedKeepFailure();objectIds.add(o.sourceObjectId);objectRefs.add(observed.instanceRef);return Object.freeze({sourceObjectId:o.sourceObjectId,...observed,meshAssetId:o.meshAssetId as string});
  });
  if(new Set([...nodeRefs,...objectRefs]).size>128)convertedKeepFailure();
  const sameChildren=(a:readonly ConvertedMeshKeepChildObservation[],b:readonly ConvertedMeshKeepChildObservation[])=>a.length===b.length&&a.every((child,i)=>child.instanceRef===b[i]!.instanceRef&&child.kind===b[i]!.kind&&child.stateSha256===b[i]!.stateSha256);
  for(const object of objects){const node=nodes.find(n=>n.instanceRef===object.instanceRef);if(node&&(node.ownedStateSha256!==object.ownedStateSha256||!sameChildren(node.authoredChildren,object.authoredChildren)))convertedKeepFailure();}
  const managedRefs=new Set([...nodeRefs,...objectRefs]),owners=new Set<string>(),childRefs=new Set<string>();
  for(const owner of [...nodes,...objects]){
    if(owners.has(owner.instanceRef))continue;owners.add(owner.instanceRef);
    for(const child of owner.authoredChildren){if(managedRefs.has(child.instanceRef)||childRefs.has(child.instanceRef))convertedKeepFailure();childRefs.add(child.instanceRef);}
  }
  if(expected){
    if(r.graphDigest!==expected.graphDigest||r.conversionRequestDigest!==expected.conversionRequestDigest||nodes.length!==expected.nodes.length||objects.length!==expected.meshes.length)convertedKeepFailure();
    const seen=new Set<string>();
    for(let i=0;i<nodes.length;i++){const actual=nodes[i]!,planned=expected.nodes[i]!;if(actual.nodeKey!==planned.nodeKey||planned.parentKey!==null&&!seen.has(planned.parentKey))convertedKeepFailure();seen.add(planned.nodeKey);}
    for(let i=0;i<objects.length;i++){
      const actual=objects[i]!,planned=expected.meshes[i]!;if(actual.sourceObjectId!==planned.sourceObjectId)convertedKeepFailure();
      const node=planned.nodeKey===null?undefined:nodes.find(n=>n.nodeKey===planned.nodeKey);
      if(planned.nodeKey!==null&&(!node||node.instanceRef!==actual.instanceRef||node.ownedStateSha256!==actual.ownedStateSha256)||planned.nodeKey===null&&nodeRefs.has(actual.instanceRef))convertedKeepFailure();
    }
  }
  return Object.freeze({formatVersion:2,receiptScope:'studio-session-observation',imported:false,engineVerification:'pending',graphDigest:r.graphDigest,conversionRequestDigest:r.conversionRequestDigest,nodes:Object.freeze(nodes),objects:Object.freeze(objects)});
}
export function validateMeshKeepReceipt(args:Record<string,Json>,value:unknown,expected?:ConvertedMeshKeepExpected):MeshKeepReceipt {
  if(expected&&args.source!=='editable-'+expected.transferDigest)convertedKeepFailure();
  if(value&&typeof value==='object'){
    if(types.isProxy(value))convertedKeepFailure();
    const descriptor=Object.getOwnPropertyDescriptor(value,'converted');
    if(descriptor){
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))convertedKeepFailure();
      const r=keepFields(convertedKeepData(value),['state','meshes','uploadsStarted','swapped','persistence','creatorId','ref','converted']);
      const {converted,...legacy}=r,receipt=validateLegacyMeshKeepReceipt(args,legacy);
      if(receipt.state!=='kept'||receipt.swapped!==receipt.meshes.length)convertedKeepFailure();
      return Object.freeze({...receipt,converted:snapshotConvertedMeshKeepObservation(converted,receipt.meshes,expected)});
    }
  }
  if(expected)convertedKeepFailure();
  return validateLegacyMeshKeepReceipt(args,value);
}
