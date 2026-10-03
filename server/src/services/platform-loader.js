'use strict';
const fs=require('fs'),path=require('path');
const builtin=fs.readFileSync(path.join(__dirname,'platform-key-ui.lua'),'utf8');
const palettes={violet:[139,92,246],blue:[59,130,246],green:[34,197,94],rose:[244,63,94],amber:[245,158,11]};
function core(projectId,baseUrl,target={}){
  return `-- AUDIT HUB client SDK. Dot calls: validate(key), load(key), getKeyUrl().
local request = request or http_request or (syn and syn.request) or (http and http.request)
local HttpService = game:GetService("HttpService")
local client = {}
local loading, loaded = false, false
local claimUrl = ${target.claimUrl?JSON.stringify(target.claimUrl):'nil'}
local hwid
pcall(function() if gethwid then hwid = tostring(gethwid()) end end)
if not hwid or #hwid < 8 then pcall(function() hwid = game:GetService("RbxAnalyticsService"):GetClientId() end) end
local executor = "Unknown"
pcall(function() if identifyexecutor then executor = tostring(identifyexecutor()) end end)
function client.getKeyUrl() return claimUrl end
local function check(key, withScript)
  ${target.targetMode==='single'&&Number.isSafeInteger(target.placeId)&&target.placeId>0?`if not (game.PlaceId == ${target.placeId}) then return {success=false,reason="wrong_place"} end`:'-- Universal release.'}
  if type(key) ~= "string" then return {success=false,reason="missing_key"} end
  key = key:gsub("%s+", "")
  if #key == 0 or #key > 200 then return {success=false,reason="missing_key"} end
  if type(request) ~= "function" then return {success=false,reason="unsupported_executor"} end
  local ok, response = pcall(function()
    return request({Url=${JSON.stringify(baseUrl+'/api/platform/v1/check')},Method="POST",
      Headers={["Content-Type"]="application/json"},
      Body=HttpService:JSONEncode({projectId=${JSON.stringify(projectId)},key=key,hwid=hwid,executor=executor,loadScript=withScript})})
  end)
  if not ok or not response then return {success=false,reason="network_error"} end
  local parsed, data = pcall(function()
    local raw = type(response)=="string" and response or response.Body
    return type(raw)=="table" and raw or HttpService:JSONDecode(raw)
  end)
  if not parsed or type(data)~="table" then return {success=false,reason="invalid_response"} end
  if data.success ~= true then return {success=false,reason=data.reason or "validation_failed"} end
  return data
end
function client.validate(key)
  local data = check(key, false)
  return {success=data.success==true,reason=data.reason}
end
function client.load(key)
  if loading then return false, "busy" end
  if loaded then return false, "already_loaded" end
  loading = true
  local checked, data = pcall(check, key, true)
  if not checked or type(data)~="table" then loading=false return false,"network_error" end
  if data.success~=true then loading=false return false,data.reason or "validation_failed" end
  if type(data.script)~="string" then loading=false return false,"no_script" end
  if type(loadstring)~="function" then loading=false return false,"unsupported_executor" end
  local compiled, fn = pcall(loadstring, data.script)
  if not compiled or type(fn)~="function" then loading=false return false,"compile_error" end
  loaded=true
  loading=false
  -- Successful return means validated and compiled; runtime errors remain possible.
  task.defer(function() local ok=pcall(fn) if not ok then warn("AUDIT HUB: script runtime error.") end end)
  return true
end
`;
}
function sdk(projectId,baseUrl,target={}){return core(projectId,baseUrl,target)+'\nreturn client\n';}
function loader(projectId,baseUrl,target={}){
  const shared=core(projectId,baseUrl,target);
  if(target.keyUiMode==='builtin'){
    const layout=['compact','card','sidebar'].includes(target.keyUiLayout)?target.keyUiLayout:'compact';
    const rgb=Object.hasOwn(palettes,target.keyUiColor)?palettes[target.keyUiColor]:palettes.violet;
    const buttonHeight={small:32,medium:40,large:48}[target.keyUiButtonSize]||40;
    return shared+`\nlocal layout=${JSON.stringify(layout)}\nlocal accent=Color3.fromRGB(${rgb.join(',')})\nlocal buttonHeight=${buttonHeight}\n`+builtin;
  }
  return shared+`
-- Custom GUI / legacy loader: Set getgenv().AUDIT_KEY before running.
local env = getgenv and getgenv() or _G
local key = env.AUDIT_KEY
assert(type(key)=="string" and #key>0,"Set getgenv().AUDIT_KEY to your project key first.")
local ok, reason = client.load(key)
assert(ok,"AUDIT HUB: " .. tostring(reason))
return ok
`;
}
module.exports={loader,sdk};
