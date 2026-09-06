--!strict
-- Boutique Option B — Developer Products (Script SERVER, Roblox Studio)
-- A placer dans ServerScriptService du jeu "hub".
--
-- Fonctionnement:
--   1. Le joueur clique un produit (GUI locale) -> MarketplaceService:PromptProductPurchase
--   2. ProcessReceipt recoit le receipt -> idempotence via DataStore (jamais double livraison)
--   3. Envoie le receipt au backend (HttpService:PostAsync) qui livre la cle
--   4. PurchaseGranted seulement apres confirmation serveur
--
-- CONFIG (ServerStorage ou ici):
--   KEYSYSTEM_URL     : https de ton site
--   KEYSYSTEM_SECRET  : ROBUX_WEBHOOK_SECRET (meme valeur que .env)
--   PRODUCTS          : map productId -> { sku, guiName }

local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")
local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")

local KEYSYSTEM_URL = "https://keysystem-vv8b.onrender.com"
local KEYSYSTEM_SECRET = "REPLACE_WITH_ROBUX_WEBHOOK_SECRET"

-- IDs des Developer Products (Monetization > Developer Products) — meme config que le .env
local PRODUCTS = {
	[0000000001] = { sku = "day1", name = "1 Day Key" },
	[0000000002] = { sku = "week1", name = "7 Days Key" },
	[0000000003] = { sku = "month1", name = "30 Days Key" },
	[0000000004] = { sku = "lifetime", name = "Lifetime Key" },
}

-- Idempotence in-game: receipts deja traites ne redeclenchent rien
local receiptsStore = DataStoreService:GetDataStore("KeySystemReceipts_v1")

-- Cle du joueur: simple ScreenGui avec un TextBox (le client copie)
local function showKey(player, key)
	local ok = pcall(function()
		local pg = player:FindFirstChild("PlayerGui") or player:WaitForChild("PlayerGui")
		local gui = Instance.new("ScreenGui")
		gui.Name = "KeyDelivery"
		gui.ResetOnSpawn = false
		gui.Parent = pg

		local frame = Instance.new("Frame")
		frame.Size = UDim2.fromOffset(380, 160)
		frame.Position = UDim2.new(0.5, -190, 0.5, -80)
		frame.BackgroundColor3 = Color3.fromRGB(18, 16, 26)
		frame.BorderSizePixel = 0
		frame.Parent = gui
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, 12)
		corner.Parent = frame

		local title = Instance.new("TextLabel")
		title.Size = UDim2.new(1, -20, 0, 40)
		title.Position = UDim2.new(0, 10, 0, 8)
		title.BackgroundTransparency = 1
		title.TextColor3 = Color3.fromRGB(216, 180, 254)
		title.TextSize = 18
		title.Font = Enum.Font.GothamBold
		title.Text = "💎 Your key is ready!"
		title.Parent = frame

		local box = Instance.new("TextBox")
		box.Size = UDim2.new(1, -20, 0, 60)
		box.Position = UDim2.new(0, 10, 0, 55)
		box.BackgroundColor3 = Color3.fromRGB(23, 20, 31)
		box.BorderSizePixel = 0
		box.Text = key
		box.TextEditable = false
		box.TextSize = 13
		box.TextColor3 = Color3.fromRGB(192, 132, 252)
		box.Font = Enum.Font.Code
		box.TextWrapped = true
		box.ClearTextOnFocus = false
		box.Parent = frame
		local c2 = Instance.new("UICorner")
		c2.CornerRadius = UDim.new(0, 8)
		c2.Parent = box
	end)
	return ok
end

-- Livraison: POST au webhook du site (secret en Authorization)
local function deliverKey(player, receiptInfo)
	local product = PRODUCTS[receiptInfo.ProductId]
	if not product then
		warn("[KeySystem] Produit inconnu:", receiptInfo.ProductId)
		return false, "unknown product"
	end

	local body = HttpService:JSONEncode({
		secret = nil, -- via header uniquement
		receipt_id = tostring(receiptInfo.PurchaseId),
		roblox_user_id = player.UserId,
		username = player.Name,
		product_id = receiptInfo.ProductId,
	})

	local ok, response = pcall(function()
		return HttpService:PostAsync(
			KEYSYSTEM_URL .. "/api/robux/webhook",
			body,
			Enum.HttpContentType.ApplicationJson,
			false,
			KEYSYSTEM_SECRET -- passe comme secret header (PostAsync 5e arg)
		)
	end)

	if not ok then
		warn("[KeySystem] Webhook error:", tostring(response))
		return false, "webhook error"
	end

	-- Reponse attendue: {"success":true,"key":"..."}
	local data
	local okParse = pcall(function()
		data = HttpService:JSONDecode(response)
	end)
	if okParse and data and data.success and data.key then
		showKey(player, data.key)
		return true
	end
	warn("[KeySystem] Reponse invalide:", response)
	return false, "bad response"
end

-- ProcessReceipt: IDEMPOTENT (doc officielle MarketplaceService)
-- Retours: PurchaseGranted (livre) | PurchaseNotProcessed (retry plus tard)
MarketplaceService.ProcessReceipt = function(receiptInfo)
	local player = Players:GetPlayerByUserId(receiptInfo.PlayerId)
	if not player then
		-- Joueur parti: retry quand il revient (Roblox re-invocera)
		return Enum.ProductPurchaseDecision.PurchaseNotProcessed
	end

	local receiptKey = "rcpt_" .. tostring(receiptInfo.PurchaseId)

	-- 1. DataStore: deja traite? (idempotence in-game)
	local alreadyDone
	local okDS = pcall(function()
		alreadyDone = receiptsStore:GetAsync(receiptKey)
	end)
	if okDS and alreadyDone then
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end

	-- 2. Livraison via backend (lui-meme idempotent sur receipt_id)
	local delivered, err = deliverKey(player, receiptInfo)
	if not delivered then
		warn("[KeySystem] Livraison echouee:", tostring(err))
		return Enum.ProductPurchaseDecision.PurchaseNotProcessed
	end

	-- 3. Marque traite
	pcall(function()
		receiptsStore:SetAsync(receiptKey, {
			userId = player.UserId,
			productId = receiptInfo.ProductId,
			at = os.time(),
		})
	end)

	return Enum.ProductPurchaseDecision.PurchaseGranted
end

print("[KeySystem] Boutique initialisée — " .. tostring(#(PRODUCTS)) .. " offres (webhook " .. KEYSYSTEM_URL .. ")")
