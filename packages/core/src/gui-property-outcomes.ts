import type {Json} from '../../protocol/src/studio.js';
import {object,jsonObject} from '../../protocol/src/studio.js';
import {canonical,GUI_PROPERTIES,guiEditBaselineNames,validateGuiBaseline,type GuiClass,type EffectKind} from './studio-policy.js';

// Match the plugin's post-assignment tolerance only. Observed baselines and companion bounds stay exact.
const near=(a:unknown,b:number):boolean=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=.0005*Math.max(1,Math.abs(b));
function assigned(className:GuiClass,name:string,wanted:Json,observed:Json):boolean{
 if(name==='Name')return wanted===observed;
 const spec=(GUI_PROPERTIES[className] as Record<string,EffectKind>)[name]!;
 const kind=typeof spec==='string'?spec:spec[0];
 if(kind==='number'||kind==='integer')return near(observed,wanted as number);
 if(kind==='font'){
  const want=object(wanted),actual=object(observed);
  return actual.family===`rbxasset://fonts/families/${want.family}.json`&&actual.weight===(want.weight??'Regular')&&actual.style===(want.style??'Normal');
 }
 if(['color','vector2','vector3','udim','udim2'].includes(kind)){
  const want=object(wanted).value as number[],actual=object(observed).value as number[];
  return actual.length===want.length&&want.every((value,index)=>(kind==='udim'||kind==='udim2')&&index%2===1?actual[index]===value:near(actual[index],value));
 }
 if(kind==='sequence'||kind==='colorSequence'){
  const want=object(wanted).value as number[][],actual=object(observed).value as number[][];
  return actual.length===want.length&&want.every((point,index)=>{
   const normalized=kind==='sequence'?[point[0]!,point[1]!,point[2]??0]:point;
   return normalized.length===actual[index]!.length&&normalized.every((value,channel)=>near(actual[index]![channel],value));
  });
 }
 return canonical(wanted)===canonical(observed);
}

/** Validate only GUI update receipts. Physical property outcomes retain their independent validator. */
export function guiEditReceiptMatches(className:GuiClass,args:Record<string,Json>,mutation:Record<string,unknown>):boolean{
 try{
  const requested=jsonObject(args.properties),expected=validateGuiBaseline(args.expected,className);
  const before=validateGuiBaseline(object(mutation.before).properties,className),after=validateGuiBaseline(object(mutation.after).properties,className);
  const names=guiEditBaselineNames(className,requested),keys=(value:Record<string,Json>)=>canonical(Object.keys(value).sort());
  if(keys(before)!==canonical(names)||keys(after)!==canonical(names)||canonical(before)!==canonical(expected))return false;
  for(const[name,value]of Object.entries(requested))if(!assigned(className,name,value,after[name]!))return false;
  for(const name of names){
   if(Object.hasOwn(requested,name))continue;
   const fontAlias=(name==='Font'||name==='FontFace')&&(Object.hasOwn(requested,'Font')||Object.hasOwn(requested,'FontFace'));
   if(!fontAlias&&canonical(before[name])!==canonical(after[name]))return false;
  }
  if(className==='UISizeConstraint'&&names.includes('MinSize')){
   const min=object(after.MinSize).value as number[],max=object(after.MaxSize).value as number[];
   if(min.some((value,index)=>value>max[index]!))return false;
  }
  if(className==='UITextSizeConstraint'&&names.includes('MinTextSize')&&(after.MinTextSize as number)>(after.MaxTextSize as number))return false;
  return true;
 }catch{return false;}
}
