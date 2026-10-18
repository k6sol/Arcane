import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const modules = ['Validation', 'Registry', 'Properties', 'Operations'];

// Engine doubles owned by this harness: UDim/UDim2/Font/Vector2 and the sequence value types, the GUI enums,
// GuiObject/LayerCollector class checks and engine coercion (fixture.coerceGui). They do not certify Roblox.
const engineFixture = `
local function f32(value: number): number
  local scratch = buffer.create(4)
  buffer.writef32(scratch, 0, value)
  return buffer.readf32(scratch, 0)
end
local function typed(kind: string, value: any): any rawset(value, "_type", kind); return value end
Vector3 = {new = function(x: number, y: number, z: number): any return typed("Vector3", triple(x, y, z)) end}
Color3 = {new = function(r: number, g: number, b: number): any return typed("Color3", triple(r, g, b)) end}
local Vector2: any = {new = function(x: number, y: number): any
  return setmetatable({X = f32(x), Y = f32(y), _type = "Vector2"}, {__eq = function(a: any, b: any): boolean return a.X == b.X and a.Y == b.Y end})
end}
local UDim: any = {new = function(scale: number, offset: number): any
  assert(offset % 1 == 0, "UDim offsets are int32")
  return setmetatable({Scale = f32(scale), Offset = offset, _type = "UDim"}, {__eq = function(a: any, b: any): boolean return a.Scale == b.Scale and a.Offset == b.Offset end})
end}
local UDim2: any = {new = function(xs: number, xo: number, ys: number, yo: number): any return {X = UDim.new(xs, xo), Y = UDim.new(ys, yo), _type = "UDim2"} end}
local Font: any = {new = function(family: string, weight: any, style: any): any
  assert(type(family) == "string" and #family > 0, "explicit fixture family")
  return {Family = family, Weight = weight, Style = style, _type = "Font"}
end}
local NumberSequenceKeypoint: any = {new = function(t: number, v: number, e: number?): any return {Time = f32(t), Value = f32(v), Envelope = f32(e or 0)} end}
local ColorSequenceKeypoint: any = {new = function(t: number, c: any): any return {Time = f32(t), Value = c} end}
local NumberSequence: any = {new = function(points: {any}): any return {Keypoints = points, _type = "NumberSequence"} end}
local ColorSequence: any = {new = function(points: {any}): any return {Keypoints = points, _type = "ColorSequence"} end}
local NumberRange: any = {new = function(low: number, high: number): any return {Min = f32(low), Max = f32(high), _type = "NumberRange"} end}
local function typeof(value: any): string
  if type(value) == "table" and value._enumItem == true then return "EnumItem" end
  if type(value) == "table" and type(rawget(value, "_type")) == "string" then return rawget(value, "_type") end
  return nativeTypeof(value)
end
for name, items in pairs({NormalId = {"Right", "Top", "Back", "Left", "Bottom", "Front"}, AutomaticSize = {"None", "X", "Y", "XY"},
  TextXAlignment = {"Left", "Center", "Right"}, TextYAlignment = {"Top", "Center", "Bottom"}, TextTruncate = {"None", "AtEnd"},
  Font = {"SourceSans", "SourceSansBold", "Gotham", "GothamBold", "BuilderSans", "BuilderSansBold", "FredokaOne", "Arcade", "Unknown"},
  FontWeight = {"Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Heavy"}, FontStyle = {"Normal", "Italic"},
  ScaleType = {"Stretch", "Slice", "Tile", "Fit", "Crop"}, ZIndexBehavior = {"Global", "Sibling"},
  ScreenInsets = {"None", "DeviceSafeInsets", "CoreUISafeInsets", "TopbarSafeInsets"}, SurfaceGuiSizingMode = {"FixedSize", "PixelsPerStud"},
  ScrollingDirection = {"X", "Y", "XY"}, ScrollBarInset = {"None", "ScrollBar", "Always"}, ApplyStrokeMode = {"Contextual", "Border"},
  LineJoinMode = {"Round", "Bevel", "Miter"}, FillDirection = {"Horizontal", "Vertical"}, HorizontalAlignment = {"Left", "Center", "Right"},
  VerticalAlignment = {"Top", "Center", "Bottom"}, SortOrder = {"LayoutOrder", "Name"}, StartCorner = {"TopLeft", "TopRight", "BottomLeft", "BottomRight"},
  AspectType = {"FitWithinMaxSize", "ScaleWithParentSize"}, DominantAxis = {"Width", "Height"}, UIFlexMode = {"None", "Grow", "Shrink", "Fill", "Custom"},
  UIFlexAlignment = {"None", "Fill", "SpaceAround", "SpaceBetween", "SpaceEvenly"}, ItemLineAlignment = {"Automatic", "Start", "Center", "End", "Stretch"}}) do Enum[name] = enumCategory(items) end
local guiObjects = {"Frame", "CanvasGroup", "ScrollingFrame", "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton", "ViewportFrame"}
local layers = {"ScreenGui", "SurfaceGui", "BillboardGui"}
local baseIsA = methods.IsA
function methods:IsA(name: string): boolean
  if name == "GuiObject" then return table.find(guiObjects, self.ClassName) ~= nil end
  if name == "LayerCollector" then return table.find(layers, self.ClassName) ~= nil end
  return baseIsA(self, name)
end
local engineSetter = instanceMetatable.__newindex
instanceMetatable.__newindex = function(self: any, key: string, value: any): ()
  if string.sub(key, 1, 1) == "_" then rawset(self, key, value); return end
  if fixture.coerceGui and fixture.coerceGui[key] ~= nil then value = fixture.coerceGui[key] end
  if fixture.guiSetter then value = fixture.guiSetter(self, key, value) end
  engineSetter(self, key, value)
  if fixture.guiAssigned then fixture.guiAssigned(self, key, value) end
end
`;

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-gui-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`),
    ]);
    sources.splice(1, 0, engineFixture);
    const harness = path.join(directory, 'gui.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
    if (compile) {
      const compiled = spawnSync(compile, ['--null', harness], { encoding: 'utf8', timeout: 10000 });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, marker);
    process.stdout.write(result.stdout);
  } finally {
    assert.ok(path.basename(directory).startsWith('arcane-gui-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const json = value => JSON.stringify(JSON.stringify(value));
const c3 = value => ({ type: 'Color3', value }), u2 = (...value) => ({ type: 'UDim2', value }), u = (...value) => ({ type: 'UDim', value });
const v2 = value => ({ type: 'Vector2', value }), v3 = value => ({ type: 'Vector3', value });
/** Wire-form screen: a ScreenGui root, a centred panel with corner/stroke/padding/list layout, a title and a styled
 * button prototype (TextButton + UICorner + UIStroke + UIGradient + UIScale) stamped four times with its own text. */
const menuBuild = {
  parent: '__PARENT__', container: { className: 'ScreenGui', name: 'MainMenu', properties: { ResetOnSpawn: false, ZIndexBehavior: 'Sibling', IgnoreGuiInset: true } },
  prototypes: [{ name: 'Button', gui: [
    { className: 'TextButton', name: 'Button', properties: { Size: u2(1, 0, 0, 48), BackgroundColor3: c3([0.145, 0.388, 0.922]), AutoButtonColor: false, Text: 'Button',
      TextColor3: c3([1, 1, 1]), TextSize: 22, FontFace: { type: 'Font', family: 'BuilderSans', weight: 'Bold' } } },
    { className: 'UICorner', name: 'Corner', parent: 1, properties: { CornerRadius: u(0, 10) } },
    { className: 'UIStroke', name: 'Stroke', parent: 1, properties: { Color: c3([0.18, 0.22, 0.28]), Thickness: 1.5, ApplyStrokeMode: 'Border' } },
    { className: 'UIGradient', name: 'Sheen', parent: 1, properties: { Rotation: 90, Color: { type: 'ColorSequence', value: [[0, 1, 1, 1], [1, 0.85, 0.85, 0.85]] } } },
    { className: 'UIScale', name: 'Scale', parent: 1, properties: { Scale: 1 } },
  ] }],
  items: [
    { kind: 'gui', className: 'Frame', name: 'Root', parent: 0, key: 'Root', properties: { AnchorPoint: v2([0.5, 0.5]), Position: u2(0.5, 0, 0.5, 0),
      Size: u2(0.32, 0, 0.6, 0), BackgroundColor3: c3([0.102, 0.122, 0.169]), BackgroundTransparency: 0.05, ClipsDescendants: true } },
    { kind: 'gui', className: 'UICorner', name: 'Corner', parent: 1, properties: { CornerRadius: u(0, 12) } },
    { kind: 'gui', className: 'UIPadding', name: 'Padding', parent: 1, properties: { PaddingTop: u(0, 16), PaddingBottom: u(0, 16), PaddingLeft: u(0, 16), PaddingRight: u(0, 16) } },
    { kind: 'gui', className: 'UIListLayout', name: 'List', parent: 1, properties: { Padding: u(0, 12), SortOrder: 'LayoutOrder', HorizontalAlignment: 'Center' } },
    { kind: 'gui', className: 'UISizeConstraint', name: 'Bounds', parent: 1, properties: { MinSize: v2([320, 240]), MaxSize: v2([460, 520]) } },
    { kind: 'gui', className: 'TextLabel', name: 'Title', parent: 1, key: 'Title', properties: { Text: 'Arcane Quest', TextScaled: true, Size: u2(1, 0, 0, 64),
      BackgroundTransparency: 1, LayoutOrder: 0, TextXAlignment: 'Center', FontFace: { type: 'Font', family: 'Montserrat', weight: 'Bold' }, TextColor3: c3([0.949, 0.957, 0.973]) } },
    { kind: 'gui', className: 'UITextSizeConstraint', name: 'TitleSize', parent: 6, properties: { MinTextSize: 24, MaxTextSize: 64 } },
    { kind: 'stamp', template: 1, name: 'PlayButton', parent: 1, key: 'Play', properties: { Text: 'Play', LayoutOrder: 1, Size: u2(1, 0, 0, 58) } },
    { kind: 'stamp', template: 1, name: 'ShopButton', parent: 1, key: 'Shop', properties: { Text: 'Shop', LayoutOrder: 2 } },
    { kind: 'stamp', template: 1, name: 'SettingsButton', parent: 1, properties: { Text: 'Settings', LayoutOrder: 3 } },
    { kind: 'stamp', template: 1, name: 'CreditsButton', parent: 1, properties: { Text: 'Credits', LayoutOrder: 4, Font: 'GothamBold', FontFace: undefined } },
    { kind: 'gui', className: 'ImageLabel', name: 'Logo', parent: 0, properties: { Image: 'rbxassetid://1234567', ScaleType: 'Fit', Size: u2(0, 128, 0, 128), BackgroundTransparency: 1 } },
  ],
};
// The last stamp switches to a legacy Font: that conflicts with the prototype root FontFace and must be refused.
const fontConflict = structuredClone(menuBuild);
const goodMenu = structuredClone(menuBuild);
delete goodMenu.items[10].properties.Font; delete goodMenu.items[10].properties.FontFace;
const responsiveMenu = structuredClone(goodMenu);
responsiveMenu.prototypes[0].gui.push({className:'UIFlexItem',name:'Flex',parent:1,properties:{FlexMode:'Custom',GrowRatio:2,ShrinkRatio:0.5,ItemLineAlignment:'Stretch'}});
Object.assign(responsiveMenu.items[3],{key:'FlexList',properties:{Wraps:true,FillDirection:'Horizontal',HorizontalFlex:'SpaceBetween',ItemLineAlignment:'Center'}});
/** World GUIs: a BillboardGui nameplate prototype stamped onto two parts and a SurfaceGui sign. */
const worldBuild = {
  parent: '__PARENT__', container: { className: 'Model', name: 'Stalls' },
  prototypes: [{ name: 'Nameplate', gui: [
    { className: 'BillboardGui', name: 'Nameplate', properties: { Size: u2(0, 200, 0, 50), StudsOffset: v3([0, 3, 0]), AlwaysOnTop: true, MaxDistance: 80 } },
    { className: 'TextLabel', name: 'Label', parent: 1, properties: { Size: u2(1, 0, 1, 0), BackgroundTransparency: 1, Text: 'Stall', TextScaled: true } },
  ] }],
  items: [
    { kind: 'part', className: 'Part', name: 'StallA', parent: 0, properties: { Size: v3([4, 1, 4]), Position: v3([0, 0.5, 0]), Anchored: true } },
    { kind: 'part', className: 'Part', name: 'StallB', parent: 0, properties: { Size: v3([4, 1, 4]), Position: v3([8, 0.5, 0]), Anchored: true } },
    { kind: 'stamp', template: 1, name: 'Nameplate', parent: 1, key: 'PlateA', properties: { MaxDistance: 120 } },
    { kind: 'stamp', template: 1, name: 'Nameplate', parent: 2 },
    { kind: 'gui', className: 'SurfaceGui', name: 'Sign', parent: 1, key: 'Sign', properties: { Face: 'Front', SizingMode: 'PixelsPerStud', PixelsPerStud: 50, LightInfluence: 0 } },
    { kind: 'gui', className: 'TextLabel', name: 'SignText', parent: 5, properties: { Size: u2(1, 0, 1, 0), Text: 'Fresh fruit', TextWrapped: true, TextSize: 40 } },
  ],
};

const checks = `
local V = Validation
local checks, serial = 0, 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local workspace = game:GetService("Workspace")
local starterGui = game:GetService("StarterGui")
local ops = Operations.new({sessionId = "gui-session", allowedRoots = {"Workspace", "StarterGui"}}, game, http)
local function run(method: string, args: any): (any, string)
  serial += 1
  local id = "gui-" .. serial
  return ops:execute({id = id, method = method, args = args}, function() end), id
end
local function refuses(code: string, callback: () -> any, text: string?): any
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
  if text then check(string.find(err.message, text, 1, true) ~= nil, "message names: " .. text .. " / " .. err.message) end
  return err
end
local function near(a: number, b: number): boolean return math.abs(a - b) < 1e-4 end
local starterRef = ops.registry:ref(starterGui)
local function create(className: string, properties: any, parent: any): any
  return run("scene.create", {parent = parent, className = className, name = className, properties = properties})
end
local function u2(xs: number, xo: number, ys: number, yo: number): any return {type = "UDim2", value = V.array({xs, xo, ys, yo})} end

-- 1. scene.create: a ScreenGui in StarterGui, then a Frame, a TextLabel and modifiers inside it; every value verified.
check(table.find(V.FEATURE_CAPABILITIES, "scene.gui") ~= nil, "plugin advertises scene.gui")
check(table.find(V.FEATURE_CAPABILITIES, "scene.gui.flex") ~= nil, "plugin advertises scene.gui.flex")
local committed = fixture.committed
local screen = ops.registry:resolve(create("ScreenGui", {ResetOnSpawn = false, ZIndexBehavior = "Sibling", IgnoreGuiInset = true, DisplayOrder = 5}, starterRef).ref)
check(fixture.committed == committed + 1 and screen.Parent == starterGui and screen.ResetOnSpawn == false, "ScreenGui created in StarterGui")
check(screen.ZIndexBehavior == Enum.ZIndexBehavior.Sibling and screen.IgnoreGuiInset == true and screen.DisplayOrder == 5, "ScreenGui values verified")
local screenRef = ops.registry:ref(screen)
local panel = ops.registry:resolve(create("Frame", {Size = u2(0.5, 0, 0.4, 20), Position = u2(0.5, 0, 0.5, 0), AnchorPoint = {type = "Vector2", value = V.array({0.5, 0.5})},
  BackgroundColor3 = {type = "Color3", value = V.array({0.1, 0.12, 0.17})}, ZIndex = 2, LayoutOrder = 3, AutomaticSize = "Y"}, screenRef).ref)
check(panel.Parent == screen and typeof(panel.Size) == "UDim2" and near(panel.Size.X.Scale, 0.5) and panel.Size.Y.Offset == 20, "UDim2 Size")
check(near(panel.AnchorPoint.X, 0.5) and panel.AutomaticSize == Enum.AutomaticSize.Y and panel.ZIndex == 2, "AnchorPoint, AutomaticSize, ZIndex")
local panelRef = ops.registry:ref(panel)
local label = ops.registry:resolve(create("TextLabel", {Text = "Hello, café 世界", TextWrapped = true, TextXAlignment = "Left",
  FontFace = {type = "Font", family = "FredokaOne", weight = "Bold", style = "Italic"}}, panelRef).ref)
check(label.Text == "Hello, café 世界" and label.TextXAlignment == Enum.TextXAlignment.Left, "text and alignment")
check(label.FontFace.Family == "rbxasset://fonts/families/FredokaOne.json" and label.FontFace.Weight == Enum.FontWeight.Bold and label.FontFace.Style == Enum.FontStyle.Italic, "built-in FontFace")
local corner = ops.registry:resolve(create("UICorner", {CornerRadius = {type = "UDim", value = V.array({0, 12})}}, panelRef).ref)
check(corner.Parent == panel and corner.CornerRadius.Offset == 12, "UICorner radius")
local grid = ops.registry:resolve(create("UIGridLayout", {CellSize = u2(0, 96, 0, 96), CellPadding = u2(0, 8, 0, 8), StartCorner = "TopLeft", FillDirectionMaxCells = 5}, screenRef).ref)
check(grid.CellSize.X.Offset == 96 and grid.FillDirectionMaxCells == 5, "UIGridLayout on the ScreenGui")
local flexList = ops.registry:resolve(create("UIListLayout", {FillDirection = "Horizontal", Wraps = true, HorizontalFlex = "SpaceBetween", ItemLineAlignment = "Center"}, panelRef).ref)
check(flexList.Wraps == true and flexList.HorizontalFlex == Enum.UIFlexAlignment.SpaceBetween and flexList.ItemLineAlignment == Enum.ItemLineAlignment.Center, "flex UIListLayout")
local flexItem = ops.registry:resolve(create("UIFlexItem", {FlexMode = "Custom", GrowRatio = 2, ShrinkRatio = 0.5, ItemLineAlignment = "Stretch"}, ops.registry:ref(label)).ref)
check(flexItem.Parent == label and flexItem.FlexMode == Enum.UIFlexMode.Custom and near(flexItem.GrowRatio, 2) and near(flexItem.ShrinkRatio, 0.5), "UIFlexItem in a GuiObject")
local part = Instance.new("Part"); part.Parent = workspace
local partRef = ops.registry:ref(part)
local billboard = ops.registry:resolve(create("BillboardGui", {Size = u2(0, 200, 0, 50), StudsOffset = {type = "Vector3", value = V.array({0, 3, 0})}, AlwaysOnTop = true, MaxDistance = 60}, partRef).ref)
check(billboard.Parent == part and billboard.Size.X.Offset == 200 and near(billboard.StudsOffset.Y, 3) and near(billboard.MaxDistance, 60), "BillboardGui on a part")
local surface = ops.registry:resolve(create("SurfaceGui", {Face = "Top", SizingMode = "PixelsPerStud", PixelsPerStud = 40}, partRef).ref)
check(surface.Face == Enum.NormalId.Top and surface.SizingMode == Enum.SurfaceGuiSizingMode.PixelsPerStud and near(surface.PixelsPerStud, 40), "SurfaceGui placement")

-- 2. Refusals before any allocation: hosts, text, ids, fonts, bounds and cross-field rules.
local allocations = #fixture.created
refuses("CLASS", function() return create("Frame", {}, starterRef) end)
refuses("CLASS", function() return create("ScreenGui", {}, partRef) end)
refuses("CLASS", function() return create("UICorner", {}, screenRef) end)
refuses("CLASS", function() return create("UIFlexItem", {}, screenRef) end)
refuses("PROPERTY", function() return create("UIFlexItem", {FlexMode = "Stretch"}, panelRef) end)
refuses("INPUT", function() return create("UIFlexItem", {GrowRatio = 101}, panelRef) end, "GrowRatio")
refuses("CLASS", function() return create("TextLabel", {}, partRef) end)
refuses("CLASS", function() return create("SurfaceGui", {}, panelRef) end)
for _, bad in ipairs({"line\\nbreak", "tab\\there", "bell\\7", "del\\127", "c1\\194\\133", string.rep("x", 2001)}) do
  refuses("PROPERTY", function() return create("TextLabel", {Text = bad}, panelRef) end)
end
for _, bad in ipairs({"http://example.com/a.png", "rbxasset://fonts/arial.ttf", "rbxassetid://0", "rbxthumb://type=Asset&id=1"}) do
  refuses("PROPERTY", function() return create("ImageLabel", {Image = bad}, panelRef) end)
end
refuses("PROPERTY", function() return create("TextLabel", {FontFace = {type = "Font", family = "../../evil"}}, panelRef) end)
refuses("PROPERTY", function() return create("TextLabel", {FontFace = {type = "Font", family = "Comic"}}, panelRef) end)
refuses("PROPERTY", function() return create("TextLabel", {FontFace = {type = "Font", family = "Roboto", weight = "Black"}}, panelRef) end)
refuses("PROPERTY", function() return create("TextLabel", {Font = "Gotham", FontFace = {type = "Font", family = "Roboto"}}, panelRef) end, "not both")
refuses("PROPERTY", function() return create("TextLabel", {Font = "Wingdings"}, panelRef) end)
refuses("INPUT", function() return create("Frame", {Size = u2(0.5, 0.5, 0, 0)}, screenRef) end, "offset")
refuses("INPUT", function() return create("Frame", {Size = u2(11, 0, 0, 0)}, screenRef) end, "scale")
refuses("PROPERTY", function() return create("Frame", {Size = {type = "UDim2", value = V.array({1, 0, 1})}}, screenRef) end)
refuses("PROPERTY", function() return create("Frame", {Size = {type = "Vector2", value = V.array({1, 1})}}, screenRef) end)
refuses("PROPERTY", function() return create("UISizeConstraint", {MinSize = {type = "Vector2", value = V.array({500, 10})}, MaxSize = {type = "Vector2", value = V.array({400, 400})}}, panelRef) end, "MinSize")
refuses("PROPERTY", function() return create("UITextSizeConstraint", {MinTextSize = 40, MaxTextSize = 20}, ops.registry:ref(label)) end, "MinTextSize")
refuses("PROPERTY", function() return create("Frame", {Draggable = true}, screenRef) end)
refuses("PROPERTY", function() return create("TextButton", {Source = "print(1)"}, screenRef) end)
refuses("PROPERTY", function() return create("ScreenGui", {Parent = workspace}, starterRef) end)
refuses("PROPERTY", function() return create("Frame", {ZIndexBehavior = "Sibling"}, screenRef) end)
check(#fixture.created == allocations, "refused GUI payloads allocate nothing")

-- 3. Engine coercion is a clean VERIFY failure; the detached element never reaches the place.
fixture.coerceGui = {TextSize = 10}
local children = #panel:GetChildren()
refuses("VERIFY", function() return create("TextLabel", {TextSize = 30}, panelRef) end, "TextLabel.TextSize")
fixture.coerceGui = {Size = UDim2.new(0.5, 1, 0, 0)}
refuses("VERIFY", function() return create("Frame", {Size = u2(0.5, 0, 0, 0)}, panelRef) end, "Frame.Size")
fixture.coerceGui = nil
check(#panel:GetChildren() == children, "coerced elements are not parented")

-- 4. scene.build: a whole ScreenGui menu with a styled button prototype stamped four times, in one recording.
local function args(source: string, parent: any): any
  local value = V.decode(source, http)
  value.parent = parent
  return value
end
committed = fixture.committed
local built, buildId = run("scene.build", args(${json(goodMenu)}, starterRef))
check(fixture.committed == committed + 1, "one recording")
check(built.created.count == 1 + 7 + 4 * 5 + 1, "root + 7 elements + 4 stamps of 5 + logo")
check(built.created.classes.TextButton == 4 and built.created.classes.UICorner == 5 and built.created.classes.ScreenGui == 1, "class histogram")
local menu = ops.registry:resolve(built.ref)
check(menu.ClassName == "ScreenGui" and menu.Parent == starterGui and menu.ResetOnSpawn == false and menu.IgnoreGuiInset == true, "ScreenGui root and its properties")
local root = ops.registry:resolve(built.refs.Root)
local play = ops.registry:resolve(built.refs.Play)
local shop = ops.registry:resolve(built.refs.Shop)
check(root.Parent == menu and play.Parent == root and shop.Parent == root, "stamps parented in the panel")
check(play.Text == "Play" and play.LayoutOrder == 1 and play.Size.Y.Offset == 58 and shop.Text == "Shop" and shop.Size.Y.Offset == 48, "per-stamp overrides over prototype values")
check(play.AutoButtonColor == false and play.FontFace.Weight == Enum.FontWeight.Bold and near(play.BackgroundColor3.B, 0.922), "prototype root values")
local kids = {}
for _, child in ipairs(play:GetChildren()) do kids[child.Name] = child end
check(kids.Corner and kids.Corner.CornerRadius.Offset == 10 and kids.Stroke.ApplyStrokeMode == Enum.ApplyStrokeMode.Border and kids.Scale and near(kids.Scale.Scale, 1), "stamped prototype children")
check(typeof(kids.Sheen.Color) == "ColorSequence" and near(kids.Sheen.Rotation, 90), "UIGradient")
local title = ops.registry:resolve(built.refs.Title)
check(title.FontFace.Family == "rbxasset://fonts/families/Montserrat.json" and title.TextScaled and title:GetChildren()[1].MaxTextSize == 64, "title with text-size constraint")
local restored = run("scene.restore", {receiptCommandId = buildId, mutation = built.mutation})
check(restored.restored and menu.Parent == nil, "restore removes the unchanged GUI build")

-- 5. Build refusals happen before any allocation.
allocations = #fixture.created
refuses("PROPERTY", function() return run("scene.build", args(${json(fontConflict)}, starterRef)) end, "not both")
local partAtRoot = args(${json(goodMenu)}, starterRef)
partAtRoot.items[12] = {kind = "part", className = "Part", name = "Brick", parent = 0}
refuses("INPUT", function() return run("scene.build", partAtRoot) end, "only gui and stamp")
local fxInFrame = args(${json(goodMenu)}, starterRef)
fxInFrame.items[12] = {kind = "effect", className = "PointLight", name = "Glow", parent = 1}
refuses("INPUT", function() return run("scene.build", fxInFrame) end)
local cornerAtRoot = args(${json(goodMenu)}, starterRef)
cornerAtRoot.items[2].parent = 0
refuses("INPUT", function() return run("scene.build", cornerAtRoot) end, "UICorner")
local placedGui = args(${json(goodMenu)}, starterRef)
placedGui.items[12] = {kind = "place", template = 1, name = "X", parent = 0, at = V.array({0, 0, 0}), yaw = 0, scale = 1, tint = V.NULL}
refuses("INPUT", function() return run("scene.build", placedGui) end)
local badPrototype = args(${json(goodMenu)}, starterRef)
badPrototype.prototypes[1].gui[2].parent = 0
refuses("INPUT", function() return run("scene.build", badPrototype) end, "prototype root")
refuses("CLASS", function() return run("scene.build", args(${json(goodMenu)}, partRef)) end, "ScreenGui")
local rootProps = args(${json(worldBuild)}, ops.registry:ref(workspace))
rootProps.container.properties = {ResetOnSpawn = false}
refuses("INPUT", function() return run("scene.build", rootProps) end)
check(#fixture.created == allocations, "refused GUI builds allocate nothing")
fixture.coerceGui = {Thickness = 3}
local before = #starterGui:GetChildren()
refuses("VERIFY", function() return run("scene.build", args(${json(goodMenu)}, starterRef)) end, "UIStroke.Thickness")
fixture.coerceGui = nil
check(#starterGui:GetChildren() == before, "a coerced stamp leaves StarterGui untouched")

-- 6. World GUIs: a BillboardGui prototype stamped onto parts and a SurfaceGui sign, inside a Model build.
local world = run("scene.build", args(${json(worldBuild)}, ops.registry:ref(workspace)))
check(world.created.count == 1 + 2 + 2 * 2 + 2, "root + parts + two nameplates + sign")
local plate = ops.registry:resolve(world.refs.PlateA)
check(plate.ClassName == "BillboardGui" and plate.Parent.Name == "StallA" and near(plate.MaxDistance, 120) and plate.AlwaysOnTop, "nameplate override on a part")
check(plate:GetChildren()[1].Text == "Stall", "nameplate label")
local sign = ops.registry:resolve(world.refs.Sign)
check(sign.Face == Enum.NormalId.Front and sign:GetChildren()[1].Text == "Fresh fruit", "SurfaceGui sign")

-- 7. Restore protects later GUI changes, including changes smaller than post-assignment tolerances.
local flexResult, flexReceipt = create("UIFlexItem", {FlexMode = "Custom", GrowRatio = 2, ShrinkRatio = 0.5}, panelRef)
local directFlex = ops.registry:resolve(flexResult.ref)
directFlex.GrowRatio = 2.00001
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = flexReceipt, mutation = flexResult.mutation}) end)
check(directFlex.Parent == panel, "manual flex edit remains in the place")
directFlex.GrowRatio = 2
check(run("scene.restore", {receiptCommandId = flexReceipt, mutation = flexResult.mutation}).restored, "unchanged flex element restores")

local gradientResult, gradientReceipt = create("UIGradient", {Transparency = {type = "NumberSequence", value = V.array({V.array({0, 0}), V.array({1, 1})})}}, panelRef)
local gradient = ops.registry:resolve(gradientResult.ref)
gradient.Transparency = NumberSequence.new({NumberSequenceKeypoint.new(0, 0), NumberSequenceKeypoint.new(1, 0.99999)})
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = gradientReceipt, mutation = gradientResult.mutation}) end)
gradient.Transparency = NumberSequence.new({NumberSequenceKeypoint.new(0, 0), NumberSequenceKeypoint.new(1, 1)})
check(run("scene.restore", {receiptCommandId = gradientReceipt, mutation = gradientResult.mutation}).restored, "structurally equal immutable sequence restores")

local responsive, responsiveReceipt = run("scene.build", args(${json(responsiveMenu)}, starterRef))
local responsiveRoot = ops.registry:resolve(responsive.ref)
local layout = ops.registry:resolve(responsive.refs.FlexList)
local button = ops.registry:resolve(responsive.refs.Play)
local grow = nil
for _, child in ipairs(button:GetChildren()) do if child.Name == "Flex" then grow = child end end
check(responsive.created.count == 1 + 7 + 4 * 6 + 1 and grow ~= nil, "flex prototype stamped into each button")
check(layout.Wraps and layout.HorizontalFlex == Enum.UIFlexAlignment.SpaceBetween and near(grow.GrowRatio, 2), "batch flex values are applied")
local function refusesResponsiveRestore(): ()
  refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = responsiveReceipt, mutation = responsive.mutation}) end)
  check(responsiveRoot.Parent == starterGui, "changed GUI build remains in the place")
end
layout.Wraps = false; refusesResponsiveRestore(); layout.Wraps = true
grow.GrowRatio = 2.00001; refusesResponsiveRestore(); grow.GrowRatio = 2
button.Text = "Manual edit"; refusesResponsiveRestore(); button.Text = "Play"
layout._attributes.ManualReview = true; refusesResponsiveRestore(); layout._attributes.ManualReview = nil
layout._tags = {"ManualReview"}; refusesResponsiveRestore(); layout._tags = nil
check(run("scene.restore", {receiptCommandId = responsiveReceipt, mutation = responsive.mutation}).restored and responsiveRoot.Parent == nil, "unchanged responsive hierarchy restores")

-- 8. Inspection returns native GUI types as exact JSON values, without creation-time rounding.
local observed = run("scene.inspect", {ref = panelRef}).properties
check(observed.Size.type == "UDim2" and observed.Position.type == "UDim2", "GUI dimensions retain their native types")
check(observed.Size.value[1] == panel.Size.X.Scale and observed.Size.value[2] == panel.Size.X.Offset, "GUI dimensions use exact engine readback")
check(observed.AnchorPoint.type == "Vector2" and observed.BackgroundColor3.type == "Color3", "GUI vectors and colours are tagged")
check(observed.Name == panel.Name, "GUI properties retain the observed name")
local faceLabel = ops.registry:resolve(create("TextLabel", {Text = "Observed", Size = u2(0.25, 5, 0.1, 6), Position = u2(0, 0, 0, 0),
  FontFace = {type = "Font", family = "BuilderSans", weight = "SemiBold", style = "Italic"}}, panelRef).ref)
faceLabel.Font = Enum.Font.Gotham
faceLabel.TextSize = 150.25 -- Existing native values are observations, not new-write intake.
local face = run("scene.inspect", {ref = ops.registry:ref(faceLabel)}).properties
check(face.TextSize == 150.25 and face.Font == "Gotham", "observations preserve numbers and enum names exactly")
check(face.FontFace.type == "Font" and face.FontFace.family == faceLabel.FontFace.Family and face.FontFace.weight == "SemiBold" and face.FontFace.style == "Italic", "font observation retains the full native family")
local observedGradient = ops.registry:resolve(create("UIGradient", {Offset = {type = "Vector2", value = V.array({0.25, -0.5})},
  Color = {type = "ColorSequence", value = V.array({V.array({0, 0.1, 0.2, 0.3}), V.array({1, 0.8, 0.7, 0.6})})},
  Transparency = {type = "NumberSequence", value = V.array({V.array({0, 0.125, 0}), V.array({1, 0.875, 0.05})})}}, panelRef).ref)
local sequences = run("scene.inspect", {ref = ops.registry:ref(observedGradient)}).properties
check(sequences.Color.type == "ColorSequence" and sequences.Transparency.type == "NumberSequence", "gradient sequences are tagged")
check(sequences.Color.value[1][2] == observedGradient.Color.Keypoints[1].Value.R and sequences.Transparency.value[2][3] == observedGradient.Transparency.Keypoints[2].Envelope, "sequence channels and envelopes remain exact")
local roundTrip = V.decode(V.encode(sequences, http), http)
check(V.equal(roundTrip, sequences), "GUI observations survive actual protocol JSON encoding")
local radius = run("scene.inspect", {ref = ops.registry:ref(corner)}).properties.CornerRadius
check(radius.type == "UDim" and radius.value[1] == corner.CornerRadius.Scale and radius.value[2] == 12, "UDim observations retain scale and whole pixels")
local flexObserved = run("scene.inspect", {ref = ops.registry:ref(flexList)}).properties
check(flexObserved.Wraps == true and flexObserved.HorizontalFlex == "SpaceBetween", "boolean and enum observations remain plain JSON")
local billboard = run("scene.inspect", {ref = world.refs.PlateA}).properties
check(billboard.StudsOffset.type == "Vector3" and billboard.Size.type == "UDim2", "world GUI values retain their native types")


-- 9. Existing GUI edits use exact observed baselines and selective receipt restoration.
local function editGui(instance: any, properties: any): (any, string)
  local selected = {}; for name in pairs(properties) do selected[name] = true end
  if properties.Font ~= nil or properties.FontFace ~= nil then selected.Font, selected.FontFace = true, true end
  if instance.ClassName == "UISizeConstraint" and (properties.MinSize ~= nil or properties.MaxSize ~= nil) then selected.MinSize, selected.MaxSize = true, true end
  if instance.ClassName == "UITextSizeConstraint" and (properties.MinTextSize ~= nil or properties.MaxTextSize ~= nil) then selected.MinTextSize, selected.MaxTextSize = true, true end
  local names = {}; for name in pairs(selected) do table.insert(names, name) end
  return run("scene.update", {ref = ops.registry:ref(instance), expected = Properties.snapshotGui(instance, names), properties = properties})
end
local changed, changedId = editGui(faceLabel, {TextSize = 24, Text = "Edited"})
check(faceLabel.TextSize == 24 and faceLabel.Text == "Edited", "existing text properties update")
check(changed.mutation.before.properties.TextSize == 150.25 and changed.mutation.after.properties.TextSize == 24, "receipt retains exact native before and after values")
faceLabel.TextSize = 24.00001
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = changedId, mutation = changed.mutation}) end)
faceLabel.TextSize = 24
faceLabel.BackgroundTransparency = 0.75
check(run("scene.restore", {receiptCommandId = changedId, mutation = changed.mutation}).restored and faceLabel.TextSize == 150.25 and faceLabel.BackgroundTransparency == 0.75, "restoration retains an out-of-intake baseline and preserves unrelated later edits")
local sizeChange, sizeId = editGui(panel, {Size = u2(0.75, 17, 0.6, -9), BackgroundColor3 = {type = "Color3", value = V.array({0.2, 0.3, 0.4})}})
check(panel.Size.X.Offset == 17 and sizeChange.mutation.after.properties.Size.type == "UDim2", "GUI size and colour updates use native typed values")
check(run("scene.restore", {receiptCommandId = sizeId, mutation = sizeChange.mutation}).restored and panel.Size.X.Scale == 0.5, "GUI size restoration uses canonical observed values")
local untouched = fixture.writes
refuses("CONFLICT", function() return run("scene.update", {ref = panelRef, expected = {Size = u2(0.5000001, 0, 0.4, 20)}, properties = {Size = u2(0.6, 0, 0.4, 20)}}) end)
check(fixture.writes == untouched, "nearby stale GUI baseline makes no writes")
local oldSize = Properties.snapshotGui(panel, {"Size"})
fixture.historyHook = function() panel.Size = UDim2.new(0.55, 0, 0.4, 20) end
refuses("CONFLICT", function() return run("scene.update", {ref = panelRef, expected = oldSize, properties = {Size = u2(0.6, 0, 0.4, 20)}}) end)
fixture.historyHook = nil
check(near(panel.Size.X.Scale, 0.55), "a later edit during undo setup remains intact")

-- Font aliases are linked by this explicit engine double. A custom face must restore through FontFace.
fixture.guiAssigned = function(item: any, key: string, value: any): ()
  if key == "Font" then item._properties.FontFace = Font.new("rbxasset://fonts/families/" .. value.Name .. ".json", Enum.FontWeight.Regular, Enum.FontStyle.Normal)
  elseif key == "FontFace" then item._properties.Font = Enum.Font.Unknown end
end
faceLabel.FontFace = Font.new("rbxassetid://123", Enum.FontWeight.SemiBold, Enum.FontStyle.Italic)
local fontChange, fontId = editGui(faceLabel, {Font = "Gotham"})
check(fontChange.mutation.before.properties.FontFace.family == "rbxassetid://123" and fontChange.mutation.before.properties.Font == "Unknown", "font receipt retains the native face rather than a non-restorable Unknown alias")
faceLabel.FontFace = Font.new("rbxassetid://456", Enum.FontWeight.Regular, Enum.FontStyle.Normal)
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = fontId, mutation = fontChange.mutation}) end)
faceLabel.Font = Enum.Font.Gotham
check(run("scene.restore", {receiptCommandId = fontId, mutation = fontChange.mutation}).restored and faceLabel.FontFace.Family == "rbxassetid://123", "font restoration retains the custom family, weight and style")
fixture.guiAssigned = nil

-- A setter fault after an earlier assignment is reverted and verified before cancelling the undo record.
local oldText, oldTransparency, beforeCancel = faceLabel.Text, faceLabel.BackgroundTransparency, fixture.cancelled
local failedOnce = false
fixture.guiSetter = function(_item: any, key: string, value: any): any
  if key == "Text" and not failedOnce then failedOnce = true; error("explicit one-shot setter fault") end
  return value
end
refuses("VERIFY", function() return editGui(faceLabel, {BackgroundTransparency = 0.25, Text = "Rejected"}) end)
fixture.guiSetter = nil
check(faceLabel.Text == oldText and faceLabel.BackgroundTransparency == oldTransparency and fixture.cancelled == beforeCancel + 1, "partial GUI setter failure restores the exact baseline and cancels only its own recording")
local coerceOnce = false
fixture.guiSetter = function(_item: any, key: string, value: any): any
  if key == "TextSize" and not coerceOnce then coerceOnce = true; return value + 2 end
  return value
end
refuses("VERIFY", function() return editGui(faceLabel, {TextSize = 22}) end)
fixture.guiSetter = nil
check(faceLabel.TextSize == 150.25, "coerced GUI assignment is reverted to the actual out-of-intake baseline")


-- 10. Coupled constraints are verified as a pair and restored without overwriting a changed opposite bound.
local vectorConstraint = ops.registry:resolve(create("UISizeConstraint", {MinSize = {type = "Vector2", value = V.array({0, 100})}, MaxSize = {type = "Vector2", value = V.array({100, 200})}}, panelRef).ref)
fixture.guiSetter = function(item: any, key: string, value: any): any
  if item == vectorConstraint then
    if key == "MinSize" then assert(value.X <= item.MaxSize.X and value.Y <= item.MaxSize.Y, "minimum assigned before the upper bound permits it")
    elseif key == "MaxSize" then assert(value.X >= item.MinSize.X and value.Y >= item.MinSize.Y, "maximum assigned before the lower bound permits it") end
  end
  return value
end
local boundsChange, boundsId = editGui(vectorConstraint, {MinSize = {type = "Vector2", value = V.array({150, 0})}, MaxSize = {type = "Vector2", value = V.array({200, 50})}})
check(vectorConstraint.MinSize.X == 150 and vectorConstraint.MaxSize.Y == 50, "mixed-axis constraint edits use a valid intermediate bound")
check(run("scene.restore", {receiptCommandId = boundsId, mutation = boundsChange.mutation}).restored and vectorConstraint.MinSize.Y == 100 and vectorConstraint.MaxSize.X == 100, "mixed-axis constraints restore both original bounds")
local beforeConstraint = fixture.writes
refuses("PROPERTY", function() return editGui(vectorConstraint, {MinSize = {type = "Vector2", value = V.array({150, 0})}}) end)
check(fixture.writes == beforeConstraint, "invalid partial constraint update is refused before any write")
local partialBounds, partialBoundsId = editGui(vectorConstraint, {MinSize = {type = "Vector2", value = V.array({10, 110})}})
vectorConstraint.MaxSize = Vector2.new(120, 220)
refuses("CONFLICT", function() return run("scene.restore", {receiptCommandId = partialBoundsId, mutation = partialBounds.mutation}) end)
vectorConstraint.MaxSize = Vector2.new(100, 200)
check(run("scene.restore", {receiptCommandId = partialBoundsId, mutation = partialBounds.mutation}).restored and vectorConstraint.MinSize.X == 0, "single-bound receipt tracks the companion bound")
fixture.guiSetter = nil
local textConstraint = ops.registry:resolve(create("UITextSizeConstraint", {MinTextSize = 10, MaxTextSize = 30}, panelRef).ref)
local textBounds, textBoundsId = editGui(textConstraint, {MinTextSize = 20, MaxTextSize = 25})
check(run("scene.restore", {receiptCommandId = textBoundsId, mutation = textBounds.mutation}).restored and textConstraint.MinTextSize == 10 and textConstraint.MaxTextSize == 30, "text constraints retain both bounds")

-- A failed revert is explicitly partial, never reported as a clean failure.
fixture.guiSetter = function(_item: any, key: string, value: any): any return if key == "TextSize" then value + 2 else value end
local partialFailure = refuses("PARTIAL", function() return editGui(faceLabel, {TextSize = 22}) end)
fixture.guiSetter = nil
check(partialFailure.unsafe == true and partialFailure.recovery.needsReconciliation and not partialFailure.recovery.rollbackVerified, "unverified GUI rollback retains reconciliation evidence")
faceLabel.TextSize = 150.25

print("Arcane GUI checks passed: " .. checks)
`;

test('GUI sources compile with the official Luau compiler', { skip: !compile }, async () => {
  for (const name of ['Properties', 'Operations', 'Validation']) {
    const result = spawnSync(compile, ['--null', path.join(repository, `plugin/src/${name}.luau`)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});

test('real Luau: GUI classes, typed bounded values, ScreenGui builds with stamped prototypes, world GUIs and refusals', { skip: !runtime }, async () => {
  await runLuau(checks, /Arcane GUI checks passed: \d+/);
});
