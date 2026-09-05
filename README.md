# KeySystem — Système de clés Roblox auto-hébergé

Système de clés complet avec monétisation LootLabs, compatibilité universelle executors (shims + IA), obfuscation automatique, loader GUI, dashboard admin Discord OAuth et statistiques d'exécution.

## Stack

- **Backend** : Node.js + Express (Render.com free)
- **DB** : Neon Postgres (free)
- **Monétisation** : LootLabs (postback serveur-à-serveur anti-bypass)
- **Admin** : Discord OAuth (allowlist d'IDs)
- **IA compat** : TokenRouter (patchs JSON contraints, review manuelle)

## Structure

```
keysystem/
├── server/
│   ├── db/schema.sql          # 11 tables
│   ├── loader/loader.luau     # loader GUI universel (servi par /api/v1/loader)
│   └── src/
│       ├── index.js           # serveur Express
│       ├── migrate.js         # applique le schéma
│       ├── db.js              # pool Postgres
│       ├── compat/            # analyse, prelude shims, obfuscation, pipeline
│       ├── services/          # crypto HMAC/AES, LootLabs, IA
│       └── routes/            # api.js (public) + admin.js
└── web/                       # index, getkey, changelog, admin (HTML statiques)
```

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/key/start` | démarre une session (12h=1 pub, 24h=2 pubs) |
| GET | `/api/lootlabs/postback` | postback LootLabs (checkpoints) |
| GET | `/api/key/status?puid=` | polling → délivre/prolonge la clé |
| GET | `/api/key/info?key=` | countdown côté front |
| POST | `/api/v1/check` | vérification loader → renvoie le build obfusqué |
| POST | `/api/v1/report` | télémétrie erreurs loader |
| GET | `/api/v1/loader` | sert loader.luau |
| GET | `/api/stats/public` | compteur public |
| — | `/api/admin/*` | stats, clés, bans, script manager, patchs IA (session Discord) |

## Déploiement pas-à-pas

### 1. Prérequis (comptes gratuits)
- [Render.com](https://render.com) (compte)
- [Neon.tech](https://neon.tech) (compte → 1 projet Postgres)
- [LootLabs](https://creators.lootlabs.gg) (compte créateur **complet : détails obligatoires remplis**)
- [Discord Developer Portal](https://discord.com/developers/applications) (1 application)

### 2. Neon — base de données
1. Crée un projet → copie la **connection string** (`postgresql://...?sslmode=require`)

### 3. LootLabs — token + postback
1. Panel LootLabs → onglet **API** → génère un token
2. Onglet **Advanced** → active le **Postback** → URL : `https://TONSITE.onrender.com/api/lootlabs/postback`

### 4. Discord — app OAuth
1. Developers Portal → New Application → OAuth2
2. Ajoute un redirect : `https://TONSITE.onrender.com/admin/auth/callback`
3. Copie **Client ID** + **Client Secret**
4. Récupère ton **ID utilisateur Discord** (mode développeur → clic droit ton nom → Copier l'ID)

### 5. Render — déploiement
1. Push ce dossier sur GitHub (repo **privé**)
2. Render → New → **Web Service** → connecte le repo
3. Root directory : `server`
4. Build command : `npm install` · Run command : `npm start`
5. Variables d'environnement (copie `.env.example` comme modèle) :
   - `DATABASE_URL` — la string Neon
   - `PUBLIC_URL` — `https://TONSITE.onrender.com` (l'URL que Render t'attribue)
   - `HMAC_SECRET` et `AES_KEY` — génère : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `LOOTLABS_API_KEY` — ton token
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ADMIN_DISCORD_IDS`
   - `AI_API_KEY`, `AI_BASE_URL=https://tokenrouter.ai/v1`, `AI_MODEL`
   - `NODE_ENV=production`
6. Déployer → note l'URL `https://xxx.onrender.com`
7. **Migrations** : Render → Shell → `npm run migrate` (ou en local avec `DATABASE_URL` en env)

### 6. Keep-alive (optionnel, anti cold-start)
[cron-job.org](https://cron-job.org) → job toutes les 10 min → `https://TONSITE.onrender.com/api/stats/public`

### 7. Premier script
1. Va sur `https://TONSITE.onrender.com/admin/` → login Discord
2. Onglet **Script** → colle ton script + note de changelog → **Sauvegarder**
3. Review les patchs IA si proposés (onglet **Patchs IA**)
4. **Publier** la version
5. Teste le loader : `loadstring(game:HttpGet("https://TONSITE.onrender.com/api/v1/loader"))()`

### 8. Obtenir une clé (test)
1. `/getkey` → 12h ou 24h → pub(s) LootLabs
2. La clé s'affiche + localStorage → countdown sur l'accueil
3. Colle-la dans le loader Roblox

## Sécurité — checklist

- [x] Clés HMAC signées serveur (impossible à forger sans le secret)
- [x] Liaison au premier UserId Roblox (anti-partage)
- [x] Ban en cascade par UserId
- [x] Postback LootLabs vérifié serveur-à-serveur (anti-bypass pub)
- [x] Script original chiffré AES-256-GCM + hash d'intégrité
- [x] Script servi uniquement après check valide (jamais public)
- [x] Secrets uniquement en variables d'environnement
- [x] Rate limiting sur tous les endpoints sensibles
- [x] Sessions admin httpOnly + allowlist Discord
- [ ] **Régénère ton token LootLabs s'il a déjà été partagé quelque part**

## Renouvellement des clés

- Clé expirée → l'utilisateur re-clique sur `/getkey` (le site propose le renouvellement car la clé est en localStorage)
- Il repasse les pubs → **le même string de clé est prolongé** (`expires_at = now + durée`)
- Le loader sauvegarde aussi la clé via `writefile` quand disponible (re-vérif auto au lancement)

## Compatibilité executors

Le pipeline injecte un **prelude** (pure addition, corps du script inchangé) :
- HTTP : `request`/`http_request`/`syn.request`/`http.request`/`fluxus.request`
- Clipboard : `setclipboard`/`toclipboard`/`syn.set_clipboard` (fallback GUI)
- `gethwid` → UserId · `getgenv` → `_G`
- `writefile`/`readfile`/`isfile`/`listfiles` → FS mémoire si absent
- `Drawing` → émulation Frames/Labels si absent (ESP mobile OK)
- `hookfunction`/`queue_on_teleport`/`clonefunction`/`identifyexecutor` → fallbacks

Cas exotiques → patchs IA **contraints** (`{find, replace}` uniques), review manuelle obligatoire avant publication.

**Limite connue** : un executor sans AUCUNE fonction HTTP ne peut pas vérifier de clé (message clair affiché).

## Télémétrie

Chaque exécution est logée (`executions`) : total, uniques, par executor, par jour. Le loader remonte les erreurs (`error_reports`). Compteur public sur l'accueil.
