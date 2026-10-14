import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from './env';
import { fail } from './errors';
import { siteOriginAllowed, writeOriginAllowed } from './origins';
import { siteIdentity } from './site-auth';
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
  if (c.env.ADMIN_ORIGIN && !siteOriginAllowed(c.env, url.origin))
    fail(403, '管理员接口只能通过管理域名访问');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (!writeOriginAllowed(c.env, c.req.raw) || c.req.header('X-Drive-Request') !== '1')
      fail(403, '请求来源校验失败');
  }
  if (isLocalAuth(c.env, url)) c.set('email', 'local@localhost');
  else if (c.env.AUTH_MODE === 'password_totp') {
    const email = await siteIdentity(c);
    if (!email) fail(401, '请登录 RCloud');
    c.set('email', email);
  } else {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) fail(401, '请通过 Cloudflare Access 登录');
    c.set('email', await verifyAdmin(token, c.env));
  }
  await next();
};
export * from './auth-crypto';
