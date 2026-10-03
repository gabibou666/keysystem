'use strict';
// Native <details> provides accessible FAQ interaction without inline scripts.
document.querySelectorAll('.faq-list details').forEach(detail => {
  detail.addEventListener('toggle', () => {
    if (detail.open) document.querySelectorAll('.faq-list details').forEach(other => { if (other !== detail) other.open = false; });
  });
});

const demoTabs=[...document.querySelectorAll('[data-demo]')];
function showDemo(tab) {
  for(const item of demoTabs) {const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;document.getElementById('demo-'+item.dataset.demo).hidden=!active;}
}
demoTabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>showDemo(tab));
  tab.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?demoTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+demoTabs.length)%demoTabs.length;
    showDemo(demoTabs[next]);demoTabs[next].focus();
  });
});
