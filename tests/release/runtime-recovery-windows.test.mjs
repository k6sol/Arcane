import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{EventEmitter}from'node:events';import{join,basename}from'node:path';import vm from'node:vm';
const main=readFileSync(new URL('../../apps/desktop/electron/main.cjs',import.meta.url),'utf8').replaceAll('\r\n','\n');
const clearSelection=main.slice(main.indexOf('function clearHumanAssetSelection()'),main.indexOf('async function selectHumanAssetConversation('));
const block=main.slice(main.indexOf('function installClipboardForWindow(owner)'),main.indexOf('async function showCodeVerificationWarning()'));
const load=main.slice(main.indexOf('async function loadWorkspace()'),main.indexOf('async function chooseProject()'));
assert.ok(block.startsWith('function installClipboardForWindow(owner)')&&load.startsWith('async function loadWorkspace()'));
assert.ok(clearSelection.startsWith('function clearHumanAssetSelection()'),'Execute the actual navigation selection-clear helper.');
const settle=async()=>{for(let n=0;n<15;n++)await Promise.resolve();};
function fixture(mode='ok'){
 const calls=[],windows=[],timers=new Map();let context,timerId=0,release=()=>{};const gate=new Promise(done=>release=done);
 class Window extends EventEmitter{
  constructor(){super();this.dead=false;this.webContents=new EventEmitter();const contents=this.webContents;contents.mainFrame={url:''};contents.isDestroyed=()=>this.dead;contents.setWindowOpenHandler=()=>{};
   contents.session={setDevicePermissionHandler(){},webRequest:{onBeforeRequest(){}},clipboard:null};windows.push(this);
  }
  isDestroyed(){return this.dead;}show(){calls.push(['show',this]);}setTitle(title){calls.push(['title',this,title]);}
  destroy(){if(this.dead)return;this.dead=true;this.webContents.emit('destroyed');this.emit('closed');calls.push(['destroy',this]);}
  async loadURL(url){this.webContents.mainFrame.url=url;this.webContents.emit('did-start-navigation',{},url,false,true);calls.push(['load',this]);
   if(mode==='hold')await gate;if(mode==='failure')throw Error('Private navigation detail');if(mode==='crash'){this.webContents.emit('render-process-gone');throw Error('Renderer stopped');}if(mode==='exit')context.child.exitCode=1;
   this.emit('ready-to-show');if(mode==='crash-after-load')this.webContents.emit('render-process-gone');
  }
 }
 context=vm.createContext({window:null,pyxBar:{reset:()=>calls.push(['pyx-reset']),hide:()=>calls.push(['pyx-hide'])},recoveryWindow:null,recoveryWindowFailure:null,deferWindowShow:false,child:{exitCode:null,signalCode:null},switching:true,closing:false,smoke:false,
  assetSelectionGeneration:7,assetSelectionReady:true,appAssets:{selectHumanConversation(value){calls.push(['asset-selection',value]);return Promise.resolve();}},
  origin:'http://127.0.0.1:45871',token:'replacement-token',projectPath:'C:\\Project',projectSession:Object.freeze({id:'fixture'}),firstReadyMs:0,started:0,
  BrowserWindow:Window,join,basename,__dirname:'C:/Fixture/app',performance:{now:()=>0},Promise,
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  policy:{installClipboardPermissions:(session,getSession)=>{session.clipboard=getSession;calls.push(['clipboard',session]);},requestAllowed:()=>false,navigationAllowed:()=>true},
  runtimeRecovery:{waitForRenderer:async()=>true,cancelRenderer:()=>{},invalidate:owner=>calls.push(['invalidate',owner]),preferences:()=>null},nativeHandoff:null,providerSetup:null,
  appDialogs:{detach:contents=>calls.push(['detach',contents])},app:{quit:()=>{calls.push(['quit']);context.closing=true;}},
  showCodeVerificationWarning:async()=>calls.push(['warning']),failStartup:async()=>calls.push(['failStartup'])});
 vm.runInContext(clearSelection+block+load,context);context.makeWindow();const previous=context.window;previous.webContents.mainFrame.url='http://127.0.0.1:45871/studio#previous-token';calls.length=0;
 return{calls,context,windows,previous,timers,release,reload:()=>context.reloadRecoveredWorkspace()};
}
test('the actual window handoff shows a loaded replacement before retiring the old owner without quitting',async()=>{
 const f=fixture();await f.reload();const replacement=f.windows[1];assert.equal(f.context.window,replacement);assert.equal(f.previous.isDestroyed(),true);assert.equal(replacement.isDestroyed(),false);assert.equal(f.calls.filter(row=>row[0]==='quit').length,0);assert.equal(f.calls.filter(row=>row[0]==='show').length,1);assert.equal(f.calls.find(row=>row[0]==='show')[1],replacement);assert.equal(f.context.recoveryWindow,null);assert.equal(f.timers.size,0);
 assert.equal(f.calls.find(row=>row[0]==='invalidate')[1],replacement,'Navigation is bound to the new window, not the retained draft owner.');assert.equal(replacement.webContents.session.clipboard().window,replacement);
 assert.deepEqual(f.calls.filter(row=>row[0]==='asset-selection'),[['asset-selection',null]],'Only the active replacement navigation clears the previous human selection.');
 assert.deepEqual(f.calls.filter(row=>row[0].startsWith('pyx-')),[['pyx-reset']],'The replacement navigation also drops the Pyx bar snapshot (honestly offline until the new document republishes).');assert.equal(f.context.assetSelectionReady,false);assert.equal(f.context.assetSelectionGeneration,8);
});
test('failed loading, a staging renderer crash or runtime exit restores the original document and clipboard owner',async()=>{
 for(const mode of['failure','crash','crash-after-load','exit']){const f=fixture(mode);await assert.rejects(f.reload());const replacement=f.windows[1];assert.equal(f.context.window,f.previous);assert.equal(f.previous.isDestroyed(),false);assert.equal(replacement.isDestroyed(),true);assert.equal(f.previous.webContents.mainFrame.url,'http://127.0.0.1:45871/studio#previous-token');assert.equal(f.previous.webContents.session.clipboard().window,f.previous);assert.equal(f.calls.filter(row=>row[0]==='failStartup').length,0);assert.equal(f.calls.filter(row=>row[0]==='quit').length,0);assert.equal(f.timers.size,0);}
});
test('a hidden replacement never appears while loading and a deadline prevents late work from changing the old owner',async()=>{
 const f=fixture('hold'),pending=f.reload();const rejected=assert.rejects(pending,/timed out/);await settle();assert.equal(f.previous.isDestroyed(),false);assert.equal(f.calls.filter(row=>row[0]==='show').length,0);assert.equal([...f.timers.values()][0].ms,30000);[...f.timers.values()][0].fn();await rejected;f.release();await settle();assert.equal(f.context.window,f.previous);assert.equal(f.calls.filter(row=>row[0]==='title'&&row[1]===f.previous).length,0);assert.equal(f.calls.filter(row=>row[0]==='warning').length,0);assert.equal(f.windows[1].isDestroyed(),true);
});
test('closing the retained window during replacement honours the user quit instead of opening another app window',async()=>{
 const f=fixture('hold'),pending=f.reload(),rejected=assert.rejects(pending);await settle();f.previous.destroy();assert.equal(f.calls.filter(row=>row[0]==='quit').length,1);f.release();await rejected;assert.equal(f.context.window,null);assert.equal(f.windows[1].isDestroyed(),true);assert.equal(f.calls.filter(row=>row[0]==='show').length,0);
});
