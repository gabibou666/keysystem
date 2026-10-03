'use strict';
const fs=require('fs'),path=require('path');
const web=path.resolve(__dirname,'../../web');
for(const file of ['style.css','platform.css','dashboard-visuals.css']){
  const css=fs.readFileSync(path.join(web,file),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  let depth=0;for(const char of css){if(char==='{')depth++;if(char==='}')depth--;if(depth<0)throw Error('Unbalanced CSS: '+file);}if(depth)throw Error('Unbalanced CSS: '+file);
}
const css=fs.readFileSync(path.join(web,'platform.css'),'utf8');
if(!css.includes('prefers-reduced-motion')||!css.includes(':focus-visible'))throw Error('Missing accessibility styles');
for(const file of fs.readdirSync(web).filter(n=>n.endsWith('.html'))){
  const html=fs.readFileSync(path.join(web,file),'utf8');
  if(!/class="platform(?:\s|\")/.test(html)||!html.includes('/platform.css?v=__V__'))throw Error('Page outside platform theme: '+file);
  if(/\bon(?:click|change|submit|load)\s*=/i.test(html))throw Error('Inline event handler: '+file);
  if(/\/design.css|\/polish.js|\/guard.js|\/ad-init.js/.test(html))throw Error('Legacy visual dependency: '+file);
}
console.log('check-design: every page uses the platform theme, with keyboard focus and reduced motion.');
