'use strict';
// The Pyx bar window's only preload. It exposes window.arcaneDesktop.pyx (PyxBarBridge in apps/desktop/src/pyx-bar.ts) and
// nothing else: no token, no provider, no file or daemon access. Every call is an intent the main process checks against
// the bar's exact frame; moving only says start / move / end (the host reads the cursor itself).
const { contextBridge, ipcRenderer } = require('electron');
const unavailable = { accepted: false, message: 'Pyx couldn’t reach Arcane. Your text is still here.' };
const subscribe = (channel, pick) => listener => {
  if (typeof listener !== 'function') throw new Error('Pyx is unavailable.');
  const handler = (_event, value) => { try { listener(value); } catch { /* the bar re-renders on the next update */ } };
  ipcRenderer.on(channel, handler);
  void ipcRenderer.invoke('arcane:pyx-snapshot').then(snapshot => { try { listener(pick(snapshot)); } catch { /* ignored */ } }, () => { try { listener(pick(null)); } catch { /* ignored */ } });
  return () => { ipcRenderer.removeListener(channel, handler); };
};
// The host may say "open" before the page's module has subscribed; the latest word is kept and replayed.
let visible = null; const visibility = new Set();
ipcRenderer.on('arcane:pyx-visibility', (_event, open) => { visible = open === true; for (const l of visibility) { try { l(visible); } catch { /* ignored */ } } });
const pyx = Object.freeze({ version: 1,
  submit: text => typeof text === 'string' && text.trim() && text.length <= 131072
    ? ipcRenderer.invoke('arcane:pyx-submit', text).then(r => r && r.accepted === true ? { accepted: true } : { accepted: false, message: typeof r?.message === 'string' ? r.message : unavailable.message }, () => unavailable)
    : Promise.resolve({ accepted: false, message: 'Pyx couldn’t send that.' }),
  onState: subscribe('arcane:pyx-state', snapshot => snapshot?.state ?? snapshot ?? null),
  onSuggestions: subscribe('arcane:pyx-suggestions', snapshot => Array.isArray(snapshot) ? snapshot : snapshot?.suggestions ?? []),
  onVisibility: listener => {
    if (typeof listener !== 'function') throw new Error('Pyx is unavailable.');
    visibility.add(listener); if (visible !== null) { try { listener(visible); } catch { /* ignored */ } }
    return () => { visibility.delete(listener); };
  },
  ready: () => ipcRenderer.send('arcane:pyx-ready'),
  close: () => ipcRenderer.send('arcane:pyx-close'),
  expandToMain: () => ipcRenderer.send('arcane:pyx-expand'),
  stop: () => ipcRenderer.send('arcane:pyx-stop'),
  models:(...args)=>args.length?Promise.resolve(null):ipcRenderer.invoke('arcane:pyx-models').catch(()=>null),
  selectModel:(...args)=>{
    const c=args[0],keys=['revision','provider','model','effort'];
    if(args.length!==1||!c||typeof c!=='object'||Array.isArray(c)||![Object.prototype,null].includes(Object.getPrototypeOf(c))||Reflect.ownKeys(c).length!==4||!Reflect.ownKeys(c).every(k=>typeof k==='string'&&keys.includes(k)&&Object.getOwnPropertyDescriptor(c,k)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(c,k),'value'))||
      typeof c.revision!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(c.revision)||!['codex','claude','arcane'].includes(c.provider)||typeof c.model!=='string'||!c.model||c.model.length>256||typeof c.effort!=='string'||!c.effort||c.effort.length>64||/[\x00-\x1f\x7f]/.test(c.model+c.effort))return Promise.resolve({state:'rejected',message:'Choose a model from the current list.'});
    return ipcRenderer.invoke('arcane:pyx-select-model',{...c}).then(r=>r&&['applied','rejected','unknown'].includes(r.state)?{state:r.state,...(typeof r.message==='string'?{message:r.message.slice(0,300)}:{})}:{state:'unknown',message:'Model selection is unconfirmed. Review it in Arcane.'},()=>({state:'unknown',message:'Model selection is unconfirmed. Review it in Arcane.'}));
  },
  pickerOpen:(...args)=>{if(args.length===1&&typeof args[0]==='boolean')ipcRenderer.send('arcane:pyx-picker-open',args[0]);},
  setInteractive: on => ipcRenderer.send('arcane:pyx-interactive', on === true),
  drag: phase => { if (phase === 'start' || phase === 'move' || phase === 'end' || phase === 'cancel') ipcRenderer.send('arcane:pyx-drag', phase); },
  nudge: (dx, dy) => ipcRenderer.send('arcane:pyx-nudge', { dx: Number.isSafeInteger(dx) ? dx : 0, dy: Number.isSafeInteger(dy) ? dy : 0 }),
});
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'pyx', pyx }));
