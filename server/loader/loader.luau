--!nocheck
-- KeySystem Loader - UI WindUI (style Windows 11)
-- Service de cles personnalise branche sur ton backend keysystem-vv8b.onrender.com
-- Compatible: Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit, Real...

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
local execName = (identifyexecutor and identifyexecutor()) or "Unknown"

-- ===== WindUI =====
local WindUI = loadstring(game:HttpGet("https://raw.githubusercontent.com/Footagesus/WindUI/main/dist/main.lua"))()

-- ===== Service de cles personnalise (branche sur TON backend) =====
WindUI.Services.keysystem = {
    Name = "Key System",
    Icon = "key",
    Args = { "SiteURL" },

    New = function(SiteURL)
        local function httpJson(url, method, body)
            local headers = { ["Content-Type"] = "application/json" }
            local res
            local ok, err = pcall(function()
                res = request({
                    Url = url,
                    Method = method or "GET",
                    Headers = headers,
                    Body = body and game:GetService("HttpService"):JSONEncode(body) or nil,
                })
            end)
            if not ok then
                return { success = false, reason = "network_error" }
            end
            local parsed
            local okParse = pcall(function()
                parsed = game:GetService("HttpService"):JSONDecode(res.Body)
            end)
            return okParse and parsed or { success = false, reason = "bad_response" }
        end

        -- Verification de cle contre le backend (liaison UserId + expiration + ban)
        local function validateKey(key)
            if not key or #key < 10 then
                return false, "Clé invalide."
            end
            local data = httpJson(SiteURL .. "/api/v1/check", "POST", {
                key = key,
                userId = lp.UserId,
                executor = execName,
                placeId = game.PlaceId,
            })

            if data.success and data.script then
                -- Cle valide: charge le script servi par le serveur
                local fn, loadErr = loadstring(data.script)
                if fn then
                    local okRun, runErr = pcall(fn)
                    if not okRun then
                        -- remonte l'erreur runtime pour la telemetrie
                        pcall(function()
                            request({
                                Url = SiteURL .. "/api/v1/report",
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
                    return true, "Clé valide ! Script chargé (v" .. tostring(data.version) .. ")."
                else
                    return false, "Erreur de chargement: " .. tostring(loadErr)
                end
            elseif data.reason == "expired" then
                return false, "Clé expirée — retourne sur le site pour la renouveler."
            elseif data.reason == "banned" then
                return false, "Ton compte Roblox est banni de ce script."
            elseif data.reason == "bound_to_other_user" then
                return false, "Cette clé est liée à un autre compte Roblox."
            elseif data.reason == "revoked" then
                return false, "Clé révoquée par l'administrateur."
            elseif data.reason == "no_script" then
                return false, "Aucun script publié pour ce jeu pour le moment."
            elseif data.reason == "invalid_key" then
                return false, "Clé invalide — vérifie le format."
            else
                return false, "Erreur: " .. tostring(data.reason or "inconnue")
            end
        end

        local function copyLink()
            if setclipboard then
                setclipboard(SiteURL .. "/getkey")
            end
        end

        return {
            Verify = validateKey,
            Copy = copyLink,
        }
    end,
}

-- ===== Fenetre avec Key System WindUI =====
local Window = WindUI:CreateWindow({
    Title = "Key System",
    Icon = "key-round",
    Author = "by you",
    Folder = "KeySystem",
    Size = UDim2.fromOffset(580, 460),
    Theme = "Dark",
    KeySystem = {
        Key = { "" }, -- les cles valides sont verifiees par le backend, pas ici
        Note = "Obtiens ta clé sur le site (bouton ci-dessous), colle-la ici, puis clique Verify.",
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

-- Le script est charge automatiquement par validateKey au moment de la verification.
