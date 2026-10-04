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

L’obfuscation est facultative et désactivée par défaut. Le serveur conserve une
copie originale chiffrée, accessible uniquement au propriétaire dans le dashboard
et son export de données. Le loader délivre la version validée choisie par
l’auteur : originale si l’option est désactivée, transformée si elle est activée.
Les scripts sont limités à **8 Mio en entrée** et **32 Mio en sortie**. Le source
courant est toujours conservé. Les copies historiques des traitements terminés
sont bornées aux 20 derniers par projet et à 32 Mio par compte ; les métadonnées
couvrent les 100 derniers traitements par projet. Les sources des traitements
actifs et en examen sont conservées. Une copie historique expirée est signalée
indisponible, jamais reconstruite à partir du code transformé.

`npm install` / `npm ci` installe trois outils épinglés depuis leurs releases
officielles, avec contrôle SHA-256 : Darklua **0.19.0**, Prometheus **0.2.11.1**
et le compilateur Luau **0.741**. `node server/scripts/install-script-tools.js`
permet de les réinstaller. Les exécutables restent hors Git ; les licences sont
conservées dans `server/licenses` et auprès des outils. L’obfuscation est prise
en charge sur Render Linux x64 et macOS Apple Silicon. Une plateforme non prise
en charge ou un outil absent bloque le traitement concerné avec une erreur
explicite, sans publier silencieusement un source à la place du résultat demandé.
Aucune dépendance NPM de production supplémentaire n’est requise. Sur Linux,
l’installateur construit l’interpréteur Lua 5.1.5 depuis l’archive officielle
épinglée de Lua.org afin d’éviter la dépendance glibc trop récente du binaire
fourni par Prometheus. Cette compilation a lieu pendant l’installation, jamais
lors d’un traitement utilisateur ; elle nécessite les outils C du build Render.

Standard utilise le renommage des identifiants locaux, la suppression des
commentaires et espaces, le découpage des longues chaînes par l’étape officielle
SplitStrings, ainsi qu’un tableau de chaînes encodées en Base64 avec
décodage à l’exécution. Fort ajoute le passage dans le dispatcher de la machine
virtuelle de Prometheus, le chiffrement des chaînes et la réécriture numérique.
Les globals d’executors tels que `getgenv` et `loadstring` restent externes.
La syntaxe Luau est normalisée par Darklua avant les étapes Lua de Prometheus.
Certains scripts valides sont incompatibles avec les transformations Fort ;
le traitement refuse alors clairement et propose Standard, notamment pour les
boucles génériques `for … in` et les appels de méthode dont les arguments
peuvent avoir des effets, car Lua 5.1 et Luau les évaluent dans des ordres différents.
Le moteur Prometheus reçoit un correctif de dépendances étroit et vérifié sur
les empreintes upstream pour conserver l’ordre des lectures/écritures de méthodes.
Aucun prédicat opaque dédié n’est activé : l’étape
AntiTamper disponible dépend du format des erreurs de l’hôte et peut casser un
executor. Le mode Fort ne prétend pas apporter cette protection. Le compilateur
Luau vérifie l’entrée et le résultat, sans exécuter de code utilisateur. Cette
validation ne prouve pas le fonctionnement dans un jeu ou chaque executor.

La migration additive `migration-script-jobs.sql` crée `developer_script_jobs`
et `developer_script_worker_lease`, et étend les scripts et demandes de revue.
Le verrou global garde un seul traitement actif, même pendant deux déploiements
qui se chevauchent ou une suppression de job sur une autre instance. La lease
technique ne contient ni compte, ni source, ni identifiant personnel.

L’upload et la publication passent par une file persistante. Le propriétaire
voit progression, résultat, date, niveau et tailles dans l’historique de son
projet, et peut annuler un traitement. L’ancienne version reste livrée pendant
le travail. Un échec de compilation, une annulation, un conflit de version ou
une restriction administrative empêche le remplacement. Les scripts douteux
restent chiffrés en attente de modération. Republier permet de changer de niveau
ou de revenir à l’original conservé. Les anciens builds dont le source original
n’était pas conservé demandent un nouvel upload pour ces opérations.

Le traitement utilise des sous-processus sans shell, un environnement restreint,
un répertoire temporaire privé supprimé après usage, des limites de temps,
de mémoire et de taille. Un seul traitement s’exécute à la fois, avec au plus
90 secondes au total pour les outils et 256 Mio par sous-processus sur Linux. La file ne lance aucun
sondage périodique lorsque la base est inactive. Aucun script n’est exécuté pendant sa validation ni
transmis à un service externe. Base64 et les clés de décodage sont présents dans
le résultat : ils gênent la lecture mais ne rendent pas les chaînes secrètes.
La machine virtuelle augmente fortement la taille et peut ralentir l’exécution.
L’obfuscation freine l’ingénierie inverse ; elle ne la rend jamais impossible.

L’upload accepte `targetMode: "universal"` (défaut) ou `"single"` avec `placeId`,
un entier positif sûr en JavaScript. Une garde `game.PlaceId` est ajoutée à la
version délivrée et au loader pour une cible unique. Une publication libre fige
la version et sa cible ; une publication avec licence suit la version du projet.

La migration historique `migration-developer-zscript-builds.sql` conserve les
anciens contenus chiffrés, mais les marque non validés. **Ré-uploader puis
republier les anciens scripts non validés** avant toute livraison. Les opérateurs
disposant du serveur et de `AES_KEY` peuvent déchiffrer les contenus en base ;
la restriction « propriétaire uniquement » concerne les accès par l’application.

Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus

### Inscription et connexion

`/signup` propose Google, Discord et email ; `/login` permet la connexion,
le renvoi de vérification et la récupération du mot de passe. L'accueil
explique le parcours en quatre étapes. Chaque compte possède un workspace
indépendant.

### Accueil, support et statistiques publiques

Le pied de page est alimenté par `GET /api/site/config`. Configurer sur Render :

- `DISCORD_URL=https://discord.gg/KdQwN99C9w` pour le support Discord ;
- `SUPPORT_EMAIL` avec l'adresse réelle du support ;
- `STATUS_URL` avec l'URL HTTPS de la page de statut.

Ces trois variables sont vides par défaut : les liens absents ou invalides
restent masqués. Les URL n'acceptent pas de credentials et utilisent HTTPS
(HTTP est uniquement accepté pour localhost/loopback en développement).
Le changelog du produit est disponible à `/changelog` sans variable.

`GET /api/site/stats` fournit les nombres agrégés de projets, de licences
en base et de scripts visibles dans le catalogue. Les scripts retirés, profils
privés et releases en quarantaine ne contribuent pas au nombre de publications.
Les comptes, noms de projets, clés et autres données individuelles restent
privés. La ligne n'est affichée que si les trois seuils sont atteints : au moins
10 projets, 100 licences et 3 scripts publiés. En dessous, ou si la base est
indisponible, toutes les valeurs sont masquées. Le résultat, y compris un échec,
est mis en cache dix minutes par processus ; les demandes simultanées partagent
une requête. Un délai de trois secondes masque les statistiques si la connexion
ou la requête est trop lente. Aucun rafraîchissement périodique n'est lancé : ne pas utiliser cet
endpoint comme sonde de disponibilité.

Le bouton de signalement des scripts utilise `/api/moderation/reports` : compte
connecté, raison limitée à malware/confidentialité/trompeur/autre et message de
500 caractères maximum. Les signalements sont enregistrés pour les modérateurs,
avec un maximum de dix demandes par heure et par compte. Les doublons ouverts
ne créent pas de second signalement.

`node server/test-site.js` vérifie les liens de support, les seuils de
confidentialité, le cache, les règles de publication et l'enregistrement des
signalements avec une base de test isolée. Les aperçus locaux utilisent uniquement
des données de démonstration : aucune preuve sociale de production n'est créée.

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
- npm run migrate : prépare les dix-huit tables développeurs. Aucune ancienne table n'est créée ni supprimée.
- npm run backup / npm run restore : sauvegarde et restauration génériques ; toutes les tables déjà présentes sont conservées. Une restauration historique exige son schéma historique, conservé dans l'historique Git.
- /ping et /api/keepalive : sondes sans accès base. /healthz : sonde de base avec cache ; ?deep=1 pour un diagnostic ponctuel.
- npm test et npm run check : tests serveur et contrôles de fichiers. Tests navigateur : test:platform:ui, test:catalog:ui et test:key-ui:ui.

Le nettoyage du site préserve les anciennes tables en base. Pour une base existante, sauvegardez avant toute intervention. Les migrations ne suppriment aucune table ; la migration de confidentialité retire les références orphelines du journal développeur, puis garantit les références restantes par des clés étrangères.


## Public profiles and moderation

Public script pages expose developer-declared mobile support, platform key requirements and an optional Discord invite. Developer profiles live at `/developers/:slug`, with a description, avatar theme and validated HTTPS community/website links. Public metadata excludes account email, API/provider credentials and private uploads.

Configure `MODERATION_ADMIN_IDS` with trusted **internal developer account IDs**, comma-separated, to bootstrap administrators. Find the signed-in account ID at authenticated `/api/moderation/me`; do not assume an email account ID is a Discord snowflake. Restart after changing environment configuration. Administrators open `/moderation` and assign existing accounts the moderator or administrator role. Signup cannot grant roles. Bootstrap administrators are managed by server configuration.

The local bounded static scanner examines original and built code without execution. High-risk uploads are blocked; opaque or suspicious uploads remain encrypted pending review, without replacing the active release. There is no safety guarantee for obfuscated or externally loaded behavior. Moderators can decide a held release, resolve reports and quarantine an exact version/hash. Quarantine blocks both free snapshots and licensed delivery. A replacement needs review, and a free listing needs explicit republication.

Application audit records are paginated and restricted to staff, with action, actor/project IDs, version/hash, rules, sanitized decision notes, role changes, time and response status when available. They exclude raw source, bodies, credentials and IP addresses. Core moderation decisions are transactionally audited; general HTTP event recording is best effort with a bounded queue. Records start with this feature, do not reconstruct historical actions or replace infrastructure logs, and currently have no automatic expiry. Keep backups under restricted access. Tests: `npm run test:moderation`, `node test-public-profiles.js`, `node test-moderation-ui.js` (Chromium required).

## Confidentialité, cookies et gestion du compte

`/privacy`, `/terms`, `/cookies` et `/legal` proposent le texte intégral en anglais
et français. La préférence de langue de la landing s'applique aux pages légales,
au pied de page et au consentement. Les valeurs publiques `LEGAL_NAME`,
`LEGAL_EMAIL` et `LEGAL_ADDRESS` sont vides par défaut : leurs emplacements restent
visibles, marqués « À renseigner par l’éditeur ». `SUPPORT_EMAIL`, `DISCORD_URL` et
`STATUS_URL` restent facultatifs ; leurs liens sont masqués quand ils sont vides.
Ces champs sont publiés sur le site : n'y mettez aucun secret.

Le bandeau est une région accessible et non modale. Accepter, refuser et
personnaliser ont le même style. Les cookies nécessaires restent actifs ; les
usages facultatifs sont désactivés par défaut. Le choix est enregistré dans
`localStorage` sous `audit-hub-cookie-consent`, avec une expiration à six mois
calendaires. « Gérer mes cookies » rouvre les préférences dans chaque footer.
Aucun outil d'analyse d'audience ou pixel n'est installé. Toute future intégration
facultative doit être enregistrée par `AuditHubConsent.whenAllowed('optional',
start)` ; `start` peut renvoyer une fonction de nettoyage pour le retrait de
l'accord. N'ajoutez pas de chargement facultatif direct dans le HTML. La catégorie
et la version du consentement doivent évoluer si les finalités changent.

Les nouvelles inscriptions email, Google et Discord exigent un accord explicite
aux conditions et à la politique de confidentialité. L'accord OAuth est inclus
dans l'état signé et lié au navigateur. La date et les versions sont conservées
sur le compte ; les comptes existants n'ont pas de date d'accord inventée.

Dans le dashboard, « Compte et données » fonctionne même sans projet. L'export
JSON (`GET /api/account/export`) exige une session active et renvoie le compte,
les identités liées et les collections appartenant au workspace. Les sources
exportées comprennent les versions délivrées et les originaux privés conservés
par le nouveau pipeline. Les originaux des anciens builds ne sont pas reconstitués. Les mots de passe, secrets/tokens et leurs
hashes, les empreintes des visiteurs et les données privées d'autres comptes sont
exclus. L'export serveur utilise un instantané cohérent et une pagination. Un seul
export par compte, deux globalement et une durée totale de 60 secondes limitent
les connexions occupées. Les interruptions libèrent les connexions.

La suppression (`DELETE /api/account`, JSON `{ "confirmation": "DELETE" }`)
exige une session et l'origine du site. Elle retire transactionnellement le compte,
ses identités, sessions et ressources dépendantes, y compris les originaux et
traitements de publication. L’ancien audit de modération est anonymisé. Le
journal administratif de sécurité est distinct : il conserve ses entrées
immutables, avec les acteurs, cibles et IP, selon la durée opérateur documentée.
Les références de l’audit de modération sont protégées par des clés étrangères,
y compris contre les écritures asynchrones.
Les preuves globales anti-rejeu sans lien compte/projet et les compteurs de
sécurité pseudonymisés continuent leur rétention documentée. OWNER ne peut pas supprimer son compte depuis l’interface. Un administrateur
configuré ou le dernier administrateur doit d’abord transférer ses responsabilités.
Les copies téléchargées chez des tiers et les sauvegardes externes ne sont pas
effacées par cette route.

Deux migrations additives préparent les versions d'accord et les références
anonymisables de l'audit. Elles sont incluses dans la procédure commune de migration
et le démarrage de production. Sauvegardez la base et vérifiez les migrations dans
votre environnement de validation avant publication.

À compléter avant publication : identité et contact de l'éditeur, mentions liées
à son statut juridique, fournisseur/région réels de la base de données, durées des
sauvegardes et journaux (y compris alertes Discord), durée et nettoyage des données
de modération, contrats et garanties des transferts hors EEE. Les pages signalent
ces informations manquantes ; elles ne constituent pas une certification RGPD.
Vérifiez l'adresse de contact et la procédure de réponse aux droits des utilisateurs.

Validation isolée : `npm test`, `npm run check`, `npm run test:consent:ui` et
`npm run test:legal:ui`. Les tests navigateur couvrent les choix de cookies,
le retrait, l'expiration, les politiques EN/FR, le clavier, l'absence de chargements
externes, l'export et la suppression d'un compte fictif à 360 px.


## Administration de l’équipe

L’espace protégé `/admin` reprend le design Studio. Il n’apparaît dans aucun menu
public ; le lien du workspace ne s’affiche qu’après vérification du rôle par le
serveur. Le document HTML est placé hors du dossier statique. Un visiteur sans
rôle staff reçoit une 404.

La hiérarchie est `OWNER > CO_OWNER > ADMIN > MODERATOR > USER`. Une action sur
un compte, une licence, un projet ou un script exige un rôle strictement supérieur
à celui du propriétaire ciblé. Une attribution ne peut accorder qu’un rôle
strictement inférieur à celui de l’acteur. Les mêmes règles s’appliquent aux
anciennes routes de modération ; masquer les boutons ne constitue jamais une
permission. Le lien « Revue de sécurité » de l’administration ouvre la file des
versions en examen à `/moderation` avec la même session courte et le token CSRF.
La gestion d’équipe reste centralisée dans `/admin/team`.

`OWNER_DISCORD_ID` vaut par défaut `899294059225579531`. Le rôle OWNER est calculé
uniquement depuis un sujet Discord vérifié par l’échange OAuth côté serveur. Un
identifiant de compte identique, un email ou un champ du client ne suffit pas.
L’interface ne peut pas modifier, retirer, bannir ou supprimer OWNER. L’éditeur
doit disposer d’un OAuth Discord opérationnel (`DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, retour `/api/discord/callback`) et se connecter avec le
compte Discord configuré pour amorcer l’équipe.

La connexion normale ne crée pas silencieusement une session d’administration.
L’utilisateur l’active explicitement ; le cookie nécessaire `ah_admin_session`
expire après deux heures d’inactivité et reste lié à sa session principale.
Les mutations exigent l’origine exacte du site, un corps JSON et le token CSRF
associé. L’accès est limité en débit. Bannir, suspendre ou forcer une déconnexion
révoque les sessions du compte. Les confirmations de bannissement, suppression
et promotion ADMIN/CO_OWNER sont aussi exigées côté serveur.

Les vues couvrent les indicateurs réels et les inscriptions sur 30 jours,
utilisateurs, projets/licences, publications, signalements, équipe, audit et
réglages. MODERATOR dispose des lectures usuelles et peut avertir, traiter un
signalement, masquer ou retirer une publication. ADMIN gère utilisateurs,
ressources et nominations MODERATOR. OWNER/CO_OWNER peuvent consulter l’audit
et les réglages ; OWNER peut nommer CO_OWNER. Les projections ne comprennent
aucun mot de passe, secret de fournisseur, token de session ou clé d’API.

Les invitations par email vérifié ou ID Discord sont appliquées lors d’une
connexion vérifiée ; la permission de leur auteur est contrôlée de nouveau.
Un pseudo absent ne peut pas prouver une identité : l’invitation reste à confirmer
jusqu’à ce que OWNER/CO_OWNER la lie explicitement à un compte vérifié. Cela évite
qu’un visiteur obtienne un rôle simplement en choisissant ce pseudo. Aucun message
n’est envoyé à un tiers par la création d’une invitation.

Le mode maintenance bloque les API de la plateforme et du catalogue, avec accès
conservé aux politiques et à l’authentification. OWNER/CO_OWNER peuvent gérer la
maintenance. La fermeture des inscriptions empêche les nouveaux comptes sans
bloquer les connexions existantes. L’annonce est affichée comme texte simple dans
un bandeau commun. Les réglages sont relus à la demande, avec un cache de dix
secondes invalidé après une modification locale ; aucun minuteur ne réveille la
base inactive. Un projet désactivé ne délivre ni script, ni licence, ni checkpoint.
Un auteur ne peut pas republier une publication masquée ni restaurer une licence
révoquée par l’équipe.

`migration-admin-dashboard.sql` est additive et incluse dans le manifeste commun.
Elle crée `developer_staff_roles`, `developer_staff_invitations`,
`developer_admin_sessions`, `developer_admin_audit`, `developer_site_settings` et
`developer_account_warnings`, et étend les comptes, identités, projets, scripts,
licences et signalements. L’audit administratif conserve acteur/rôle, action,
cible, date, adresse IP et états filtrés. Il ne comporte aucune route d’édition
ou de suppression ; un trigger PostgreSQL refuse UPDATE/DELETE. Il est distinct
de l’ancien audit de modération anonymisable. Définissez et documentez sa durée
justifiée de conservation ainsi que la procédure opérateur avant production.

Les tests utilisent une base et des identités fictives. Le moteur pg-mem ne
reproduit pas les verrous ni les triggers procéduraux de PostgreSQL : le bloc
explicitement marqué du trigger est omis uniquement dans ces fixtures. Validez
la migration, la concurrence réelle et l’immutabilité sur une base PostgreSQL
de validation avant publication.

## Central Discord bot connection



Platform administrators open `/discord-bot` from the workspace sidebar. This integration controls the operator's central bot; it is **not** developer guild delegation. Ordinary developers and website moderators cannot access the bot API. Discord verification and roles do not grant website moderator or administrator access.



Set `BOT_API_URL` to the bot API HTTPS origin (no path, query or embedded credentials), and set the same strong `BOT_API_SECRET` of at least 32 characters in both the site and bot hosting environments. A bot token and this API secret are different credentials. Restart both applications after environment changes. Production requires HTTPS; a private API without a HTTPS reverse proxy or ingress cannot be reached by Render. Never expose a bot secret through browser configuration or public Discord messages. Missing/weak configuration shows Not configured and performs no bot request. Requests time out, refuse redirects and bound response size.



The page shows bot status and connected server metadata. Administrators may change existing verification, welcome, AutoMod and ticket settings. The bot validates channels/roles against its guild. It does not post panels or run `/setup automatic` automatically. Use that Discord command yourself for onboarding panels. Changes are journaled by action, account and guild ID; message contents and secrets are not stored in the site audit. Discord and PostgreSQL cannot share a transaction: bot settings can be updated even if subsequent journal persistence fails.



Bot sources are in `C:/Users/varoq/Desktop/discord_bot`, a separate local project. Its deployment archive must be rebuilt after API changes and uploaded through its deployment launcher. Local `.env` configuration is excluded from both deployment archives and Git; configure hosting variables separately. `npm run test:bot` and `npm run test:bot:ui` use an isolated simulated bot, not the production Discord gateway.

Script counters

`npm run test:metrics` and `npm run test:metrics:ui` verify public and tenant-scoped counters. The loader sends a per-instance executionId with the existing `/api/platform/v1/check` request. Only successful loadScript deliveries count, after key, device and security validation. Validation-only calls are excluded. Identical licence/load IDs deduplicate for 48 hours. Legacy clients without an ID retain compatibility and each successful delivery counts. Views and free deliveries deduplicate per project/network/UTC day using keyed, daily IP hashes; no raw address, key, device or user agent is stored in metric receipts. Receipts expire at 48 hours and daily purge removes them; cumulative counts persist until project deletion. Counters measure deliveries, not proof of runtime execution or fraud-proof unique users. No unauthenticated arbitrary execution increment endpoint exists.

Automatic scanning always considers original and output, including opaque output from our own obfuscator. Static findings can block or require review; no static scan certifies arbitrary obfuscated code as harmless.

Published releases also run through bounded automatic revalidation after startup and every day (disabled when SCHEDULERS=off). Active bodies, saved originals and distinct free snapshots are checked without execution; missing originals require review. Exact matching prior human approvals may remain approved for opaque findings, but never override high findings or ciphertext/hash changes. New versions cannot be replaced by stale analysis. Owners see the last check timestamp and findings; moderation audit contains metadata only. Tests: npm run test:revalidation.

New usage totals start at deployment; historical key-validation events do not distinguish downloads from validation-only calls and are not backfilled as executions.
