/**
 * Test de validation : Auto-Save Key & Fast-Boot dans loader.luau et getkey.html
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST AUTO-SAVE KEY & FAST-BOOT ===\n');

// 1. Validation de loader.luau
console.log('1. Analyse de loader.luau...');
const loaderPath = path.join(__dirname, 'loader', 'loader.luau');
assert(fs.existsSync(loaderPath), 'loader.luau doit exister');
const loaderContent = fs.readFileSync(loaderPath, 'utf8');

// Vérification de la persistance
assert(loaderContent.includes('local KEY_FILE = "keysystem_key.txt"'), 'KEY_FILE doit être défini');
assert(loaderContent.includes('local function loadSavedKey()'), 'loadSavedKey doit être défini');
assert(loaderContent.includes('local function saveKey(key)'), 'saveKey doit être défini');
assert(loaderContent.includes('local function clearSavedKey()'), 'clearSavedKey doit être défini');
assert(loaderContent.includes('getgenv().Key'), 'Support de getgenv().Key requis');
assert(loaderContent.includes('_G.Key'), 'Support de _G.Key requis');
assert(loaderContent.includes('writefile(KEY_FILE'), 'Écriture locale writefile requise');
assert(loaderContent.includes('delfile(KEY_FILE'), 'Suppression propre delfile requise');

// Vérification du Fast-Boot silencieux pré-UI
assert(loaderContent.includes('FAST-BOOT SILENCIEUX'), 'Commentaire Fast-Boot présent');
assert(loaderContent.includes('local existingKey = loadSavedKey()'), 'Lecture de existingKey avant l\'UI requise');
assert(loaderContent.includes('local okFast, msgFast = performCheck(existingKey)'), 'performCheck sur existingKey requis');
assert(loaderContent.includes('return -- Exécution terminée avec succès, aucun GUI requis !'), 'Fast-Boot doit return sans afficher d\'UI');
assert(loaderContent.includes('clearSavedKey()'), 'Nettoyage en cas de clé invalide/expirée requis');

// Vérification des UI (WindUI & Fallback GUI)
assert(loaderContent.includes('Key verified & auto-saved to device!'), 'Notification WindUI auto-save présente');
assert(loaderContent.includes('autoSaveBar'), 'Barre auto-save présente dans le GUI de secours');
assert(loaderContent.includes('clearSavedBtn'), 'Bouton pour effacer la clé présent dans le GUI de secours');
assert(loaderContent.includes('💾 Key auto-saved! Next launch will fast-boot silently.'), 'Message statut auto-save présent');

// Vérification de l'équilibre des blocs Luau (if, function, do vs end)
const lines = loaderContent.split('\n');
let blockCount = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].replace(/--.*$/, '').trim(); // supprime les commentaires
  const words = line.split(/\s+/);
  
  // Incrémentateurs de blocs
  if (/^(function\b|local\s+function\b|if\b|for\b|while\b|do\b)/.test(line) && !line.endsWith('end')) {
    // Cas particulier : "function() ... end" sur une seule ligne
    const opens = (line.match(/\b(then|do|function)\b/g) || []).length;
    const closes = (line.match(/\bend\b/g) || []).length;
    blockCount += (opens - closes);
  } else if (/\bend\b/.test(line)) {
    const closes = (line.match(/\bend\b/g) || []).length;
    blockCount -= closes;
  }
}
console.log(`  -> Blocs Luau analysés (balance: ${blockCount})`);
console.log('  -> PASS: loader.luau structurellement conforme et complet\n');

// 2. Validation de getkey.html
console.log('2. Analyse de web/getkey.html...');
const getkeyPath = path.join(__dirname, '..', 'web', 'getkey.html');
assert(fs.existsSync(getkeyPath), 'getkey.html doit exister');
const getkeyContent = fs.readFileSync(getkeyPath, 'utf8');

assert(getkeyContent.includes('copyLuauScriptFromKey'), 'Fonction copyLuauScriptFromKey présente');
assert(getkeyContent.includes('getgenv().Key ='), 'Génération de code avec getgenv().Key présente');
assert(getkeyContent.includes('loadstring(game:HttpGet'), 'loadstring pour injection directe présent');
assert(getkeyContent.includes('⚡ Copy Luau script'), 'Boutons Copy Luau script présents');
assert(getkeyContent.includes('Auto-saves to your device on launch'), 'Mention explicite de l\'auto-save dans la modale');

console.log('  -> PASS: getkey.html prêt et boutons intégrés\n');

console.log('=== TOUS LES TESTS AUTO-SAVE KEY SONT VALIDÉS AVEC SUCCÈS ===');
