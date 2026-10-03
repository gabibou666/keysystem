'use strict';
function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  let email=value.trim().toLowerCase();
  const parts=email.split('@');
  if(parts.length===2 && ['gmail.com','googlemail.com'].includes(parts[1])) {
    email=parts[0].split('+')[0].replace(/\./g,'')+'@gmail.com';
  }
  return email;
}
const validEmail=email=>email.length<=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
module.exports={normalizeEmail,validEmail};
