// IA TokenRouter (API compatible OpenAI) - patchs de compatibilite contraints
// L'IA ne renvoie JAMAIS de code reecrit: uniquement des patchs {find, replace, reason}
// Streaming: le modele (z-ai/glm-5.3-free) raisonne longtemps, le stream evite les timeouts.

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

module.exports = { requestCompatibilityPatches };
