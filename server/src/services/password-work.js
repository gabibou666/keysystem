'use strict';
const { scrypt } = require('crypto');
const { promisify } = require('util');
const derive = promisify(scrypt);
let active = 0;

// Reserve worker-pool capacity for other requests instead of accumulating an
// unbounded queue of expensive password operations during a login flood.
async function passwordWork(password, salt) {
  if (active >= 2) {
    const error = new Error('Password service busy');
    error.code = 'AUTH_BUSY';
    throw error;
  }
  active++;
  try { return await derive(password, salt, 64); }
  finally { active--; }
}
module.exports = { passwordWork };
