import type { Env } from './env';
export function proxyOrigins(env: Env) {
  return (env.TRUSTED_PROXY_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' && u.origin === s;
      } catch {
        return false;
      }
    });
}
export function siteOriginAllowed(env: Env, origin: string) {
  return origin === env.ADMIN_ORIGIN || proxyOrigins(env).includes(origin);
}
export function writeOriginAllowed(env: Env, request: Request) {
  const origin = request.headers.get('Origin');
  return !!origin && (origin === new URL(request.url).origin || proxyOrigins(env).includes(origin));
}
