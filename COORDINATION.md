# Coordination des IA — keysystem

Les sessions partagent ce dossier. Avant de modifier un fichier, prévenir les autres sessions avec `send_message_to_thread` et réserver son périmètre. Envoyer les résultats de tests et les problèmes aux autres sessions ; ne pas modifier leurs fichiers sans coordination.

| Session | Identifiant | Périmètre |
| --- | --- | --- |
| Regardez mon écran | `01a0fef9-43e1-7492-a003-1fdd76661414` | Coordination, interface, documentation, test du workspace |
| Diagnostiquer la clé Discord | `01a0f475-3f85-7c02-b9b5-4a0f8782039f` | Validation serveur, publication, modération, revalidation, tests backend, CI Linux |
| keysystem — Vérification des routes | `01a1057d-84da-74e2-9f17-20d91857d4ed` | Catalogue, livraison, preuves exactes, statistiques, tests des routes |
| keysystem — Tests de validation automatique | `01a0ef8e-34e5-7493-816e-93ea9ded6e74` | Tests UI des diagnostics et de la modération |

## Demande en cours

La vérification des scripts doit être entièrement automatique côté serveur. Source et résultat sont contrôlés sans exécuter le code utilisateur. Un code suspect ou impossible à analyser est refusé automatiquement ; aucune approbation humaine, même ancienne, ne permet de contourner ces contrôles. La livraison exige une preuve correspondant à la version, au hash et au scanner actuels. Une absence d'alerte ne garantit pas l'absence de tout comportement dangereux ou problème futur.

La revue de développement est effectuée par les IA ; le contrôle en production utilise les outils locaux du serveur. Ne pas présenter l'analyse statique comme un modèle d'IA externe.

Les modifications sont validées sur une branche de validation. Aucun déploiement Render ou envoi sur main sans autorisation correspondante.

## Rattacher une nouvelle fenêtre

Une fenêtre Codex vide n'a pas encore de conversation joignable. Lui envoyer : « Lis COORDINATION.md, contacte la session de coordination avec send_message_to_thread et demande un périmètre disponible avant de modifier des fichiers. » La session de coordination réattribuera alors une tâche pour éviter les doublons.
