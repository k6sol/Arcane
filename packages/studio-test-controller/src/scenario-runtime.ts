import { scenarioPlanSchema, type ScenarioPlan } from './scenario.js';

/** Fixed Client program. Targets are actual engine references held in this one
 * invocation, never attributes or paths reacquired after an input/yield. */
export const SCENARIO_RUNTIME_SOURCE = String.raw`function(gameModel, plan, runId, scenarioDigest)
  local rows = {}
  for _, step in ipairs(plan.steps) do
    local expected = if step.kind == "hold-key" then step.key .. ":" .. tostring(step.holdMs)
      elseif step.kind == "click-gui" then step.targetId
      elseif step.kind == "assert-displacement" then step.minimumStuds else step.equals
    rows[#rows + 1] = {id = step.id, kind = step.kind, outcome = "not_run", expected = expected, observed = "not-observed"}
  end
  local run = gameModel:GetService("RunService")
  local players = gameModel:GetService("Players")
  local userInput = gameModel:GetService("UserInputService")
  local player, character, root, gui, input
  local links, targets, keys = {}, {}, {}
  local mouse = nil
  local clickContext = nil
  local attempted, released, active = false, true, nil
  local started = os.clock()
  local deadline = started + plan.runtimeBudgetMs / 1000
  local samples = 0
  local function fail(code) error({arcaneCode = code}, 0) end
  local function bounded(value)
    return type(value) == "number" and value == value and math.abs(value) <= 16384
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
    local available, value = pcall(function() return userInput:CreateVirtualInput() end)
    if not available or not value then fail("UNSUPPORTED_TOOL") end
    input = value
    for _, selector in ipairs(plan.targets) do
      local parent = gui
      for _, segment in ipairs(selector.segments) do
        guard()
        local found, count = nil, 0
        local children = parent:GetChildren()
        if #children > 512 then fail("UNSUPPORTED_TOOL") end
        for _, child in ipairs(children) do if child.Name == segment then found = child; count += 1 end end
        if count ~= 1 then fail("BINDING_CHANGED") end
        links[#links + 1] = {instance = found, parent = parent, name = found.Name, className = found.ClassName}
        parent = found
      end
      if parent.ClassName ~= selector.className or not parent:IsDescendantOf(gui) then fail("BINDING_CHANGED") end
      targets[selector.id] = parent
    end
    local initial = root.Position
    -- Establish each transition's initial state before any scenario input. An
    -- already satisfied postcondition cannot prove an interaction changed it.
    for index, step in ipairs(plan.steps) do
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
