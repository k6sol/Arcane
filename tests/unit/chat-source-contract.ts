import assert from 'node:assert/strict';

// Only these complete, reviewed inert display statements may contain the old
// prohibited labels. Do not erase every quoted string: that would hide aliases,
// bracket calls or a newly added mutation inside a formerly pure label branch.
const DISPLAY_ONLY_ASSET_SOURCE = [
  `    case 'assets_procedural':{
      const generator=activityRecord(args?.generator),kind=activityText(generator?.kind,20),species=activityText(generator?.species,20);
      if(!kind||!/^[a-z]{1,20}$/.test(kind))return 'Modelling a procedural mesh';
      return 'Generating '+(kind==='tree'&&species&&/^[a-z]{1,20}$/.test(species)?species:kind)+' model';
    }`,
  "    case 'assets_start':case 'assets_procedural':return make(['Starting','Started'],['Blender job','Blender jobs'],null);",
  "  if(state==='finished'&&(tool==='assets_start'||tool==='assets_procedural'))return {text:'Blender job started',change:null};",
  "  if(typeof r.jobId==='string'&&typeof r.state==='string')return 'assets_procedural';",
  "const ASYNC_ASSET_TOOLS=new Set(['assets_start','assets_procedural','assets_adopt_glb','assets_convert_glb']);",
];

/** Test-only source contract; real capability/permission enforcement remains in the host. */
export function assertTextOnlyChatSource(source: string, label = 'chat source'): void {
  let checked = source.replace(/\r\n/g, '\n');
  for (const inert of DISPLAY_ONLY_ASSET_SOURCE) {
    const namesOnly = inert.replace(/\bassets_(?:start|procedural)\b/g, 'display_label');
    checked = checked.split(inert).join(namesOnly);
  }
  // Original storage/HTML/endpoint/authority and bare-name refusals remain.
  // Unrecognised uses of the new procedural label also fail closed.
  assert.doesNotMatch(checked, /localStorage|sessionStorage|\.innerHTML|\.outerHTML|\/v1\/assets|assets_start|assets_cancel|assets_procedural|initiatedBy\s*:/, label);
  // Catch actual SDK references, including aliases, property/element access,
  // optional calls and direct calls using other asset method names.
  assert.doesNotMatch(checked, /\bassets[A-Z][A-Za-z0-9_]*\b|\.\s*assets_[A-Za-z0-9_]+\b|\[\s*['"]assets_[A-Za-z0-9_]+['"]\s*\]|\bassets_[A-Za-z0-9_]+\s*(?:\?\.)?\s*\(/, label);
}
