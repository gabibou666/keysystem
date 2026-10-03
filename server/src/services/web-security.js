'use strict';
const express = require('express');
const helmet = require('helmet');

const pages = new Set(['/', '/index', '/dashboard', '/moderation', '/docs', '/claim', '/signup', '/login', '/verify-email', '/reset-password', '/hubs', '/scripts', '/terms', '/privacy', '/cookies']);
const platformCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    frameSrc: ["'none'"], frameAncestors: ["'none'"], objectSrc: ["'none'"],
    baseUri: ["'none'"], formAction: ["'self'"],
  },
});

function platformHeaders(req, res, next) {
  const path = req.path.replace(/\.html$/, '');
  if (!pages.has(path) && !/^\/(hubs|scripts|developers)\//.test(path) && !/^\/api\/(auth|platform|catalog|discord|moderation)(\/|$)/.test(path)) return next();
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  platformCsp(req, res, next);
}

// Password/email endpoints never need megabyte-sized or compressed bodies.
const authJsonParser = express.json({ limit: '16kb', inflate: false });

function bodyError(error, req, res, next) {
  const status = { 'entity.too.large': 413, 'entity.parse.failed': 400,
    'encoding.unsupported': 415, 'charset.unsupported': 415 }[error.type];
  if (!status) return next(error);
  res.status(status).json({ success: false, error: status === 413 ? 'Request body too large.' :
    status === 415 ? 'Unsupported request encoding.' : 'Invalid JSON request.' });
}

function parseCookies(req, res, next) {
  const cookies = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
    if (!name || value.length > 4096 || Object.hasOwn(cookies, name)) continue;
    try { cookies[name] = decodeURIComponent(value); } catch { /* Ignore malformed unrelated cookies. */ }
  }
  req.cookies = cookies;
  next();
}

module.exports = { platformHeaders, authJsonParser, bodyError, parseCookies };
