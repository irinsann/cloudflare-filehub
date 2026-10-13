import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from './env';
import { fail } from './errors';
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function isLocalAuth(env: Env, url: URL) {
  return (
    env.ENVIRONMENT === 'local' &&
    env.LOCAL_AUTH === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}
export async function verifyAdmin(token: string, env: Env, key?: Parameters<typeof jwtVerify>[1]) {
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    !env.ACCESS_AUD ||
    !env.ADMIN_EMAILS
  )
    fail(503, '请配置 Cloudflare Access');
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key ?? jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    }));
  } catch {
    fail(401, '认证无效或已过期');
  }
  if (
    typeof payload.iat !== 'number' ||
    payload.iat > Date.now() / 1000 + 60 ||
    typeof payload.sub !== 'string' ||
    !payload.sub
  )
    fail(401, '认证声明无效');
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (
    !env.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .includes(email)
  )
    fail(403, '此身份没有管理员权限');
  return email;
}
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  if (c.env.ADMIN_ORIGIN && url.origin !== new URL(c.env.ADMIN_ORIGIN).origin)
    fail(403, '管理员接口只能通过管理域名访问');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('Origin') !== url.origin || c.req.header('X-Drive-Request') !== '1')
      fail(403, '请求来源校验失败');
  }
  if (isLocalAuth(c.env, url)) c.set('email', 'local@localhost');
  else {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) fail(401, '请通过 Cloudflare Access 登录');
    c.set('email', await verifyAdmin(token, c.env));
  }
  await next();
};
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
    'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
  )
    .bind(key, (bucket + 1) * seconds * 1000)
    .first<{ count: number }>();
  if (!row || row.count > max) fail(429, '请求过于频繁，请稍后重试');
}
