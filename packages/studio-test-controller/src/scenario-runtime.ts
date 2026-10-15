import { scenarioPlanSchema, type ScenarioPlan } from './scenario.js';

/** Fixed Client program. Targets are actual engine references held in this one
 * invocation, never attributes or paths reacquired after an input/yield. */
export const SCENARIO_RUNTIME_SOURCE = String.raw`function(gameModel, plan, runId, scenarioDigest)
  local rows = {}
  for _, step in ipairs(plan.steps) do
    local expected = if step.kind == "hold-key" then step.key .. ":" .. tostring(step.holdMs)
      elseif step.kind == "click-gui" then step.targetId
      elseif step.kind == "assert-gui-layout" then "core-safe:" .. tostring(step.minimumWidth) .. "x" .. tostring(step.minimumHeight)
      elseif step.kind == "assert-displacement" then step.minimumStuds else step.equals
    rows[#rows + 1] = {id = step.id, kind = step.kind, outcome = "not_run", expected = expected, observed = "not-observed"}
  end
  local run = gameModel:GetService("RunService")
  local players = gameModel:GetService("Players")
  local userInput = gameModel:GetService("UserInputService")
  local player, character, root, gui, input
  local links, targets, keys, targetLinks = {}, {}, {}, {}
  local mouse = nil
  local clickContext = nil
  local layoutContext = nil
  local attempted, released, active = false, true, nil
  local started = os.clock()
  local deadline = started + plan.runtimeBudgetMs / 1000
  local samples = 0
  local function fail(code) error({arcaneCode = code}, 0) end
  -- The retained Client player is observed, never written or replaced by a
  -- server-state claim. Explicit presence keeps nil distinct from false/zero.
  local function readAttribute(attributeName: string)
    local value = player:GetAttribute(attributeName)
    if value == nil then return {present = false} end
    local kind = type(value)
    if kind == "number" then
      if value ~= value or math.abs(value) > 9007199254740991 then fail("UNSUPPORTED_TOOL") end
    elseif kind == "string" then
      if #value > 256 or not utf8.len(value) then fail("UNSUPPORTED_TOOL") end
      local units = 0
      for _, point in utf8.codes(value) do
        units += if point > 65535 then 2 else 1
        if units > 128 or point < 32 or point >= 127 and point <= 159
          or point >= 55296 and point <= 57343 or point >= 8203 and point <= 8207
          or point >= 8234 and point <= 8238 or point >= 8288 and point <= 8303 or point == 65279 then fail("UNSUPPORTED_TOOL") end
      end
    elseif kind ~= "boolean" then fail("UNSUPPORTED_TOOL") end
    return {present = true, value = value}
  end
  local function attributePasses(step, measurement)
    return measurement.observed.present and measurement.observed.value == step.equals
      and (not step.requireTransition or not measurement.baseline.present or measurement.baseline.value ~= step.equals)
  end
  local function bounded(value)
    return type(value) == "number" and value == value and math.abs(value) <= 16384
  end
  local function rectangle(left, top, right, bottom)
    if not bounded(left) or not bounded(top) or not bounded(right) or not bounded(bottom)
      or right < left or bottom < top or right - left > 16384 or bottom - top > 16384 then fail("UNSUPPORTED_TOOL") end
    return {left = left, top = top, right = right, bottom = bottom}
  end
  local function layoutBasis(value)
    local area = value.guiService:GetInsetArea(Enum.ScreenInsets.CoreUISafeInsets)
    local safe = rectangle(area.Min.X, area.Min.Y, area.Max.X, area.Max.Y)
    if safe.left ~= 0 or safe.top ~= 0 or safe.right <= 0 or safe.bottom <= 0 then fail("UNSUPPORTED_TOOL") end
    local viewport = value.camera.ViewportSize
    if not bounded(viewport.X) or not bounded(viewport.Y) or viewport.X <= 0 or viewport.Y <= 0 then fail("UNSUPPORTED_TOOL") end
    return safe, {width = viewport.X, height = viewport.Y, units = "RobloxUIOffset"}
  end
  -- GUI hit tests use CoreUISafeInsets coordinates; VirtualInput documents only
  -- screen-space pixels. Admit clicks only where every documented area coincides,
  -- without guessing an inset translation or comparing unlike viewport units.
  local function clickBasis(value)
    local areas = {Enum.ScreenInsets.None, Enum.ScreenInsets.CoreUISafeInsets, Enum.ScreenInsets.DeviceSafeInsets}
    local width, height
    for index = 1, 3 do
      if areas[index] == nil then return nil end
      local rect = value.guiService:GetInsetArea(areas[index])
      if not rect or not bounded(rect.Min.X) or not bounded(rect.Min.Y)
        or not bounded(rect.Max.X) or not bounded(rect.Max.Y)
        or rect.Min.X ~= 0 or rect.Min.Y ~= 0 or rect.Max.X <= 0 or rect.Max.Y <= 0 then return nil end
      if index == 1 then width = rect.Max.X; height = rect.Max.Y
      elseif rect.Max.X ~= width or rect.Max.Y ~= height then return nil end
    end
    local topLeft, bottomRight = value.guiService:GetGuiInset()
    if not topLeft or not bottomRight or topLeft.X ~= 0 or topLeft.Y ~= 0
      or bottomRight.X ~= 0 or bottomRight.Y ~= 0 then return nil end
    local viewport = value.camera.ViewportSize
    if not viewport or not bounded(viewport.X) or not bounded(viewport.Y)
      or viewport.X ~= width or viewport.Y ~= height then return nil end
    return width, height
  end
  local function context()
    if not run:IsClient() or gameModel.PlaceId ~= 0 or gameModel.GameId ~= 0
      or players.LocalPlayer ~= player or not player or player.Parent ~= players
      or player.Character ~= character or not character or not root
      or root.Parent ~= character or not root:IsA("BasePart")
      or player:FindFirstChildOfClass("PlayerGui") ~= gui then fail("BINDING_CHANGED") end
    if clickContext then
      local ok, width, height = pcall(function()
        if gameModel:GetService("Workspace") ~= clickContext.workspace
          or gameModel:GetService("GuiService") ~= clickContext.guiService
          or clickContext.workspace.CurrentCamera ~= clickContext.camera then return nil end
        return clickBasis(clickContext)
      end)
      if not ok or width ~= clickContext.width or height ~= clickContext.height then fail("BINDING_CHANGED") end
    end
    if layoutContext then
      local ok, current = pcall(function()
        if gameModel:GetService("Workspace") ~= layoutContext.workspace
          or gameModel:GetService("GuiService") ~= layoutContext.guiService
          or layoutContext.workspace.CurrentCamera ~= layoutContext.camera then return nil end
        local safe, viewport = layoutBasis(layoutContext)
        return safe.left == layoutContext.safeArea.left and safe.top == layoutContext.safeArea.top
          and safe.right == layoutContext.safeArea.right and safe.bottom == layoutContext.safeArea.bottom
          and viewport.width == layoutContext.viewport.width and viewport.height == layoutContext.viewport.height
      end)
      if not ok or current ~= true then fail("BINDING_CHANGED") end
    end
  end
  local function guard()
    context()
    if os.clock() >= deadline or samples >= 128 then fail("TIMEOUT") end
    for _, link in ipairs(links) do
      if link.instance.Parent ~= link.parent or link.instance.Name ~= link.name
        or link.instance.ClassName ~= link.className then fail("BINDING_CHANGED") end
    end
  end
  local function pause(seconds)
    guard()
    samples += 1
    task.wait(math.min(seconds, math.max(0, deadline - os.clock())))
    guard()
  end
  local function releaseKey(key, state)
    if state.releaseAttempted then return end
    state.releaseAttempted = true
    local trusted = pcall(context)
    local ok = pcall(function()
      input:SendKey(false, Enum.KeyCode[key], false)
      if userInput:IsKeyDown(Enum.KeyCode[key]) then fail("EFFECT_UNKNOWN") end
    end)
    if ok and trusted then keys[key] = nil else released = false end
  end
  local function releaseMouse(state)
    if state.releaseAttempted then return end
    state.releaseAttempted = true
    local trusted = pcall(context)
    local ok = pcall(function()
      input:SendMouseButton(state.position, Enum.UserInputType.MouseButton1, false, 0)
      if userInput:IsMouseButtonPressed(Enum.UserInputType.MouseButton1) then fail("EFFECT_UNKNOWN") end
    end)
    if ok and trusted then mouse = nil else released = false end
  end
  local function guiRectangle(instance)
    local position, size = instance.AbsolutePosition, instance.AbsoluteSize
    if not bounded(size.X) or not bounded(size.Y) or size.X < 0 or size.Y < 0 then fail("UNSUPPORTED_TOOL") end
    return rectangle(position.X, position.Y, position.X + size.X, position.Y + size.Y)
  end
  local function measureLayout(targetId)
    local chain = targetLinks[targetId]
    if not chain or #chain > 8 then fail("UNSUPPORTED_TOOL") end
    local seenScreen, visible, clips = false, true, {}
    for index, instance in ipairs(chain) do
      if instance.ClassName == "ScreenGui" then
        if seenScreen or type(instance.Enabled) ~= "boolean" then fail("UNSUPPORTED_TOOL") end
        seenScreen = true; visible = visible and instance.Enabled
      elseif instance.ClassName == "Folder" and not seenScreen then
        -- A folder may organize ScreenGuis, never substitute for a GUI parent.
      elseif instance:IsA("GuiObject") and seenScreen then
        if instance.Rotation ~= 0 or instance.AbsoluteRotation ~= 0 or type(instance.Visible) ~= "boolean"
          or type(instance.ClipsDescendants) ~= "boolean" then fail("UNSUPPORTED_TOOL") end
        visible = visible and instance.Visible
        if index < #chain and instance.ClipsDescendants then
          if #clips >= 8 then fail("UNSUPPORTED_TOOL") end
          clips[#clips + 1] = guiRectangle(instance)
        end
      else fail("UNSUPPORTED_TOOL") end
    end
    if not seenScreen then fail("UNSUPPORTED_TOOL") end
    return {coordinateSpace = "CoreUISafeInsets", target = guiRectangle(targets[targetId]), safeArea = layoutContext.safeArea,
      clips = clips, visibleChain = visible, viewport = layoutContext.viewport}
  end
  local function layoutPasses(step, value)
    local target = value.target
    if not value.visibleChain or target.right - target.left < step.minimumWidth or target.bottom - target.top < step.minimumHeight then return false end
    local function contains(rect)
      return target.left >= rect.left and target.top >= rect.top and target.right <= rect.right and target.bottom <= rect.bottom
    end
    if not contains(value.safeArea) then return false end
    for _, rect in ipairs(value.clips) do if not contains(rect) then return false end end
    return true
  end
  local success, problem = xpcall(function()
    if not run:IsClient() or gameModel.PlaceId ~= 0 or gameModel.GameId ~= 0 then fail("UNSUPPORTED_TOOL") end
    player = players.LocalPlayer
    if not player then fail("UNSUPPORTED_TOOL") end
    character = player.Character
    root = if character then character:FindFirstChild("HumanoidRootPart") else nil
    gui = player:FindFirstChildOfClass("PlayerGui")
    if not root or not gui then fail("UNSUPPORTED_TOOL") end
    context()
    -- Preflight the whole plan before creating input or running an earlier key
    -- step, so an unsupported later click cannot cause partial input effects.
    for _, step in ipairs(plan.steps) do
      if step.kind == "click-gui" then
        local ok, value = pcall(function()
          local workspace = gameModel:GetService("Workspace")
          local value = {workspace = workspace, guiService = gameModel:GetService("GuiService"), camera = workspace.CurrentCamera}
          if not value.camera then return nil end
          value.width, value.height = clickBasis(value)
          return if value.width then value else nil
        end)
        if not ok or not value then fail("UNSUPPORTED_TOOL") end
        clickContext = value
        break
      end
    end
    for _, step in ipairs(plan.steps) do
      if step.kind == "assert-gui-layout" then
        local ok, value = pcall(function()
          local workspace = gameModel:GetService("Workspace")
          local value = {workspace = workspace, guiService = gameModel:GetService("GuiService"), camera = workspace.CurrentCamera}
          if not value.camera then return nil end
          value.safeArea, value.viewport = layoutBasis(value)
          return value
        end)
        if not ok or not value then fail("UNSUPPORTED_TOOL") end
        layoutContext = value
        break
      end
    end
    for _, selector in ipairs(plan.targets) do
      local parent = gui
      local chain = {}
      for _, segment in ipairs(selector.segments) do
        guard()
        local found, count = nil, 0
        local children = parent:GetChildren()
        if #children > 512 then fail("UNSUPPORTED_TOOL") end
        for _, child in ipairs(children) do if child.Name == segment then found = child; count += 1 end end
        if count ~= 1 then fail("BINDING_CHANGED") end
        links[#links + 1] = {instance = found, parent = parent, name = found.Name, className = found.ClassName}
        chain[#chain + 1] = found
        parent = found
      end
      if parent.ClassName ~= selector.className or not parent:IsDescendantOf(gui) then fail("BINDING_CHANGED") end
      targets[selector.id] = parent
      targetLinks[selector.id] = chain
    end
    -- Validate every layout's supported geometry before any earlier input step.
    for _, step in ipairs(plan.steps) do if step.kind == "assert-gui-layout" then measureLayout(step.targetId) end end
    local attributeBaselines = {}
    for index, step in ipairs(plan.steps) do
      if step.kind == "assert-player-attribute" then
        guard()
        attributeBaselines[index] = readAttribute(step.attribute)
        guard()
      end
    end
    for _, step in ipairs(plan.steps) do
      if step.kind == "hold-key" or step.kind == "click-gui" then
        local available, value = pcall(function() return userInput:CreateVirtualInput() end)
        if not available or not value then fail("UNSUPPORTED_TOOL") end
        input = value
        break
      end
    end
    local initial = root.Position
    -- Establish each transition's initial state before any scenario input. An
    -- already satisfied postcondition cannot prove an interaction changed it.
    for index, step in ipairs(plan.steps) do
      if step.kind == "assert-player-attribute" and step.requireTransition then
        local baseline = attributeBaselines[index]
        if baseline.present and baseline.value == step.equals then
          active = index
          rows[index].attribute = {context = "Client", subject = "LocalPlayer", name = step.attribute, baseline = baseline, observed = baseline}
          rows[index].observed = false
          fail("ASSERTION_FAILED")
        end
      end
      if step.kind == "assert-gui" or step.kind == "assert-text" then
        local target = targets[step.targetId]
        local value = if step.kind == "assert-text" then target.Text else target.Visible
        rows[index].baseline = if type(value)=="string" and #value>256 then "text-exceeds-report-bound" else value
        if step.requireTransition and value == step.equals then
          active = index; rows[index].observed = "already-satisfied"; fail("ASSERTION_FAILED")
        end
      end
    end
    for index, step in ipairs(plan.steps) do
      guard(); active = index
      local row = rows[index]
      if step.kind == "hold-key" then
        if userInput:GetFocusedTextBox() ~= nil or userInput:IsKeyDown(Enum.KeyCode[step.key]) then fail("UNSUPPORTED_TOOL") end
        local state = {releaseAttempted = false}; keys[step.key] = state; attempted = true
        input:SendKey(true, Enum.KeyCode[step.key], false)
        local untilAt = os.clock() + step.holdMs / 1000
        while os.clock() < untilAt do pause(math.min(0.025, untilAt - os.clock())) end
        releaseKey(step.key, state)
        if keys[step.key] then fail("EFFECT_UNKNOWN") end
        row.observed = "observed-released"
      elseif step.kind == "click-gui" then
        local target = targets[step.targetId]
        if not target.Visible or not target.Active or not target:IsDescendantOf(gui) then fail("ASSERTION_FAILED") end
        local point = target.AbsolutePosition + target.AbsoluteSize / 2
        if not clickContext or not bounded(point.X) or not bounded(point.Y)
          or point.X < 0 or point.Y < 0 or point.X >= clickContext.width or point.Y >= clickContext.height
          or not bounded(target.AbsoluteSize.X) or not bounded(target.AbsoluteSize.Y)
          or target.AbsoluteSize.X <= 0 or target.AbsoluteSize.Y <= 0 then fail("UNSUPPORTED_TOOL") end
        local top = gui:GetGuiObjectsAtPosition(math.floor(point.X), math.floor(point.Y))[1]
        if not top or top ~= target and not top:IsDescendantOf(target) then fail("BINDING_CHANGED") end
        local recipient = top
        for _ = 1, 16 do
          if recipient == target then break end
          if not recipient or recipient:IsA("GuiButton") or recipient:IsA("TextBox") or recipient.Active then fail("BINDING_CHANGED") end
          recipient = recipient.Parent
        end
        if recipient ~= target then fail("BINDING_CHANGED") end
        if userInput:IsMouseButtonPressed(Enum.UserInputType.MouseButton1) then fail("UNSUPPORTED_TOOL") end
        guard()
        mouse = {position = point, releaseAttempted = false}; attempted = true
        input:SendMouseButton(point, Enum.UserInputType.MouseButton1, true, 0)
        pause(0.025)
        releaseMouse(mouse)
        if mouse then fail("EFFECT_UNKNOWN") end
        row.observed = "observed-released"
      elseif step.kind == "assert-player-attribute" then
        local untilAt = math.min(deadline, os.clock() + step.withinMs / 1000)
        repeat
          guard()
          local value = readAttribute(step.attribute)
          guard()
          row.attribute = {context = "Client", subject = "LocalPlayer", name = step.attribute,
            baseline = attributeBaselines[index], observed = value}
          row.observed = attributePasses(step, row.attribute)
          if row.observed then break end
          if os.clock() >= untilAt then fail("ASSERTION_FAILED") end
          pause(math.min(0.025, untilAt - os.clock()))
        until false
      elseif step.kind == "assert-gui-layout" then
        local untilAt = math.min(deadline, os.clock() + step.withinMs / 1000)
        repeat
          guard()
          local value = measureLayout(step.targetId)
          guard()
          row.layout = value; row.observed = layoutPasses(step, value)
          if row.observed then break end
          if os.clock() >= untilAt then fail("ASSERTION_FAILED") end
          pause(math.min(0.025, untilAt - os.clock()))
        until false
      elseif step.kind == "assert-displacement" then
        local delta = root.Position - initial
        row.observed = math.sqrt(delta.X * delta.X + delta.Z * delta.Z)
        if row.observed < step.minimumStuds then fail("ASSERTION_FAILED") end
      else
        local target = targets[step.targetId]
        local untilAt = math.min(deadline, os.clock() + step.withinMs / 1000)
        repeat
          guard()
          local observed = if step.kind == "assert-text" then target.Text else target.Visible
          row.observed = if type(observed) == "string" and #observed > 256 then "text-exceeds-report-bound" else observed
          if observed == step.equals then break end
          if os.clock() >= untilAt then fail("ASSERTION_FAILED") end
          pause(math.min(0.025, untilAt - os.clock()))
        until false
      end
      row.outcome = "passed"; active = nil
    end
  end, function(value) return value end)
  -- Attempt the SAME original object's releases once, including a press whose
  -- native call threw after dispatch. No fresh input object or release replay.
  for key, state in pairs(keys) do releaseKey(key, state) end
  if mouse then releaseMouse(mouse) end
  for _ in pairs(keys) do released = false end
  if mouse then released = false end
  local code = if success then "OK" elseif type(problem) == "table" and type(problem.arcaneCode) == "string" then problem.arcaneCode
    elseif attempted then "EFFECT_UNKNOWN" else "UNSUPPORTED_TOOL"
  local outcome = if success then "passed" elseif code == "UNSUPPORTED_TOOL" then "unsupported" elseif code == "EFFECT_UNKNOWN" then "unknown" else "failed"
  if active then rows[active].outcome = "failed" end
  if success and not released then code = "EFFECT_UNKNOWN"; outcome = "unknown" end
  return {version = 1, runId = runId, scenarioDigest = scenarioDigest, code = code, outcome = outcome,
    inputRelease = if not attempted then "not_started" elseif released then "observed_released" else "unknown", steps = rows}
end`;

/** Byte-only literals avoid interpolating user strings as Luau syntax, including
 * quotes, Unicode and long-bracket delimiters. The fixed program owns execution. */
function literal(value: string): string {
  const bytes = Buffer.from(value, 'utf8'), chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += 64) chunks.push('string.char(' + [...bytes.subarray(at, at + 64)].join(',') + ')');
  return chunks.length ? chunks.join(' .. ') : '""';
}
export function buildScenarioProgram(plan: ScenarioPlan, runId: string, scenarioDigest: string): string {
  const parsed = scenarioPlanSchema.parse(plan);
  if (!/^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(runId) || !/^[a-f0-9]{64}(?![\s\S])/.test(scenarioDigest)) throw new Error('Invalid private scenario identity.');
  return 'local execute = ' + SCENARIO_RUNTIME_SOURCE + '\nreturn execute(game, game:GetService("HttpService"):JSONDecode(' +
    literal(JSON.stringify({ ...parsed, temporaryEdits: undefined })) + '), ' + literal(runId) + ', ' + literal(scenarioDigest) + ')';
}
