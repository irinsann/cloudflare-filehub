import { jwtVerify, SignJWT } from 'jose';
import type { Env } from './env';
import { fail } from './errors';
export const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));
async function derive(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 100000 },
        key,
        256,
      ),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${hex(salt)}:${await derive(password, salt)}`;
}
export async function checkPassword(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  const actual = await derive(password, unhex(salt));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function sessionKey(env: Env) {
  if (!env.SHARE_SESSION_SECRET || env.SHARE_SESSION_SECRET.length < 32)
    fail(503, '分享会话密钥未配置');
  return new TextEncoder().encode(env.SHARE_SESSION_SECRET);
}
export async function signShareSession(shareId: string, env: Env) {
  return new SignJWT({ shareId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('irin-drive')
    .setAudience('share')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(sessionKey(env));
}
export async function validShareSession(token: string | undefined, shareId: string, env: Env) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), {
      algorithms: ['HS256'],
      issuer: 'irin-drive',
      audience: 'share',
    });
    return payload.shareId === shareId;
  } catch {
    return false;
  }
}
export async function rateLimit(env: Env, scope: string, ip: string, max: number, seconds = 60) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const key = `${scope}:${await digest(ip)}:${bucket}`;
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE rate_limits.count<? RETURNING count',
  )
    .bind(key, (bucket + 1) * seconds * 1000, max)
    .first<{ count: number }>();
  if (!row || row.count > max) fail(429, '请求过于频繁，请稍后重试');
}
