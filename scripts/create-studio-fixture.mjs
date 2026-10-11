import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PLUGIN_SOURCES} from './build-plugin.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cdata=s=>'<![CDATA['+s.replaceAll(']]>',']]]]><![CDATA[>')+']]>';
let counter=0;
function item(name,className,source,children='',properties=''){return `<Item class="${className}" referent="RBXFixture${++counter}"><Properties><string name="Name">${name}</string>${source===null?'':`<ProtectedString name="Source">${cdata(source)}</ProtectedString>`}${properties}</Properties>${children}</Item>`;}
export async function createStudioFixture(){
 const modules=[];for(const[name,,filename]of PLUGIN_SOURCES.slice(1)){modules.push(item(name,'ModuleScript',await readFile(join(repo,'plugin','src',filename),'utf8')));}
 const folder=item('ArcaneFixtureModules','Folder',null,modules.join(''));
 const workspace=item('Workspace','Workspace',null,item('Baseplate','Part',null,'','<bool name="Anchored">true</bool><Vector3 name="size"><X>120</X><Y>1</Y><Z>120</Z></Vector3>'));
 const xml='<?xml version="1.0" encoding="utf-8"?><roblox version="4"><External>null</External><External>nil</External>'+workspace+item('ServerStorage','ServerStorage',null,folder)+'</roblox>';
 const root=join(repo,'runtime','fixtures');await mkdir(root,{recursive:true});const path=join(root,'Arcane-Disposable-'+randomUUID()+'.rbxlx');await writeFile(path,xml,{flag:'wx'});return{path,disposable:true,containsExecutableScripts:false,modulesOnly:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await createStudioFixture()));
