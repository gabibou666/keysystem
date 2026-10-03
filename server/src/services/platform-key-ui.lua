-- Locally bundled Roblox GUI; no third-party UI library is downloaded.
local gui = Instance.new("ScreenGui")
gui.Name = "AuditHubKey"
gui.ResetOnSpawn = false
gui.DisplayOrder = 100
local parented = pcall(function() gui.Parent = game:GetService("CoreGui") end)
if not parented then
  local player = game:GetService("Players").LocalPlayer
  assert(player, "AUDIT HUB: no local player.")
  gui.Parent = player:WaitForChild("PlayerGui", 10)
  assert(gui.Parent, "AUDIT HUB: GUI unavailable.")
end
local function make(class, props, parent)
  local object = Instance.new(class)
  for key, value in pairs(props) do object[key] = value end
  object.Parent = parent
  return object
end
local function round(object, radius)
  make("UICorner", {CornerRadius=UDim.new(0, radius or 10)}, object)
end
local compact = layout == "compact"
local sidebar = layout == "sidebar"
local width = sidebar and 520 or (compact and 360 or 420)
local height = compact and (190 + buttonHeight) or (236 + buttonHeight)
local frame = make("Frame", {AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.fromScale(0.5,0.5),Size=UDim2.fromOffset(width,height),BackgroundColor3=Color3.fromRGB(19,19,29),BorderSizePixel=0}, gui)
round(frame, 14)
local scale = make("UIScale", {Scale=1}, frame)
local camera = workspace.CurrentCamera
local function fit()
  if camera then scale.Scale=math.min(1, math.max(0.1,(camera.ViewportSize.X-24)/width),math.max(0.1,(camera.ViewportSize.Y-24)/height)) end
end
fit()
local resizeConnection = camera and camera:GetPropertyChangedSignal("ViewportSize"):Connect(fit)
local closed = false
local function close()
  if closed then return end
  closed=true
  if resizeConnection then resizeConnection:Disconnect() end
  gui:Destroy()
end
local left = sidebar and 150 or 20
if sidebar then
  local rail=make("Frame", {Size=UDim2.new(0,130,1,0),BackgroundColor3=accent,BorderSizePixel=0},frame)
  round(rail,14)
  make("TextLabel", {Position=UDim2.fromOffset(14,24),Size=UDim2.new(1,-28,0,70),BackgroundTransparency=1,Text="AUDIT\nHUB",TextColor3=Color3.fromRGB(16,16,24),TextSize=24,Font=Enum.Font.GothamBold,TextXAlignment=Enum.TextXAlignment.Left},rail)
end
make("TextLabel", {Position=UDim2.fromOffset(left,18),Size=UDim2.new(1,-left-50,0,28),BackgroundTransparency=1,Text="Unlock your script",TextColor3=Color3.new(1,1,1),TextSize=compact and 18 or 22,Font=Enum.Font.GothamBold,TextXAlignment=Enum.TextXAlignment.Left},frame)
local exit=make("TextButton", {Position=UDim2.new(1,-44,0,12),Size=UDim2.fromOffset(32,32),BackgroundTransparency=1,Text="X",TextSize=18,TextColor3=Color3.fromRGB(180,180,200),Font=Enum.Font.Gotham},frame)
exit.Activated:Connect(close)
local inputY=compact and 58 or 94
if not compact then
  make("TextLabel", {Position=UDim2.fromOffset(left,49),Size=UDim2.new(1,-left-20,0,30),BackgroundTransparency=1,Text="Paste your key to continue.",TextColor3=Color3.fromRGB(170,170,190),TextSize=14,Font=Enum.Font.Gotham,TextXAlignment=Enum.TextXAlignment.Left},frame)
end
local input=make("TextBox", {Position=UDim2.fromOffset(left,inputY),Size=UDim2.new(1,-left-20,0,42),BackgroundColor3=Color3.fromRGB(31,31,45),BorderSizePixel=0,Text="",PlaceholderText="Your key",TextColor3=Color3.new(1,1,1),PlaceholderColor3=Color3.fromRGB(140,140,160),TextSize=14,ClearTextOnFocus=false,Font=Enum.Font.Gotham},frame)
round(input,8)
local buttonsY=inputY+54
local unlock=make("TextButton", {Position=UDim2.fromOffset(left,buttonsY),Size=UDim2.new(0.5,-left/2-16,0,buttonHeight),BackgroundColor3=accent,BorderSizePixel=0,Text="Unlock",TextColor3=Color3.fromRGB(16,16,24),TextSize=14,Font=Enum.Font.GothamBold},frame)
round(unlock,8)
local getKey=make("TextButton", {Position=UDim2.new(0.5,left/2+4,0,buttonsY),Size=UDim2.new(0.5,-left/2-24,0,buttonHeight),BackgroundColor3=Color3.fromRGB(40,40,57),BorderSizePixel=0,Text="Get key",TextColor3=Color3.new(1,1,1),TextSize=14,Font=Enum.Font.Gotham},frame)
round(getKey,8)
local status=make("TextLabel", {Position=UDim2.fromOffset(left,buttonsY+buttonHeight+8),Size=UDim2.new(1,-left-20,0,32),BackgroundTransparency=1,Text="",TextColor3=Color3.fromRGB(180,180,200),TextSize=12,TextWrapped=true,Font=Enum.Font.Gotham,TextXAlignment=Enum.TextXAlignment.Left},frame)
local link=make("TextBox", {Position=UDim2.fromOffset(left,height-32),Size=UDim2.new(1,-left-20,0,26),BackgroundTransparency=1,Text="",TextColor3=Color3.fromRGB(180,180,220),TextSize=11,ClearTextOnFocus=false,Visible=false,Font=Enum.Font.Gotham},frame)
getKey.Activated:Connect(function()
  local url=client.getKeyUrl()
  if not url then status.Text="Key page unavailable. Ask the developer for a key." return end
  local copied=false
  if type(setclipboard)=="function" then copied=pcall(setclipboard,url) end
  if copied then status.Text="Link copied. Open it in your browser."
  else link.Text=url link.Visible=true status.Text="Copy the link below into your browser." end
end)
local messages={missing_key="Enter your key.",network_error="Network error. Try again.",invalid_response="Server unavailable. Try again.",unsupported_executor="Your executor is not supported.",wrong_place="Open the correct game first.",expired="Your key expired. Get a new key.",revoked="Your key was revoked.",hwid_mismatch="This key is bound to another device.",compile_error="Script could not start. Contact the developer.",already_loaded="Script already started.",busy="Please wait."}
local busy=false
local function unlockScript()
  if busy or closed then return end
  busy=true
  unlock.Text="Checking..."
  status.Text="Validating your key..."
  task.spawn(function()
    local safe, ok, reason=pcall(client.load,input.Text)
    if closed then return end
    if safe and ok then input.Text="" close() return end
    busy=false
    unlock.Text="Unlock"
    status.Text=messages[reason] or "Key rejected or service unavailable. Try again."
  end)
end
unlock.Activated:Connect(unlockScript)
input.FocusLost:Connect(function(enter) if enter then unlockScript() end end)
return gui
