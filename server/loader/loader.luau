--!nocheck
-- KeySystem Loader - UI WindUI (style Windows 11) + fallback GUI leger enrichi
-- Verification par TON backend via KeyValidator (pas de double bouton "Get key": URL seul)
-- Compatible: Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit, Potassium, Real...

local SITE = (...)
if type(SITE) ~= "string" or #SITE == 0 then
    SITE = "https://keysystem-vv8b.onrender.com"
end

-- ===== Shim HTTP universel =====
local request = request or http_request or (syn and syn.request) or (http and http.request) or (fluxus and fluxus.request)
if not request then
    game:GetService("StarterGui"):SetCore("SendNotification", {
        Title = "Not supported",
        Text = "Your executor does not have an HTTP function.",
        Duration = 6
    })
    return
end

local lp = game:GetService("Players").LocalPlayer
local TweenService = game:GetService("TweenService")

-- Nom d'executor robuste: identifyexecutor peut manquer, renvoyer des casse differentes
-- selon les versions (ex: "potassium", "Potassium", "POTASSIUM-ANDROid")
local execName = "Unknown"
do
    local ok, name = pcall(function() return identifyexecutor and identifyexecutor() end)
    if ok and type(name) == "string" and #name > 0 then
        execName = name
    elseif syn then
        execName = "Synapse"
    elseif delta then
        execName = "Delta"
    end
end
-- Normalisation pour affichage + logs serveur coherents
execName = execName:sub(1, 1):upper() .. execName:sub(2):lower()

-- Extraction HWID/appareil robuste (compatibilite universelle)
local clientHwid = nil
do
    pcall(function()
        if type(gethwid) == "function" then
            clientHwid = tostring(gethwid())
        elseif type(get_hwid) == "function" then
            clientHwid = tostring(get_hwid())
        elseif getgenv and type(getgenv().gethwid) == "function" then
            clientHwid = tostring(getgenv().gethwid())
        else
            local analytics = game:GetService("RbxAnalyticsService")
            if analytics and analytics.GetClientId then
                clientHwid = tostring(analytics:GetClientId())
            end
        end
    end)
    if type(clientHwid) == "string" then
        clientHwid = clientHwid:gsub("%s+", "")
        if #clientHwid < 8 then clientHwid = nil end
    end
end

-- Detecte si l'executor est probablement mobile (UI tactile plus grande)
local isMobile = (execName:lower():find("potassium") or execName:lower():find("delta")
    or execName:lower():find("fluxus") or execName:lower():find("hydrogen")
    or execName:lower():find("codex") or execName:lower():find("arceus")) ~= nil
    or (game:GetService("UserInputService").TouchEnabled)

local function notify(title, text, duration)
    pcall(function()
        game:GetService("StarterGui"):SetCore("SendNotification", {
            Title = title,
            Text = text,
            Duration = duration or 5,
        })
    end)
end

-- ===== HTTP + logique de verification (partagee par les 2 UI) =====
local function httpJson(url, method, body)
    local res
    local ok = pcall(function()
        res = request({
            Url = url,
            Method = method or "GET",
            Headers = { ["Content-Type"] = "application/json" },
            Body = body and game:GetService("HttpService"):JSONEncode(body) or nil,
        })
    end)
    if not ok or not res then
        return { success = false, reason = "network_error" }
    end
    -- Certains executeurs renvoient le body en string direct
    if type(res) == "string" then
        local parsed
        local okParse = pcall(function()
            parsed = game:GetService("HttpService"):JSONDecode(res)
        end)
        return okParse and parsed or { success = false, reason = "bad_response" }
    end
    -- Wrappers qui decodent deja le body en table
    if type(res) == "table" and type(res.Body) == "table" then
        return res.Body
    end
    -- Requete refusee par le wrapper (blocage CSP/executor)
    if type(res) == "table" and res.Success == false then
        return { success = false, reason = "network_error" }
    end
    local parsed
    local okParse = pcall(function()
        parsed = game:GetService("HttpService"):JSONDecode(res.Body)
    end)
    return okParse and parsed or { success = false, reason = "bad_response" }
end

-- Formate une date ISO en "Xj Yh" restants (plus lisible qu'une date brute)
local function formatRemaining(expiresAt)
    if not expiresAt then return nil end
    local ok, parsed = pcall(function()
        return DateTime.fromIsoDate(expiresAt)
    end)
    if not ok or not parsed then return nil end
    local diff = parsed.UnixTimestamp - os.time()
    if diff <= 0 then return "expired" end
    local d = math.floor(diff / 86400)
    local h = math.floor((diff % 86400) / 3600)
    local m = math.floor((diff % 3600) / 60)
    if d >= 1 then return d .. "d " .. h .. "h" end
    if h >= 1 then return h .. "h " .. m .. "m" end
    return m .. "m"
end

-- Verifie la cle contre le backend; si valide, charge le script et retourne (true, message, details)
local function performCheck(key)
    if not key or #key < 10 then
        return false, "Invalid key."
    end
    key = key:gsub("%s+", "")

    local data = httpJson(SITE .. "/api/v1/check", "POST", {
        key = key,
        userId = lp.UserId,
        hwid = clientHwid,
        executor = execName,
        placeId = game.PlaceId,
    })

    if data.success and data.script then
        local fn, loadErr = loadstring(data.script)
        if not fn then
            pcall(function()
                request({
                    Url = SITE .. "/api/v1/report",
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = game:GetService("HttpService"):JSONEncode({
                        userId = lp.UserId,
                        executor = execName,
                        version = data.version,
                        error = "loadstring: " .. tostring(loadErr),
                    }),
                })
            end)
            return false, "Load error: " .. tostring(loadErr)
        end
        local okRun, runErr = pcall(fn)
        if not okRun then
            pcall(function()
                request({
                    Url = SITE .. "/api/v1/report",
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = game:GetService("HttpService"):JSONEncode({
                        userId = lp.UserId,
                        executor = execName,
                        version = data.version,
                        error = "runtime: " .. tostring(runErr),
                    }),
                })
            end)
        end
        -- Message DETAILLE: version + temps restant sur la cle
        local remaining = formatRemaining(data.expiresAt)
        local detail = "Script loaded (v" .. tostring(data.version) .. ")"
        if remaining then
            detail = detail .. " — key valid for " .. remaining
        end
        return true, detail
    elseif data.reason == "expired" then
        return false, "Key expired — go back to the website to renew it (1 ad = 12/24h)."
    elseif data.reason == "banned" then
        return false, "Your Roblox account is banned from this script."
    elseif data.reason == "bound_to_other_user" then
        return false, "This key is bound to another Roblox account."
    elseif data.reason == "bound_to_other_device" then
        return false, "This key is bound to another PC/device."
    elseif data.reason == "revoked" then
        return false, "Key revoked by the administrator."
    elseif data.reason == "no_script" then
        return false, "No script published for this game yet — try again later."
    elseif data.reason == "invalid_key" then
        return false, "Invalid key — check the format (kid.signature)."
    elseif data.reason == "rate_limited" then
        return false, "Too many attempts — wait a minute."
    elseif data.reason == "network_error" then
        return false, "Network error — check your connection and retry."
    else
        return false, "Error: " .. tostring(data.reason or "unknown")
    end
end

local function copyGetKeyLink()
    if setclipboard then
        setclipboard(SITE .. "/getkey")
        notify("Link copied", "Open it in your browser to get a key.", 7)
    else
        notify("Get key — open in browser", SITE .. "/getkey", 20)
    end
end

-- Cle sauvegardee si writefile dispo
local function loadSavedKey()
    local saved
    pcall(function() saved = readfile("keysystem_key.txt") end)
    if type(saved) == "string" then
        return saved:gsub("%s+", "")
    end
    return nil
end
local function saveKey(key)
    pcall(function() writefile("keysystem_key.txt", key:gsub("%s+", "")) end)
end

-- ===== Tente WindUI avec FALLBACK PROGRESSIF =====
-- 1) WindUI self-host complet (1.3 Mo) — certains execs mobiles timeout dessus.
-- 2) Si echec: GUI leger enrichi (100% Roblox Instance, aucune lib, aucun bug de compat).
local WindUI
do
    local ok, result = pcall(function()
        return loadstring(game:HttpGet(SITE .. "/api/v1/windui"))()
    end)
    if ok and type(result) == "table" and result.CreateWindow then
        WindUI = result
    else
        WindUI = nil
    end
end

if WindUI then
    -- ================= PATH WINDUI =================
    -- KeyValidator = le backend verifie la cle (une seule source de verite)
    -- URL seul (PAS de KeySystem.API): un seul bouton "Get key", pas de panneau "Select Service" qui se superpose.
    local Window = WindUI:CreateWindow({
        Title = "Key System",
        Icon = "key-round",
        Author = SITE:gsub("^https?://", ""),
        Folder = "KeySystem",
        Size = isMobile and UDim2.fromOffset(480, 420) or UDim2.fromOffset(580, 460),
        Theme = "Dark",
        KeySystem = {
            Key = { "backend-verified-only" }, -- jamais matche: KeyValidator passe TOUJOURS par ton backend
            Note = "Get your key on the website (Get key button), paste it here, then click Submit.",
            URL = SITE .. "/getkey",
            -- SaveKey = false: WindUI fait writefile SANS pcall dans handleSuccess —
            -- sur un executor sans writefile, CreateWindow restait bloque a l'infini
            -- apres validation. Le loader sauvegarde deja la cle lui-meme (saveKey pculle).
            SaveKey = false,
            KeyValidator = function(key)
                local ok, msg = performCheck(key)
                if ok and key and #key >= 10 then
                    saveKey(key)
                elseif not ok then
                    -- WindUI n'affiche que "Invalid key." — on complete avec le
                    -- message DETAILLE (expired/banned/rate_limited/bound...) en notif
                    pcall(function()
                        WindUI:Notify({
                            Title = "Key System",
                            Content = msg,
                            Icon = "triangle-alert",
                            Duration = 7,
                        })
                    end)
                end
                return ok, msg
            end,
        },
    })

    -- Ferme la fenetre principale (vide) apres validation: le script charge derriere
    task.delay(2, function()
        local closed = pcall(function() Window:Destroy() end)
        if not closed then pcall(function() Window:Close() end) end
    end)
else
    -- ================= FALLBACK GUI LEGER ENRICHI =================
    -- Pour les executors ou WindUI (1.3 Mo) ne charge pas (Potassium, mobiles...).
    -- 100% Instances Roblox: aucune lib externe, aucune dependance, aucun bug de compat.

    local screenGui = Instance.new("ScreenGui")
    screenGui.Name = "KeySystemLoader"
    pcall(function() screenGui.Parent = lp:WaitForChild("PlayerGui") end)
    if not screenGui.Parent then
        pcall(function() screenGui.Parent = game:GetService("CoreGui") end)
    end
    if not screenGui.Parent then
        screenGui.Parent = lp:WaitForChild("PlayerGui")
    end

    local scaleFactor = isMobile and 1.2 or 1
    local main = Instance.new("Frame")
    main.Size = UDim2.new(0, 460 * scaleFactor, 0, 390 * scaleFactor)
    main.Position = UDim2.new(0.5, -230 * scaleFactor, 0.5, -195 * scaleFactor)
    main.BackgroundColor3 = Color3.fromRGB(12, 10, 18)
    main.BorderSizePixel = 0
    main.Active = true
    main.Parent = screenGui
    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 14)
    corner.Parent = main

    local mainStroke = Instance.new("UIStroke")
    mainStroke.Color = Color3.fromRGB(139, 92, 246)
    mainStroke.Transparency = 0.55
    mainStroke.Thickness = 1.5
    mainStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
    mainStroke.Parent = main

    -- Top neon accent gradient
    local accent = Instance.new("Frame")
    accent.Size = UDim2.new(1, 0, 0, 3)
    accent.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
    accent.BorderSizePixel = 0
    accent.Parent = main
    local ac = Instance.new("UICorner")
    ac.CornerRadius = UDim.new(0, 3)
    ac.Parent = accent
    local ag = Instance.new("UIGradient")
    ag.Color = ColorSequence.new{
        ColorSequenceKeypoint.new(0, Color3.fromRGB(124, 58, 237)),
        ColorSequenceKeypoint.new(0.5, Color3.fromRGB(192, 132, 252)),
        ColorSequenceKeypoint.new(1, Color3.fromRGB(139, 92, 246))
    }
    ag.Parent = accent

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

    local title = Instance.new("TextLabel")
    title.Size = UDim2.new(1, -60, 0, 26)
    title.Position = UDim2.new(0, 18, 0, 14)
    title.BackgroundTransparency = 1
    title.TextColor3 = Color3.fromRGB(255, 255, 255)
    title.TextSize = 18 * scaleFactor
    title.Font = Enum.Font.GothamBold
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Text = "🔑  KEY SYSTEM"
    title.Parent = main

    local subLabel = Instance.new("TextLabel")
    subLabel.Size = UDim2.new(1, -60, 0, 18)
    subLabel.Position = UDim2.new(0, 18, 0, 42)
    subLabel.BackgroundTransparency = 1
    subLabel.TextColor3 = Color3.fromRGB(192, 132, 252)
    subLabel.TextSize = 12 * scaleFactor
    subLabel.Font = Enum.Font.GothamSemibold
    subLabel.TextXAlignment = Enum.TextXAlignment.Left
    subLabel.Text = "⚡ " .. execName .. "  •  Secure Hub Loader"
    subLabel.Parent = main

    local closeBtn = Instance.new("TextButton")
    closeBtn.Size = UDim2.new(0, 30, 0, 30)
    closeBtn.Position = UDim2.new(1, -40, 0, 14)
    closeBtn.BackgroundColor3 = Color3.fromRGB(22, 17, 34)
    closeBtn.Text = "✕"
    closeBtn.TextSize = 13
    closeBtn.TextColor3 = Color3.fromRGB(200, 190, 225)
    closeBtn.Font = Enum.Font.GothamBold
    closeBtn.Parent = main
    local cc = Instance.new("UICorner")
    cc.CornerRadius = UDim.new(0, 8)
    cc.Parent = closeBtn
    local closeStroke = Instance.new("UIStroke")
    closeStroke.Color = Color3.fromRGB(139, 92, 246)
    closeStroke.Transparency = 0.7
    closeStroke.Thickness = 1
    closeStroke.Parent = closeBtn
    closeBtn.MouseButton1Click:Connect(function()
        screenGui:Destroy()
    end)

    local keyBox = Instance.new("TextBox")
    keyBox.Size = UDim2.new(1, -36, 0, 42 * scaleFactor)
    keyBox.Position = UDim2.new(0, 18, 0, 72 * scaleFactor)
    keyBox.BackgroundColor3 = Color3.fromRGB(16, 13, 25)
    keyBox.BorderSizePixel = 0
    keyBox.PlaceholderText = "Paste your key here..."
    keyBox.Text = loadSavedKey() or ""
    keyBox.TextSize = 13.5 * scaleFactor
    keyBox.TextColor3 = Color3.fromRGB(245, 240, 255)
    keyBox.PlaceholderColor3 = Color3.fromRGB(120, 110, 140)
    keyBox.Font = Enum.Font.Code
    keyBox.ClearTextOnFocus = false
    keyBox.TextXAlignment = Enum.TextXAlignment.Left
    keyBox.Parent = main
    local kc = Instance.new("UICorner")
    kc.CornerRadius = UDim.new(0, 9)
    kc.Parent = keyBox
    local kp = Instance.new("UIPadding")
    kp.PaddingLeft = UDim.new(0, 14)
    kp.Parent = keyBox
    local keyStroke = Instance.new("UIStroke")
    keyStroke.Color = Color3.fromRGB(139, 92, 246)
    keyStroke.Transparency = 0.55
    keyStroke.Thickness = 1
    keyStroke.Parent = keyBox

    local function mkBtn(text, color, strokeColor, posY)
        local btn = Instance.new("TextButton")
        btn.Size = UDim2.new(1, -36, 0, 40 * scaleFactor)
        btn.Position = UDim2.new(0, 18, 0, posY * scaleFactor)
        btn.BackgroundColor3 = color
        btn.BorderSizePixel = 0
        btn.Text = text
        btn.TextSize = 14 * scaleFactor
        btn.TextColor3 = Color3.fromRGB(255, 255, 255)
        btn.Font = Enum.Font.GothamBold
        btn.Parent = main
        local b = Instance.new("UICorner")
        b.CornerRadius = UDim.new(0, 9)
        b.Parent = btn
        if strokeColor then
            local s = Instance.new("UIStroke")
            s.Color = strokeColor
            s.Transparency = 0.5
            s.Thickness = 1
            s.Parent = btn
        end
        return btn
    end

    local getBtn = mkBtn("🌐  Get Key  (Copy Link)", Color3.fromRGB(124, 58, 237), Color3.fromRGB(192, 132, 252), 124)
    local checkBtn = mkBtn("⚡  Verify & Launch Script", Color3.fromRGB(139, 92, 246), Color3.fromRGB(216, 180, 254), 172)

    -- Panneau de statut / Guide integre
    local statusCard = Instance.new("Frame")
    statusCard.Size = UDim2.new(1, -36, 0, 126 * scaleFactor)
    statusCard.Position = UDim2.new(0, 18, 0, 222 * scaleFactor)
    statusCard.BackgroundColor3 = Color3.fromRGB(16, 13, 25)
    statusCard.BorderSizePixel = 0
    statusCard.Parent = main
    local sc = Instance.new("UICorner")
    sc.CornerRadius = UDim.new(0, 9)
    sc.Parent = statusCard
    local sStroke = Instance.new("UIStroke")
    sStroke.Color = Color3.fromRGB(139, 92, 246)
    sStroke.Transparency = 0.75
    sStroke.Thickness = 1
    sStroke.Parent = statusCard

    local status = Instance.new("TextLabel")
    status.Size = UDim2.new(1, -20, 1, -16)
    status.Position = UDim2.new(0, 10, 0, 8)
    status.BackgroundTransparency = 1
    status.TextColor3 = Color3.fromRGB(175, 170, 195)
    status.TextSize = 12 * scaleFactor
    status.Font = Enum.Font.Gotham
    status.TextWrapped = true
    status.TextXAlignment = Enum.TextXAlignment.Left
    status.TextYAlignment = Enum.TextYAlignment.Top
    status.Text = "How to use:\n• 1. Click 'Get Key' to copy the website link\n• 2. Complete the short checkpoint (30s)\n• 3. Paste your key above and click 'Verify & Launch'\n\nKey is valid for 12h or 24h once activated."
    status.Parent = statusCard

    -- Domaine affiche en clair
    local linkLabel = Instance.new("TextLabel")
    linkLabel.Size = UDim2.new(1, -36, 0, 16 * scaleFactor)
    linkLabel.Position = UDim2.new(0, 18, 0, 360 * scaleFactor)
    linkLabel.BackgroundTransparency = 1
    linkLabel.TextColor3 = Color3.fromRGB(139, 92, 246)
    linkLabel.TextSize = 11.5 * scaleFactor
    linkLabel.Font = Enum.Font.GothamSemibold
    linkLabel.TextXAlignment = Enum.TextXAlignment.Center
    linkLabel.Text = "🔒 " .. SITE:gsub("^https?://", "")
    linkLabel.Parent = main

    local function setStatus(text, color)
        pcall(function()
            TweenService:Create(status, TweenInfo.new(0.2), { TextColor3 = color }):Play()
        end)
        status.Text = text
    end

    getBtn.MouseButton1Click:Connect(function()
        copyGetKeyLink()
        local copied = setclipboard ~= nil
        setStatus((copied and "✅ Link copied — open it in your browser" or "🔗 Link shown in the notification") .. "\n" .. SITE .. "/getkey", Color3.fromRGB(139, 92, 246))
    end)

    local checking = false
    local function doCheck()
        if checking then return end
        local key = keyBox.Text:gsub("%s+", "")
        if #key == 0 then
            setStatus("Enter your key first — click \"Get a key\" if you don't have one.", Color3.fromRGB(229, 193, 205))
            return
        end
        checking = true
        checkBtn.Text = "⏳ Verifying..."
        setStatus("Checking your key against " .. SITE:gsub("^https?://", "") .. " ...\nExecutor: " .. execName .. " · Game: " .. tostring(game.PlaceId), Color3.fromRGB(150, 150, 160))

        local ok, msg = performCheck(key)
        checking = false
        checkBtn.Text = "⚡  Verify & Launch Script"

        if ok then
            saveKey(key)
            setStatus(msg, Color3.fromRGB(46, 160, 83))
            task.wait(3) -- laisse le temps de lire "Script loaded (vX) — key valid for 2d 5h"
            screenGui:Destroy()
        else
            setStatus(msg .. "\n\nIf your key is expired, get a new one on the website.", Color3.fromRGB(241, 100, 100))
        end
    end

    checkBtn.MouseButton1Click:Connect(doCheck)
    keyBox.FocusLost:Connect(function(enter)
        if enter then doCheck() end
    end)

    if keyBox.Text and #keyBox.Text > 0 then
        task.spawn(function()
            task.wait(0.5)
            setStatus("Saved key found — verifying automatically...", Color3.fromRGB(150, 150, 160))
            doCheck()
        end)
    end
end
