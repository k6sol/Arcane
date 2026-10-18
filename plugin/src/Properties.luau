--!strict
local V = require(script.Parent.Validation)
local Properties = {}
Properties.PART_FIELDS = table.freeze({"Size", "Position", "Color", "Anchored", "CanCollide", "Transparency", "Material"})
Properties.CLASSES = table.freeze({"Folder", "Model", "Part", "Script", "LocalScript", "ModuleScript"})
Properties.MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Metal", "Wood", "WoodPlanks", "Concrete", "Brick", "Glass", "Neon", "Slate", "Sand", "Fabric", "Grass", "Ground", "Rock", "Cobblestone", "Asphalt", "Marble", "Granite", "Limestone", "Sandstone", "Basalt", "Pebble", "LeafyGrass", "Mud", "Snow", "Ice", "Pavement", "Plaster", "DiamondPlate", "CorrodedMetal", "Foil"})

function Properties.decode(name: string, value: any, isPart: boolean): any
	if name == "Name" then return V.string(value, "Name", 100) end
	if not isPart or not table.find(Properties.PART_FIELDS, name) then V.fail("PROPERTY", "Property is not writable for this class.") end
	if name == "Anchored" or name == "CanCollide" then return V.boolean(value, name) end
	if name == "Transparency" then return V.number(value, 0, 1, name) end
	if name == "Material" then
		if type(value) ~= "string" or not table.find(Properties.MATERIALS, value) then V.fail("PROPERTY", "Unsupported Material.") end
		return Enum.Material[value]
	end
	local tag = V.fields(value, {"type", "value"}, "tagged property")
	local expectedType = if name == "Color" then "Color3" else "Vector3"
	if tag.type ~= expectedType then V.fail("PROPERTY", "Incorrect property type tag.") end
	local components = V.list(tag.value, 3, "components")
	if #components ~= 3 then V.fail("PROPERTY", "Property needs three components.") end
	for _, component in ipairs(components) do
		local low = if name == "Size" then 0.05 elseif name == "Color" then 0 else -100000
		local high = if name == "Size" then 2048 elseif name == "Color" then 1 else 100000
		V.number(component, low, high, name)
	end
	if name == "Color" then return Color3.new(components[1], components[2], components[3]) end
	return Vector3.new(components[1], components[2], components[3])
end

function Properties.encode(name: string, value: any): any
	if name == "Size" or name == "Position" then return {type = "Vector3", value = V.array({value.X, value.Y, value.Z})} end
	if name == "Color" then return {type = "Color3", value = V.array({value.R, value.G, value.B})} end
	if name == "Material" then return value.Name end
	return value
end

function Properties.validate(instance: any, values: any, service: boolean): ({[string]: any}, {string})
	V.object(values, "properties")
	local decoded: {[string]: any} = {}
	local names: {string} = {}
	for name, value in pairs(values) do
		if service and name == "Name" then V.fail("SERVICE", "Services cannot be renamed.") end
		decoded[name] = Properties.decode(name, value, instance:IsA("BasePart"))
		table.insert(names, name)
	end
	table.sort(names)
	return decoded, names
end

function Properties.snapshot(instance: any, names: {string}?): {[string]: any}
	local fields: {string} = names or {"Name"}
	if not names and instance:IsA("BasePart") then
		fields = table.clone(Properties.PART_FIELDS)
		table.insert(fields, "Name")
	end
	local result: {[string]: any} = {}
	for _, name in ipairs(fields) do result[name] = Properties.encode(name, instance[name]) end
	if not names and instance:IsA("BaseScript") then result.Disabled = instance.Disabled end
	return result
end

function Properties.compare(instance: any, expected: any, names: {string}): boolean
	-- Compare engine values (float32 Vector3/Color3 round-trip) after validation.
	local decoded = Properties.validate(instance, expected, false)
	for _, name in ipairs(names) do
		if expected[name] == nil or instance[name] ~= decoded[name] then return false end
	end
	return true
end

-- Post-assignment verification only. Baseline comparison above stays exact.
-- Native BasePart.Color stores RGB8: the engine multiplies float32 channels
-- by 255 in float32, then truncates. Double arithmetic would corrupt some
-- already-canonical byte values (for example 7/255).
local colorProduct = buffer.create(4) -- One shared scratch word; never yields between write and read.
local function colorChannel(value: number): number
	buffer.writef32(colorProduct, 0, value * 255)
	return math.floor(buffer.readf32(colorProduct, 0))
end
-- Same comparison as assignedMatches, against a value the caller already read back once.
function Properties.readMatches(name: string, requested: any, actual: any): boolean
	if name == "Color" then
		return actual == Color3.fromRGB(colorChannel(requested.R), colorChannel(requested.G), colorChannel(requested.B))
	end
	return actual == requested
end

function Properties.assignedMatches(instance: any, name: string, requested: any): boolean
	return Properties.readMatches(name, requested, instance[name])
end

-- Effects classes. Fixed allowlist mirrored from packages/core/src/studio-policy.ts EFFECT_PROPERTIES;
-- the daemon validates first, this module re-validates, assigns and verifies every value read back.
local NORMAL_IDS = {"Top", "Bottom", "Left", "Right", "Front", "Back"}
local function merge(...: any): any
	local result = {}
	for _, source in ipairs({...}) do for key, value in pairs(source) do result[key] = value end end
	return result
end
local LIGHT = {Brightness = {"number", 0, 40}, Range = {"number", 0, 60}, Color = {"color"}, Shadows = {"boolean"}, Enabled = {"boolean"}}
local FACED_LIGHT = merge(LIGHT, {Angle = {"number", 0, 180}, Face = {"enum", "NormalId", NORMAL_IDS}})
local GLOW = {LightEmission = {"number", 0, 1}, LightInfluence = {"number", 0, 1}, Brightness = {"number", 0, 20}}
local TEXTURE_MODE = {"enum", "TextureMode", {"Stretch", "Wrap", "Static"}}
local DECAL = {Texture = {"content"}, Face = {"enum", "NormalId", NORMAL_IDS}, Color3 = {"color"}, Transparency = {"number", 0, 1}}
Properties.EFFECT_SPECS = table.freeze({
	Attachment = {Position = {"vector3", -2048, 2048}, Orientation = {"vector3", -360, 360}},
	ParticleEmitter = merge(GLOW, {Enabled = {"boolean"}, Rate = {"number", 0, 500}, Lifetime = {"range", 0, 20}, Speed = {"range", 0, 500},
		SpreadAngle = {"vector2", -360, 360}, Acceleration = {"vector3", -500, 500}, Drag = {"number", 0, 50}, Size = {"sequence", 0, 100},
		Transparency = {"sequence", 0, 1}, Squash = {"sequence", -3, 3}, Color = {"colorSequence"}, Rotation = {"range", -360, 360}, RotSpeed = {"range", -1000, 1000},
		Orientation = {"enum", "ParticleOrientation", {"FacingCamera", "FacingCameraWorldUp", "VelocityParallel", "VelocityPerpendicular"}},
		EmissionDirection = {"enum", "NormalId", NORMAL_IDS}, Shape = {"enum", "ParticleEmitterShape", {"Box", "Sphere", "Cylinder", "Disc"}},
		ShapeStyle = {"enum", "ParticleEmitterShapeStyle", {"Volume", "Surface"}}, ShapeInOut = {"enum", "ParticleEmitterShapeInOut", {"Outward", "Inward", "InAndOut"}},
		LockedToPart = {"boolean"}, ZOffset = {"number", -50, 50}, TimeScale = {"number", 0, 1}, Texture = {"content"}}),
	Beam = merge(GLOW, {Attachment0 = {"attachment"}, Attachment1 = {"attachment"}, Color = {"colorSequence"}, Transparency = {"sequence", 0, 1},
		Width0 = {"number", 0, 100}, Width1 = {"number", 0, 100}, CurveSize0 = {"number", -100, 100}, CurveSize1 = {"number", -100, 100}, Segments = {"integer", 1, 100},
		FaceCamera = {"boolean"}, Enabled = {"boolean"}, Texture = {"content"}, TextureMode = TEXTURE_MODE, TextureLength = {"number", 0.01, 100},
		TextureSpeed = {"number", -100, 100}, ZOffset = {"number", -50, 50}}),
	Trail = merge(GLOW, {Attachment0 = {"attachment"}, Attachment1 = {"attachment"}, Color = {"colorSequence"}, Transparency = {"sequence", 0, 1},
		WidthScale = {"sequence", 0, 10}, Lifetime = {"number", 0.01, 20}, MinLength = {"number", 0, 100}, MaxLength = {"number", 0, 1000},
		FaceCamera = {"boolean"}, Enabled = {"boolean"}, Texture = {"content"}, TextureMode = TEXTURE_MODE, TextureLength = {"number", 0.01, 100}}),
	PointLight = LIGHT, SpotLight = FACED_LIGHT, SurfaceLight = FACED_LIGHT,
	Highlight = {FillColor = {"color"}, OutlineColor = {"color"}, FillTransparency = {"number", 0, 1}, OutlineTransparency = {"number", 0, 1},
		DepthMode = {"enum", "HighlightDepthMode", {"AlwaysOnTop", "Occluded"}}, Enabled = {"boolean"}},
	Fire = {Size = {"number", 2, 30}, Heat = {"number", -25, 25}, Color = {"color"}, SecondaryColor = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Smoke = {Size = {"number", 0.1, 100}, Opacity = {"number", 0, 1}, RiseVelocity = {"number", -25, 25}, Color = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Sparkles = {SparkleColor = {"color"}, Enabled = {"boolean"}, TimeScale = {"number", 0, 1}},
	Decal = DECAL,
	Texture = merge(DECAL, {StudsPerTileU = {"number", 0.01, 1000}, StudsPerTileV = {"number", 0.01, 1000}, OffsetStudsU = {"number", -1000, 1000}, OffsetStudsV = {"number", -1000, 1000}}),
	-- Audio. SoundId is rbxassetid://<digits> only; SoundGroup is a Ref to a SoundGroup of the same build/session.
	Sound = {SoundId = {"audio"}, Volume = {"number", 0, 10}, PlaybackSpeed = {"number", 0.1, 4}, Looped = {"boolean"}, Playing = {"boolean"},
		RollOffMode = {"enum", "RollOffMode", {"Inverse", "Linear", "LinearSquare", "InverseTapered"}}, RollOffMinDistance = {"number", 0, 10000},
		RollOffMaxDistance = {"number", 0, 10000}, SoundGroup = {"soundGroup"}, TimePosition = {"number", 0, 3600}},
	SoundGroup = {Volume = {"number", 0, 10}},
	ReverbSoundEffect = {Enabled = {"boolean"}, DecayTime = {"number", 0.1, 20}, Density = {"number", 0, 1}, Diffusion = {"number", 0, 1},
		DryLevel = {"number", -80, 20}, WetLevel = {"number", -80, 20}},
	EqualizerSoundEffect = {Enabled = {"boolean"}, HighGain = {"number", -80, 10}, MidGain = {"number", -80, 10}, LowGain = {"number", -80, 10}},
	EchoSoundEffect = {Enabled = {"boolean"}, Delay = {"number", 0.01, 5}, Feedback = {"number", 0, 1}, DryLevel = {"number", -80, 10}, WetLevel = {"number", -80, 10}},
	ChorusSoundEffect = {Enabled = {"boolean"}, Depth = {"number", 0, 1}, Mix = {"number", 0, 1}, Rate = {"number", 0, 20}},
	CompressorSoundEffect = {Enabled = {"boolean"}, Threshold = {"number", -60, 0}, Ratio = {"number", 1, 50}, Attack = {"number", 0.001, 1},
		Release = {"number", 0.01, 5}, GainMakeup = {"number", 0, 30}},
	DistortionSoundEffect = {Enabled = {"boolean"}, Level = {"number", 0, 1}},
	-- Characters (scene.characters). Data and containers only: no rig parts, joints, animation ids or code. MaxHealth is assigned before Health.
	Humanoid = {WalkSpeed = {"number", 0, 100}, JumpPower = {"number", 0, 200}, UseJumpPower = {"boolean"}, DisplayName = {"text"}, MaxHealth = {"number", 1, 100000},
		Health = {"number", 0, 100000}, HipHeight = {"number", 0, 50}, AutoRotate = {"boolean"}, RigType = {"enum", "HumanoidRigType", {"R6", "R15"}},
		DisplayDistanceType = {"enum", "HumanoidDisplayDistanceType", {"Viewer", "Subject", "None"}}},
	HumanoidDescription = {HeadColor = {"color"}, TorsoColor = {"color"}, LeftArmColor = {"color"}, RightArmColor = {"color"}, LeftLegColor = {"color"},
		RightLegColor = {"color"}, HeightScale = {"number", 0.5, 2}, WidthScale = {"number", 0.5, 2}, DepthScale = {"number", 0.5, 2}, HeadScale = {"number", 0.5, 2},
		BodyTypeScale = {"number", 0, 1}, ProportionScale = {"number", 0, 1}},
	AnimationController = {},
	Animator = {},
})
-- Host kind each effect class provides to effect items inside it (nil: it hosts nothing).
Properties.EFFECT_HOST_CLASSES = table.freeze({Attachment = "attachment", Sound = "sound", SoundGroup = "soundGroup", Humanoid = "humanoid",
	AnimationController = "animationController"})
Properties.EFFECT_HOSTS = table.freeze({Attachment = {"part"}, ParticleEmitter = {"part", "attachment"}, PointLight = {"part", "attachment"},
	SpotLight = {"part", "attachment"}, SurfaceLight = {"part"}, Fire = {"part", "attachment"}, Smoke = {"part", "attachment"}, Sparkles = {"part", "attachment"},
	Decal = {"part"}, Texture = {"part"}, Beam = {"part", "group"}, Trail = {"part", "group"}, Highlight = {"part", "group"},
	Sound = {"part", "attachment", "group"}, SoundGroup = {"group"}, ReverbSoundEffect = {"sound", "soundGroup"}, EqualizerSoundEffect = {"sound", "soundGroup"},
	EchoSoundEffect = {"sound", "soundGroup"}, ChorusSoundEffect = {"sound", "soundGroup"}, CompressorSoundEffect = {"sound", "soundGroup"},
	DistortionSoundEffect = {"sound", "soundGroup"}, Humanoid = {"group"}, HumanoidDescription = {"humanoid", "group"}, AnimationController = {"group"},
	Animator = {"humanoid", "animationController"}})
-- GUI classes. Fixed allowlist mirrored from packages/core/src/studio-policy.ts GUI_PROPERTIES; same decode/assign/verify path.
-- udim2 = [xScale, xOffset, yScale, yOffset], udim = [scale, offset] (offsets whole pixels); text is bounded, no control characters;
-- font is a built-in family only; Image ids reuse the content rule (rbxassetid digits or rbxasset://textures).
Properties.FONT_FAMILIES = table.freeze({"BuilderSans", "SourceSansPro", "GothamSSm", "Montserrat", "Roboto", "RobotoMono", "RobotoCondensed", "Arial", "Oswald", "FredokaOne",
	"Bangers", "Creepster", "DenkOne", "Fondamento", "GrenzeGotisch", "IndieFlower", "JosefinSans", "Jura", "Kalam", "LuckiestGuy", "Merriweather", "Michroma",
	"Nunito", "PatrickHand", "PermanentMarker", "PressStart2P", "Sarpanch", "SpecialElite", "TitilliumWeb", "Ubuntu", "AmaticSC"})
Properties.FONT_WEIGHTS = table.freeze({"Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Heavy"})
local FONT_NAMES = {"SourceSans", "SourceSansBold", "SourceSansSemibold", "SourceSansLight", "SourceSansItalic", "Gotham", "GothamMedium", "GothamBold", "GothamBlack",
	"BuilderSans", "BuilderSansMedium", "BuilderSansBold", "BuilderSansExtraBold", "Arial", "ArialBold", "Roboto", "RobotoMono", "RobotoCondensed",
	"Oswald", "FredokaOne", "Bangers", "Creepster", "DenkOne", "Fondamento", "GrenzeGotisch", "IndieFlower", "JosefinSans", "Jura", "Kalam", "LuckiestGuy", "Merriweather",
	"Michroma", "Nunito", "PatrickHand", "PermanentMarker", "Sarpanch", "SpecialElite", "TitilliumWeb", "Ubuntu", "AmaticSC", "Code", "Arcade", "SciFi", "Cartoon", "Fantasy", "Antique"}
Properties.GUI_LIMITS = table.freeze({textBytes = 2000, udimScale = 10, udimOffset = 10000})
local UNIT = {"number", 0, 1}
local AUTOMATIC_SIZE = {"enum", "AutomaticSize", {"None", "X", "Y", "XY"}}
local GUI_OBJECT = {Size = {"udim2"}, Position = {"udim2"}, AnchorPoint = {"vector2", 0, 1}, BackgroundColor3 = {"color"}, BackgroundTransparency = UNIT,
	BorderSizePixel = {"integer", 0, 100}, Visible = {"boolean"}, ZIndex = {"integer", -1000, 1000}, LayoutOrder = {"integer", -1000000, 1000000},
	AutomaticSize = AUTOMATIC_SIZE, ClipsDescendants = {"boolean"}, Rotation = {"number", -360, 360}, Active = {"boolean"}, Selectable = {"boolean"}}
local GUI_TEXT = {Text = {"text"}, TextColor3 = {"color"}, TextSize = {"integer", 1, 100}, TextScaled = {"boolean"}, TextWrapped = {"boolean"},
	TextXAlignment = {"enum", "TextXAlignment", {"Left", "Center", "Right"}}, TextYAlignment = {"enum", "TextYAlignment", {"Top", "Center", "Bottom"}},
	TextTransparency = UNIT, TextStrokeColor3 = {"color"}, TextStrokeTransparency = UNIT, Font = {"enum", "Font", FONT_NAMES}, FontFace = {"font"},
	TextTruncate = {"enum", "TextTruncate", {"None", "AtEnd"}}, LineHeight = {"number", 0.5, 3}}
local GUI_IMAGE = {Image = {"content"}, ImageColor3 = {"color"}, ImageTransparency = UNIT, ScaleType = {"enum", "ScaleType", {"Stretch", "Slice", "Tile", "Fit", "Crop"}}, TileSize = {"udim2"}}
local GUI_LAYER = {Enabled = {"boolean"}, ResetOnSpawn = {"boolean"}, ZIndexBehavior = {"enum", "ZIndexBehavior", {"Global", "Sibling"}}}
local GUI_WORLD = {AlwaysOnTop = {"boolean"}, MaxDistance = {"number", 0, 100000}, LightInfluence = UNIT, Brightness = {"number", 0, 20}, ClipsDescendants = {"boolean"}}
local GUI_LAYOUT = {FillDirection = {"enum", "FillDirection", {"Horizontal", "Vertical"}}, HorizontalAlignment = {"enum", "HorizontalAlignment", {"Left", "Center", "Right"}},
	VerticalAlignment = {"enum", "VerticalAlignment", {"Top", "Center", "Bottom"}}, SortOrder = {"enum", "SortOrder", {"LayoutOrder", "Name"}}}
Properties.GUI_SPECS = table.freeze({
	ScreenGui = merge(GUI_LAYER, {IgnoreGuiInset = {"boolean"}, DisplayOrder = {"integer", -1000, 1000},
		ScreenInsets = {"enum", "ScreenInsets", {"None", "DeviceSafeInsets", "CoreUISafeInsets", "TopbarSafeInsets"}}}),
	SurfaceGui = merge(GUI_LAYER, GUI_WORLD, {Face = {"enum", "NormalId", NORMAL_IDS}, SizingMode = {"enum", "SurfaceGuiSizingMode", {"FixedSize", "PixelsPerStud"}},
		PixelsPerStud = {"number", 1, 500}, CanvasSize = {"vector2", 1, 8192}}),
	BillboardGui = merge(GUI_LAYER, GUI_WORLD, {Size = {"udim2"}, StudsOffset = {"vector3", -1000, 1000}, StudsOffsetWorldSpace = {"vector3", -1000, 1000}}),
	Frame = GUI_OBJECT,
	CanvasGroup = merge(GUI_OBJECT, {GroupTransparency = UNIT, GroupColor3 = {"color"}}),
	ScrollingFrame = merge(GUI_OBJECT, {CanvasSize = {"udim2"}, ScrollBarThickness = {"integer", 0, 50}, ScrollingDirection = {"enum", "ScrollingDirection", {"X", "Y", "XY"}},
		AutomaticCanvasSize = AUTOMATIC_SIZE, ScrollBarImageColor3 = {"color"}, ScrollBarImageTransparency = UNIT, ScrollingEnabled = {"boolean"},
		VerticalScrollBarInset = {"enum", "ScrollBarInset", {"None", "ScrollBar", "Always"}}}),
	TextLabel = merge(GUI_OBJECT, GUI_TEXT),
	TextButton = merge(GUI_OBJECT, GUI_TEXT, {AutoButtonColor = {"boolean"}}),
	TextBox = merge(GUI_OBJECT, GUI_TEXT, {PlaceholderText = {"text"}, PlaceholderColor3 = {"color"}, ClearTextOnFocus = {"boolean"}, TextEditable = {"boolean"}, MultiLine = {"boolean"}}),
	ImageLabel = merge(GUI_OBJECT, GUI_IMAGE),
	ImageButton = merge(GUI_OBJECT, GUI_IMAGE, {AutoButtonColor = {"boolean"}, HoverImage = {"content"}, PressedImage = {"content"}}),
	ViewportFrame = merge(GUI_OBJECT, {Ambient = {"color"}, LightColor = {"color"}, ImageColor3 = {"color"}, ImageTransparency = UNIT}),
	UICorner = {CornerRadius = {"udim"}},
	UIStroke = {Color = {"color"}, Thickness = {"number", 0, 50}, Transparency = UNIT, ApplyStrokeMode = {"enum", "ApplyStrokeMode", {"Contextual", "Border"}},
		LineJoinMode = {"enum", "LineJoinMode", {"Round", "Bevel", "Miter"}}, Enabled = {"boolean"}},
	UIGradient = {Color = {"colorSequence"}, Transparency = {"sequence", 0, 1}, Rotation = {"number", -360, 360}, Offset = {"vector2", -1, 1}, Enabled = {"boolean"}},
	UIPadding = {PaddingTop = {"udim"}, PaddingBottom = {"udim"}, PaddingLeft = {"udim"}, PaddingRight = {"udim"}},
	UIListLayout = merge(GUI_LAYOUT, {Padding = {"udim"}}),
	UIGridLayout = merge(GUI_LAYOUT, {CellSize = {"udim2"}, CellPadding = {"udim2"}, StartCorner = {"enum", "StartCorner", {"TopLeft", "TopRight", "BottomLeft", "BottomRight"}},
		FillDirectionMaxCells = {"integer", 0, 100}}),
	UIAspectRatioConstraint = {AspectRatio = {"number", 0.01, 100}, AspectType = {"enum", "AspectType", {"FitWithinMaxSize", "ScaleWithParentSize"}},
		DominantAxis = {"enum", "DominantAxis", {"Width", "Height"}}},
	UISizeConstraint = {MinSize = {"vector2", 0, 100000}, MaxSize = {"vector2", 0, 100000}},
	UITextSizeConstraint = {MinTextSize = {"integer", 1, 100}, MaxTextSize = {"integer", 1, 100}},
	UIScale = {Scale = {"number", 0.01, 20}},
})
local ELEMENT_HOSTS, MODIFIER_HOSTS = {"layer", "guiObject"}, {"guiObject"}
Properties.GUI_HOSTS = table.freeze({ScreenGui = {"starterGui", "group"}, SurfaceGui = {"part"}, BillboardGui = {"part", "attachment"},
	Frame = ELEMENT_HOSTS, CanvasGroup = ELEMENT_HOSTS, ScrollingFrame = ELEMENT_HOSTS, TextLabel = ELEMENT_HOSTS, TextButton = ELEMENT_HOSTS, TextBox = ELEMENT_HOSTS,
	ImageLabel = ELEMENT_HOSTS, ImageButton = ELEMENT_HOSTS, ViewportFrame = ELEMENT_HOSTS, UIListLayout = ELEMENT_HOSTS, UIGridLayout = ELEMENT_HOSTS, UIScale = ELEMENT_HOSTS,
	UICorner = MODIFIER_HOSTS, UIStroke = MODIFIER_HOSTS, UIGradient = MODIFIER_HOSTS, UIPadding = MODIFIER_HOSTS,
	UIAspectRatioConstraint = MODIFIER_HOSTS, UISizeConstraint = MODIFIER_HOSTS, UITextSizeConstraint = MODIFIER_HOSTS})
-- Host kind each GUI class provides to its children (nil: it hosts nothing).
Properties.GUI_HOST_CLASSES = table.freeze({ScreenGui = "layer", SurfaceGui = "layer", BillboardGui = "layer", Frame = "guiObject", CanvasGroup = "guiObject",
	ScrollingFrame = "guiObject", TextLabel = "guiObject", TextButton = "guiObject", TextBox = "guiObject", ImageLabel = "guiObject", ImageButton = "guiObject", ViewportFrame = "guiObject"})

-- Spec table and allowed host kinds of one effect or GUI class (nil when the class is neither).
function Properties.specsOf(className: any): any
	if type(className) ~= "string" then return nil end
	return Properties.EFFECT_SPECS[className] or Properties.GUI_SPECS[className]
end
function Properties.hostsOf(className: string): {string}
	return Properties.EFFECT_HOSTS[className] or Properties.GUI_HOSTS[className]
end

-- Ref-valued spec kinds and the class each Ref must name.
Properties.REF_CLASSES = table.freeze({attachment = "Attachment", soundGroup = "SoundGroup"})
Properties.EFFECT_LIMITS = table.freeze({properties = 32, keypoints = 20})
local CONTENT_EXTENSIONS = {"png", "jpg", "jpeg", "dds", "tga"}
local TAGS = {color = "Color3", vector3 = "Vector3", vector2 = "Vector2", range = "NumberRange", sequence = "NumberSequence", colorSequence = "ColorSequence"}

-- Only numeric rbxassetid or built-in rbxasset://textures paths. Never URLs or other schemes.
function Properties.contentId(value: any, label: string): string
	if type(value) == "string" and #value <= 200 then
		local digits = string.match(value, "^rbxassetid://([1-9]%d*)$")
		if digits and #digits <= 19 then return value end
		local path = string.match(value, "^rbxasset://textures/([%w_%-/%.]+)$")
		local stem, extension = string.match(path or "", "^(.+)%.(%a+)$")
		if stem and #stem <= 160 and table.find(CONTENT_EXTENSIONS, extension) and not string.find(path, "..", 1, true) then return value end
	end
	return V.fail("PROPERTY", label .. " must be rbxassetid://<digits> or a built-in rbxasset://textures/... path.")
end

-- Audio ids: numeric rbxassetid only. Never URLs, rbxasset:// paths or other schemes.
function Properties.audioId(value: any, label: string): string
	if type(value) == "string" and #value <= 40 then
		local digits = string.match(value, "^rbxassetid://([1-9]%d*)$")
		if digits and #digits <= 19 then return value end
	end
	return V.fail("PROPERTY", label .. " must be rbxassetid://<digits> (an id the user gave or asset search returned).")
end

function Properties.hostKind(instance: any): string?
	if instance:IsA("Sound") then return "sound" end
	if instance:IsA("SoundGroup") then return "soundGroup" end
	if instance:IsA("Humanoid") then return "humanoid" end
	if instance:IsA("AnimationController") then return "animationController" end
	if instance:IsA("BasePart") then return "part" end
	if instance:IsA("Attachment") then return "attachment" end
	if instance:IsA("Model") or instance:IsA("Folder") or instance.ClassName == "Workspace" then return "group" end
	if instance.ClassName == "StarterGui" then return "starterGui" end
	if instance:IsA("LayerCollector") then return "layer" end
	if instance:IsA("GuiObject") then return "guiObject" end
	return nil
end

-- Bounded display text: valid UTF-8, no control characters (C0, DEL or C1).
function Properties.guiText(value: any, label: string): string
	if type(value) ~= "string" or #value > Properties.GUI_LIMITS.textBytes or utf8.len(value) == nil or string.find(value, "%c")
		or string.find(value, "\194[\128-\159]") then
		V.fail("PROPERTY", label .. " must be text of at most " .. Properties.GUI_LIMITS.textBytes .. " UTF-8 bytes without control characters.")
	end
	return value
end

local function udims(value: any, count: number, label: string): {number}
	local list = V.list(value, count, label)
	if #list ~= count then V.fail("PROPERTY", label .. " needs " .. count .. " numbers.") end
	local limits = Properties.GUI_LIMITS
	for index, item in ipairs(list) do
		if index % 2 == 1 then V.number(item, -limits.udimScale, limits.udimScale, label .. " scale")
		else V.integer(item, -limits.udimOffset, limits.udimOffset, label .. " offset") end
	end
	return list
end

local function fontFace(value: any, label: string): any
	local face = V.fields(value, {"type", "family", "weight", "style"}, label)
	if face.type ~= "Font" or type(face.family) ~= "string" or not table.find(Properties.FONT_FAMILIES, face.family) then
		V.fail("PROPERTY", label .. " must be a built-in font family.")
	end
	local weight = V.enum(if face.weight == nil then "Regular" else face.weight, Properties.FONT_WEIGHTS, Enum.FontWeight, label .. " weight")
	local style = V.enum(if face.style == nil then "Normal" else face.style, {"Normal", "Italic"}, Enum.FontStyle, label .. " style")
	return Font.new("rbxasset://fonts/families/" .. face.family .. ".json", weight, style)
end

local function numbers(value: any, count: number, low: number, high: number, label: string): {number}
	local list = V.list(value, count, label)
	if #list ~= count then V.fail("PROPERTY", label .. " needs " .. count .. " numbers.") end
	for _, item in ipairs(list) do V.number(item, low, high, label) end
	return list
end

local function keypoints(value: any, width: number, label: string): {any}
	local list = V.list(value, Properties.EFFECT_LIMITS.keypoints, label)
	if #list < 2 then V.fail("PROPERTY", label .. " needs at least two keypoints.") end
	local last = -1
	for index, point in ipairs(list) do
		local items = V.list(point, width, label .. " keypoint")
		if #items < 2 then V.fail("PROPERTY", label .. " keypoints need time and value.") end
		local time = V.number(items[1], 0, 1, label .. " time")
		if time <= last or (index == 1 and time ~= 0) or (index == #list and time ~= 1) then V.fail("PROPERTY", label .. " keypoint times must rise from 0 to 1.") end
		last = time
	end
	return list
end

-- resolve(tag, label) maps a {type="Ref"} value to what is assigned (an Attachment or a build marker).
function Properties.decodeEffect(className: string, name: string, value: any, resolve: (any, string, string) -> any): any
	local specs = Properties.specsOf(className)
	local spec = if specs then specs[name] else nil
	local label = className .. "." .. name
	if not spec then V.fail("PROPERTY", label .. " is not writable by the safe bridge.") end
	local kind = spec[1]
	if kind == "boolean" then return V.boolean(value, label) end
	if kind == "content" then return Properties.contentId(value, label) end
	if kind == "audio" then return Properties.audioId(value, label) end
	if kind == "number" then return V.number(value, spec[2], spec[3], label) end
	if kind == "integer" then return V.integer(value, spec[2], spec[3], label) end
	if kind == "enum" then return V.enum(value, spec[3], Enum[spec[2]], label) end
	if kind == "text" then return Properties.guiText(value, label) end
	if kind == "font" then return fontFace(value, label) end
	if kind == "udim2" or kind == "udim" then
		local tag = V.fields(value, {"type", "value"}, label)
		if tag.type ~= (if kind == "udim2" then "UDim2" else "UDim") then V.fail("PROPERTY", "Incorrect property type tag for " .. label .. ".") end
		local c = udims(tag.value, if kind == "udim2" then 4 else 2, label)
		if kind == "udim" then return UDim.new(c[1], c[2]) end
		return UDim2.new(c[1], c[2], c[3], c[4])
	end
	if Properties.REF_CLASSES[kind] then
		local tag = V.object(value, label)
		if tag.type ~= "Ref" then V.fail("PROPERTY", label .. " must be a Ref to a " .. Properties.REF_CLASSES[kind] .. ".") end
		return resolve(tag, label, kind)
	end
	local tag = V.fields(value, {"type", "value"}, label)
	if tag.type ~= TAGS[kind] then V.fail("PROPERTY", "Incorrect property type tag for " .. label .. ".") end
	if kind == "color" then
		local c = numbers(tag.value, 3, 0, 1, label)
		return Color3.new(c[1], c[2], c[3])
	elseif kind == "vector3" then
		local c = numbers(tag.value, 3, spec[2], spec[3], label)
		return Vector3.new(c[1], c[2], c[3])
	elseif kind == "vector2" then
		local c = numbers(tag.value, 2, spec[2], spec[3], label)
		return Vector2.new(c[1], c[2])
	elseif kind == "range" then
		local c = numbers(tag.value, 2, spec[2], spec[3], label)
		if c[1] > c[2] then V.fail("PROPERTY", label .. " min must not exceed max.") end
		return NumberRange.new(c[1], c[2])
	elseif kind == "sequence" then
		local points = {}
		for _, point in ipairs(keypoints(tag.value, 3, label)) do
			local envelope = if point[3] == nil then 0 else V.number(point[3], 0, (spec[3] - spec[2]) / 2, label .. " envelope")
			table.insert(points, NumberSequenceKeypoint.new(point[1], V.number(point[2], spec[2], spec[3], label), envelope))
		end
		return NumberSequence.new(points)
	end
	local points = {}
	for _, point in ipairs(keypoints(tag.value, 4, label)) do
		if #point ~= 4 then V.fail("PROPERTY", label .. " keypoints are [time,r,g,b].") end
		for channel = 2, 4 do V.number(point[channel], 0, 1, label) end
		table.insert(points, ColorSequenceKeypoint.new(point[1], Color3.new(point[2], point[3], point[4])))
	end
	return ColorSequence.new(points)
end

function Properties.decodeEffects(className: string, values: any, resolve: (any, string, string) -> any): {[string]: any}
	if not Properties.specsOf(className) then V.fail("CLASS", "Unsupported effect or GUI class.") end
	V.object(values, "effect properties")
	local decoded, count = {}, 0
	for name, value in pairs(values) do
		count += 1
		if count > Properties.EFFECT_LIMITS.properties then V.fail("INPUT", "Too many effect properties.") end
		if name == "Name" then V.fail("PROPERTY", "Use the name field.") end
		decoded[name] = Properties.decodeEffect(className, name, value, resolve)
	end
	if decoded.RollOffMinDistance and decoded.RollOffMaxDistance and decoded.RollOffMinDistance > decoded.RollOffMaxDistance then
		V.fail("PROPERTY", className .. ".RollOffMinDistance must not exceed RollOffMaxDistance.")
	end
	if decoded.Health and decoded.MaxHealth and decoded.Health > decoded.MaxHealth then V.fail("PROPERTY", className .. ".Health must not exceed MaxHealth.") end
	Properties.crossCheck(className, decoded)
	return decoded
end

-- GUI cross-field rules (mirrored in studio-policy.ts): one font source; minimums never above maximums.
-- Also run on a stamp's merged prototype-root and override properties.
function Properties.crossCheck(className: string, decoded: {[string]: any}): ()
	if decoded.Font ~= nil and decoded.FontFace ~= nil then V.fail("PROPERTY", className .. ": set Font or FontFace, not both.") end
	if decoded.MinTextSize and decoded.MaxTextSize and decoded.MinTextSize > decoded.MaxTextSize then
		V.fail("PROPERTY", className .. ".MinTextSize must not exceed MaxTextSize.")
	end
	local low, high = decoded.MinSize, decoded.MaxSize
	if low and high and (low.X > high.X or low.Y > high.Y) then V.fail("PROPERTY", className .. ".MinSize must not exceed MaxSize.") end
end

local function near(actual: any, expected: number): boolean
	return type(actual) == "number" and math.abs(actual - expected) <= 0.0005 * math.max(1, math.abs(expected))
end
local function sameColor(actual: any, expected: any): boolean
	return typeof(actual) == "Color3" and near(actual.R, expected.R) and near(actual.G, expected.G) and near(actual.B, expected.B)
end
-- Euler triples (YXZ, degrees) are compared as rotations: the engine may normalize angles.
local function rotation(v: any): {number}
	local x, y, z = math.rad(v.X), math.rad(v.Y), math.rad(v.Z)
	local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
	return {cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx}
end

function Properties.effectMatches(instance: any, className: string, name: string, expected: any): boolean
	local kind = Properties.specsOf(className)[name][1]
	local ok, actual = pcall(function(): any return instance[name] end)
	if not ok then return false end
	if kind == "number" or kind == "integer" then return near(actual, expected) end
	if kind == "color" then return sameColor(actual, expected) end
	if kind == "udim" then return typeof(actual) == "UDim" and near(actual.Scale, expected.Scale) and actual.Offset == expected.Offset end
	if kind == "udim2" then
		return typeof(actual) == "UDim2" and near(actual.X.Scale, expected.X.Scale) and actual.X.Offset == expected.X.Offset
			and near(actual.Y.Scale, expected.Y.Scale) and actual.Y.Offset == expected.Y.Offset
	end
	if kind == "font" then
		return typeof(actual) == "Font" and actual.Family == expected.Family and actual.Weight == expected.Weight and actual.Style == expected.Style
	end
	if kind == "vector3" and className == "Attachment" and name == "Orientation" then
		if typeof(actual) ~= "Vector3" then return false end
		local a, b = rotation(actual), rotation(expected)
		for index = 1, 9 do if math.abs(a[index] - b[index]) > 0.0001 then return false end end
		return true
	end
	if kind == "vector3" then return typeof(actual) == "Vector3" and near(actual.X, expected.X) and near(actual.Y, expected.Y) and near(actual.Z, expected.Z) end
	if kind == "vector2" then return typeof(actual) == "Vector2" and near(actual.X, expected.X) and near(actual.Y, expected.Y) end
	if kind == "range" then return typeof(actual) == "NumberRange" and near(actual.Min, expected.Min) and near(actual.Max, expected.Max) end
	if kind == "sequence" or kind == "colorSequence" then
		local want = expected.Keypoints
		if typeof(actual) ~= (if kind == "sequence" then "NumberSequence" else "ColorSequence") or #actual.Keypoints ~= #want then return false end
		for index, point in ipairs(actual.Keypoints) do
			local target = want[index]
			if not near(point.Time, target.Time) then return false end
			if kind == "sequence" and (not near(point.Value, target.Value) or not near(point.Envelope, target.Envelope)) then return false end
			if kind == "colorSequence" and not sameColor(point.Value, target.Value) then return false end
		end
		return true
	end
	return actual == expected
end

-- Limits assigned before the values they clamp (Humanoid.Health is clamped to MaxHealth).
local ASSIGN_FIRST = table.freeze({MaxHealth = true})
-- Assign in sorted order (limits first), then verify every value read back. resolveMarker maps build markers to Instances.
function Properties.applyEffect(instance: any, className: string, decoded: {[string]: any}, resolveMarker: ((any) -> any)?): ()
	local names: {string} = {}
	for name in pairs(decoded) do table.insert(names, name) end
	table.sort(names, function(a: string, b: string): boolean
		local first, second = ASSIGN_FIRST[a] == true, ASSIGN_FIRST[b] == true
		if first ~= second then return first end
		return a < b
	end)
	local values: {[string]: any} = {}
	for _, name in ipairs(names) do
		local value = decoded[name]
		if Properties.REF_CLASSES[Properties.specsOf(className)[name][1]] and resolveMarker then value = resolveMarker(value) end
		values[name] = value
		local ok = pcall(function() instance[name] = value end)
		if not ok then V.fail("VERIFY", "Studio refused " .. className .. "." .. name .. ".") end
	end
	for _, name in ipairs(names) do
		if not Properties.effectMatches(instance, className, name, values[name]) then V.fail("VERIFY", className .. "." .. name .. " did not take the requested value.") end
	end
end

return table.freeze(Properties)
