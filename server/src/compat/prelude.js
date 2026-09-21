// Prelude de compatibilite universelle - injecte au debut du build.
// Pure ADDITION: le corps du script utilisateur reste identique octet par octet.
// Toutes les globals non universales y sont definies avec des fallbacks + degradations.

function buildPrelude(options) {
  // Controle de session (anti-dump). L'adresse publique est injectee a la
  // generation; sans elle, aucun controle n'est ajoute (un build local de
  // developpement doit rester executable tel quel).
  // Une adresse fournie explicitement fait foi, y compris vide: c'est ce qui
  // permet de generer un build SANS controle (developpement, tests).
  const site = String(
    options && typeof options.siteUrl === 'string' ? options.siteUrl : (process.env.PUBLIC_URL || '')
  ).replace(/\/+$/, '');
  const session = !site ? '' : `-- ===== CONTROLE DE SESSION (anti-dump) =====
-- POURQUOI: sans ce bloc, une copie extraite (dump) du script tourne sans cle et
-- sans publicite, indefiniment. Aucune protection cote client n'est inviolable
-- (le script s'execute chez l'utilisateur), mais ce controle transforme une copie
-- gratuite et permanente en une copie qui cesse de fonctionner.
-- REGLE DE TOLERANCE: seul un REFUS EXPLICITE du serveur arrete le script. Une
-- absence de reponse (reseau, panne passagere) est toleree plusieurs fois, pour
-- ne jamais couper un utilisateur legitime.
local __KS_AVANT = {}
local __KS_GENV = _G
pcall(function()
  if type(getgenv) == "function" then
    local g = getgenv()
    if type(g) == "table" then __KS_GENV = g end
  end
end)
pcall(function()
  for k in pairs(__KS_GENV) do __KS_AVANT[k] = true end
end)
local __KS_SITE = ${JSON.stringify(site)}
local __KS_ARRET = false
local __KS_WAIT = (type(task) == "table" and type(task.wait) == "function") and task.wait or wait
local __KS_SPAWN = (type(task) == "table" and type(task.spawn) == "function") and task.spawn or spawn

local function __KS_CLE()
  local cle = nil
  pcall(function()
    if type(getgenv) == "function" then
      local g = getgenv()
      if type(g) == "table" then
        if type(g.Key) == "string" then cle = g.Key end
        if type(cle) ~= "string" and type(g.keysystem_key) == "string" then cle = g.keysystem_key end
      end
    end
    if type(cle) ~= "string" and type(_G.Key) == "string" then cle = _G.Key end
  end)
  if type(cle) == "string" then
    local propre = cle:gsub("%s+", "")
    if #propre >= 10 then return propre end
  end
  return nil
end

local function __KS_USERID()
  local id = ""
  pcall(function()
    local joueurs = game:GetService("Players")
    local moi = joueurs.LocalPlayer
    if moi then id = tostring(moi.UserId) end
  end)
  return id
end

local function __KS_NEUTRALISER(motif)
  if __KS_ARRET then return end
  __KS_ARRET = true
  pcall(function()
    if type(getgenv) == "function" then
      local g = getgenv()
      if type(g) == "table" then
        g.Key = nil
        g.KeySystemSession = false
      end
    end
    _G.Key = nil
  end)
  -- Neutralisation: les fonctions que ce preambule a ajoutees pour rendre le
  -- script compatible refusent desormais de servir. La copie extraite cesse de
  -- fonctionner sans que le script lui-meme ait ete modifie.
  local n = 0
  pcall(function()
    for k in pairs(__KS_GENV) do
      if not __KS_AVANT[k] then
        __KS_GENV[k] = function() error("[KeySystem] session invalide (" .. tostring(motif) .. ")", 0) end
        n = n + 1
      end
    end
  end)
  pcall(function()
    warn("[KeySystem] session invalide (" .. tostring(motif) .. "): " .. tostring(n) .. " fonctions neutralisees.")
  end)
end

if __KS_SITE ~= "" then
  local __KS_POST = nil
  pcall(function()
    if type(request) == "function" then
      __KS_POST = request
    elseif type(http_request) == "function" then
      __KS_POST = http_request
    elseif type(syn) == "table" and type(syn.request) == "function" then
      __KS_POST = syn.request
    elseif type(http) == "table" and type(http.request) == "function" then
      __KS_POST = http.request
    end
  end)
  if type(__KS_POST) == "function" and __KS_SITE ~= "" then
    local function __KS_APPEL(cle)
      local corps = '{"key":"' .. cle .. '","userId":"' .. __KS_USERID() .. '"}'
      local ok, rep = pcall(function()
        return __KS_POST({
          Url = __KS_SITE .. "/api/v1/token",
          Method = "POST",
          Headers = { ["Content-Type"] = "application/json" },
          Body = corps,
        })
      end)
      if not ok or type(rep) ~= "table" then return nil end
      local texte = rep.Body or rep.body
      if type(texte) ~= "string" then return nil end
      local okd, donnees = pcall(function()
        return game:GetService("HttpService"):JSONDecode(texte)
      end)
      if okd and type(donnees) == "table" then return donnees end
      if texte:find('"ok":true', 1, true) then return { ok = true } end
      return { ok = false, reason = "unreadable" }
    end

    -- 1) Porte d'entree: un refus explicite empeche le script de demarrer.
    local __KS_CLE_INIT = __KS_CLE()
    if __KS_CLE_INIT then
      local premiere = __KS_APPEL(__KS_CLE_INIT)
      if premiere and premiere.ok ~= true and premiere.reason then
        error("[KeySystem] cle refusee par le serveur (" .. tostring(premiere.reason) .. "): lance le script depuis le loader.", 0)
      end
    end

    -- 2) Surveillance continue.
    __KS_SPAWN(function()
      local echecs = 0
      local intervalle = 540
      local premiereBoucle = true
      while not __KS_ARRET do
        __KS_WAIT(premiereBoucle and 45 or intervalle)
        premiereBoucle = false
        local cle = __KS_CLE()
        if not cle then
          -- Aucune cle: c'est le cas d'une copie extraite et relancee seule.
          -- Tolerance courte au demarrage, puis arret.
          echecs = echecs + 1
          intervalle = 45
          if echecs >= 2 then
            __KS_NEUTRALISER("aucune cle")
            break
          end
        else
          local rep = __KS_APPEL(cle)
          if rep and rep.ok == true then
            echecs = 0
            local i = tonumber(rep.intervalSec)
            intervalle = (i and i >= 30) and i or 540
          elseif rep and rep.reason then
            __KS_NEUTRALISER(tostring(rep.reason))
            break
          else
            -- Pas de reponse du tout: reseau. On tolere.
            echecs = echecs + 1
            if echecs >= 3 then
              __KS_NEUTRALISER("serveur injoignable")
              break
            end
          end
        end
      end
    end)
  end
end

`;
  return `-- [compat prelude]
${session}local __EXEC_NAME = (identifyexecutor and identifyexecutor()) or "Unknown"
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
