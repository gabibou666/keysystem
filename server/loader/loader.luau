--!nocheck
-- KeySystem Loader - UI WindUI (style Windows 11) + fallback GUI leger
-- Service de cles personnalise branche sur ton backend
-- Compatible: Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit, Real...

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
local execName = (identifyexecutor and identifyexecutor()) or "Unknown"
local TweenService = game:GetService("TweenService")

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
    local parsed
    local okParse = pcall(function()
        parsed = game:GetService("HttpService"):JSONDecode(res.Body)
    end)
    return okParse and parsed or { success = false, reason = "bad_response" }
end

-- Verifie la cle contre le backend; si valide, charge le script et retourne (true, message)
local function performCheck(key)
    if not key or #key < 10 then
        return false, "Invalid key."
    end
    key = key:gsub("%s+", "")

    local data = httpJson(SITE .. "/api/v1/check", "POST", {
        key = key,
        userId = lp.UserId,
        executor = execName,
        placeId = game.PlaceId,
    })

    if data.success and data.script then
        local fn, loadErr = loadstring(data.script)
        if not fn then
            -- remonte pour la telemetrie + message precis
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
        return true, "Script loaded (v" .. tostring(data.version) .. ")."
    elseif data.reason == "expired" then
        return false, "Key expired — go back to the website to renew it."
    elseif data.reason == "banned" then
        return false, "Your Roblox account is banned from this script."
    elseif data.reason == "bound_to_other_user" then
        return false, "This key is bound to another Roblox account."
    elseif data.reason == "revoked" then
        return false, "Key revoked by the administrator."
    elseif data.reason == "no_script" then
        return false, "No script published for this game yet."
    elseif data.reason == "invalid_key" then
        return false, "Invalid key — check the format."
    elseif data.reason == "rate_limited" then
        return false, "Too many attempts — wait a minute."
    else
        return false, "Error: " .. tostring(data.reason or "unknown")
    end
end

local function copyGetKeyLink()
    if setclipboard then
        setclipboard(SITE .. "/getkey")
        notify("Link copied", "Open it in your browser to get a key.")
    else
        notify("Get key", SITE .. "/getkey", 15)
    end
end

-- Clé sauvegardee si writefile dispo
local function loadSavedKey()
    local saved
    pcall(function() saved = readfile("keysystem_key.txt") end)
    return saved
end
local function saveKey(key)
    pcall(function() writefile("keysystem_key.txt", key) end)
end

-- ===== Tente WindUI (echoue proprement sur les executors limites) =====
local WindUI
do
    local ok, result = pcall(function()
        return loadstring(game:HttpGet("https://raw.githubusercontent.com/Footagesus/WindUI/main/dist/main.lua"))()
    end)
    if ok and type(result) == "table" and result.CreateWindow then
        WindUI = result
    else
        WindUI = nil
    end
end

if WindUI then
    -- ================= PATH WINDUI =================
    WindUI.Services.keysystem = {
        Name = "Key System",
        Icon = "key",
        Args = { "SiteURL" },

        New = function(SiteURL)
            local function validateKey(key)
                local ok, msg = performCheck(key)
                if ok then
                    -- sauvegarde + notification + ferme la fenetre (le script est deja charge)
                    if key and #key >= 10 then saveKey(key:gsub("%s+", "")) end
                    notify("Key valid!", msg, 6)
                end
                return ok, msg
            end

            local function copyLink()
                copyGetKeyLink()
            end

            return {
                Verify = validateKey,
                Copy = copyLink,
            }
        end,
    }

    local Window = WindUI:CreateWindow({
        Title = "Key System",
        Icon = "key-round",
        Author = SITE:gsub("^https?://", ""),
        Folder = "KeySystem",
        Size = UDim2.fromOffset(580, 460),
        Theme = "Dark",
        KeySystem = {
            -- jamais matche: la validation passe UNIQUEMENT par le backend
            Key = { "backend-verified-only" },
            Note = "Get your key on the website (button below), paste it here, then click Verify.",
            URL = SITE .. "/getkey",
            SaveKey = true,
            API = {
                {
                    Type = "keysystem",
                    SiteURL = SITE,
                },
            },
        },
    })

    -- Ferme la fenetre principale (vide) apres validation: le script charge derriere
    task.delay(2, function()
        local closed = pcall(function() Window:Destroy() end)
        if not closed then pcall(function() Window:Close() end) end
    end)
else
    -- ================= FALLBACK GUI LEGER =================
    -- Pour les executors ou WindUI (1.3 Mo) ne charge pas.

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
    main.Size = UDim2.new(0, 440, 0, 300)
    main.Position = UDim2.new(0.5, -220, 0.5, -150)
    main.BackgroundColor3 = Color3.fromRGB(32, 32, 38)
    main.BorderSizePixel = 0
    main.Active = true
    main.Parent = screenGui
    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 10)
    corner.Parent = main

    local accent = Instance.new("Frame")
    accent.Size = UDim2.new(1, 0, 0, 4)
    accent.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
    accent.BorderSizePixel = 0
    accent.Parent = main
    local ac = Instance.new("UICorner")
    ac.CornerRadius = UDim.new(0, 4)
    ac.Parent = accent

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
    title.Size = UDim2.new(1, -60, 0, 40)
    title.Position = UDim2.new(0, 16, 0, 10)
    title.BackgroundTransparency = 1
    title.TextColor3 = Color3.fromRGB(240, 240, 245)
    title.TextSize = 19
    title.Font = Enum.Font.GothamBold
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Text = "🔑 Key System"
    title.Parent = main

    local closeBtn = Instance.new("TextButton")
    closeBtn.Size = UDim2.new(0, 30, 0, 30)
    closeBtn.Position = UDim2.new(1, -40, 0, 14)
    closeBtn.BackgroundColor3 = Color3.fromRGB(40, 40, 48)
    closeBtn.Text = "✕"
    closeBtn.TextSize = 13
    closeBtn.TextColor3 = Color3.fromRGB(230, 230, 235)
    closeBtn.Font = Enum.Font.Gotham
    closeBtn.Parent = main
    local cc = Instance.new("UICorner")
    cc.CornerRadius = UDim.new(0, 8)
    cc.Parent = closeBtn
    closeBtn.MouseButton1Click:Connect(function()
        screenGui:Destroy()
    end)

    local keyBox = Instance.new("TextBox")
    keyBox.Size = UDim2.new(1, -32, 0, 40)
    keyBox.Position = UDim2.new(0, 16, 0, 62)
    keyBox.BackgroundColor3 = Color3.fromRGB(24, 24, 30)
    keyBox.BorderSizePixel = 0
    keyBox.PlaceholderText = "Your key here..."
    keyBox.Text = loadSavedKey() or ""
    keyBox.TextSize = 14
    keyBox.TextColor3 = Color3.fromRGB(235, 235, 240)
    keyBox.PlaceholderColor3 = Color3.fromRGB(110, 110, 120)
    keyBox.Font = Enum.Font.Code
    keyBox.ClearTextOnFocus = false
    keyBox.Parent = main
    local kc = Instance.new("UICorner")
    kc.CornerRadius = UDim.new(0, 8)
    kc.Parent = keyBox

    local function mkBtn(text, color, posY)
        local btn = Instance.new("TextButton")
        btn.Size = UDim2.new(1, -32, 0, 40)
        btn.Position = UDim2.new(0, 16, 0, posY)
        btn.BackgroundColor3 = color
        btn.BorderSizePixel = 0
        btn.Text = text
        btn.TextSize = 15
        btn.TextColor3 = Color3.fromRGB(255, 255, 255)
        btn.Font = Enum.Font.GothamSemibold
        btn.Parent = main
        local b = Instance.new("UICorner")
        b.CornerRadius = UDim.new(0, 8)
        b.Parent = btn
        return btn
    end

    local getBtn = mkBtn("🌐 Get a key (copies the link)", Color3.fromRGB(88, 101, 242), 112)
    local checkBtn = mkBtn("✅ Verify key", Color3.fromRGB(46, 160, 83), 160)

    local status = Instance.new("TextLabel")
    status.Size = UDim2.new(1, -32, 0, 100)
    status.Position = UDim2.new(0, 16, 0, 212)
    status.BackgroundTransparency = 1
    status.TextColor3 = Color3.fromRGB(150, 150, 160)
    status.TextSize = 13
    status.Font = Enum.Font.Gotham
    status.TextWrapped = true
    status.TextXAlignment = Enum.TextXAlignment.Left
    status.Text = "Executor: " .. execName .. " (fallback UI)"
    status.Parent = main

    local function setStatus(text, color)
        TweenService:Create(status, TweenInfo.new(0.2), { TextColor3 = color }):Play()
        status.Text = text
    end

    getBtn.MouseButton1Click:Connect(copyGetKeyLink)

    local checking = false
    local function doCheck()
        if checking then return end
        local key = keyBox.Text:gsub("%s+", "")
        if #key == 0 then
            setStatus("Enter your key first.", Color3.fromRGB(229, 193, 205))
            return
        end
        checking = true
        checkBtn.Text = "⏳ Verifying..."
        setStatus("Checking your key...", Color3.fromRGB(150, 150, 160))

        local ok, msg = performCheck(key)
        checking = false
        checkBtn.Text = "✅ Verify key"

        if ok then
            saveKey(key)
            setStatus(msg, Color3.fromRGB(46, 160, 83))
            task.wait(0.4)
            screenGui:Destroy()
        else
            setStatus(msg, Color3.fromRGB(241, 100, 100))
        end
    end

    checkBtn.MouseButton1Click:Connect(doCheck)
    keyBox.FocusLost:Connect(function(enter)
        if enter then doCheck() end
    end)

    if keyBox.Text and #keyBox.Text > 0 then
        task.spawn(function()
            task.wait(0.5)
            setStatus("Saved key found, verifying...", Color3.fromRGB(150, 150, 160))
            doCheck()
        end)
    end
end
