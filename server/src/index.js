require('dotenv').config();
const {assertProdConfig,checkConfig}=require('./config-check');
assertProdConfig();
const express=require('express'),helmet=require('helmet'),nodeCrypto=require('crypto'),fs=require('fs'),path=require('path');
const pool=require('./db');
const {startPurgeScheduler}=require('./services/purge');
const {notifyDiscord}=require('./services/notify');
const alerts=require('./services/alerts');
const {errorSummary,diagnosticUrl,diagnosticDirective}=require('./services/private-diagnostics');
const webDir=path.join(__dirname,'..','..','web');
function listStaticFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listStaticFiles(full, acc);
    else if (!/\.html?$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

function computeAssetVersion() {
  const hash = nodeCrypto.createHash('sha1');
  try {
    for (const file of listStaticFiles(webDir).sort()) {
      // Empreinte du CONTENU, et non de la date de modification. Un deploiement
      // reecrit les fichiers avec une nouvelle date: avec l'ancienne version, la
      // version des assets changeait a chaque deploiement et forcait tous les
      // visiteurs a retelecharger CSS, polices et JS sans qu'un octet ait bouge.
      hash.update(`${path.relative(webDir, file)}:`);
      hash.update(fs.readFileSync(file));
    }
  } catch (e) {
    console.warn('[assets] version partielle:', e.message);
  }
  return hash.digest('hex').slice(0, 12);
}

const ASSET_VERSION = computeAssetVersion();

// URL publique du site, utilisee pour canonical/Open Graph (placeholder __SITE__
// dans les pages). Fallback: la variable d'environnement PORT/URL Render.
const SITE_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ============================================================================
// Pages HTML: injection de la version d'assets (placeholder __V__) + en-tetes.
// Le HTML se revalide toujours (no-cache), les assets versionnes sont caches 1 an.
// ============================================================================
const htmlCache = new Map();

function serveHtml(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let rel = decodeURIComponent(req.path).replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel === 'scripts' || /^(hubs|developers)\/[a-z0-9-]{3,48}$/.test(rel) || /^scripts\/[a-f0-9-]{36}$/i.test(rel)) rel = 'hubs';
  if (rel === '') rel = 'index';
  if (rel.startsWith('api/') || rel.startsWith('admin/auth')) return next(); // routes dynamiques
  if (path.extname(rel)) {
    if (!rel.endsWith('.html')) return next(); // asset -> express.static
  } else {
    rel += '.html'; // Extensionless public pages.
  }

  const abs = path.resolve(webDir, rel);
  if (!abs.startsWith(path.resolve(webDir) + path.sep)) return next(); // anti path traversal

  let st;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) return next();
  } catch {
    return next();
  }

  let html;
  const cached = htmlCache.get(abs);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    html = cached.html;
  } else {
    try {
      html = fs.readFileSync(abs, 'utf8');
    } catch {
      return next();
    }
    if (html.includes('__V__')) html = html.split('__V__').join(ASSET_VERSION);
    // __SITE__: URL publique reelle (canonical, Open Graph). Evite toute URL de
    // domaine codee en dur dans les pages (le domaine peut changer).
    if (html.includes('__SITE__')) html = html.split('__SITE__').join(SITE_URL);
    htmlCache.set(abs, { html, mtimeMs: st.mtimeMs });
  }

  res.set('Content-Type', 'text/html; charset=UTF-8');
  res.set('Cache-Control', 'no-cache, must-revalidate');
  // Pages d'administration / d'attente: jamais indexees.
  if (['discord-bot.html','dashboard.html','moderation.html', 'claim.html', 'signup.html', 'login.html', 'verify-email.html', 'reset-password.html'].includes(rel)) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  res.send(html);
}


const app=express();
app.disable('x-powered-by');
const PORT=process.env.PORT||3000;
const TRUST_PROXY=parseInt(process.env.TRUST_PROXY||'1',10);
app.set('trust proxy',Number.isFinite(TRUST_PROXY)?TRUST_PROXY:1);
app.use(require('./services/antiddos').antiDdosMiddleware);
app.use(helmet({contentSecurityPolicy:{directives:{
  defaultSrc:["'self'"],scriptSrc:["'self'"],scriptSrcAttr:["'none'"],
  styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:'],
  frameSrc:["'none'"],mediaSrc:["'self'"],fontSrc:["'self'",'data:'],connectSrc:["'self'"],
  objectSrc:["'none'"],baseUri:["'self'"],formAction:["'self'"],frameAncestors:["'self'"],reportUri:['/api/csp-report']
}},crossOriginEmbedderPolicy:false,referrerPolicy:{policy:'strict-origin-when-cross-origin'}}));
const webSecurity=require('./services/web-security');
app.use(webSecurity.platformHeaders);
app.use(webSecurity.parseCookies);
require('./services/script-upload-http')(app);
app.use('/api/auth',webSecurity.authJsonParser);
app.use('/admin/api',webSecurity.authJsonParser);
app.use(express.json({limit:'2mb',type:['application/json','application/csp-report','application/reports+json']}));
app.use(webSecurity.bodyError);
// Frequent monitoring must never wake the database.
app.get('/api/keepalive', (req, res) => res.json({ok:true,t:Date.now()}));
app.get('/ping', (req, res) => res.set('Cache-Control','no-store').json({ok:true,t:Date.now()}));
const cspAlertState={lastAt:0};
app.post('/api/csp-report',(req,res)=>{
  const raw=req.body||{};
  const report=raw['csp-report']||raw.body||(Array.isArray(raw)?raw[0]?.body:null)||{};
  const directive=diagnosticDirective(report['violated-directive']||report.violatedDirective||report['effective-directive']);
  const blocked=diagnosticUrl(report['blocked-uri']||report.blockedURL);
  const page=diagnosticUrl(report['document-uri']||report.documentURL);
  console.warn('[csp]',directive,blocked,page);
  if(Date.now()-cspAlertState.lastAt>600000){
    cspAlertState.lastAt=Date.now();
    notifyDiscord({title:'CSP: blocked resource',color:'warn',description:directive+' '+blocked+' '+page}).catch(()=>{});
  }
  res.status(204).end();
});
const HEALTHZ_DEEP_TTL_MS = Math.max(5, Number(process.env.HEALTHZ_DEEP_TTL_MIN) || 360) * 60 * 1000;
const healthzState = { checkedAt: 0, ok: false, latencyMs: null, error: null };

app.get('/healthz', async (req, res) => {
  const forced = req.query.deep === '1';
  const age = Date.now() - healthzState.checkedAt;
  const ttl = healthzState.ok ? HEALTHZ_DEEP_TTL_MS : 60 * 1000;

  if (!forced && healthzState.checkedAt && age < ttl) {
    return res.status(healthzState.ok ? 200 : 503).json({
      ok: healthzState.ok,
      db: healthzState.ok ? 'up' : 'down',
      cached: true,
      checkedAgeSec: Math.round(age / 1000),
      nextDeepCheckInSec: Math.round((ttl - age) / 1000),
      assets: ASSET_VERSION,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      ...(healthzState.error ? { error: healthzState.error } : {}),
    });
  }

  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    Object.assign(healthzState, { checkedAt: Date.now(), ok: true, latencyMs: Date.now() - started, error: null });
  } catch (e) {
    Object.assign(healthzState, { checkedAt: Date.now(), ok: false, latencyMs: null, error: 'database_unavailable' });
    alerts.report(e, { where: 'healthz', route: '/healthz' }).catch(() => {});
  }
  res.status(healthzState.ok ? 200 : 503).json({
    ok: healthzState.ok,
    db: healthzState.ok ? 'up' : 'down',
    cached: false,
    node: process.version,
    ...(healthzState.latencyMs !== null ? { latencyMs: healthzState.latencyMs } : {}),
    ...(healthzState.error ? { error: healthzState.error } : {}),
    assets: ASSET_VERSION,
    uptimeSec: Math.round(process.uptime()),
  });
});


// robots.txt / sitemap.xml: servis avec l'URL publique reelle (placeholder
// __SITE__) pour ne jamais dependre d'un domaine code en dur.
for (const [route, file, type] of [
  ['/robots.txt', 'robots.txt', 'text/plain; charset=utf-8'],
  ['/sitemap.xml', 'sitemap.xml', 'application/xml; charset=utf-8'],
]) {
  app.get(route, (req, res) => {
    try {
      const body = fs
        .readFileSync(path.join(webDir, file), 'utf8')
        .split('__SITE__')
        .join(SITE_URL);
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(body);
    } catch {
      res.status(404).type('text/plain').send('Not found');
    }
  });
}

// ===== Front statique =====
// Staff pages are guarded before any public file handling.
app.use('/admin/api', require('./routes/admin'));
app.use('/admin', require('./routes/admin-page')({ assetVersion: ASSET_VERSION, siteUrl: SITE_URL }));
// 1) Pages HTML (versionnees + no-cache)
app.use(serveHtml);

// 2) Polices auto-hebergees: cache tres long
app.use(
  '/fonts',
  express.static(path.join(webDir, 'fonts'), { maxAge: '365d', immutable: true })
);

// 3) Assets versionnes (style.css?v=xxxx, app-*.js?v=xxxx...): cache 1 an
app.use(
  express.static(webDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(css|js|woff2|png|svg|ico|jpg|webp|mp4)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);


app.use('/api/discord',require('./routes/discord').router);
app.use('/api/platform',require('./services/site-controls').enforceMaintenance,require('./routes/platform'));
app.use('/api/auth',require('./routes/auth'));
app.use('/api/catalog',require('./services/site-controls').enforceMaintenance,require('./routes/catalog'));
app.use('/api/moderation',require('./routes/moderation'));
app.use('/api/bot',require('./routes/discord-bot'));
app.use('/api/site',require('./routes/site'));
app.use('/api/account',require('./routes/account'));
app.use((req,res)=>res.status(404).type('text/plain').send('Not found'));
app.use((err,req,res,next)=>{
  console.error('[server]',errorSummary(err));
  alerts.report(err,{where:'express',route:req.path}).catch(()=>{});
  if(res.headersSent)return next(err);
  res.status(500).json({success:false,error:'Internal error'});
});
const SELF_PING_URL=process.env.PUBLIC_URL?process.env.PUBLIC_URL.replace(/\/$/,'')+'/api/keepalive':null;
alerts.install();
function startServer(){
  require('./services/publication-queue').start();
  return app.listen(PORT,()=>{
  console.log('[server] AUDIT HUB on port '+PORT+' assets='+ASSET_VERSION);
  const {warnings}=checkConfig();
  if(warnings.length&&process.env.NODE_ENV==='production')notifyDiscord({title:'Configuration warnings',color:'warn',description:warnings.join('\n')}).catch(()=>{});
  if(process.env.SCHEDULERS==='off')return;
  startPurgeScheduler();
  require('./services/script-revalidation').startScheduler();
  if(SELF_PING_URL&&!/localhost|127\.0\.0\.1/.test(SELF_PING_URL))setInterval(async()=>{
    try{await fetch(SELF_PING_URL,{signal:AbortSignal.timeout(20000)});}catch(e){console.warn('[self-ping]',errorSummary(e));}
  },5*60*1000).unref();
});}
if(process.env.NODE_ENV==='production')require('./services/developer-schema').ensureDeveloperSchema(pool)
  .then(startServer).catch(error=>{console.error('[schema]',errorSummary(error));pool.end().finally(()=>process.exit(1));});
else startServer();
module.exports=app;
