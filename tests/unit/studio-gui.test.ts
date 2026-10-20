import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCommandArgs, sceneBuildInstanceCount, GUI_CLASSES, GUI_PROPERTIES, GUI_HOSTS, GUI_HOST_CLASSES, FONT_FAMILIES, FONT_WEIGHTS, guiText } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, ROOTS, GUI_LIMITS, STUDIO_EFFECTS_CAPABILITY, STUDIO_GUI_CAPABILITY, STUDIO_GUI_FLEX_CAPABILITY, STUDIO_FEATURE_CAPABILITIES, type InstanceRef, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, compileGuiProps, sceneBuildShape, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { z } from 'zod';

const SESSION = 'gui-session';
const session = (gui = true, roots: StudioSession['allowedRoots'] = ['Workspace', 'StarterGui']): StudioSession => ({
  id: SESSION, protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: roots, allowWrites: true, capabilities: [...READ_METHODS, ...WRITE_METHODS, STUDIO_EFFECTS_CAPABILITY, ...(gui ? [STUDIO_GUI_CAPABILITY, STUDIO_GUI_FLEX_CAPABILITY] : [])],
  connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });
const ref = (className: string, root: InstanceRef['root'] = 'StarterGui', path: string[] = [className]): InstanceRef => ({ instanceId: 'opaque-' + className, sessionId: SESSION, root, pathSegments: path, className });
const STARTER_GUI = ref('StarterGui', 'StarterGui', []);
const create = (className: string, properties: Record<string, unknown>, parent: InstanceRef, s = session()) =>
  validateCommandArgs('scene.create', { parent, className, name: className, properties } as unknown as Record<string, Json>, s);
const u2 = (...value: number[]) => ({ type: 'UDim2', value }), u = (...value: number[]) => ({ type: 'UDim', value });

test('StarterGui stays a granted root everywhere it is pinned; GUI building adds no root and no method', () => {
  assert.ok(ROOTS.includes('StarterGui'));
  const plugin = readFileSync('plugin/src/Validation.luau', 'utf8');
  assert.match(plugin, /Validation\.ROOTS = table\.freeze\(\{"Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPlayer", "Lighting"\}\)/);
  assert.match(plugin, /FEATURE_CAPABILITIES = table\.freeze\(\{[^}]*"scene\.gui"/);
  assert.ok(STUDIO_FEATURE_CAPABILITIES.includes(STUDIO_GUI_CAPABILITY));
  assert.equal((WRITE_METHODS as readonly string[]).includes('scene.gui'), false, 'a feature capability, not a method');
  // GUI writes still need the StarterGui grant: a ref outside the session roots is refused before any GUI rule.
  assert.throws(() => create('ScreenGui', {}, STARTER_GUI, session(true, ['Workspace'])), { code: 'SCOPE' });
});

test('GUI allowlist: the plugin mirrors the exact class/property/kind/bound table, hosts, fonts and limits', { skip: !process.env.ARCANE_LUAU_BIN }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-gui-parity-'));
  try {
    const wrap = (name: string) => `local ${name} = (function()\n${readFileSync(`plugin/src/${name}.luau`, 'utf8').replace(/require\(script\.Parent\.([A-Za-z]+)\)/g, '$1')}\nend)()\n`;
    const dump = `
local function encode(value: any): string
  if type(value) == "string" then return string.format("%q", value) end
  if type(value) == "number" or type(value) == "boolean" then return tostring(value) end
  if #value > 0 or next(value) == nil then
    if #value == 1 and type(value[1]) == "string" then return encode(value[1]) end
    local parts = {}
    for _, item in ipairs(value) do table.insert(parts, encode(item)) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do table.insert(keys, key) end
  table.sort(keys)
  local parts = {}
  for _, key in ipairs(keys) do table.insert(parts, string.format("%q", key) .. ":" .. encode(value[key])) end
  return "{" .. table.concat(parts, ",") .. "}"
end
print(encode({specs = Properties.GUI_SPECS, hosts = Properties.GUI_HOSTS, provides = Properties.GUI_HOST_CLASSES, families = Properties.FONT_FAMILIES,
  weights = Properties.FONT_WEIGHTS, limits = Properties.GUI_LIMITS}))`;
    const harness = join(directory, 'parity.luau');
    writeFileSync(harness, wrap('Validation') + wrap('Properties') + dump);
    const result = spawnSync(process.env.ARCANE_LUAU_BIN!, [harness], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const plugin = JSON.parse(result.stdout.trim());
    // The dump writes one-string lists ({"boolean"}, {"part"}) as that string; normalise the TypeScript side the same way.
    const sorted = (value: unknown): unknown => Array.isArray(value) ? (value.length === 1 && typeof value[0] === 'string' ? value[0] : value.map(sorted))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sorted(v)])) : value;
    assert.deepEqual(plugin.specs, sorted(JSON.parse(JSON.stringify(GUI_PROPERTIES))));
    assert.deepEqual(plugin.hosts, sorted(JSON.parse(JSON.stringify(GUI_HOSTS))));
    assert.deepEqual(plugin.provides, sorted({ ...GUI_HOST_CLASSES }));
    assert.deepEqual(plugin.families, [...FONT_FAMILIES]);
    assert.deepEqual(plugin.weights, [...FONT_WEIGHTS]);
    assert.deepEqual(plugin.limits, sorted({ ...GUI_LIMITS }));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scene.create GUI: hosts, typed bounded values and the scene.gui capability are enforced', () => {
  assert.equal(GUI_CLASSES.length, 23);
  for (const className of ['ScreenGui', 'SurfaceGui', 'BillboardGui', 'Frame', 'ScrollingFrame', 'TextLabel', 'TextButton', 'TextBox', 'ImageLabel', 'ImageButton', 'ViewportFrame',
    'UICorner', 'UIStroke', 'UIGradient', 'UIPadding', 'UIListLayout', 'UIGridLayout', 'UIAspectRatioConstraint', 'UISizeConstraint', 'UITextSizeConstraint', 'UIScale', 'UIFlexItem'])
    assert.ok(GUI_CLASSES.includes(className as never), className);
  const screen = { ResetOnSpawn: false, IgnoreGuiInset: true, ZIndexBehavior: 'Sibling', DisplayOrder: 3, ScreenInsets: 'CoreUISafeInsets' };
  assert.deepEqual(create('ScreenGui', screen, STARTER_GUI).properties, screen);
  const frame = { Size: u2(0.5, 0, 0.4, 20), Position: u2(0.5, 0, 0.5, 0), AnchorPoint: { type: 'Vector2', value: [0.5, 0.5] }, ZIndex: 2, LayoutOrder: -3,
    AutomaticSize: 'Y', ClipsDescendants: true, BackgroundColor3: { type: 'Color3', value: [0.1, 0.1, 0.2] }, BackgroundTransparency: 0.2 };
  assert.deepEqual(create('Frame', frame, ref('ScreenGui')).properties, frame);
  assert.ok(create('TextLabel', { Text: 'Score: 10 — café 世界 🎉', TextScaled: true, TextXAlignment: 'Left', FontFace: { type: 'Font', family: 'Montserrat', weight: 'Bold', style: 'Italic' } }, ref('Frame')));
  assert.ok(create('TextButton', { Font: 'GothamBold', AutoButtonColor: false }, ref('Frame')));
  assert.ok(create('ImageLabel', { Image: 'rbxassetid://123', ScaleType: 'Fit' }, ref('Frame')));
  assert.ok(create('ImageButton', { Image: 'rbxasset://textures/ui/GuiImagePlaceholder.png' }, ref('ScreenGui')));
  assert.ok(create('ScrollingFrame', { CanvasSize: u2(0, 0, 0, 0), AutomaticCanvasSize: 'Y', ScrollBarThickness: 6, ScrollingDirection: 'Y' }, ref('ScreenGui')));
  assert.ok(create('UIGradient', { Rotation: 90, Color: { type: 'ColorSequence', value: [[0, 1, 1, 1], [1, 0.8, 0.8, 0.8]] }, Transparency: { type: 'NumberSequence', value: [[0, 0], [1, 0.5]] } }, ref('Frame')));
  assert.ok(create('UICorner', { CornerRadius: u(0.5, 0) }, ref('TextButton')));
  assert.ok(create('UIPadding', { PaddingTop: u(0, 16), PaddingLeft: u(0.05, 0) }, ref('Frame')));
  assert.ok(create('UIListLayout', { Padding: u(0, 8), SortOrder: 'LayoutOrder', FillDirection: 'Vertical' }, ref('ScreenGui')));
  assert.ok(create('UISizeConstraint', { MinSize: { type: 'Vector2', value: [320, 240] }, MaxSize: { type: 'Vector2', value: [760, 560] } }, ref('Frame')));
  assert.ok(create('UITextSizeConstraint', { MinTextSize: 14, MaxTextSize: 24 }, ref('TextLabel')));
  assert.ok(create('UIListLayout', { FillDirection: 'Horizontal', Wraps: true, HorizontalFlex: 'SpaceBetween', VerticalFlex: 'Fill', ItemLineAlignment: 'Center' }, ref('Frame')));
  assert.ok(create('UIFlexItem', { FlexMode: 'Custom', GrowRatio: 2, ShrinkRatio: 0.5, ItemLineAlignment: 'Stretch' }, ref('TextButton')));
  for (const [className, bad, parent] of [['UIFlexItem', { FlexMode: 'Stretch' }, ref('Frame')], ['UIFlexItem', { GrowRatio: 101 }, ref('Frame')],
    ['UIListLayout', { HorizontalFlex: 'Justify' }, ref('Frame')], ['UIFlexItem', {}, ref('ScreenGui')]] as const)
    assert.throws(() => create(className, bad, parent), className);
  assert.ok(create('BillboardGui', { Size: u2(0, 200, 0, 50), StudsOffset: { type: 'Vector3', value: [0, 3, 0] }, AlwaysOnTop: true, MaxDistance: 80 }, ref('Part', 'Workspace')));
  assert.ok(create('BillboardGui', {}, ref('Attachment', 'Workspace')));
  assert.ok(create('SurfaceGui', { Face: 'Front', SizingMode: 'PixelsPerStud', PixelsPerStud: 50 }, ref('Part', 'Workspace')));
  // Hosts.
  for (const [className, parent] of [['Frame', STARTER_GUI], ['ScreenGui', ref('Part', 'Workspace')], ['UICorner', ref('ScreenGui')], ['TextLabel', ref('Part', 'Workspace')],
    ['SurfaceGui', ref('Frame')], ['BillboardGui', ref('ScreenGui')], ['UIPadding', ref('SurfaceGui')], ['Frame', ref('UICorner')], ['ScreenGui', ref('StarterGui', 'StarterGui', ['Nested'])]] as const)
    assert.throws(() => create(className, {}, parent), { code: 'CLASS' }, `${className} in ${parent.className}`);
  assert.throws(() => create('ScreenGui', {}, STARTER_GUI, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => create('Frame', {}, ref('ScreenGui'), session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  // Values.
  const bad: [string, Record<string, unknown>, InstanceRef][] = [
    ['TextLabel', { Text: 'line\nbreak' }, ref('Frame')], ['TextLabel', { Text: 'tab\there' }, ref('Frame')], ['TextLabel', { Text: 'nel\u0085' }, ref('Frame')],
    ['TextLabel', { Text: 'del\u007f' }, ref('Frame')], ['TextLabel', { Text: 'x'.repeat(2001) }, ref('Frame')], ['TextLabel', { Text: 'é'.repeat(1001) }, ref('Frame')],
    ['TextLabel', { Text: 'lone \ud800' }, ref('Frame')], ['TextLabel', { Text: 7 }, ref('Frame')], ['TextBox', { PlaceholderText: 'a\rb' }, ref('Frame')],
    ['ImageLabel', { Image: 'https://example.com/a.png' }, ref('Frame')], ['ImageLabel', { Image: 'rbxasset://fonts/a.ttf' }, ref('Frame')], ['ImageLabel', { Image: 'rbxassetid://0' }, ref('Frame')],
    ['TextLabel', { FontFace: { type: 'Font', family: 'Comic' } }, ref('Frame')], ['TextLabel', { FontFace: { type: 'Font', family: '../x' } }, ref('Frame')],
    ['TextLabel', { FontFace: { type: 'Font', family: 'Roboto', weight: 'Black' } }, ref('Frame')], ['TextLabel', { FontFace: { family: 'Roboto' } }, ref('Frame')],
    ['TextLabel', { FontFace: { type: 'Font', family: 'Roboto', url: 'rbxassetid://1' } }, ref('Frame')], ['TextLabel', { Font: 'Wingdings' }, ref('Frame')],
    ['TextLabel', { Font: 'Gotham', FontFace: { type: 'Font', family: 'Roboto' } }, ref('Frame')],
    ['Frame', { Size: u2(0.5, 0.5, 0, 0) }, ref('ScreenGui')], ['Frame', { Size: u2(11, 0, 0, 0) }, ref('ScreenGui')], ['Frame', { Size: u2(0, 10001, 0, 0) }, ref('ScreenGui')],
    ['Frame', { Size: u2(1, 0, 1) }, ref('ScreenGui')], ['Frame', { Size: { type: 'Vector2', value: [1, 1] } }, ref('ScreenGui')], ['Frame', { AnchorPoint: { type: 'Vector2', value: [1.5, 0] } }, ref('ScreenGui')],
    ['Frame', { ZIndex: 1.5 }, ref('ScreenGui')], ['Frame', { AutomaticSize: 'Both' }, ref('ScreenGui')], ['Frame', { Draggable: true }, ref('ScreenGui')], ['Frame', { Parent: 'x' }, ref('ScreenGui')],
    ['TextButton', { Source: 'print(1)' }, ref('ScreenGui')], ['Frame', { ZIndexBehavior: 'Sibling' }, ref('ScreenGui')], ['UICorner', { CornerRadius: u(0, 1.5) }, ref('Frame')],
    ['UISizeConstraint', { MinSize: { type: 'Vector2', value: [500, 10] }, MaxSize: { type: 'Vector2', value: [400, 400] } }, ref('Frame')],
    ['UITextSizeConstraint', { MinTextSize: 40, MaxTextSize: 20 }, ref('TextLabel')], ['SurfaceGui', { PixelsPerStud: 0 }, ref('Part', 'Workspace')],
    ['ScreenGui', { Name: 'Renamed' }, STARTER_GUI], ['TextLabel', { RichText: true }, ref('Frame')],
  ];
  for (const [className, properties, parent] of bad) assert.throws(() => create(className, properties, parent), { code: /PROPERTY|INPUT/ }, `${className} ${JSON.stringify(properties).slice(0, 80)}`);
  assert.equal(guiText('', 'Text'), '');
  assert.equal(guiText('é'.repeat(1000), 'Text').length, 1000, '2000 UTF-8 bytes is the bound');
});

/** Compact model-facing input: a whole menu as one ScreenGui build with a styled button prototype stamped four times. */
const menuInput = (): Record<string, unknown> => ({
  name: 'MainMenu', container: 'ScreenGui', screen: { IgnoreGuiInset: true },
  prototypes: { Button: { ui: [
    { name: 'Button', className: 'TextButton', ui: { Size: [1, 0, 0, 48], BackgroundColor3: '#2563eb', AutoButtonColor: false, TextColor3: '#ffffff', TextSize: 22, FontFace: { family: 'BuilderSans', weight: 'Bold' } } },
    { name: 'Corner', className: 'UICorner', ui: { CornerRadius: 10 } },
    { name: 'Stroke', className: 'UIStroke', ui: { Color: '#2f3747', Thickness: 1.5, ApplyStrokeMode: 'Border' } },
    { name: 'Sheen', className: 'UIGradient', ui: { Rotation: 90, Color: ['#ffffff', '#d9d9d9'] } },
    { name: 'Scale', className: 'UIScale' },
  ] } },
  items: [
    { key: 'Root', name: 'Root', className: 'Frame', ui: { AnchorPoint: [0.5, 0.5], Position: [0.5, 0, 0.5, 0], Size: [0.32, 0, 0.6, 0], BackgroundColor3: '#1a1f2b' } },
    { in: 'Root', name: 'Corner', className: 'UICorner', ui: { CornerRadius: 12 } },
    { in: 'Root', name: 'Padding', className: 'UIPadding', ui: { PaddingTop: 16, PaddingBottom: 16, PaddingLeft: [0, 16], PaddingRight: [0, 16] } },
    { in: 'Root', name: 'List', className: 'UIListLayout', ui: { Padding: 12, SortOrder: 'LayoutOrder' } },
    { in: 'Root', key: 'Title', name: 'Title', className: 'TextLabel', ui: { Text: 'Arcane Quest', TextScaled: true, Size: [1, 0, 0, 64], BackgroundTransparency: 1, FontFace: 'Montserrat' } },
    { in: 'Title', name: 'TitleSize', className: 'UITextSizeConstraint', ui: { MinTextSize: 24, MaxTextSize: 64 } },
    ...['Play', 'Shop', 'Settings', 'Credits'].map((text, index) => ({ in: 'Root', key: text, use: 'Button', name: text + 'Button', ui: { Text: text, LayoutOrder: index + 1 } })),
  ],
});
const parse = (input: Record<string, unknown>) => z.object(sceneBuildShape).parse(input) as SceneBuildInput;

test('scene_build ScreenGui: one atomic command builds the whole tree; prototypes are stamped with root overrides', () => {
  const compiled = compileSceneBuild(parse(menuInput()), STARTER_GUI as unknown as Json);
  assert.equal(compiled.instances, 1 + 6 + 4 * 5);
  const args = compiled.args as { container: { className: string; properties: Record<string, Json> }; prototypes: { gui: { parent: number; className: string; properties: Record<string, Json> }[] }[]; items: Record<string, Json>[] };
  assert.deepEqual(args.container, { className: 'ScreenGui', name: 'MainMenu', properties: { ResetOnSpawn: false, ZIndexBehavior: 'Sibling', IgnoreGuiInset: true } });
  assert.deepEqual(args.prototypes[0]!.gui.map(element => element.parent), [0, 1, 1, 1, 1]);
  assert.deepEqual(args.prototypes[0]!.gui[0]!.properties.Size, { type: 'UDim2', value: [1, 0, 0, 48] });
  assert.deepEqual(args.prototypes[0]!.gui[0]!.properties.FontFace, { type: 'Font', family: 'BuilderSans', weight: 'Bold' });
  assert.deepEqual(args.prototypes[0]!.gui[1]!.properties.CornerRadius, { type: 'UDim', value: [0, 10] });
  assert.deepEqual(args.items[0]!.properties, { AnchorPoint: { type: 'Vector2', value: [0.5, 0.5] }, Position: { type: 'UDim2', value: [0.5, 0, 0.5, 0] },
    Size: { type: 'UDim2', value: [0.32, 0, 0.6, 0] }, BackgroundColor3: { type: 'Color3', value: [0.1020, 0.1216, 0.1686] } });
  assert.deepEqual(args.items[6], { kind: 'stamp', template: 1, name: 'PlayButton', parent: 1, properties: { Text: 'Play', LayoutOrder: 1 }, key: 'Play' });
  assert.equal(args.items[5]!.parent, 5, 'UITextSizeConstraint inside the keyed title');
  const wire = validateCommandArgs('scene.build', compiled.args, session());
  assert.equal(sceneBuildInstanceCount(wire), compiled.instances, 'the receipt count the store will demand');
  assert.throws(() => validateCommandArgs('scene.build', compiled.args, session(false)), { code: 'PLUGIN_UPDATE_REQUIRED' });
  // World GUIs: a BillboardGui prototype stamped onto parts in a Model build.
  const world = compileSceneBuild(parse({ name: 'Stalls', prototypes: { Plate: { ui: [{ name: 'Plate', className: 'BillboardGui', ui: { Size: [0, 200, 0, 50], StudsOffset: [0, 3, 0] } },
    { name: 'Label', className: 'TextLabel', ui: { Text: 'Stall', Size: [1, 0, 1, 0] } }] } },
    items: [{ key: 'A', name: 'A', props: { Size: [4, 1, 4], Position: [0, 0.5, 0] } }, { in: 'A', use: 'Plate', ui: { MaxDistance: 90 } }, { in: 'A', name: 'Sign', className: 'SurfaceGui', ui: { Face: 'Front' } }] }),
    ref('Workspace', 'Workspace', []) as unknown as Json);
  assert.equal(compiled.instances > world.instances, true);
  assert.equal(world.instances, 1 + 1 + 2 + 1);
  assert.ok(validateCommandArgs('scene.build', world.args, session()));
});

test('scene_build GUI refusals happen before anything is queued', () => {
  const refuses = (mutate: (input: Record<string, any>) => void, pattern: RegExp) => {
    const input = menuInput(); mutate(input);
    assert.throws(() => compileSceneBuild(parse(input), STARTER_GUI as unknown as Json), pattern);
  };
  refuses(input => { input.items.push({ name: 'Brick', props: { Size: [1, 1, 1] } }); }, /holds only GUI items/);
  refuses(input => { input.items.push({ name: 'Glow', className: 'PointLight', fx: { Brightness: 1 }, in: 'Root' }); }, /PointLight must be inside/);
  refuses(input => { input.items.push({ name: 'Corner', className: 'UICorner' }); }, /UICorner must be inside a guiObject/);
  refuses(input => { input.items[0].ui.Draggable = true; }, /not an allowed GUI property/);
  refuses(input => { input.items[4].ui.Text = 'two\nlines'; }, /without control characters/);
  refuses(input => { input.items[0].props = { Size: [1, 1, 1] }; }, /takes ui/);
  refuses(input => { input.items.push({ name: 'Logo', className: 'ImageLabel', in: 'Root', ui: { Image: 'https://example.com/logo.png' } }); }, /rbxassetid/);
  refuses(input => { input.prototypes.Button.ui[1].in = 'Missing'; }, /must name one earlier element/);
  refuses(input => { input.prototypes.Button.ui[0].in = 'Button'; }, /root and has no "in"/);
  refuses(input => { input.items[6].ui.Font = 'GothamBold'; }, /not both/);
  refuses(input => { input.container = 'Model'; }, /screen applies only/);
  refuses(input => { input.scatter = [{ use: 'Button', count: 2, center: [0, 0, 0], radius: 5, minSpacing: 1 }]; input.container = 'ScreenGui'; }, /holds only GUI items|part prototypes only/);
  // Wire-level policy (what the daemon enforces even without the MCP compiler).
  const wire = () => structuredClone(compileSceneBuild(parse(menuInput()), STARTER_GUI as unknown as Json).args) as Record<string, any>;
  const wireRefuses = (mutate: (args: Record<string, any>) => void, code: string | RegExp, parent?: InstanceRef) => {
    const args = wire(); mutate(args); if (parent) args.parent = parent;
    assert.throws(() => validateCommandArgs('scene.build', args, session()), { code });
  };
  wireRefuses(args => { args.items.push({ kind: 'part', className: 'Part', name: 'Brick', parent: 0, properties: {} }); }, 'INPUT');
  wireRefuses(args => { args.items.push({ kind: 'effect', className: 'PointLight', name: 'Glow', parent: 1, properties: {} }); }, 'INPUT');
  wireRefuses(args => { args.items.push({ kind: 'gui', className: 'UIPadding', name: 'P', parent: 0, properties: {} }); }, 'CLASS');
  wireRefuses(args => { args.items.push({ kind: 'stamp', template: 2, name: 'X', parent: 1 }); }, 'INPUT');
  wireRefuses(args => { args.items.push({ kind: 'place', template: 1, name: 'X', parent: 0, at: [0, 0, 0], yaw: 0, scale: 1, tint: null }); }, 'INPUT');
  wireRefuses(args => { args.prototypes[0].gui[1].parent = 0; }, 'INPUT');
  wireRefuses(args => { args.prototypes[0].gui.push({ className: 'Frame', name: 'F', parent: 2, properties: {} }); }, 'CLASS');
  wireRefuses(args => { args.prototypes[0].gui[0].properties.Text = 'a\u0000b'; }, /INPUT|PROPERTY/);
  wireRefuses(args => { args.items[6].properties.Font = 'Gotham'; }, 'PROPERTY');
  wireRefuses(() => undefined, 'CLASS', ref('Part', 'Workspace'));
  wireRefuses(args => { args.container.className = 'Model'; }, 'INPUT');
  wireRefuses(args => { args.container.className = 'Frame'; delete args.container.properties; }, 'CLASS');
  wireRefuses(args => { args.container.properties.Draggable = true; }, 'PROPERTY');
  assert.throws(() => validateCommandArgs('scene.build', wire(), session(true, ['Workspace'])), { code: 'SCOPE' });
});

test('the arcane-interface recipe build example compiles and passes the wire policy', () => {
  const recipes = readFileSync('skills/arcane/arcane-interface/references/recipes.md', 'utf8');
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(recipes)![1]!) as Record<string, unknown>;
  const compiled = compileSceneBuild(parse(example), STARTER_GUI as unknown as Json);
  assert.equal(compiled.instances, 1 + 3 + 2 * 4);
  assert.ok(validateCommandArgs('scene.build', compiled.args, session()));
});

test('compact GUI values: UDim shorthands, font names and hex colours compile to tagged wire values', () => {
  assert.deepEqual(compileGuiProps('UICorner', { CornerRadius: 8 }), { CornerRadius: { type: 'UDim', value: [0, 8] } });
  assert.deepEqual(compileGuiProps('TextLabel', { FontFace: 'Oswald', TextColor3: '#ff0000', Size: [1, 0, 0, 40] }),
    { FontFace: { type: 'Font', family: 'Oswald' }, TextColor3: { type: 'Color3', value: [1, 0, 0] }, Size: { type: 'UDim2', value: [1, 0, 0, 40] } });
  assert.throws(() => compileGuiProps('Frame', { Size: [1, 0.5, 0, 0] }), /whole pixels/);
  assert.throws(() => compileGuiProps('UICorner', { CornerRadius: 'round' }), /UDim/);
});

test('pairing accepts the GUI, effects and mesh feature capabilities and still refuses unknown capability names', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-gui-store-'));
  const store = new StudioStore({ directory });
  t.after(() => { store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true, force: true }); });
  const identity = { clientSessionId: 'gui-window', placeId: 0, universeId: 0, name: 'Disposable fixture', pluginVersion: '0.2.0' };
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'StarterGui'], allowWrites: true });
  const paired = store.pair({ code: grant.code, protocolVersion: 1, identity, capabilities: [...READ_METHODS, ...WRITE_METHODS, ...STUDIO_FEATURE_CAPABILITIES] });
  const listed = store.sessions().find(s => s.id === paired.sessionId)!;
  for (const capability of STUDIO_FEATURE_CAPABILITIES) assert.ok(listed.capabilities.includes(capability), capability);
  const other = store.createGrant({ allowedRoots: ['StarterGui'], allowWrites: true });
  assert.throws(() => store.pair({ code: other.code, protocolVersion: 1, identity: { ...identity, clientSessionId: 'other' }, capabilities: ['scene.gui', 'scene.anything'] }), { code: 'METHOD' });
});

test('interface skill build templates compile and pass the plugin wire policy as written', () => {
  const blocks = ['recipes', 'controller'].flatMap(name => [...readFileSync(`skills/arcane/arcane-interface/references/${name}.md`, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)]
    .map(match => JSON.parse(match[1]!) as Record<string, unknown>));
  assert.ok(blocks.length >= 3, 'menu, shop card and HUD templates');
  for (const block of blocks) {
    // A bare prototype map (shop card) is checked by stamping it once inside a ScreenGui.
    const input = block.container ? block : { name: 'Probe', container: 'ScreenGui', prototypes: block, items: Object.keys(block).map(name => ({ use: name, name })) };
    const compiled = compileSceneBuild(parse(input), STARTER_GUI as unknown as Json);
    const wire = validateCommandArgs('scene.build', compiled.args, session());
    assert.equal(sceneBuildInstanceCount(wire), compiled.instances, String(input.name));
  }
});
