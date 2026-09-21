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
| GET | `/ping` | sonde de disponibilité — **aucune requête SQL** (cible des moniteurs et keep-alive) |
| GET | `/healthz` | sonde profonde (vérifie la base) — résultat en cache 60 min, `?deep=1` pour forcer |
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

   Optionnel mais recommandé :
   - `DISCORD_INVITE_URL` — invitation Discord **permanente** affichée par le site.
     Génère-la/vérifie-la avec `npm run invite:ensure`. Si la variable est absente,
     le serveur cherche une invitation permanente et en crée une tout seul au
     démarrage (permission *Create Invite* requise pour le bot).
   - `TRUST_PROXY` — défaut `1` (Render). À ajuster uniquement si l'IP vue par
     l'anti-DDoS n'est pas celle du visiteur : l'onglet **anti-DDoS** du panel
     admin affiche un diagnostic (`ipResolution.samples`).
   - `IP_HEADER=cf-connecting-ip` — à activer **seulement** si tout le trafic
     passe par un Cloudflare que tu contrôles (sinon l'en-tête est falsifiable).
   - `SCHEDULERS=off` — pour lancer un serveur local de test sans déclencher la
     purge, l'audit LootLabs et le self-ping sur la production.
6. Déployer → note l'URL `https://xxx.onrender.com`
7. **Migrations** : Render → Shell → `npm run migrate` (ou en local avec `DATABASE_URL` en env)

### 6. Keep-alive & surveillance (gratuit)
- **Réveil de Render** : [cron-job.org](https://cron-job.org) → job toutes les 10-30 min → `https://TONSITE.onrender.com/ping`
- **Surveillance** : [UptimeRobot](https://uptimerobot.com), **deux moniteurs** :
  - `/ping` toutes les **5 min** → disponibilité du site, **zéro requête SQL** ;
  - `/healthz` toutes les **6 h** au maximum → contrôle aussi la base (503 si Neon est injoignable) ;
    son résultat est mis en cache `HEALTHZ_DEEP_TTL_MIN` (360 min par défaut), donc même un moniteur
    trop fréquent ne coûte qu'une sonde toutes les 6 h.
  - La détection d'une panne ne dépend plus de la sonde : **les alertes Discord** (`services/alerts.js`)
    préviennent en quelques minutes quand une erreur serveur ou une base injoignable se produit — et
    elles ne coûtent **aucun** quota tant que tout va bien.
- ⚠️ **Ne jamais pointer un moniteur fréquent vers une route qui lit la base** (`/healthz`,
  `/api/stats/public`… ) : cela garde Neon éveillé 24 h/24 et épuise le quota gratuit. Le garde-fou
  `npm run check` refuse ce cas — c'est exactement l'erreur qui a consommé le quota.
- ⚠️ Le workflow GitHub Actions ci-dessus ne suffit pas comme unique filet : GitHub **désactive les workflows planifiés après 60 jours sans activité du dépôt**. D'où la surveillance externe.

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
- [x] **Secrets obligatoires en production** : le serveur refuse de démarrer si `DATABASE_URL` ou `HMAC_SECRET` manquent (`src/config-check.js`) — plus jamais de repli silencieux sur `dev-secret` (clés forgeables). Les autres variables manquantes déclenchent un avertissement + une alerte Discord **sans couper le site**.
- [x] Liaison au premier UserId Roblox (anti-partage)
- [x] Ban en cascade par UserId
- [x] Postback LootLabs vérifié serveur-à-serveur (anti-bypass pub)
- [x] Script original chiffré AES-256-GCM + hash d'intégrité
- [x] Script servi uniquement après check valide (jamais public)
- [x] Secrets uniquement en variables d'environnement
- [x] Rate limiting sur tous les endpoints sensibles
- [x] Sessions admin httpOnly + allowlist Discord
- [x] **Source d'IP anti-DDoS non falsifiable** : `req.ip` (chaîne de proxies déclarée), en-têtes clients ignorés ; une adresse non publique n'est jamais mise en quarantaine.
- [x] **Échappement HTML strict** dans le panel admin (fini les injections par pseudo Discord) + aucune donnée serveur injectée dans un attribut HTML (`data-*` uniquement)
- [x] **CSP sans `unsafe-inline`** sur les scripts : tous les `<script>` sont des fichiers externes
- [x] Polices auto-hébergées : aucun appel à Google Fonts (RGPD + performance)
- [x] **Garde-fou automatique** (`npm run check`) exécuté en CI : assets, CSP, syntaxe, échappement
- [ ] **Régénère ton token LootLabs s'il a déjà été partagé quelque part**
- [ ] Passe les attributs `onclick=` en `addEventListener` (tolérance actuelle de la CSP) — voir « Suites »

## Scripts

| Commande | Rôle |
|---|---|
| `npm start` | Serveur de production |
| `npm run dev` | Serveur avec rechargement automatique |
| `npm run migrate` | Applique le schéma en base |
| `npm run check` | Garde-fous qualité : assets/scripts inline/syntaxe/échappement (`check-assets`) **+** respect de la direction visuelle (`check-design`) — **exécuté en CI** |
| `npm run check:design` | Vérifie seulement le contrat visuel : violet sur noir, aucune boucle d'animation, `prefers-reduced-motion`, flous ≤ 14 px, jetons `--dx-*` cohérents |
| `npm run invite:ensure` | Trouve/crée une **invitation Discord permanente** |
| `npm run fonts` | Re-télécharge et auto-héberge les polices (`web/fonts/`) |
| `npm run og` | Régénère l'image de partage social (`web/og.png`) |

CI GitHub Actions (`.github/workflows/ci.yml`) : lance `npm ci`, `npm run check`,
un audit des dépendances et un **smoke test** qui démarre réellement le serveur
puis vérifie les pages, `robots.txt`, `sitemap.xml`, le CSS et `healthz`.

## Automatisation (sauvegarde et surveillance)

| Tâche | Mécanisme | Cadence | Trace |
|---|---|---|---|
| Sauvegarde de la base | tâche planifiée Windows « KeySystem - sauvegarde base » | quotidienne à 20:00 | `…/keysystem-backups/backup.log` |
| Sauvegarde de la base | `.github/workflows/backup.yml` | quotidienne 03:17 UTC | artefact GitHub (30 j) |
| Surveillance du site | tâche planifiée « KeySystem - surveillance site » | toutes les 15 min | `…/keysystem-backups/watchdog.log` |
| Surveillance du site | `.github/workflows/watchdog.yml` | toutes les 15 min | onglet Actions + Discord |

Les deux tâches locales **fonctionnent sans compte ni secret** (elles lisent `.env`) : la sauvegarde
s'exécute même si personne n'est devant l'écran, et la surveillance sonde `/ping` (aucune requête SQL)
puis `/healthz`. Les workflows GitHub prennent le relais quand le PC est éteint ; ils demandent des
secrets de dépôt (Settings → Secrets and variables → Actions) :

- `DATABASE_URL` — **obligatoire** pour la sauvegarde hors PC ;
- `AES_KEY` — recommandé : enregistre l'empreinte de la clé dans le manifest, ce qui permet de vérifier
  plus tard qu'une sauvegarde reste déchiffrable ;
- `DISCORD_WEBHOOK_URL` — optionnel : alerte en cas d'échec ou de site injoignable.

**Vérifier que l'automatisation tourne vraiment** (une automatisation silencieuse ne sert à rien) :

```bash
tail -2 ../keysystem-backups/backup.log     # une ligne par sauvegarde
tail -2 ../keysystem-backups/watchdog.log   # une ligne par sonde, avec les temps de réponse
```

À la main : `npm run backup`, `npm run watchdog -- --deep`. Rétention : `npm run backup -- --keep=14`
(14 sauvegardes conservées par défaut, les plus anciennes sont supprimées).

⚠️ Une sauvegarde contient des données utilisateurs (identifiants Discord, clés) : elle vit **hors du
dépôt git**, et les artefacts GitHub ne sont téléchargeables que par les personnes authentifiées sur le
dépôt.

## Sauvegarde et restauration de la base

`pg_dump` n'est pas nécessaire — et ne serait pas suffisant : la base gratuite peut être **suspendue à
tout moment** (quota de calcul épuisé) et, dans ce cas, plus aucune connexion n'est possible, donc plus
aucune sauvegarde. Les deux scripts fournis n'utilisent que la dépendance `pg` déjà présente.

```bash
npm run backup                       # uniquement des SELECT : n'écrit rien en base
npm run backup -- D:/mes-sauvegardes # dossier de sortie personnalisé
```

Ce que produit une sauvegarde — par défaut `<Documents>/keysystem-backups/<horodatage>/`, **hors du
dépôt git**, car elle contient des données utilisateurs :

- `data/<table>.json` : un fichier par table du schéma `public`. La liste des tables est **lue en
  base**, jamais codée en dur : une table ajoutée plus tard est sauvegardée automatiquement ;
- `manifest.json` : horodatage, compte de lignes et empreinte sha256 par fichier, empreintes des
  fichiers de schéma du dépôt, taille de la base, et l'**empreinte de l'`AES_KEY`** utilisée.

Restauration, sur une base neuve :

```bash
npm run migrate                                                   # recrée le schéma
npm run restore -- ../keysystem-backups/2026-09-21T16-09          # simulation
npm run restore -- ../keysystem-backups/2026-09-21T16-09 --write  # écrit réellement
```

Le script de restauration vérifie les empreintes avant toute écriture, **refuse d'écrire dans des tables
non vides** (`--force` pour un écrasement délibéré), insère dans l'ordre **calculé depuis les clés
étrangères réelles**, et recalibre les séquences — sans quoi la première clé créée après restauration
entrerait en conflit avec un id déjà utilisé.

### Migrer vers un autre hébergeur de base

Le mot de passe de la nouvelle base n'a pas à être montré à quiconque, et une erreur de cible est
impossible à commettre en silence :

1. créer la base chez le nouvel hébergeur, puis copier sa chaîne de connexion complète ;
2. l'écrire dans `server/.env.migration` (ignoré par git) :
   `DATABASE_URL=postgres://utilisateur:motdepasse@hote:port/base`
3. **vérifier la cible avant toute écriture** : `npm run db:target` — affiche `hote:port/base`, jamais les
   identifiants, et indique si `.env.migration` est pris en compte ;
4. créer le schéma, puis réinjecter les données :
   ```bash
   npm run migrate                                              # schema.sql + db/migration-*.sql
   npm run restore -- ../keysystem-backups/<horodatage> --write
   ```
5. remplacer `DATABASE_URL` dans Render par la même chaîne, puis redéployer ;
6. vérifier : `/healthz` (`db:"up"`), `/api/stats/public` (compteurs identiques), et la délivrance d'une clé ;
7. supprimer `server/.env.migration`, et garder l'ancienne base quelques jours — revenir en arrière se
   limite à rechanger une variable.

Garde-fous : la restauration **refuse d'écrire dans une base non vide** et **vérifie que la cible contient
les 21 tables** attendues (sinon elle s'arrête en indiquant qu'il faut lancer `npm run migrate`).

⚠️ **`script_versions.original_enc` est chiffré (AES-256-GCM)** : les originaux de scripts ne sont
lisibles qu'avec **la même `AES_KEY`** que celle qui les a chiffrés. Conservez donc, hors du dépôt
(gestionnaire de mots de passe), `AES_KEY` **et** `HMAC_SECRET` — sans le second, toutes les clés déjà
délivrées deviennent invalides. Le démarrage du serveur affiche l'empreinte de la clé en service : elle
doit correspondre à celle du `manifest.json` de la sauvegarde.

## Consommation de la base (plan gratuit Neon)

Le plan gratuit Neon accorde **100 CU-hours par mois et par projet** et **met le calcul en veille
après 5 minutes d'inactivité**. D'où une conséquence contre-intuitive :

| Scénario | Requêtes SQL | CU-hours/mois | Verdict |
|---|---|---|---|
| Ping toutes les 5 min vers une route qui lit la base | 288/jour | ~182 | ❌ quota épuisé vers le 16 |
| Ping toutes les 30 min vers une route qui lit la base | 48/jour | ~182 | ❌ idem : la base ne dort jamais |
| Sonde profonde `/healthz` toutes les heures | 24/jour | ~15 | ⚠️ possible, mais 15 % du quota pour rien |
| Sonde profonde `/healthz` toutes les 6 h (défaut) | 4/jour | ~2,5 | ✅ |
| Visites réelles + surveillance sur `/ping` | ~10/jour | < 5 | ✅ confortable |

Quand le quota est dépassé, Neon **suspend le calcul jusqu'à la période suivante** (ou jusqu'à un
passage payant). Les **données ne sont jamais supprimées**, et le compteur repart de zéro à chaque
période de facturation. Suivi : console Neon → projet → **Monitoring / Usage**.

**Les règles, et pourquoi :**
- les moniteurs et keep-alive visent `/ping` ou `/api/keepalive` : **aucune requête SQL**, donc la
  base peut dormir entre deux visites réelles — c'est tout l'intérêt du plan gratuit ;
- `/healthz` est la sonde **profonde** : son résultat est mis en cache `HEALTHZ_DEEP_TTL_MIN`
  minutes (**360 par défaut**), donc l'appeler en boucle ne coûte qu'une sonde toutes les 6 h.
  `?deep=1` force une sonde réelle (diagnostic) ;
- la détection de panne vient des **alertes événementielles** (`src/services/alerts.js`), pas de la
  sonde : elles partent vers Discord quand une erreur serveur non gérée survient ou quand la base
  devient injoignable (une alerte par bug et par 10 min, plafond d'une alerte/minute) ;
- une base en panne n'est **pas** mise en cache une heure : nouvelle sonde au bout de **60 s**, pour
  détecter la reprise rapidement ;
- les tâches planifiées qui touchent la base restent espacées : purge **quotidienne**, audit LootLabs
  `AUDIT_INTERVAL_HOURS` (**6 h par défaut**).

Garde-fou : `npm run check` exécute `scripts/check-cost.js`, qui échoue si un workflow GitHub pointe
un ping vers une route qui lit la base, si `/ping` ou `/api/keepalive` se mettent à appeler le pool,
ou si un `setInterval` de moins de 5 minutes contient une requête SQL. `npm test` exécute
`test-healthz-cache.js`, qui démarre le vrai serveur et vérifie ces comportements.

## Suites recommandées (non bloquantes)

1. **Cache CDN long** : les assets sont servis en `immutable` avec `?v=<hash>` calculé au démarrage (`src/index.js`). Le HTML reste en `no-cache`.
2. **Loader** : `/api/v1/check` renvoie tout le script à chaque lancement; un ETag/`If-None-Match` éviterait de re-télécharger 30 Ko identiques.
3. **Attributs `onclick=`** : les convertir en `addEventListener` permettrait de retirer `script-src-attr 'unsafe-inline'` de la CSP.
4. **Observabilité** : Sentry (erreurs) + un moniteur sur `/healthz` avec alerte Discord.
5. **Sauvegardes** : un `pg_dump` planifié vers un stockage externe (la perte de la base = tous les utilisateurs bloqués).
6. **`trust proxy`** : confirmer via le diagnostic admin que l'IP résolue est bien celle du visiteur.

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
