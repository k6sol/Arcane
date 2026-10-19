--!strict
-- Engine double owned by this test: one oriented box, uniform ScaleTo and Y yaw.
-- No Studio or native scene is read or changed. The runner prepends AssetPlacement.
local count = 0
local function check(condition: boolean, label: string): () assert(condition, label); count += 1 end
local function close(a: number, b: number, label: string): () check(math.abs(a-b) < 1e-7, label .. ': ' .. a .. ' != ' .. b) end
local identity = {0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1}
local Vector3: any = {new = function(x: number, y: number, z: number): any return {X=x, Y=y, Z=z} end}
local CFrame: any = {}
local meta: any = {}; meta.__index = meta
local function frame(c: {number}): any return setmetatable({c=c},meta) end
function CFrame.new(x: number?, y: number?, z: number?): any return frame({x or 0,y or 0,z or 0,1,0,0,0,1,0,0,0,1}) end
function CFrame.Angles(_x: number, yaw: number, _z: number): any
  local c,s=math.cos(yaw),math.sin(yaw);return frame({0,0,0,c,0,s,0,1,0,-s,0,c})
end
function meta:GetComponents(): ...number return table.unpack(self.c) end
meta.__mul = function(a: any,b: any): any
  local x,y=a.c,b.c
  local r={x[1]+x[4]*y[1]+x[5]*y[2]+x[6]*y[3],x[2]+x[7]*y[1]+x[8]*y[2]+x[9]*y[3],x[3]+x[10]*y[1]+x[11]*y[2]+x[12]*y[3]}
  for row=0,2 do for column=0,2 do r[4+row*3+column]=x[4+row*3]*y[4+column]+x[5+row*3]*y[7+column]+x[6+row*3]*y[10+column] end end
  return frame(r)
end
-- The module closes over these names when the runner wraps it below this fixture.


local function runPlacement(yaw: number, size: any, maxSize: {number}?, initial: any?): any
  local part: any={Anchored=false,Parent=true,Name='Box'}
  function part:IsA(class: string): boolean return class=='BasePart' end
  local box: any={Name='OwnedBox',ClassName='Model',Parent=true,_size=size,_scale=1,_frame=initial or CFrame.new(4,5,6)}
  function box:IsA(class: string): boolean return class=='Model' end
  function box:GetDescendants(): {any} return {part} end
  function box:GetBoundingBox(): (any,any) return self._frame,self._size end
  function box:GetScale(): number return self._scale end
  function box:ScaleTo(scale: number): ()
    local ratio=scale/self._scale; self._size=Vector3.new(self._size.X*ratio,self._size.Y*ratio,self._size.Z*ratio); self._scale=scale
  end
  function box:PivotTo(target: any): ()
    local old=self.WorldPivot.c; local center=self._frame.c
    local delta=CFrame.new(center[1]-old[1],center[2]-old[2],center[3]-old[3])
    local rotated=target*delta
    local orientation=target*frame({0,0,0,center[4],center[5],center[6],center[7],center[8],center[9],center[10],center[11],center[12]})
    orientation.c[1],orientation.c[2],orientation.c[3]=rotated.c[1],rotated.c[2],rotated.c[3]
    self._frame=orientation;self.WorldPivot=target
  end
  local container={};local registry: any={owned={}}
  function registry:resolve(_ref: string): any return container end
  function registry:root(_name: string): any return {} end
  function registry:ref(_box: any): string return 'owned' end
  local ops: any={registry=registry}
  function ops:record(_command: any,_guard: any,callback: any): any return callback({}) end
  local placed=AssetPlacement.adopt(ops,{}, {parent='parent'},function() end,box,container,'Placed',maxSize,{20,3,-7},yaw,false,true,false,true,'offline')
  local measured=AssetPlacement.worldExtents({box._frame:GetComponents()},box._size)
  for i=1,3 do
    close(placed.size[i],measured[i],'receipt reports final-yaw extents')
    if maxSize then check(measured[i]<=maxSize[i]+1e-7,'final-yaw fit stays within cap') end
  end
  close(box._frame.c[2]-measured[2]/2,3,'floor stays at target')
  close(box._frame.c[1],20,'XZ centre X');close(box._frame.c[3],-7,'XZ centre Z')
  return placed
end

local placed=runPlacement(90,Vector3.new(10,2,2),{10,10,2})
close(placed.scale,.2,'yaw-aware fit scale')
close(placed.size[1],.4,'final X');close(placed.size[3],2,'final Z')
runPlacement(0,Vector3.new(10,2,2),{10,10,2})
runPlacement(37,Vector3.new(10,2,2),{8,6,3})
runPlacement(-71,Vector3.new(10,2,2),nil)

-- Existing box orientation and requested yaw compose before absolute extents.
-- A pre-rotated thin box turns back to identity: rotating its world AABB again
-- would overestimate and shrink it unnecessarily.
local rootRotation=CFrame.Angles(0,math.rad(45),0)
rootRotation.c[1],rootRotation.c[2],rootRotation.c[3]=4,5,6
local unrotate=runPlacement(-45,Vector3.new(10,2,2),{10,10,2},rootRotation)
close(unrotate.scale,1,'existing OBB yaw cancels requested yaw')

print('YAW_REGRESSION_OK '..count..' checks')
