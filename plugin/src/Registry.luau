--!strict
local V = require(script.Parent.Validation)
local Registry = {}
Registry.__index = Registry
type Registry = any

function Registry.new(sessionId: string, roots: {string}, gameModel: any, http: any): Registry
	local services: {[string]: any} = {}
	for _, root in ipairs(roots) do services[root] = gameModel:GetService(root) end
	return setmetatable({sessionId = sessionId, services = services, gameModel = gameModel, http = http,
		byId = {}, byInstance = {}, owned = {}, count = 0}, Registry)
end

function Registry:rootOf(instance: any): string?
	for root, service in pairs(self.services) do
		if instance == service or instance:IsDescendantOf(service) then return root end
	end
	return nil
end

function Registry:root(name: any): any
	if type(name) ~= "string" or not self.services[name] then V.fail("GRANT", "Root is not granted.") end
	return self.services[name]
end

function Registry:isService(instance: any): boolean
	-- Class tags are not exposed to plugins; IsA(Service) is not a valid test.
	return instance.Parent == self.gameModel or table.find(V.ROOTS, instance.ClassName) ~= nil
end

function Registry:ref(instance: any): any
	local root = self:rootOf(instance)
	if not root then V.fail("REF", "Instance is outside granted roots.") end
	local id = self.byInstance[instance]
	if not id then
		if self.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
		id = self.http:GenerateGUID(false)
		self.byInstance[instance] = id
		self.byId[id] = instance
		self.count += 1
	end
	local path: {string} = {}
	local cursor = instance
	while cursor and cursor ~= self.services[root] do
		if #path >= 63 then V.fail("REF", "Instance hierarchy is too deep.") end
		table.insert(path, 1, V.string(cursor.Name, "instance name", 256, true))
		cursor = cursor.Parent
	end
	-- Root services have an empty display path; descendant paths are relative.
	return {instanceId = id, sessionId = self.sessionId, root = root,
		pathSegments = V.array(path), className = instance.ClassName}
end

function Registry:resolve(value: any): any
	local ref = V.fields(value, {"instanceId", "sessionId", "root", "pathSegments", "className"}, "reference")
	V.string(ref.instanceId, "instance ID", 256)
	V.string(ref.className, "class name", 256)
	local path = V.list(ref.pathSegments, 64, "display path")
	for _, segment in ipairs(path) do V.string(segment, "display path segment", 256, true) end
	if ref.sessionId ~= self.sessionId then V.fail("SESSION", "Reference belongs to another session.") end
	local instance = self.byId[ref.instanceId]
	if not instance or self:rootOf(instance) ~= ref.root or instance.ClassName ~= ref.className then
		V.fail("REF", "Reference is unknown, removed, moved outside its root, or has the wrong class.")
	end
	-- pathSegments are deliberately never used for resolution.
	return instance
end

function Registry:node(instance: any): any
	return {ref = self:ref(instance), name = V.string(instance.Name, "instance name", 256, true),
		className = instance.ClassName, childCount = #instance:GetChildren()}
end

return Registry
