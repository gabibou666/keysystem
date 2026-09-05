const { usesGlobal } = require('./lexer');

// ~20 incompatibilites connues entre executors
// shimmed: corrige par le prelude automatiquement
// degraded: corrige par degradation intelligente
// ai: laisse a l'IA
// none: manquant sur certains executors sans solution
const CHECKS = [
  { name: 'request', alternatives: ['request', 'http_request', 'syn.request', 'http.request'], category: 'http', fix: 'shimmed' },
  { name: 'setclipboard', alternatives: ['setclipboard', 'toclipboard', 'syn.set_clipboard'], category: 'clipboard', fix: 'shimmed' },
  { name: 'getgenv', alternatives: ['getgenv'], category: 'env', fix: 'shimmed' },
  { name: 'gethwid', alternatives: ['gethwid', 'gethwid'], category: 'hwid', fix: 'shimmed' },
  { name: 'writefile', alternatives: ['writefile'], category: 'files', fix: 'degraded' },
  { name: 'readfile', alternatives: ['readfile'], category: 'files', fix: 'degraded' },
  { name: 'isfile', alternatives: ['isfile'], category: 'files', fix: 'degraded' },
  { name: 'listfiles', alternatives: ['listfiles'], category: 'files', fix: 'degraded' },
  { name: 'Drawing.new', alternatives: ['Drawing.new'], category: 'drawing', fix: 'degraded' },
  { name: 'getconnections', alternatives: ['getconnections'], category: 'connections', fix: 'none' },
  { name: 'hookfunction', alternatives: ['hookfunction', 'replaceclosure'], category: 'hooking', fix: 'shimmed' },
  { name: 'hookmetamethod', alternatives: ['hookmetamethod'], category: 'hooking', fix: 'shimmed' },
  { name: 'queue_on_teleport', alternatives: ['queue_on_teleport', 'syn.queue_on_teleport', 'teleportqueue'], category: 'teleport', fix: 'shimmed' },
  { name: 'identifyexecutor', alternatives: ['identifyexecutor'], category: 'meta', fix: 'shimmed' },
  { name: 'getcustomasset', alternatives: ['getcustomasset'], category: 'assets', fix: 'degraded' },
  { name: 'setrenderproperty', alternatives: ['setrenderproperty', 'set_render_property'], category: 'render', fix: 'shimmed' },
  { name: ' firesignal', alternatives: ['firesignal'], category: 'signal', fix: 'none' },
  { name: 'getcallingscript', alternatives: ['getcallingscript'], category: 'meta', fix: 'none' },
  {name: 'firetouchinterest', alternatives: ['firetouchinterest', 'firesynctouch'], category: 'signal', fix: 'none' },
  { name: 'WebSocket.connect', alternatives: ['WebSocket.connect', 'syn.websocket.connect'], category: 'websocket', fix: 'shimmed' },
  { name: 'clonefunction', alternatives: ['clonefunction', 'syn.clonefunction'], category: 'meta', fix: 'shimmed' },
  { name: 'getreg', alternatives: ['getreg', 'debug.getregistry'], category: 'meta', fix: 'none' },
];

function analyzeScript(source) {
  const report = [];
  for (const check of CHECKS) {
    const used = check.alternatives.some((alt) =>
      usesGlobal(source, alt.startsWith(' ') ? alt.trim() : alt.trim())
    );
    if (used) {
      report.push({
        api: check.name.trim(),
        category: check.category,
        alternatives: check.alternatives,
        fix: check.fix,
      });
    }
  }

  // Detecte d'autres globals suspects (non-Roblox) pour le rapport IA
  const knownRoblox = new Set(['game', 'workspace', 'wait', 'spawn', 'delay', 'print', 'warn', 'tick', 'time', 'UDim2', 'UDim', 'Vector2', 'Vector3', 'CFrame', 'Color3', 'ColorSequence', 'NumberSequence', 'TweenInfo', 'Enum', 'Instance', 'task', 'math', 'string', 'table', 'os', 'coroutine', 'debug', 'pcall', 'xpcall', 'error', 'assert', 'select', 'unpack', 'rawget', 'rawset', 'tostring', 'tonumber', 'type', 'typeof', 'ipairs', 'pairs', 'next', 'setmetatable', 'getmetatable', 'require', 'loadstring', 'Random', 'Ray', 'Region3', 'BrickColor', 'PhysicalProperties', 'loadstring']);
  const allKnown = new Set([
    ...knownRoblox,
    ...CHECKS.flatMap((c) => c.alternatives.map((a) => a.trim().split('.')[0])),
    'Drawing', 'WebSocket', 'syn', 'http', 'Fluxus', 'cache', 'checkcaller', 'is_synapse_genuin', 'getrenv',
    'cloneref', 'getfunctionalenv', 'mousemoverel', 'keypress', 'keyrelease', 'keytap',
    ' firesignal', 'fireclickdetector', 'getloadedmodules', 'isexecutorclosure', 'get_thread_identity',
    'set_thread_identity', 'getidentity', 'setidentity', 'GUI', 'msgbox', 'messagebox', 'writefile',
  ]);

  const tokens = require('./lexer').tokenize(source);
  const found = new Set();
  let prev = null;
  for (const t of tokens) {
    if (t.type === 'name' && prev && prev.value === '.') continue;
    if (t.type === 'name' && !allKnown.has(t.value)) {
      // capture si suivi de ( ou . (appel ou acces)
      found.add(t.value);
    }
    prev = t;
  }

  const unknownGlobals = [...found].filter((g) => g.length > 2).slice(0, 30);

  return { issues: report, unknownGlobals };
}

module.exports = { analyzeScript, CHECKS };
