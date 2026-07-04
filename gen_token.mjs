import { SignJWT } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const openId = process.env.OWNER_OPEN_ID;
const appId = process.env.VITE_APP_ID;

console.log('OWNER_OPEN_ID:', openId);
console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);

const token = await new SignJWT({ openId, appId, name: 'Peter Allen' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(secret);

console.log('TOKEN:', token);
