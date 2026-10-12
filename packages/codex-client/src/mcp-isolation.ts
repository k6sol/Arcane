import {fail} from './validation.js';
export interface McpInventoryRow {name:string;runtimeStatus:string|null;toolNames:string[];toolsError:boolean;plugin:boolean;pluginId:string|null}
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
export function arcaneThreadIsIsolated(rows:McpInventoryRow[]):boolean {
 return rows.some(row=>row.name==='arcane'&&row.runtimeStatus==='connected'&&!row.toolsError)&&rows.every(row=>row.name==='arcane'||row.runtimeStatus==='disabled');
}
