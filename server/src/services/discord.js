'use strict';
// Developer OAuth; no guild membership or bot required.
function loginUrl(redirectUri, state, scope = 'identify email') {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  return res.json();
}

async function fetchUser(accessToken) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`user fetch ${res.status}`);
  return res.json();
}


module.exports={loginUrl,exchangeCode,fetchUser};
