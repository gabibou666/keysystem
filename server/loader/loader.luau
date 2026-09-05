--!nocheck
-- Loader universel KeySystem - GUI style library (pur Instance.new, zero dependance)
-- Compatible: Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit...

local SITE = (...)
if type(SITE) ~= "string" or #SITE == 0 then
    SITE = "https://keysystem-vv8b.onrender.com"
end

-- ===== Shim HTTP universel =====
local request = request or http_request or (syn and syn.request) or (http and http.request) or (fluxus and fluxus.request)
if not request then
    game:GetService("StarterGui"):SetCore("SendNotification", {
        Title = "Non supporté",
        Text = "Ton executor n'a pas de fonction HTTP.",
        Duration = 6
    })
    return
end

local lp = game:GetService("Players").LocalPlayer
local TweenService = game:GetService("TweenService")
local execName = (identifyexecutor and identifyexecutor()) or "Unknown"

local savedKey
pcall(function() savedKey = readfile("keysystem_key.txt") end)

-- ===== UI =====
local screenGui = Instance.new("ScreenGui")
screenGui.Name = "KeySystemLoader"
pcall(function() screenGui.Parent = lp:WaitForChild("PlayerGui") end)
if not screenGui.Parent then
    pcall(function() screenGui.Parent = game:GetService("CoreGui") end)
end
if not screenGui.Parent then
    screenGui.Parent = lp:WaitForChild("PlayerGui")
end

local main = Instance.new("Frame")
main.Size = UDim2.new(0, 440, 0, 320)
main.Position = UDim2.new(0.5, -220, 0.5, -160)
main.BackgroundColor3 = Color3.fromRGB(22, 22, 27)
main.BorderSizePixel = 0
main.Active = true
main.Parent = screenGui
local mainCorner = Instance.new("UICorner")
mainCorner.CornerRadius = UDim.new(0, 10)
mainCorner.Parent = main

-- Accent bar
local accent = Instance.new("Frame")
accent.Size = UDim2.new(1, 0, 0, 4)
accent.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
accent.BorderSizePixel = 0
accent.Parent = main
local accentCorner = Instance.new("UICorner")
accentCorner.CornerRadius = UDim.new(0, 4)
accentCorner.Parent = accent

-- Drag
do
    local dragging, dragStart, startPos
    main.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            dragStart = input.Position
            startPos = main.Position
            input.Changed:Connect(function()
                if input.UserInputState == Enum.UserInputState.End then dragging = false end
            end)
        end
    end)
    game:GetService("UserInputService").InputChanged:Connect(function(input)
        if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
            local delta = input.Position - dragStart
            main.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X, startPos.Y.Scale, startPos.Y.Offset + delta.Y)
        end
    end)
end

-- Titre
local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, -60, 0, 40)
title.Position = UDim2.new(0, 16, 0, 8)
title.BackgroundTransparency = 1
title.TextColor3 = Color3.fromRGB(240, 240, 245)
title.TextSize = 20
title.Font = Enum.Font.GothamBold
title.TextXAlignment = Enum.TextXAlignment.Left
title.Text = "🔑 Key System"
title.Parent = main

-- Close
local closeBtn = Instance.new("TextButton")
closeBtn.Size = UDim2.new(0, 32, 0, 32)
closeBtn.Position = UDim2.new(1, -40, 0, 12)
closeBtn.BackgroundColor3 = Color3.fromRGB(40, 40, 48)
closeBtn.Text = "✕"
closeBtn.TextSize = 14
closeBtn.TextColor3 = Color3.fromRGB(230, 230, 235)
closeBtn.Font = Enum.Font.Gotham
closeBtn.Parent = main
local closeCorner = Instance.new("UICorner")
closeCorner.CornerRadius = UDim.new(0, 8)
closeCorner.Parent = closeBtn
closeBtn.MouseButton1Click:Connect(function()
    screenGui:Destroy()
end)

-- Champ clé
local keyBox = Instance.new("TextBox")
keyBox.Size = UDim2.new(1, -32, 0, 42)
keyBox.Position = UDim2.new(0, 16, 0, 64)
keyBox.BackgroundColor3 = Color3.fromRGB(30, 30, 36)
keyBox.BorderSizePixel = 0
keyBox.PlaceholderText = "Ta clé ici..."
keyBox.Text = savedKey or ""
keyBox.TextSize = 14
keyBox.TextColor3 = Color3.fromRGB(235, 235, 240)
keyBox.PlaceholderColor3 = Color3.fromRGB(110, 110, 120)
keyBox.Font = Enum.Font.Code
keyBox.ClearTextOnFocus = false
keyBox.Parent = main
local keyCorner = Instance.new("UICorner")
keyCorner.CornerRadius = UDim.new(0, 8)
keyCorner.Parent = keyBox

local function mkBtn(text, color, posY)
    local btn = Instance.new("TextButton")
    btn.Size = UDim2.new(1, -32, 0, 42)
    btn.Position = UDim2.new(0, 16, 0, posY)
    btn.BackgroundColor3 = color
    btn.BorderSizePixel = 0
    btn.Text = text
    btn.TextSize = 15
    btn.TextColor3 = Color3.fromRGB(255, 255, 255)
    btn.Font = Enum.Font.GothamSemibold
    btn.AutoButtonColor = true
    btn.Parent = main
    local c = Instance.new("UICorner")
    c.CornerRadius = UDim.new(0, 8)
    c.Parent = btn
    btn.MouseEnter:Connect(function()
        TweenService:Create(btn, TweenInfo.new(0.15), { Size = UDim2.new(1, -26, 0, 42), Position = UDim2.new(0, 13, 0, posY) }):Play()
    end)
    btn.MouseLeave:Connect(function()
        TweenService:Create(btn, TweenInfo.new(0.15), { Size = UDim2.new(1, -32, 0, 42), Position = UDim2.new(0, 16, 0, posY) }):Play()
    end)
    return btn
end

local getBtn = mkBtn("🌐 Obtenir une clé (copie le lien)", Color3.fromRGB(88, 101, 242), 118)
local checkBtn = mkBtn("✅ Vérifier la clé", Color3.fromRGB(46, 160, 83), 170)

-- Status
local status = Instance.new("TextLabel")
status.Size = UDim2.new(1, -32, 0, 90)
status.Position = UDim2.new(0, 16, 0, 226)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(150, 150, 160)
status.TextSize = 13
status.Font = Enum.Font.Gotham
status.TextWrapped = true
status.TextXAlignment = Enum.TextXAlignment.Left
status.Text = "Executor: " .. execName
status.Parent = main

local function setStatus(text, color)
    TweenService:Create(status, TweenInfo.new(0.2), { TextColor3 = color }):Play()
    status.Text = text
end

-- ===== HTTP helpers =====
local function httpRequest(url, method, body)
    local res = request({
        Url = url,
        Method = method,
        Headers = { ["Content-Type"] = "application/json" },
        Body = body and game:GetService("HttpService"):JSONEncode(body) or nil,
    })
    local ok, data = pcall(function()
        return game:GetService("HttpService"):JSONDecode(res.Body)
    end)
    return ok and data or { success = false, reason = "bad_response" }, res
end

local function reportError(msg)
    pcall(function()
        request({
            Url = SITE .. "/api/v1/report",
            Method = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body = game:GetService("HttpService"):JSONEncode({
                userId = lp.UserId,
                executor = execName,
                error = msg,
            }),
        })
    end)
end

-- ===== Boutons =====
getBtn.MouseButton1Click:Connect(function()
    local url = SITE .. "/getkey"
    local ok = pcall(function() setclipboard(url) end)
    if ok then
        setStatus("Lien copié ! Ouvre-le dans ton navigateur pour obtenir une clé.", Color3.fromRGB(46, 160, 83))
    else
        setStatus("Va sur: " .. url, Color3.fromRGB(88, 166, 255))
    end
end)

local checking = false
local function doCheck()
    if checking then return end
    local key = keyBox.Text:gsub("%s+", "")
    if #key == 0 then
        setStatus("Entre ta clé d'abord.", Color3.fromRGB(229, 193, 205))
        return
    end
    checking = true
    checkBtn.Text = "⏳ Vérification..."

    local data = httpRequest(SITE .. "/api/v1/check", "POST", {
        key = key,
        userId = lp.UserId,
        executor = execName,
        placeId = game.PlaceId,
    })

    checking = false
    checkBtn.Text = "✅ Vérifier la clé"

    if data.success then
        setStatus("Clé valide ! Chargement du script...", Color3.fromRGB(46, 160, 83))
        pcall(function() writefile("keysystem_key.txt", key) end)
        -- Petit delai pour laisser la GUI disparaitre proprement
        task.wait(0.3)
        screenGui:Destroy()
        local fn, err = loadstring(data.script)
        if fn then
            local ok2, runErr = pcall(fn)
            if not ok2 then
                reportError("runtime: " .. tostring(runErr))
            end
        else
            reportError("loadstring: " .. tostring(err))
        end
    elseif data.reason == "expired" then
        setStatus("Clé expirée. Retourne sur le site (bouton Obtenir une clé) pour la renouveler.", Color3.fromRGB(229, 193, 205))
    elseif data.reason == "banned" then
        setStatus("Ton compte Roblox est banni de ce script.", Color3.fromRGB(241, 100, 100))
    elseif data.reason == "bound_to_other_user" then
        setStatus("Cette clé est liée à un autre compte Roblox.", Color3.fromRGB(241, 100, 100))
    elseif data.reason == "revoked" then
        setStatus("Clé révoquée par l'administrateur.", Color3.fromRGB(241, 100, 100))
    elseif data.reason == "invalid_key" then
        setStatus("Clé invalide. Vérifie le format.", Color3.fromRGB(241, 100, 100))
    elseif data.reason == "no_script" then
        setStatus("Aucun script publié pour le moment. Reviens plus tard.", Color3.fromRGB(229, 193, 205))
    else
        setStatus("Erreur: " .. tostring(data.reason or "inconnue"), Color3.fromRGB(241, 100, 100))
    end
end

checkBtn.MouseButton1Click:Connect(doCheck)
keyBox.FocusLost:Connect(function(enter) if enter then doCheck() end end)

-- Auto-check au lancement si clé sauvegardee
if savedKey and #savedKey > 0 then
    setStatus("Clé trouvée, vérification automatique...", Color3.fromRGB(150, 150, 160))
    task.spawn(doCheck)
end
