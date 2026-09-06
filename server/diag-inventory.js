// Diagnostic: que renvoie VRAIMENT l'API inventory pour un gamepass non possede ?
async function main() {
  // 1. Status pour user 1 (Roblox admin) + pass bidon
  const url = 'https://inventory.roblox.com/v1/users/1/items/1/99999999999';
  const r = await fetch(url, { headers: { 'User-Agent': 'KeySystem/1.0', Accept: 'application/json' } });
  console.log('inventory non-possede: HTTP ' + r.status);
  console.log('  body: ' + (await r.text()).slice(0, 200));

  // 2. Autre endpoint connu: games.roblox.com game-passes details
  const r2 = await fetch('https://apis.roblox.com/game-passes/v1/game-passes/99999999999/details');
  console.log('game-pass details: HTTP ' + r2.status + ' -> ' + (await r2.text()).slice(0, 150));

  // 3. Test ownership API alternative (badges-style inventory v2)
  const r3 = await fetch('https://inventory.roblox.com/v2/users/1/inventory/1?limit=10&sortOrder=Asc');
  console.log('inventory v2: HTTP ' + r3.status + ' -> ' + (await r3.text()).slice(0, 150));
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
