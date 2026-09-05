// Prelude de compatibilite universelle - injecte au debut du build.
// Pure ADDITION: le corps du script utilisateur reste identique octet par octet.
// Toutes les globals non universales y sont definies avec des fallbacks + degradations.

function buildPrelude() {
  return `-- [compat prelude]
local __EXEC_NAME = (identifyexecutor and identifyexecutor()) or "Unknown"
local __HAS = {}
local function __detect(names)
  for _, n in ipairs(names) do
    local v = rawget(getfenv and getfenv(0) or _G, n)
    if type(v) ~= "nil" then return true end
  end
  return false
end

-- Detection brute des fonctions
local function __getglobal(name)
  local ok, v = pcall(function() return rawget(_G, name) end)
  return ok and v or nil
end

-- ===== HTTP =====
if not request then
  request = __getglobal("http_request") or (__getglobal("syn") and syn.request) or (__getglobal("http") and http.request) or (__getglobal("fluxus") and fluxus.request)
  if not request then
    request = function(opts)
      error("[compat] Cet executor n'a pas de fonction HTTP - impossible d'utiliser request()")
    end
  end
end
if not http_request then http_request = request end
if syn and not syn.request then syn.request = request end
if http and not http.request then http.request = request end

-- ===== CLIPBOARD =====
if not setclipboard then
  setclipboard = __getglobal("toclipboard") or (__getglobal("syn") and syn.set_clipboard) or function(text)
    -- Degradation: GUI de copie manuelle
    local ok, err = pcall(function()
      local Players = game:GetService("Players")
      local lp = Players.LocalPlayer
      local pg = lp:FindFirstChild("PlayerGui") or lp:WaitForChild("PlayerGui")
      local g = Instance.new("ScreenGui")
      g.Name = "CompatClipboard"
      g.Parent = pg
      local f = Instance.new("Frame")
      f.Size = UDim2.new(0, 460, 0, 160)
      f.Position = UDim2.new(0.5, -230, 0.5, -80)
      f.BackgroundColor3 = Color3.fromRGB(24, 24, 28)
      f.BorderSizePixel = 0
      f.Active = true
      f.Draggable = true
      f.Parent = g
      local tb = Instance.new("TextButton")
      tb.Size = UDim2.new(1, -20, 1, -60)
      tb.Position = UDim2.new(0, 10, 0, 40)
      tb.BackgroundColor3 = Color3.fromRGB(36, 36, 42)
      tb.TextColor3 = Color3.fromRGB(235, 235, 240)
      tb.TextSize = 14
      tb.TextWrapped = true
      tb.TextXAlignment = Enum.TextXAlignment.Left
      tb.TextYAlignment = Enum.TextYAlignment.Top
      tb.Text = text
      tb.AutoButtonColor = false
      tb.Parent = f
      local t = Instance.new("TextLabel")
      t.Size = UDim2.new(1, -20, 0, 26)
      t.Position = UDim2.new(0, 10, 0, 8)
      t.BackgroundTransparency = 1
      t.TextColor3 = Color3.fromRGB(160, 160, 170)
      t.TextSize = 13
      t.Text = "Copie manuellement (presque un presse-papier):"
      t.Parent = f
      local close = Instance.new("TextButton")
      close.Size = UDim2.new(0, 24, 0, 24)
      close.Position = UDim2.new(1, -28, 0, 4)
      close.Text = "X"
      close.TextSize = 12
      close.BackgroundColor3 = Color3.fromRGB(200, 60, 60)
      close.TextColor3 = Color3.fromRGB(255, 255, 255)
      close.Parent = f
      close.MouseButton1Click:Connect(function() g:Destroy() end)
      task.delay(60, function() if g.Parent then g:Destroy() end end)
    end)
  end
end
if not toclipboard then toclipboard = setclipboard end

-- ===== HWID =====
if not gethwid then
  gethwid = function()
    local ok, id = pcall(function()
      return game:GetService("Players").LocalPlayer.UserId
    end)
    return ok and tostring(id) or "unknown"
  end
end

-- ===== GENV =====
if not getgenv then getgenv = function() return _G end end

-- ===== FILES (degradation memoire) =====
do
  local memfs = {}
  local orig_writefile = writefile
  local orig_readfile = readfile
  local orig_isfile = isfile
  local orig_listfiles = listfiles

  if not orig_writefile then
    writefile = function(path, content)
      memfs[tostring(path)] = tostring(content)
    end
  end
  if not orig_readfile then
    readfile = function(path)
      return memfs[tostring(path)]
    end
  end
  if not orig_isfile then
    isfile = function(path)
      return memfs[tostring(path)] ~= nil
    end
  end
  if not orig_listfiles then
    listfiles = function(folder)
      local out = {}
      local prefix = tostring(folder or "")
      for k in pairs(memfs) do
        if k:sub(1, #prefix) == prefix then table.insert(out, k) end
      end
      return out
    end
  end
end

-- ===== DRAWING -> Frames (degradation mobile) =====
if not Drawing or not Drawing.new then
  local Players = game:GetService("Players")
  local CoreGui = game:GetService("CoreGui")
  local parent = (select(2, pcall(function() return CoreGui end)) and CoreGui) or Players.LocalPlayer and Players.LocalPlayer:FindFirstChild("PlayerGui")
  if parent then
    local __drawingParent = Instance.new("ScreenGui")
    __drawingParent.Name = "CompatDrawing_" .. tostring(math.floor(tick() * 1000))
    pcall(function() __drawingParent.Parent = parent end)

    local function clearFallback(obj, className)
      if obj.Remove then return end
      obj.Remove = function(o) o:Destroy() end
    end

    local function makeDrawObj(class, props)
      local guiObj
      if class == "Line" then
        guiObj = Instance.new("Frame")
        guiObj.BorderSizePixel = 0
        guiObj.BackgroundColor3 = props.Color or Color3.new(1, 1, 1)
        guiObj.BackgroundTransparency = props.Transparency ~= nil and (1 - props.Transparency) or 0
      elseif class == "Text" then
        guiObj = Instance.new("TextLabel")
        guiObj.BackgroundTransparency = props.Background ~= nil and (1 - props.Background) or 1
        guiObj.TextColor3 = props.Color or Color3.new(1, 1, 1)
        guiObj.TextSize = props.Size or 14
        guiObj.Font = (props.Font and Enum.Font[props.Font]) or Enum.Font.SourceSans
        guiObj.TextXAlignment = Enum.TextXAlignment.Left
        guiObj.TextYAlignment = Enum.TextYAlignment.Top
        guiObj.Text = props.Text or ""
      elseif class == "Circle" then
        guiObj = Instance.new("Frame")
        guiObj.BorderSizePixel = 0
        guiObj.BackgroundColor3 = props.Color or Color3.new(1, 1, 1)
        guiObj.Size = UDim2.fromOffset(props.Radius and props.Radius * 2 or 4, props.Radius and props.Radius * 2 or 4)
        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(1, 0)
        corner.Parent = guiObj
      elseif class == "Square" then
        guiObj = Instance.new("Frame")
        guiObj.BorderSizePixel = 0
        guiObj.BackgroundColor3 = props.Color or Color3.new(1, 1, 1)
      elseif class == "Image" then
        guiObj = Instance.new("ImageLabel")
        guiObj.BackgroundTransparency = 1
      else
        guiObj = Instance.new("Frame")
        guiObj.BackgroundTransparency = 1
      end
      guiObj.Visible = false
      pcall(function() guiObj.Parent = __drawingParent end)
      return guiObj
    end

    local DrawAPI
    DrawAPI = {}
    DrawAPI.new = function(class)
      local obj = makeDrawObj(class, {})
      local proxy = setmetatable({}, {
        __index = function(_, k)
          if k == "Remove" or k == "Destroy" then return function() obj:Destroy() end end
          if k == "Update" then return function() end end
          local v = obj[k]
          if type(v) == "function" then return function(_, ...) return v(obj, ...) end end
          return v
        end,
        __newindex = function(_, k, v)
          if k == "Color" and obj:IsA("TextLabel") then obj.TextColor3 = v return end
          if k == "Color" and obj:IsA("Frame") then obj.BackgroundColor3 = v return end
          if k == "Transparency" then
            if obj:IsA("Frame") then obj.BackgroundTransparency = v else obj.TextTransparency = v end
            return
          end
          if k == "Text" then obj.Text = v return end
          if k == "Size" and obj:IsA("TextLabel") then obj.TextSize = v return end
          if k == "Font" then pcall(function() obj.Font = Enum.Font[v] end) return end
          if k == "Visible" then obj.Visible = v return end
          if k == "Position" then
            if typeof(v) == "Vector2" then
              obj.Position = UDim2.fromOffset(v.X, v.Y)
            else
              obj.Position = v
            end
            return
          end
          if k == "Thickness" then return end
          if k == "Radius" then return end
          if k == "Filled" then return end
          rawset(obj, k, v)
        end,
      })
      return proxy
    end

    Drawing = { new = DrawAPI.new }
    if not Drawing.Fonts then
      Drawing.Fonts = { Mono = "SourceSansSemibold" }
    end
  end
end

-- ===== HOOKING =====
if not hookfunction then
  hookfunction = __getglobal("replaceclosure")
end
if not hookmetamethod then
  hookmetamethod = function() error("[compat] hookmetamethod non disponible sur cet executor") end
end
if not clonefunction then
  clonefunction = __getglobal("syn") and syn.clonefunction or function(f) return f end
end

-- ===== TELEPORT =====
if not queue_on_teleport then
  queue_on_teleport = (__getglobal("syn") and syn.queue_on_teleport) or __getglobal("teleportqueue") or function() end
end

-- ===== META =====
if not identifyexecutor then
  identifyexecutor = function() return __EXEC_NAME end
end
if not isexecutorclosure then isexecutorclosure = function() return false end end
if not checkcaller then checkcaller = function() return true end end

-- ===== WEBSOCKET =====
if not WebSocket then
  WebSocket = (__getglobal("syn") and syn.websocket) or {
    connect = function()
      error("[compat] WebSocket non disponible sur cet executor")
    end,
  }
end

-- ===== RENDER PROPERTIES =====
if not setrenderproperty then
  setrenderproperty = function(obj, prop, value)
    local ok = pcall(function()
      obj[prop] = value
    end)
    if not ok then
      pcall(function()
        if prop == "FieldOfView" and obj:IsA("Camera") then obj.FieldOfView = value end
      end)
    end
  end
end
if not getrenderproperty then
  getrenderproperty = function(obj, prop)
    local v
    pcall(function() v = obj[prop] end)
    return v
  end
end


-- [end compat prelude]

`;
}

module.exports = { buildPrelude };
