import { writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { buildScenarioProgram } from '../src/scenario-runtime.js';
import { scenarioPlanSchema, type ScenarioPlan, type ScenarioRuntimeReport } from '../src/scenario.js';
import { digest } from '../src/contracts.js';
import { makeFixtureDirectory, fixtureTempDirectory } from '../../../tests/unit/windows-fixture-paths.js';
import { resolveScenarioFixtureRuntime } from './luau-runtime.js';

// The real production program runs in standalone Luau. Engine objects, physics,
// input delivery and virtual time below are explicitly synthetic test fixtures.
const literal=(value:unknown):string=>typeof value==='string'?'"'+[...Buffer.from(value)].map(byte=>'\\'+String(byte).padStart(3,'0')).join('')+'"':
  value===null||value===undefined?'nil':typeof value==='number'||typeof value==='boolean'?String(value):Array.isArray(value)?'{'+value.map(literal).join(',')+'}':
  '{'+Object.entries(value as Record<string,unknown>).map(([key,item])=>'['+literal(key)+']='+literal(item)).join(',')+'}';
export interface ScenarioFixtureOptions { immobile?:boolean; noInteraction?:boolean; alreadySatisfied?:boolean; inputUnavailable?:boolean;
  pressError?:boolean; releaseError?:boolean; focus?:boolean; replace?:'character'|'gui'|'target'; replaceDuringMouse?:boolean;hit?:'nested-button'|'passive-label';
  basis?:'topbar'|'cutout'|'extent-mismatch'|'inset-only'|'missing-api'|'missing-inset'|'viewport-mismatch'|'nonfinite'|'oversized'|'zero-size'|'missing-camera';
  changeBasis?:'inset'|'viewport'|'camera';changeDuringMouse?:boolean }
export interface ScenarioFixtureResult {report:ScenarioRuntimeReport;effects:{kind:string;key:string;pressed:boolean;object:number;x?:number;y?:number}[];creates:number;held:boolean}
export function runScenarioFixture(input:ScenarioPlan,options:ScenarioFixtureOptions={},runId='fixture-owned-run',wireProgram?:string):ScenarioFixtureResult {
  const plan=scenarioPlanSchema.parse(input);
  const executable=resolveScenarioFixtureRuntime();
  const directory=makeFixtureDirectory('arcane-scenario-vm-');
  const program=wireProgram??buildScenarioProgram(plan,runId,digest(plan));
  const source=String.raw`
local config=${literal(options)}
local plan=${literal({...plan,temporaryEdits:undefined})}
local expectedJson=${literal(JSON.stringify({...plan,temporaryEdits:undefined}))}
local now=0
local os={clock=function() return now end}
local Enum={KeyCode={W="W",A="A",S="S",D="D",E="E",F="F",Space="Space"},UserInputType={MouseButton1="MouseButton1"},
 ScreenInsets={None="None",CoreUISafeInsets="CoreUISafeInsets",DeviceSafeInsets="DeviceSafeInsets"}}
local function vector(x,y,z)
 local mt={}
 mt.__add=function(a,b)return vector(a.X+b.X,a.Y+b.Y,(a.Z or 0)+(b.Z or 0))end
 mt.__sub=function(a,b)return vector(a.X-b.X,a.Y-b.Y,(a.Z or 0)-(b.Z or 0))end
 mt.__div=function(a,b)return vector(a.X/b,a.Y/b,(a.Z or 0)/b)end
 return setmetatable({X=x,Y=y,Z=z or 0},mt)
end
local function node(name,class,parent)
 local self={Name=name,ClassName=class,Parent=parent,children={}}
 if parent then table.insert(parent.children,self) end
 function self:IsA(kind)return kind==self.ClassName or kind=="BasePart" and self.ClassName=="Part" or kind=="GuiButton" and (self.ClassName=="TextButton" or self.ClassName=="ImageButton")end
 function self:GetChildren()local values={};for _,child in ipairs(self.children)do if child.Parent==self then values[#values+1]=child end end;return values end
 function self:FindFirstChild(name)for _,child in ipairs(self:GetChildren())do if child.Name==name then return child end end;return nil end
 function self:FindFirstChildOfClass(class)for _,child in ipairs(self:GetChildren())do if child.ClassName==class then return child end end;return nil end
 function self:IsDescendantOf(parent)local current=self.Parent;for _=1,32 do if not current then return false end;if current==parent then return true end;current=current.Parent end;error("fixture depth")end
 return self
end
local game={PlaceId=0,GameId=0,children={}}
local workspace=node("Workspace","Workspace",game)
-- The successful click fixture explicitly has zero insets and coincident areas;
-- it does not stand in for a native desktop or device coordinate contract.
local areaWidth=if config.basis=="oversized" then 16385 elseif config.basis=="zero-size" then 0 else 800
workspace.CurrentCamera=if config.basis=="missing-camera"then nil else {ViewportSize=vector(if config.basis=="viewport-mismatch"then 801 else areaWidth,600)}
local basisChanged=false
local guiService={}
function guiService:GetInsetArea(kind)
 local x,y,right=0,0,areaWidth
 if kind=="None" and (config.basis=="topbar" or basisChanged and config.changeBasis=="inset")then y=-36 end
 if kind=="None" and config.basis=="cutout"then x=-24 end
 if kind=="DeviceSafeInsets" and config.basis=="extent-mismatch"then right=799 end
 if config.basis=="nonfinite"then right=0/0 end
 return {Min=vector(x,y),Max=vector(right,600)}
end
function guiService:GetGuiInset()return vector(0,if config.basis=="inset-only"then 36 else 0),vector(0,0)end
if config.basis=="missing-api"then guiService.GetInsetArea=nil end
if config.basis=="missing-inset"then guiService.GetGuiInset=nil end
local players=node("Players","Players",game)
local player=node("Player","Player",players);players.LocalPlayer=player
local character=node("Character","Model",workspace);player.Character=character
local root=node("HumanoidRootPart","Part",character);root.Position=vector(0,0,0)
local gui=node("PlayerGui","PlayerGui",player)
local hud=node("Hud","ScreenGui",gui)
local button=node("Interact","TextButton",hud);button.Visible=true;button.Active=true;button.AbsolutePosition=vector(100,100);button.AbsoluteSize=vector(100,40)
local status=node("Status","TextLabel",hud);status.Visible=config.alreadySatisfied==true;status.Text=if config.alreadySatisfied then "Open" else "Closed"
local hit=button
if config.hit then hit=node("Decoration",if config.hit=="nested-button"then"TextButton"else"TextLabel",button);hit.Active=config.hit=="nested-button"end
function gui:GetGuiObjectsAtPosition()return {hit}end
local effects,held,creates={}, {}, 0
local userInput={}
function userInput:GetFocusedTextBox()return if config.focus then {} else nil end
function userInput:IsKeyDown(key)return held[key]==true end
function userInput:IsMouseButtonPressed(key)return held[key]==true end
function userInput:CreateVirtualInput()
 if config.inputUnavailable then return nil end
 creates+=1;local serial=creates;local input={}
 function input:SendKey(pressed,key,repeated)
  assert(repeated==false);effects[#effects+1]={kind="key",key=key,pressed=pressed,object=serial}
  if not pressed and config.releaseError then error("fixture release failed")end
  held[key]=pressed
  if pressed and (key=="E" or key=="F")and not config.noInteraction then status.Visible=true;status.Text="Open"end
  if pressed and config.pressError then error("fixture press ACK failed after effect")end
 end
 function input:SendMouseButton(position,key,pressed,repeatCount)
  assert(repeatCount==0);effects[#effects+1]={kind="mouse",key=key,pressed=pressed,object=serial,x=position.X,y=position.Y}
  if not pressed and config.releaseError then error("fixture release failed")end
  held[key]=pressed
  if pressed and not config.noInteraction then status.Visible=true;status.Text="Open"end
  if pressed and config.pressError then error("fixture mouse ACK failed after effect")end
 end
 return input
end
local services={RunService={IsClient=function()return true end},Players=players,Workspace=workspace,GuiService=guiService,UserInputService=userInput,
 HttpService={JSONDecode=function(_,json)assert(json==expectedJson,"fixed program passed different plan bytes");return plan end}}
function game:GetService(name)return assert(services[name],"unavailable fixture service "..name)end
local replaced=false
local task={wait=function(seconds)
 now+=math.max(seconds,0.001)
 if held.W and not config.immobile then root.Position=root.Position+vector(0,0,seconds*16)end
 if not basisChanged and config.changeBasis and (not config.changeDuringMouse or held.MouseButton1)then
  basisChanged=true
  if config.changeBasis=="viewport"then workspace.CurrentCamera.ViewportSize=vector(801,600)
  elseif config.changeBasis=="camera"then workspace.CurrentCamera={ViewportSize=vector(800,600)}end
 end
 if not replaced and config.replace and (not config.replaceDuringMouse or held.MouseButton1)then
  replaced=true
  if config.replace=="character" then player.Character=node("ReplacementCharacter","Model",workspace)
  elseif config.replace=="gui" then gui.Parent=nil;node("PlayerGui","PlayerGui",player)
  else status.Parent=nil;local replacement=node("Status","TextLabel",hud);replacement.Visible=true;replacement.Text="Open"end
 end
end}
local report=(function()
${program}
end)()
local function encode(value)
 if type(value)=="boolean" or type(value)=="number" then return tostring(value)end
 if type(value)=="string"then return '"'..value:gsub('\\','\\\\'):gsub('"','\\"'):gsub('\n','\\n'):gsub('\r','\\r')..'"'end
 if type(value)=="nil"then return "null"end
 local parts={}
 if #value>0 then for _,item in ipairs(value)do parts[#parts+1]=encode(item)end;return "["..table.concat(parts,",").."]"end
 for key,item in pairs(value)do parts[#parts+1]=encode(key)..":"..encode(item)end
 return "{"..table.concat(parts,",").."}"
end
local anyHeld=false;for _,value in pairs(held)do if value then anyHeld=true end end
print(encode({report=report,effects=effects,creates=creates,held=anyHeld}))
`;
  try {
    const file=join(directory,'scenario.luau');writeFileSync(file,source);
    const result=spawnSync(executable,[file],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,windowsHide:true});
    if(result.error||result.status!==0)throw new Error('Production Luau scenario fixture failed: '+String(result.error??result.stderr).slice(0,2048));
    const value=JSON.parse(result.stdout.trim()) as ScenarioFixtureResult;if(!Array.isArray(value.effects)&&Object.keys(value.effects).length===0)value.effects=[];return value;
  } finally {const tail=relative(fixtureTempDirectory(),directory);if(isAbsolute(tail)||tail.startsWith('..')||!tail.startsWith('arcane-scenario-vm-'))throw new Error('Invalid fixture cleanup scope.');rmSync(directory,{recursive:true,force:true});}
}
export const fixtureScenario=():ScenarioPlan=>scenarioPlanSchema.parse({version:1,runtimeBudgetMs:800,
  targets:[{id:'status',root:'LocalPlayer.PlayerGui',segments:['Hud','Status'],className:'TextLabel'}],
  steps:[{id:'walk',kind:'hold-key',key:'W',holdMs:200},{id:'moved',kind:'assert-displacement',minimumStuds:1},
    {id:'interact',kind:'hold-key',key:'E',holdMs:50},{id:'opened',kind:'assert-gui',targetId:'status',property:'Visible',equals:true,withinMs:200}],capture:{required:true}});
