import {fail} from './validation.js';
import { missingArcaneTools } from '../../protocol/src/arcane-tools.js';
export interface McpInventoryRow {name:string;runtimeStatus:string|null;toolNames:string[];toolsError:boolean;plugin:boolean;pluginId:string|null}
/** Check effective native inventory, not merely a configured/connected server. */
export function requireArcaneBuildTools(rows: readonly McpInventoryRow[]): void {
 const row=rows.find(value=>value.name==='arcane');
 const missing=missingArcaneTools(row?.toolNames ?? []);
 if(missing.length)fail('MCP_CAPABILITIES','Arcane build tools did not load: '+missing.join(', ')+'. No model turn was sent.');
}
/** Child-only policy; unsupported CLI dotted keys fail closed, never rewrite user config. */
export function arcaneIsolationOverrides(rows:McpInventoryRow[],nodeExecutable:string,agentToken:string):string[] {
 const args:string[]=[];
 for(const server of rows) {
  if(server.name==='arcane')continue;
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(server.name)||server.pluginId!==null&&!/^[A-Za-z0-9_@-]{1,256}$/.test(server.pluginId))fail('MCP_ISOLATION','Inherited server/plugin keys cannot be safely overridden by this installed CLI.');
  if(server.pluginId!==null){const key='plugins.'+server.pluginId+'.mcp_servers.'+server.name;args.push('-c',key+'.enabled=false','-c',key+'.enabled_tools=[]');}
  else args.push('-c','mcp_servers.'+server.name+'={command='+JSON.stringify(nodeExecutable)+',args=["-e","process.exit(0)"],enabled=false,enabled_tools=[]}');
 }
 if(agentToken&&args.some(arg=>arg.includes(agentToken)))fail('MCP_ISOLATION','A private bearer cannot occur in child configuration arguments.');
 return args;
}
export function arcaneThreadIsIsolated(rows:readonly McpInventoryRow[]):boolean {
 if(!Array.isArray(rows)||!rows.length||rows.length>64)return false;
 const names=new Set<string>();let tools=0,arcane=false;
 const bounded=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&!value.includes('\0')&&Buffer.byteLength(value)<=256;
 for(const row of rows) {
  if(!row||typeof row!=='object'||!bounded(row.name)||names.has(row.name)||typeof row.toolsError!=='boolean'||typeof row.plugin!=='boolean'||
     (row.pluginId!==null&&!bounded(row.pluginId))||row.plugin!==(row.pluginId!==null)||!Array.isArray(row.toolNames))return false;
  names.add(row.name);tools+=row.toolNames.length;
  if(tools>2048||new Set(row.toolNames).size!==row.toolNames.length)return false;
  for(const tool of row.toolNames)if(!bounded(tool))return false;
  if(row.name==='arcane') {
   if(row.runtimeStatus!=='connected'||row.toolsError||row.plugin)return false;
   arcane=true;
  } else if(row.runtimeStatus!=='disabled')return false;
 }
 return arcane;
}
