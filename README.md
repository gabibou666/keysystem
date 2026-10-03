# AUDIT HUB — Plateforme de scripts et licences

## Plateforme développeurs

L'accueil présente désormais la plateforme multi-développeurs. `/dashboard` est
le workspace développeur, `/docs` documente l'API, `/claim?project=UUID` délivre les
clés des projets après vérification LootLabs, Work.ink, Linkvertise ou
LinkUnlocker. Les anciennes pages joueurs, boutique Robux, administration et API historiques ont été retirées.

Chaque développeur possède ses projets, licences, scripts et tokens API dans
des tables `developer_*` séparées. Les clés `ah_` sont propres à un projet;
les tokens privés `ahp_` permettent seulement l'émission depuis un backend.
Le loader public n'embarque aucun token API. Les scripts et tokens fournisseurs
sont chiffrés avec la même `AES_KEY` stable que le service existant.

En production, le serveur applique les migrations développeurs dans une
transaction avant d'accepter les requêtes. Il utilise sa `DATABASE_URL`, avec
un verrou pour les démarrages simultanés et des délais SQL bornés. Les migrations
conservent les données existantes ; la normalisation des emails peut bloquer
sur un doublon préexistant. Aucune fusion automatique n'est faite.
`npm run migrate` applique le même ensemble de migrations développeurs.
Le callback Discord reste
`/api/discord/callback`: aucun nouveau redirect URI n'est nécessaire.

### Checkpoints par projet

Chaque projet choisit LootLabs, Work.ink, Linkvertise ou LinkUnlocker dans son
onglet Checkpoints. LootLabs utilise son token et un postback authentifie ;
Work.ink utilise un lien et son ID numerique ; Linkvertise utilise un Target
Link, son token anti-bypass et la destination indiquee apres configuration ;
LinkUnlocker utilise son lien et son Redirect API token. Les secrets sont
chiffres dans la base et leurs valeurs sauvegardees ne sont pas renvoyees au
navigateur. Le callback authentifie est visible et copiable uniquement par le
proprietaire du projet ; cette URL contient un secret a garder prive.

La migration `migration-developer-zcheckpoint-providers.sql` fait partie du
démarrage en production et préserve les projets LootLabs existants. Les retours
Work.ink, Linkvertise et LinkUnlocker sont verifies cote serveur et lies a une
session du même navigateur et de la même IP. Work.ink doit confirmer un jeton
créé après le démarrage, non expiré, pour le bon lien et la bonne IP. LootLabs
exige `click_id`, `unique_id` et `ip` dans son postback. Les preuves consommées
sont enregistrées sous forme d'empreintes dans un registre global : les
réutiliser sur un autre projet ou après le nettoyage des sessions est refusé.
Seul un HMAC de l'IP est conservé dans la session, sans adresse brute.
La migration `migration-developer-zprovider-guards.sql` expire les anciennes
sessions incomplètes sans liaison IP ; elle conserve les clés déjà délivrées.
Tester un parcours réel pour chaque fournisseur avant de partager la page publique.

### Validation et obfuscation des scripts développeurs

`npm install` / `npm ci` installe darklua **0.19.0** depuis sa release officielle,
avec vérification SHA-256 de l'archive avant extraction. Les plateformes Windows,
Linux et macOS x64/arm64 prises en charge sont définies dans
`server/scripts/install-darklua.js`. L'exécutable reste hors Git ; le réinstaller
avec `node server/scripts/install-darklua.js` si nécessaire. Une installation
indisponible bloque les builds, sans fallback vers le source original.

Chaque upload parse Lua/Luau, retire les commentaires et types, renomme les
variables locales par AST et compacte le résultat. Le résultat est reparsé,
puis uniquement ce **build obfusqué** est stocké chiffré. Le nouvel original n'est
pas conservé en base : il est traité en mémoire et dans un répertoire temporaire
privé, supprimé après la fin du processus. Le code n'est jamais exécuté pendant
la validation et n'est transmis à aucun service d'obfuscation externe.

L'obfuscation est légère, gratuite et sans crédit commercial. Elle n'empêche pas
un destinataire d'analyser le code reçu. La validation est syntaxique ; elle ne
prouve ni le fonctionnement d'un jeu ni la compatibilité avec chaque exécuteur.
Les protections HTTP, la limite de 1 Mo par upload, deux traitements simultanés
par processus et un délai de 15 secondes restent nécessaires. La publication
revalide le build et refuse une version modifiée entre validation et sauvegarde.

L'upload accepte `targetMode: "universal"` (défaut) ou `"single"` avec `placeId`,
un entier positif sûr en JavaScript. Une garde `game.PlaceId` est ajoutée au build
et au loader pour une cible unique. Une publication libre fige le build et sa
cible ; une publication avec licence suit le build actuel du projet.

La migration `migration-developer-zscript-builds.sql` préserve les anciens
contenus chiffrés, mais les marque non validés. **Ré-uploader puis republier les
anciens scripts** : un ancien contenu non validé ne sera plus livré, y compris
sur un endpoint de source libre. Les sauvegardes historiques peuvent encore
contenir les anciens originaux. Les opérateurs disposant du serveur et de
`AES_KEY` peuvent déchiffrer les contenus stockés ; le site n'offre pas de garantie
que son administrateur ne pourra jamais accéder au code.

`npm --prefix server run test:scripts` et `node server/test-data-privacy.js`
vérifient les builds, les cibles et la non-exposition des champs privés.

### Inscription et connexion

`/signup` propose Google, Discord et email ; `/login` permet la connexion,
le renvoi de vérification et la récupération du mot de passe. L'accueil
explique les quatre étapes et comporte des aperçus interactifs identifiés
comme exemples. Chaque compte possède un workspace indépendant.

La migration `migration-developer-signup.sql` conserve les identifiants et
projets existants. La colonne historique `discord_id` représente désormais
l'identifiant interne du compte : les nouvelles inscriptions utilisent un
UUID. Les identités OAuth sont séparées par fournisseur et sujet. Aucun
rapprochement automatique n'est effectué entre deux comptes ayant le même
email. Utiliser la même méthode de connexion pour retrouver ses projets.

Les nouveaux comptes Google et Discord exigent un email vérifié par le
fournisseur. Un email déjà utilisé, y compris ses alias Gmail, ne crée pas de
second compte via une autre méthode : le développeur doit reprendre sa méthode
de connexion initiale. Les comptes existants ne sont jamais fusionnés automatiquement.

La migration `migration-developer-zaccount-guards.sql` normalise les emails et
ajoute les quotas de création en base : un compte par navigateur et cinq par IP
sur une fenêtre de 24 heures. Les connexions à un compte existant sont exemptées.
Le cookie signé de navigateur et les compteurs HMAC réduisent les créations
répétées ; changer de navigateur ou d'IP peut contourner ces limites. Il ne
s'agit pas d'une preuve d'identité humaine. Une collision entre emails existants
arrête la migration pour examen, sans fusion ni suppression de comptes.

Configurer les variables dans l'environnement de l'hébergeur, jamais dans
le dépôt ni dans le chat :

- Google : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Dans un client OAuth
  Web Google, ajouter exactement `https://VOTRE_DOMAINE/api/auth/google/callback`
  comme URI de redirection. La connexion utilise state, nonce, PKCE et vérifie
  la signature Google, l'émetteur, l'audience et l'expiration du jeton.
- Discord : `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` existants et
  `https://VOTRE_DOMAINE/api/discord/callback` comme redirection.
- Email : domaine expéditeur vérifié dans Resend, `RESEND_API_KEY` et
  `AUTH_EMAIL_FROM` (exemple : `AUDIT HUB <accounts@VOTRE_DOMAINE>`).
- `PUBLIC_URL` doit correspondre à l'origine publique HTTPS exacte.

Sans configuration, les options concernées sont signalées comme indisponibles.
Les mots de passe sont hachés avec scrypt. Les liens de vérification et de
réinitialisation expirent après une heure et sont stockés hachés. Les sessions
développeurs utilisent un cookie HttpOnly de sept jours et un token haché en
base ; déconnexion et changement de mot de passe les révoquent côté serveur.
Une réinitialisation ne modifie pas les projets ni les tokens API.
La connexion email, la réinitialisation et la réservation d'envoi d'un lien
partagent un verrou de compte PostgreSQL. Le réseau email est appelé après
la transaction. `test:auth` couvre les deux ordres de concurrence connexion /
réinitialisation et les envois simultanés avec un adaptateur de verrou, car
pg-mem ignore `FOR UPDATE`. Cela ne remplace pas une validation des migrations
et des transactions sur PostgreSQL avant le déploiement.

Valider après configuration : inscription et vérification depuis une boîte
réelle, récupération du mot de passe, puis connexion Google et Discord sur le
domaine public. Les tests locaux simulent les fournisseurs et les emails.

Vérification locale sans base ni secrets de production:

```sh
npm --prefix server run test:platform
npm --prefix server run test:auth
npx --prefix server playwright install chromium
npm --prefix server run test:platform:ui
npm --prefix server run preview:platform
```

L'aperçu isolé écoute sur `http://127.0.0.1:3215`. Il utilise des comptes fictifs,
des tables en mémoire et un fournisseur LootLabs simulé. Les captures des tests
sont enregistrées dans `artifacts/platform`. Les tests ne remplacent pas une
vérification réelle du callback LootLabs après configuration de chaque compte.


## Interfaces de clé

Choisissez une interface personnelle (SDK public) ou celle du site : compact, card, sidebar ; cinq couleurs et trois tailles de boutons avec aperçu. Le SDK expose validate(key), load(key), getKeyUrl() avec des appels par point. load revalide côté serveur, compile puis programme l'exécution ; true ne certifie pas le fonctionnement du script.

## Installation et exploitation

Node 20 à 24. Depuis server : npm ci, configurez les variables de .env.example puis npm start. Gardez HMAC_SECRET et AES_KEY distincts et stables. Les credentials de checkpoints sont configurés dans chaque projet, pas dans les anciennes variables globales.

- npm run migrate -- --dry-run : affiche les migrations développeurs sans connexion.
- npm run migrate : prépare les treize tables développeurs. Aucune ancienne table n'est créée ni supprimée.
- npm run backup / npm run restore : sauvegarde et restauration génériques ; toutes les tables déjà présentes sont conservées. Une restauration historique exige son schéma historique, conservé dans l'historique Git.
- /ping et /api/keepalive : sondes sans accès base. /healthz : sonde de base avec cache ; ?deep=1 pour un diagnostic ponctuel.
- npm test et npm run check : tests serveur et contrôles de fichiers. Tests navigateur : test:platform:ui, test:catalog:ui et test:key-ui:ui.

Le nettoyage retire le code de l'ancien site, sans supprimer les anciennes données en base et sans déployer. Pour une base existante, sauvegarder avant toute intervention ; aucun DROP ni effacement historique n'est exécuté.


## Public profiles and moderation

Public script pages expose developer-declared mobile support, platform key requirements and an optional Discord invite. Developer profiles live at `/developers/:slug`, with a description, avatar theme and validated HTTPS community/website links. Public metadata excludes account email, API/provider credentials and private uploads.

Configure `MODERATION_ADMIN_IDS` with trusted **internal developer account IDs**, comma-separated, to bootstrap administrators. Find the signed-in account ID at authenticated `/api/moderation/me`; do not assume an email account ID is a Discord snowflake. Restart after changing environment configuration. Administrators open `/moderation` and assign existing accounts the moderator or administrator role. Signup cannot grant roles. Bootstrap administrators are managed by server configuration.

The local bounded static scanner examines original and built code without execution. High-risk uploads are blocked; opaque or suspicious uploads remain encrypted pending review, without replacing the active release. There is no safety guarantee for obfuscated or externally loaded behavior. Moderators can decide a held release, resolve reports and quarantine an exact version/hash. Quarantine blocks both free snapshots and licensed delivery. A replacement needs review, and a free listing needs explicit republication.

Application audit records are paginated and restricted to staff, with action, actor/project IDs, version/hash, rules, sanitized decision notes, role changes, time and response status when available. They exclude raw source, bodies, credentials and IP addresses. Core moderation decisions are transactionally audited; general HTTP event recording is best effort with a bounded queue. Records start with this feature, do not reconstruct historical actions or replace infrastructure logs, and currently have no automatic expiry. Keep backups under restricted access. Tests: `npm run test:moderation`, `node test-public-profiles.js`, `node test-moderation-ui.js` (Chromium required).
