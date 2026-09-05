const { analyzeScript } = require('./analyzer');
const { buildPrelude } = require('./prelude');
const { obfuscate, validateStructure } = require('./obfuscator');
const { requestCompatibilityPatches } = require('../services/ai');
const { sha256 } = require('../services/crypto');

// Pipeline complet: analyse -> prelude -> patches IA -> obfuscation -> VALIDATION STRUCTURELLE
// Le build servi est PROUVE structurellement equivalent a prelude + corps patche.

async function runPipeline(source, { useAI = true } = {}) {
  // 1. Analyse
  const report = analyzeScript(source);

  // 2. Prelude de shims (addition pure)
  const prelude = buildPrelude();

  // 3. Patches IA (contraints: {find, replace, reason})
  let aiPatches = [];
  let aiRaw = null;
  if (useAI && report.issues.some((i) => i.fix === 'ai')) {
    try {
      const aiRes = await requestCompatibilityPatches(source, JSON.stringify(report.issues));
      aiPatches = aiRes.patches;
      aiRaw = aiRes.raw || null;
    } catch (e) {
      // L'IA echoue => build shims-seuls, on ne bloque pas
      aiRaw = `Erreur IA: ${e.message}`;
    }
  }

  // 4. Validation des patches: find doit exister une seule fois
  const validated = [];
  for (const patch of aiPatches) {
    const occurrences = source.split(patch.find).length - 1;
    if (occurrences === 1) {
      validated.push(patch);
    }
  }

  // 5. Application des patches + construction du build
  let patchedBody = source;
  for (const patch of validated) {
    patchedBody = patchedBody.replace(patch.find, patch.replace);
  }

  // 6. Build final: prelude + corps (patche ou non) puis obfuscation
  const fullSource = prelude + patchedBody;
  let build = obfuscate(fullSource);

  // 7. VALIDATION STRUCTURELLE: squelette code du build === squelette de prelude+corps
  //    Si divergence => l'obfuscateur a casse le code => on sert le prelude + corps NON obfusque
  //    (fiabilite d'abord: un script chargeable non obfusque > un script casse obfusque)
  const check = validateStructure(fullSource, build);
  if (!check.ok) {
    console.error('[pipeline] obfuscation rejetee (' + check.message + ') - fallback prelude+source');
    build = prelude + patchedBody;
  }

  return {
    prelude,
    patches: validated,
    rejectedPatches: aiPatches.length - validated.length,
    build,
    report,
    aiRaw,
    bodyHash: sha256(patchedBody),
    obfuscationApplied: check.ok,
  };
}

// Re-construit un build avec uniquement les patches approuves
function rebuildWithPatches(source, patches) {
  let patchedBody = source;
  for (const patch of patches) {
    patchedBody = patchedBody.replace(patch.find, patch.replace);
  }
  const fullSource = buildPrelude() + patchedBody;
  let build = obfuscate(fullSource);
  const check = validateStructure(fullSource, build);
  if (!check.ok) {
    console.error('[pipeline/rebuild] obfuscation rejetee - fallback prelude+source');
    build = fullSource;
  }
  return { build, bodyHash: sha256(patchedBody), obfuscationApplied: check.ok };
}

module.exports = { runPipeline, rebuildWithPatches };
