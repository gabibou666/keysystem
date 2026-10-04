'use strict';
(() => {
  const select=document.getElementById('scriptDocsLanguage');
  if(!select) return;
  function language() {
    try { const saved=localStorage.getItem('audit-hub-language'); if(['en','fr'].includes(saved)) return saved; } catch {}
    return (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('fr')?'fr':'en';
  }
  function apply(code) {
    if(!['en','fr'].includes(code)) return;
    select.value=code;
    document.querySelectorAll('[data-doc-locale]').forEach(section=>section.hidden=section.dataset.docLocale!==code);
  }
  select.addEventListener('change',()=>{
    apply(select.value);
    try { localStorage.setItem('audit-hub-language',select.value); } catch {}
    document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:select.value}}));
  });
  document.addEventListener('audit-hub:language',event=>apply(event.detail?.language));
  apply(language());
})();
