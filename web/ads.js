// ads.js — fichier appat anti-adblock.
// Les listes de filtres (EasyList, uBlock, AdGuard, Brave...) bloquent ce fichier
// par son NOM "ads.js" et par les mots-cles publicitaires ci-dessous.
// Si ce script ne s'execute pas dans la page => un adblock est actif.
window.adblockDetectedBait = false;
window.adsManager = window.adsManager || {};
window.adsManager.init = function () { window.adblockDetectedBait = true; };
window.adsManager.init();
// google_ad_client / doubleclick / adserver: mots-cles classiques des regles de filtres
var google_ad_client = 'ca-pub-0000000000000000';
var doubleclick_tag = 'https://www.googletagservices.com/tag/js/gpt.js';
var adserver_url = 'https://adserver.example.com/impression';
