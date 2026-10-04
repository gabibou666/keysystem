# Protections de la plateforme

## Comptes et navigateur

- Les nouveaux comptes partagent une contrainte unique d'email entre email, Google et Discord. Les variantes Gmail avec points ou suffixe `+` sont normalisées ; les autres domaines conservent leurs points et suffixes.
- Google et Discord doivent fournir un email vérifié pour créer un compte. Une correspondance avec un compte existant impose sa méthode de connexion initiale et ne fusionne pas les comptes.
- Les créations sont limitées en base à une par navigateur signé et cinq par IP en 24 heures. Les quotas et la création de compte partagent une transaction avec verrous ; les connexions existantes ne consomment pas le quota.
- Le cookie `ah_registration` est HttpOnly et signé, avec une durée de 180 jours. Les compteurs utilisent des HMAC de l'IP et de l'identifiant navigateur ; ils sont nettoyés après 30 jours d'inactivité. Aucun identifiant matériel n'est collecté. Supprimer le cookie ou changer de réseau reste un contournement possible : cette protection ne prouve pas qu'une personne a un seul compte.
- La migration de normalisation échoue sur une collision préexistante plutôt que de fusionner ou supprimer des comptes.

- Connexions email : dix tentatives échouées par adresse sur quinze minutes, indépendamment de l'IP. Les adresses sont normalisées et les clés du compteur sont des HMAC, pas des emails en clair.
- Le calcul des mots de passe est limité à deux opérations simultanées par processus. Une surcharge reçoit une réponse temporaire 503.
- Les jetons de récupération invalides sont refusés avant tout calcul de mot de passe. Une réinitialisation révoque les sessions précédentes.
- Les parcours OAuth Discord et Google exigent un état lié au navigateur. Les cookies de session sont HttpOnly, SameSite et Secure en production.
- Les pages développeur chargent uniquement les scripts du site, refusent les scripts inline et l'intégration dans une iframe. Leurs URL ne sont pas transmises comme référents.
- Les mutations de compte et de projet refusent les origines étrangères. Les corps JSON d'authentification sont limités à 16 Ko et ne sont pas décompressés.
- Les appels OAuth, emails et fournisseurs refusent les redirections HTTP pour éviter de transmettre leurs secrets à une autre destination.

## Projets et checkpoints

- L'accès aux projets, scripts et licences est limité à leur propriétaire. Les identifiants d'autres projets ne donnent aucun accès.
- Une preuve de checkpoint consommée ne peut pas avancer une autre session, même sur un autre projet ou compte développeur. Une contrainte unique globale rend sa consommation atomique ; son empreinte reste conservée après le nettoyage de la session.
- Le démarrage, le retour et la récupération de clé sont liés au navigateur et à l'IP de la session. Seul un HMAC de l'IP est stocké. Changer de réseau impose de recommencer ; `TRUST_PROXY` doit correspondre aux proxies réels pour empêcher la falsification de cette liaison.
- Work.ink doit confirmer le jeton, le lien, sa création après le démarrage, son expiration et l'IP. LootLabs exige un postback authentifié avec identifiant de tâche unique et IP correspondante. Linkvertise et LinkUnlocker exigent leur validation serveur ; visiter le callback seul ne délivre pas de clé.
- Un changement de configuration invalide les sessions de checkpoint en attente, conserve les preuves consommées et les clés déjà émises.
- Les changements de configuration et de jeton API sont verrouillés face aux requêtes concurrentes.
- Une licence liée à un appareil refuse un identifiant absent, invalide ou différent. L'identifiant étant fourni par l'exécuteur, cette liaison ne garantit pas l'identité physique de l'appareil.

## Données privées et builds développeurs

- Les listes et fiches publiques exposent uniquement les métadonnées de publications visibles. Une page de clé utilise les métadonnées publiées ou un titre neutre, sans nom privé ni notes de projet.
- Aucun endpoint public de métadonnées n'expose email, note client, source, token API, token fournisseur, secret callback, IV ou contenu chiffré. Le propriétaire conserve un accès limité aux callbacks nécessaires à sa configuration.
- Le source libre est un choix explicite du propriétaire : seule la version validée publiée est livrée, avec ou sans obfuscation selon son choix. Une version avec licence exige une licence valide, limitée au projet et à son appareil lorsque la liaison est activée.
- Chaque nouvel upload et publication est parsé avec darklua local. Aucun code utilisateur n'est exécuté pendant la vérification ; erreurs brutes, source et chemins temporaires ne sont pas journalisés. Un échec bloque la publication et conserve la version précédente.
- Les originaux et les versions de livraison sont chiffrés séparément. Le propriétaire peut récupérer son original et exporter ses données ; aucun accès public ne permet de récupérer cet original privé. Les copies historiques de traitements terminés sont bornées à 20 par projet et 32 Mio par compte. Le contrôle syntaxique et l'obfuscation ne garantissent pas la sécurité du code à exécuter ni sa compatibilité universelle.
- Les répertoires temporaires sont privés, nettoyés après la fin du processus sur succès ou échec. La taille d'upload, le délai total et la concurrence sont bornés ; il n'y a pas de quota de crédits commercial.
- Les diagnostics CSP et routes masquent credentials, queries, fragments et segments inconnus ; les erreurs de base ou fournisseur sont remplacées par classe/code. Les alertes utilisent une signature hachée, sans message brut. Les réponses de santé ne révèlent pas d'erreur de connexion détaillée.
- Chiffrement serveur ne signifie pas confidentialité vis-à-vis de l'opérateur : une personne avec accès serveur et clés peut lire les contenus. Aucune promesse absolue d'absence de fuite ou d'illisibilité par l'administrateur n'est faite.

## Protection HTTP et limites

Le filtre HTTP ralentit une IP au-delà de 60 requêtes en dix secondes et la bloque quinze minutes à partir de 95 requêtes. Il utilise l'IP résolue par Express ; `TRUST_PROXY` doit correspondre aux proxies réels. `IP_HEADER=cf-connecting-ip` ne doit être activé que si tous les accès passent par Cloudflare.

Les tables de suivi, de blocage et de délai d'alerte sont plafonnées à 10 000 entrées chacune. Les sondes de santé restent accessibles. Ces protections et compteurs sont locaux au processus ; plusieurs instances nécessitent un stockage partagé. Elles ne remplacent pas une protection réseau contre les attaques volumétriques.

La politique de scripts stricte s'applique à toutes les pages. Les anciens modules joueurs, publicités, administration historique et boutique Robux ont été retirés.

## Vérification

- `cd server` puis `npm run test:security` : abus de connexion, parsing, cookies, protections navigateur, flood, rejouement et courses de checkpoints.
- `npm test` : suite serveur complète avec bases et fournisseurs de test.
- `npm run test:platform:ui` : parcours navigateur et affichages mobiles.
- `npm run check` : assets, syntaxe, DOM, schéma et coûts des sondes.

Les simulations d'attaque ne visent pas la production.
