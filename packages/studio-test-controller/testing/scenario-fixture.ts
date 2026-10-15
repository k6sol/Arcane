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
export interface ScenarioFixtureOptions { immobile?:boolean; noInteraction?:boolean; alreadySatisfied?:boolean; inputUnavailable?:boolean;externalTransition?:boolean;
  pressError?:boolean; releaseError?:boolean; focus?:boolean; replace?:'player'|'character'|'gui'|'target'|'layout-ancestor'|'layout-target'; replaceDuringMouse?:boolean;hit?:'nested-button'|'passive-label';
  attribute?:{name?:string;initial?:boolean|number|string;next?:boolean|number|string;transition?:'input'|'wait';
    invalid?:'table'|'nan'|'infinite'|'invalid-utf8'|'long-string'|'control';invalidAfterWait?:boolean;missingApi?:boolean;replaceOnRead?:boolean;readError?:boolean};
  basis?:'topbar'|'cutout'|'extent-mismatch'|'inset-only'|'missing-api'|'missing-inset'|'viewport-mismatch'|'nonfinite'|'oversized'|'zero-size'|'missing-camera';
  changeBasis?:'inset'|'viewport'|'camera'|'safe-area'|'service';changeDuringMouse?:boolean;
  layout?:{width?:number;height?:number;left?:number;top?:number;safeWidth?:number;safeHeight?:number;viewportWidth?:number;viewportHeight?:number;
    clipping?:boolean;clipWidth?:number;clipHeight?:number;hiddenTarget?:boolean;hiddenAncestor?:boolean;disabledScreen?:boolean;settle?:boolean;
    rotation?:'target'|'ancestor'|'cancelled';invalid?:'negative-size'|'nonfinite-position'|'negative-clip'|'oversized'|'safe-origin';duplicateTarget?:boolean;folderParent?:boolean;folderBeforeScreen?:boolean} }
export interface ScenarioFixtureResult {report:ScenarioRuntimeReport;effects:{kind:string;key:string;pressed:boolean;object:number;x?:number;y?:number}[];inputRequests:number;creates:number;held:boolean}
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
 function self:IsA(kind)return kind==self.ClassName or kind=="BasePart" and self.ClassName=="Part" or kind=="GuiButton" and (self.ClassName=="TextButton" or self.ClassName=="ImageButton")
  or kind=="GuiObject" and (self.ClassName=="Frame" or self.ClassName=="TextLabel" or self.ClassName=="TextButton" or self.ClassName=="ImageButton")end
 if self:IsA("GuiObject")then self.Visible=true;self.Active=false;self.Rotation=0;self.AbsoluteRotation=0;self.ClipsDescendants=false;self.AbsolutePosition=vector(0,0);self.AbsoluteSize=vector(800,600)end
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
if config.layout and workspace.CurrentCamera then workspace.CurrentCamera.ViewportSize=vector(config.layout.viewportWidth or 800,config.layout.viewportHeight or 644)end
local basisChanged=false
local guiService={}
function guiService:GetInsetArea(kind)
 local x,y,right,bottom=0,0,areaWidth,600
 if config.layout and kind=="CoreUISafeInsets"then right=config.layout.safeWidth or 800;bottom=config.layout.safeHeight or 600;if config.layout.invalid=="safe-origin"then x=1 end end
 if basisChanged and config.changeBasis=="safe-area"and kind=="CoreUISafeInsets"then right-=1 end
 if kind=="None" and (config.basis=="topbar" or basisChanged and config.changeBasis=="inset")then y=-36 end
 if kind=="None" and config.basis=="cutout"then x=-24 end
 if kind=="DeviceSafeInsets" and config.basis=="extent-mismatch"then right=799 end
 if config.basis=="nonfinite"then right=0/0 end
 return {Min=vector(x,y),Max=vector(right,bottom)}
end
function guiService:GetGuiInset()return vector(0,if config.basis=="inset-only"then 36 else 0),vector(0,0)end
if config.basis=="missing-api"then guiService.GetInsetArea=nil end
if config.basis=="missing-inset"then guiService.GetGuiInset=nil end
local players=node("Players","Players",game)
local player=node("Player","Player",players);players.LocalPlayer=player
local attributeOptions=config.attribute or {}
local attributeValue,attributeChanged=attributeOptions.initial,false
function player:GetAttribute(name)
 if attributeOptions.readError then error("PRIVATE_ATTRIBUTE_ERROR")end
 if attributeOptions.replaceOnRead then players.LocalPlayer=node("ReplacementPlayer","Player",players)end
 if name~=(attributeOptions.name or "Checkpoint")then return nil end
 local invalid=if not attributeOptions.invalidAfterWait or attributeChanged then attributeOptions.invalid else nil
 if invalid=="table"then return {}elseif invalid=="nan"then return 0/0 elseif invalid=="infinite"then return math.huge
 elseif invalid=="invalid-utf8"then return string.char(255)elseif invalid=="long-string"then return string.rep("x",257)
 elseif invalid=="control"then return string.char(1)end
 return attributeValue
end
if attributeOptions.missingApi then player.GetAttribute=nil end
local function updateAttribute(mode)
 if attributeOptions.transition==mode and not attributeChanged then attributeValue=attributeOptions.next;attributeChanged=true end
end
local character=node("Character","Model",workspace);player.Character=character
local root=node("HumanoidRootPart","Part",character);root.Position=vector(0,0,0)
local gui=node("PlayerGui","PlayerGui",player)
local hud=node("Hud","ScreenGui",gui);hud.Enabled=not(config.layout and config.layout.disabledScreen)
if config.layout and config.layout.folderBeforeScreen then local folder=node("Ui","Folder",gui);hud.Parent=folder;folder.children[#folder.children+1]=hud end
local button=node("Interact","TextButton",hud);button.Visible=true;button.Active=true;button.AbsolutePosition=vector(100,100);button.AbsoluteSize=vector(100,40)
local status=node("Status","TextLabel",hud);status.Visible=config.alreadySatisfied==true;status.Text=if config.alreadySatisfied then "Open" else "Closed"
local layoutFrame=node("Layout",if config.layout and config.layout.folderParent then"Folder"else"Frame",hud)
local layoutTarget=node("Target","TextButton",layoutFrame)
layoutFrame.AbsolutePosition=vector(0,0);layoutFrame.AbsoluteSize=vector(400,300);layoutFrame.ClipsDescendants=true
layoutTarget.AbsolutePosition=vector(24,24);layoutTarget.AbsoluteSize=vector(200,50)
if config.layout then
 local options=config.layout
 layoutFrame.Visible=not options.hiddenAncestor;layoutFrame.ClipsDescendants=options.clipping~=false
 layoutFrame.AbsoluteSize=vector(options.clipWidth or 400,options.clipHeight or 300)
 layoutTarget.Visible=not options.hiddenTarget;layoutTarget.AbsolutePosition=vector(options.left or 24,options.top or 24)
 layoutTarget.AbsoluteSize=vector(options.width or 200,options.height or 50)
 if options.settle then layoutTarget.AbsoluteSize=vector(1,1)end
 if options.rotation=="target"then layoutTarget.Rotation=45;layoutTarget.AbsoluteRotation=45
 elseif options.rotation then layoutFrame.Rotation=45;layoutFrame.AbsoluteRotation=45;if options.rotation=="cancelled"then layoutTarget.Rotation=-45;layoutTarget.AbsoluteRotation=0 end end
 if options.invalid=="negative-size"then layoutTarget.AbsoluteSize=vector(-1,50)
 elseif options.invalid=="nonfinite-position"then layoutTarget.AbsolutePosition=vector(0/0,24)
 elseif options.invalid=="negative-clip"then layoutFrame.AbsoluteSize=vector(-1,300)
 elseif options.invalid=="oversized"then layoutTarget.AbsoluteSize=vector(16385,50)end
 if options.duplicateTarget then node("Target","TextButton",layoutFrame)end
end
local hit=button
if config.hit then hit=node("Decoration",if config.hit=="nested-button"then"TextButton"else"TextLabel",button);hit.Active=config.hit=="nested-button"end
function gui:GetGuiObjectsAtPosition()return {hit}end
local effects,held,creates,inputRequests={}, {}, 0,0
local userInput={}
function userInput:GetFocusedTextBox()return if config.focus then {} else nil end
function userInput:IsKeyDown(key)return held[key]==true end
function userInput:IsMouseButtonPressed(key)return held[key]==true end
function userInput:CreateVirtualInput()
 inputRequests+=1
 if config.inputUnavailable then return nil end
 creates+=1;local serial=creates;local input={}
 function input:SendKey(pressed,key,repeated)
  assert(repeated==false);effects[#effects+1]={kind="key",key=key,pressed=pressed,object=serial}
  if not pressed and config.releaseError then error("fixture release failed")end
  held[key]=pressed
  if pressed and (key=="E" or key=="F")and not config.noInteraction then status.Visible=true;status.Text="Open"end
  if pressed and (key=="E" or key=="F")and not config.noInteraction then updateAttribute("input")end
  if pressed and config.pressError then error("fixture press ACK failed after effect")end
 end
 function input:SendMouseButton(position,key,pressed,repeatCount)
  assert(repeatCount==0);effects[#effects+1]={kind="mouse",key=key,pressed=pressed,object=serial,x=position.X,y=position.Y}
  if not pressed and config.releaseError then error("fixture release failed")end
  held[key]=pressed
  if pressed and not config.noInteraction then status.Visible=true;status.Text="Open"end
  if pressed and not config.noInteraction then updateAttribute("input")end
  if pressed and config.pressError then error("fixture mouse ACK failed after effect")end
 end
 return input
end
local services={RunService={IsClient=function()return true end},Players=players,Workspace=workspace,GuiService=guiService,UserInputService=userInput,
 HttpService={JSONDecode=function(_,json)assert(json==expectedJson,"fixed program passed different plan bytes");return plan end}}
function game:GetService(name)return assert(services[name],"unavailable fixture service "..name)end
local replaced,transitioned=false,false
local task={wait=function(seconds)
 now+=math.max(seconds,0.001)
 updateAttribute("wait")
 if held.W and not config.immobile then root.Position=root.Position+vector(0,0,seconds*16)end
 if config.externalTransition and not transitioned then
  transitioned=true;status.Visible=true;status.Text="Open";root.Position=root.Position+vector(0,0,2)
 end
 if config.layout and config.layout.settle then layoutTarget.AbsoluteSize=vector(config.layout.width or 200,config.layout.height or 50)end
 if not basisChanged and config.changeBasis and (not config.changeDuringMouse or held.MouseButton1)then
  basisChanged=true
  if config.changeBasis=="viewport"then workspace.CurrentCamera.ViewportSize=vector(801,600)
  elseif config.changeBasis=="camera"then workspace.CurrentCamera={ViewportSize=vector(800,600)}end
  if config.changeBasis=="service"then services.GuiService={GetInsetArea=guiService.GetInsetArea,GetGuiInset=guiService.GetGuiInset}end
 end
 if not replaced and config.replace and (not config.replaceDuringMouse or held.MouseButton1)then
  replaced=true
  if config.replace=="player"then players.LocalPlayer=node("ReplacementPlayer","Player",players)
  elseif config.replace=="character" then player.Character=node("ReplacementCharacter","Model",workspace)
  elseif config.replace=="gui" then gui.Parent=nil;node("PlayerGui","PlayerGui",player)
  elseif config.replace=="layout-ancestor"then layoutFrame.Parent=nil;node("Layout","Frame",hud)
  elseif config.replace=="layout-target"then layoutTarget.Parent=nil;node("Target","TextButton",layoutFrame)
  else status.Parent=nil;local replacement=node("Status","TextLabel",hud);replacement.Visible=true;replacement.Text="Open"end
 end
end}
local report=(function()
${program}
end)()
local function encode(value,array)
 if type(value)=="boolean" or type(value)=="number" then return tostring(value)end
 if type(value)=="string"then return '"'..value:gsub('\\','\\\\'):gsub('"','\\"'):gsub('\n','\\n'):gsub('\r','\\r')..'"'end
 if type(value)=="nil"then return "null"end
 local parts={}
 if array or #value>0 then for _,item in ipairs(value)do parts[#parts+1]=encode(item)end;return "["..table.concat(parts,",").."]"end
 for key,item in pairs(value)do parts[#parts+1]=encode(key)..":"..encode(item,key=="clips")end
 return "{"..table.concat(parts,",").."}"
end
local anyHeld=false;for _,value in pairs(held)do if value then anyHeld=true end end
print(encode({report=report,effects=effects,inputRequests=inputRequests,creates=creates,held=anyHeld}))
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
export const fixtureLayoutScenario=():ScenarioPlan=>scenarioPlanSchema.parse({version:1,runtimeBudgetMs:300,
  targets:[{id:'layout',root:'LocalPlayer.PlayerGui',segments:['Hud','Layout','Target'],className:'TextButton'}],
  steps:[{id:'layout-fit',kind:'assert-gui-layout',targetId:'layout',minimumWidth:120,minimumHeight:40,withinMs:100}],capture:{required:false}});
