'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const labels = {
    en: {
      nav:'Account & data', eyebrow:'YOUR PERSONAL DATA', title:'Your account. Your control.', description:'Download your workspace data or permanently close your account.', exportTitle:'Take your data with you', exportText:'A JSON copy of your profile, linked identities, projects, licenses and activity. Passwords, private credentials and other users’ personal data are excluded.', exportButton:'Export my data (JSON)', exportDone:'Your data export has been downloaded.', deleteTitle:'Close your workspace', deleteText:'Delete your account and its projects, scripts, licenses and personal data from the active database. All access issued by your projects will stop.', deleteButton:'Delete my account and data', privacy:'Read the privacy policy for retention details.', dialogTitle:'Permanently delete your account?', dialogText:'This removes your workspace, public profile, hosted scripts and licenses. It signs you out on every device. Export your data first if you want to keep a copy.', copies:'Copies downloaded by others and external backups follow their own retention rules. Moderation audit references are anonymized. The separate security log retains staff actor, target and IP details for its documented retention period.', confirmation:'Type DELETE to confirm', hint:'This action cannot be undone.', cancel:'Keep my account', confirm:'Delete permanently', close:'Close confirmation', failed:'The request could not be completed. Please try again.', auth:'Your session has expired. Sign in again.', admin:'Transfer any remaining staff responsibility before deleting this account. The configured OWNER cannot be deleted.'
    },
    fr: {
      nav:'Compte et données', eyebrow:'VOS DONNÉES PERSONNELLES', title:'Votre compte. Votre contrôle.', description:'Téléchargez vos données ou fermez définitivement votre compte.', exportTitle:'Emportez vos données', exportText:'Une copie JSON de votre profil, des identités liées, projets, licences et activités. Les mots de passe, identifiants secrets et données personnelles des autres utilisateurs sont exclus.', exportButton:'Exporter mes données (JSON)', exportDone:'Votre export de données a été téléchargé.', deleteTitle:'Fermez votre espace', deleteText:'Supprimez votre compte ainsi que ses projets, scripts, licences et données personnelles de la base active. Les accès délivrés par vos projets cesseront de fonctionner.', deleteButton:'Supprimer mon compte et mes données', privacy:'Consultez la politique de confidentialité pour les durées de conservation.', dialogTitle:'Supprimer définitivement votre compte ?', dialogText:'Votre espace, profil public, scripts hébergés et licences seront supprimés. Vous serez déconnecté sur tous vos appareils. Exportez vos données avant si vous souhaitez en garder une copie.', copies:'Les copies téléchargées par d’autres et les sauvegardes externes suivent leurs propres durées. Les références de l’audit de modération sont anonymisées. Le journal de sécurité distinct conserve les acteurs staff, cibles et adresses IP pendant sa durée documentée.', confirmation:'Saisissez DELETE pour confirmer', hint:'Cette action est irréversible.', cancel:'Conserver mon compte', confirm:'Supprimer définitivement', close:'Fermer la confirmation', failed:'La demande n’a pas abouti. Veuillez réessayer.', auth:'Votre session a expiré. Reconnectez-vous.', admin:'Transférez vos dernières responsabilités d’équipe avant de supprimer ce compte. Le propriétaire OWNER configuré ne peut pas être supprimé.'
    },
  };
  let language;
  let deleting = false;
  function preferredLanguage() {
    try { const saved = localStorage.getItem('audit-hub-language'); if (Object.hasOwn(labels, saved)) return saved; } catch {}
    return (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  function translate(code) {
    if (!Object.hasOwn(labels, code)) return;
    language = code;
    document.querySelectorAll('[data-account-text]').forEach(element => {
      const value = labels[code][element.dataset.accountText];
      if (value) element.textContent = value;
    });
    $('accountPanel').lang = code;
    document.querySelector('[data-view="account"]').lang = code;
    $('deleteAccountDialog').lang = code;
    $('openDeleteAccountBtn').lang = code;
    $('closeDeleteAccountBtn').setAttribute('aria-label', labels[code].close);
  }
  translate(preferredLanguage());
  document.addEventListener('audit-hub:language', event => translate(event.detail?.language));
  function message(text, error = false, dialog = false) {
    const element = $(dialog ? 'deleteAccountMessage' : 'accountMessage');
    element.hidden = !text; element.textContent = text;
    element.classList.toggle('error', error);
  }
  function errorText(response, data) {
    if (response.status === 401) return labels[language].auth;
    if (response.status === 409) return labels[language].admin;
    return language === 'en' && typeof data?.error === 'string' ? data.error : labels[language].failed;
  }
  $('exportAccountBtn').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; message('');
    try {
      const response = await fetch('/api/account/export', { credentials:'same-origin', cache:'no-store' });
      if (!response.ok) throw Error(errorText(response, await response.json().catch(() => null)));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = 'audit-hub-data-' + new Date().toISOString().slice(0,10) + '.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      message(labels[language].exportDone);
    } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
  const dialog = $('deleteAccountDialog');
  function close() { if (!deleting) dialog.close(); }
  $('openDeleteAccountBtn').addEventListener('click', () => {
    $('deleteAccountForm').reset(); $('confirmDeleteAccountBtn').disabled = true;
    message('', false, true); dialog.showModal(); $('deleteAccountConfirmation').focus();
  });
  $('closeDeleteAccountBtn').addEventListener('click', close);
  $('cancelDeleteAccountBtn').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  dialog.addEventListener('close', () => $('openDeleteAccountBtn').focus());
  $('deleteAccountConfirmation').addEventListener('input', event => {
    $('confirmDeleteAccountBtn').disabled = deleting || event.target.value !== 'DELETE';
  });
  $('deleteAccountForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (deleting || $('deleteAccountConfirmation').value !== 'DELETE') return;
    deleting = true; $('confirmDeleteAccountBtn').disabled = true; $('cancelDeleteAccountBtn').disabled = true;
    $('closeDeleteAccountBtn').disabled = true; message('', false, true);
    try {
      const response = await fetch('/api/account', { method:'DELETE', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirmation:'DELETE'}) });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.success === false) throw Error(errorText(response, data));
      location.replace('/?account=deleted');
    } catch (error) {
      deleting = false; $('confirmDeleteAccountBtn').disabled = false; $('cancelDeleteAccountBtn').disabled = false;
      $('closeDeleteAccountBtn').disabled = false; message(error.message, true, true);
    }
  });
})();
