// IA TokenRouter (API compatible OpenAI) - patchs de compatibilite contraints
// L'IA ne renvoie JAMAIS de code reecrit: uniquement des patchs {find, replace, reason}
// Streaming: le modele (z-ai/glm-5.3-free) raisonne longtemps, le stream evite les timeouts.
// Depuis la fabrique de prompt, ce service ne GENERE plus de script: il ne reste ici
// que les patchs de compatibilite, plus la construction du prompt et la validation
// de syntaxe, toutes deux 100% locales (aucun appel reseau).

const https = require('https');
const { URL } = require('url');

const SYSTEM_PROMPT = `You are a Lua compatibility patcher for Roblox executor scripts.
The user script must run on ALL Roblox executors (Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit...).
Known executor-specific APIs are already shimmed by a prelude (you must NOT re-patch those: request, http_request, syn.request, http.request, setclipboard, toclipboard, getgenv, gethwid, writefile, readfile, Drawing, hookfunction, hookmetamethod, queue_on_teleport, identifyexecutor, setrenderproperty, firetouchinterest, WebSocket.connect, getconnections, getcallingscript, getreg, clonefunction).
Your ONLY job: find code that calls executor-specific or non-universal APIs NOT covered by the prelude list above, and propose minimal textual patches.
Rules:
- Return a JSON array only. No markdown fences, no explanation outside the JSON.
- Each item: {"find": "exact source substring to replace (short, unique)", "replace": "replacement text", "reason": "short explanation"}
- Patches must be MINIMAL: never rewrite functions, never change logic. Just rename or adapt the call.
- The "find" string MUST appear exactly once in the script source.
- If nothing needs patching, return []
- Max 5 patches. Do not overthink; answer fast.`;

function streamChatCompletions({ baseUrl, apiKey, model, messages, maxTokens, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions');
    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.1,
      max_tokens: maxTokens,
    });

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const contentParts = [];
        const reasoningParts = [];
        let buf = '';
        let usage = null;
        let statusCode = res.statusCode;

        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.usage) usage = j.usage;
              const delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta) {
                if (typeof delta.content === 'string') contentParts.push(delta.content);
                if (typeof delta.reasoning_content === 'string') reasoningParts.push(delta.reasoning_content);
              }
            } catch {
              // chunk SSE incomplet: ignore
            }
          }
        });

        res.on('end', () => {
          if (statusCode !== 200) {
            reject(new Error(`AI API ${statusCode}`));
            return;
          }
          resolve({
            content: contentParts.join(''),
            reasoning: reasoningParts.join(''),
            usage,
          });
        });

        res.on('error', (e) => reject(e));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function requestCompatibilityPatches(source, compatReport) {
  if (!process.env.AI_API_KEY) {
    return { patches: [], skipped: 'IA non configuree (AI_API_KEY manquant) - builds shims-seuls uniquement' };
  }

  const baseUrl = process.env.AI_BASE_URL || 'https://api.tokenrouter.com/v1';
  const model = process.env.AI_MODEL || 'z-ai/glm-5.3-free';

  const userMsg = `SCRIPT SOURCE:
\`\`\`lua
${source.slice(0, 60000)}
\`\`\`

COMPATIBILITY REPORT (already handled by prelude, do NOT patch these):
${compatReport}

Propose patches for executor-specific calls NOT covered by the prelude. JSON array only.`;

  const { content, reasoning } = await streamChatCompletions({
    baseUrl,
    apiKey: process.env.AI_API_KEY,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    maxTokens: 6000,
    timeoutMs: 120000,
  });

  // Reponse finale = content; si vide (modeles non-streaming?), fallback reasoning
  const text = content && content.trim() ? content : reasoning || '';

  // Extrait le JSON (meme si entoure de markdown)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { patches: [], raw: text.slice(0, 500) };

  let patches;
  try {
    patches = JSON.parse(jsonMatch[0]);
  } catch {
    return { patches: [], raw: text.slice(0, 500) };
  }

  // Filtre: validite basique + find doit exister dans la source
  const valid = patches
    .filter(
      (p) =>
        typeof p.find === 'string' &&
        typeof p.replace === 'string' &&
        p.find.length > 0 &&
        p.replace !== p.find
    )
    .slice(0, 10);

  return { patches: valid };
}

// ============================================================================
// FABRIQUE DE PROMPT (100% locale: aucun appel reseau, aucun cout)
// ----------------------------------------------------------------------------
// Le panneau d'administration n'appelle plus aucun modele. Il FABRIQUE le
// prompt exigeant que l'admin copie dans l'IA de son choix: ce texte est donc
// la seule garantie de qualite du flux. S'il oublie une contrainte, l'IA rendra
// un script qui ne compile pas, ou qui cassera l'executeur de l'utilisateur
// (d'ou les interdictions explicites de require tiers et de loadstring
// distant, et l'exigence "code directement executable").
//
// La VERIFICATION reste ici, locale elle aussi: nettoyerCode puis
// verifierSyntaxe (luaparse) sont appliques au code colle par l'admin AVANT
// tout enregistrement. Aucune de ces deux fonctions ne touche au reseau.
// ============================================================================

const PROMPT_TETE =
  'Tu es un ingenieur Luau senior. Ecris UN script Luau complet et autonome qui construit une interface graphique (GUI) pour un executeur Roblox.';

// Contraintes techniques: chacune repond a une panne observee (code qui ne
// compile pas, fenetre qui s'empile, passerelle cassee par un require tiers).
// test-admin-generate.js verifie qu'aucune ne disparait du prompt.
const PROMPT_REGLES = `REGLES DE SORTIE (absolues)
- Reponds avec LE CODE SOURCE UNIQUEMENT: aucun texte avant ou apres, aucune explication, aucune balise de bloc de code markdown, aucun JSON, jamais une phrase du genre "voici votre script".
- Le code doit etre syntaxiquement valide pour un analyseur Lua 5.1: pas d'affectation composee (+=, -=, ..=, *=, /=), pas d'annotations de type, pas de continue, pas de goto, pas d'operateur //, pas de chaine interpolee entre accents graves.
- Le code doit etre directement executable tel quel dans un executeur Roblox: table de configuration en haut, fonctions utilitaires, puis la construction. Aucun placeholder, aucun "...", aucun TODO, aucune fonction vide.

CE QUE L'INTERFACE DOIT CONTENIR
- Un ScreenGui parente au PlayerGui du joueur local (l'affectation passe par un pcall).
- Un cadre principal DEPLACABLE a la souris: implemente le deplacement toi-meme (UserInputService ou InputChanged sur l'en-tete).
- Des boutons bascule dont l'APPARENCE reflete l'etat (couleur ON differente de la couleur OFF), organises en SECTIONS avec un titre et un separateur.
- Des animations douces d'ouverture, de fermeture et de bascule avec TweenService (durees courtes, aucune boucle infinie).
- La palette violet et noir: fonds #08070c et #12101a, accents violets #8b5cf6, #c084fc, #a78bfa, texte blanc.
- Une FERMETURE PROPRE: le bouton de fermeture detruit le ScreenGui avec :Destroy(), deconnecte la connexion de deplacement, et plus rien ne continue de tourner ensuite.
- Uniquement task.wait et task.spawn (jamais wait, spawn, delay ni sleep des globales historiques).
- pcall autour des appels fragiles (PlayerGui, creation d'Instance, acces au personnage).
- AUCUNE dependance externe: jamais require(id) d'un asset tiers, jamais loadstring d'un contenu distant, aucun telechargement HTTP. Services Roblox uniquement.
- Detruis toute instance existante du meme nom avant de creer la nouvelle, pour qu'executer le script deux fois n'empile pas deux fenetres.

STYLE
- Bloc de commentaires en tete decrivant l'interface, bannieres de commentaires entre les sections, noms de variables explicites. Moins de 600 lignes.`;

// Fabrique le prompt complet a remettre a une IA, a partir de la description de
// l'admin et (facultativement) d'un ID de jeu. Purement local: aucune lecture
// de fichier, aucun appel reseau, aucun acces a la base.
function buildScriptPrompt({ brief, placeId } = {}) {
  const description = String(brief == null ? '' : brief).trim();
  if (!description) {
    throw new Error('Description vide: impossible de construire le prompt');
  }

  const blocs = [`CE QUE L'INTERFACE DOIT FAIRE\n${description}`];

  // Le PlaceId n'est qu'un contexte: il ne doit pas finir code en dur dans le
  // script (un meme script peut servir plusieurs jeux).
  const id = Number.parseInt(placeId, 10);
  if (Number.isFinite(id) && id > 0) {
    blocs.push(
      `ID DU JEU CIBLE (contexte seulement: ne code aucune logique de jeu en dur et n'ecris pas cet identifiant dans le script)\n${id}`
    );
  }

  return [PROMPT_TETE, blocs.join('\n\n'), PROMPT_REGLES].join('\n\n');
}

// Analyseur de syntaxe charge a la demande (devDependency: elle n'est pas
// necessaire au reste du service, mais son absence doit faire ECHOUER la
// verification plutot que de laisser passer un script non controle).
let _luaparse;
function analyseurLua() {
  if (_luaparse === undefined) {
    try {
      _luaparse = require('luaparse');
    } catch (_) {
      _luaparse = null;
    }
  }
  if (!_luaparse) {
    throw new Error('luaparse absent (npm install): impossible de garantir la syntaxe du script');
  }
  return _luaparse;
}

// Verifie la syntaxe du code. Renvoie { ok, message } - le message est celui du
// parseur, tel quel (c'est celui-la qui est affiche a l'admin).
function verifierSyntaxe(code) {
  try {
    analyseurLua().parse(code, { luaVersion: '5.1' });
    return { ok: true, message: '' };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

// Retire les balises de code que l'IA produit malgre la consigne.
// Cas courant: trois accents graves devant et derriere le script.
function nettoyerCode(texte) {
  let code = String(texte || '');
  const bloc = code.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/);
  if (bloc) {
    code = bloc[1];
  } else {
    code = code.replace(/```[a-zA-Z]*/g, '');
  }
  return code.replace(/^[\s\r\n]+/, '').replace(/[\s\r\n]+$/, '');
}

// Resume LOCAL du script (aucun appel IA): ce que l'admin doit voir avant de
// relire le code - taille et elements attendus.
function resumerScript(source) {
  const lignes = source.split('\n').length;
  const octets = Buffer.byteLength(source, 'utf8');
  const marqueurs = [
    ['ScreenGui', /ScreenGui/],
    ['TweenService', /TweenService/],
    ['fenetre deplacable', /UserInputService|InputChanged|InputBegan/],
    ['boutons bascule', /TextButton|ImageButton|Toggle/],
    ['task.spawn', /task\.spawn/],
    ['pcall', /pcall\s*\(/],
    ['fermeture propre', /:Destroy\(\)/],
  ]
    .filter(([, motif]) => motif.test(source))
    .map(([nom]) => nom);
  return `${lignes} lignes, ${octets} octets${marqueurs.length ? ' - ' + marqueurs.join(', ') : ''}`;
}

module.exports = {
  requestCompatibilityPatches,
  buildScriptPrompt,
  verifierSyntaxe,
  nettoyerCode,
  resumerScript,
};
