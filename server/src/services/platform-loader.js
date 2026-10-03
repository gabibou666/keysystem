'use strict';
function loader(projectId, baseUrl) {
  return `-- AUDIT HUB project loader. Set getgenv().AUDIT_KEY before running.
local request = request or http_request or (syn and syn.request) or (http and http.request)
assert(type(request) == "function", "Your executor does not support HTTP requests.")
local HttpService = game:GetService("HttpService")
local env = getgenv and getgenv() or _G
local key = env.AUDIT_KEY
assert(type(key) == "string" and #key > 0, "Set getgenv().AUDIT_KEY to your project key first.")
local hwid
pcall(function() if gethwid then hwid = tostring(gethwid()) end end)
if not hwid or #hwid < 8 then
  pcall(function() hwid = game:GetService("RbxAnalyticsService"):GetClientId() end)
end
local executor = "Unknown"
pcall(function() if identifyexecutor then executor = tostring(identifyexecutor()) end end)
local ok, response = pcall(request, {
  Url = ${JSON.stringify(baseUrl + '/api/platform/v1/check')}, Method = "POST",
  Headers = { ["Content-Type"] = "application/json" },
  Body = HttpService:JSONEncode({projectId = ${JSON.stringify(projectId)}, key = key:gsub("%s+", ""), hwid = hwid, executor = executor, loadScript = true}),
})
assert(ok and response, "AUDIT HUB: network error. Retry in a moment.")
local raw = type(response) == "string" and response or response.Body
local parsed, data = pcall(function() return type(raw) == "table" and raw or HttpService:JSONDecode(raw) end)
assert(parsed and type(data) == "table", "AUDIT HUB: invalid server response.")
assert(data.success, "AUDIT HUB: " .. tostring(data.reason or data.error or "validation failed"))
assert(type(data.script) == "string", "AUDIT HUB: no published script.")
local fn, err = loadstring(data.script)
assert(fn, "AUDIT HUB: script compile error: " .. tostring(err))
return fn()
`;
}
module.exports = { loader };
