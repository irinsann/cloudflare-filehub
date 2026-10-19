import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, Env } from './env';
import { now, uuid } from './env';
import { digest, rateLimit } from './auth-crypto';
import { fail } from './errors';
import { proxyOrigins, siteOriginAllowed } from './origins';
import { isLocalAuth } from './security';
import {
  configured,
  DRIVE_SCOPE,
  seal,
  unseal,
  tokenRequest,
  upstream,
  googleError,
  mutationConnection,
} from './google-drive-client';
import type { GoogleDriveStatus } from '../shared/google-drive';

export const GOOGLE_CALLBACK = '/api/oauth/google/callback';
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const nonceName = (env: Env) =>
  env.ENVIRONMENT === 'local' ? 'rcloud-google-oauth' : '__Host-rcloud-google-oauth';
export function redirectUris(env: Env) {
  return [...new Set([env.ADMIN_ORIGIN, ...proxyOrigins(env)])]
    .filter((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === 'https:' && url.origin === origin;
      } catch {
        return false;
      }
    })
    .map((origin) => origin + GOOGLE_CALLBACK);
}
export async function beginGoogleConnect(c: AppContext) {
  if (!configured(c.env)) fail(503, '请先配置 Google OAuth 客户端');
  const url = new URL(c.req.url);
  if (!siteOriginAllowed(c.env, url.origin) && !isLocalAuth(c.env, url)) fail(403, '授权来源无效');
  // A trusted reverse proxy can preserve the browser Origin while using ADMIN_ORIGIN upstream.
  const browserOrigin = c.req.header('Origin');
  if (
    !browserOrigin ||
    (!siteOriginAllowed(c.env, browserOrigin) &&
      !(isLocalAuth(c.env, url) && browserOrigin === url.origin))
  )
    fail(403, '授权来源无效');
  const previous = await c.env.DB.prepare(
    'SELECT connection_id FROM google_drive_connections WHERE id=1',
  ).first<{ connection_id: string }>();
  const expected = c.req.header('X-Google-Connection');
  if ((previous && expected !== previous.connection_id) || (!previous && expected))
    fail(409, 'Google Drive 连接已变化，请刷新');
  const state = random(),
    nonce = random(),
    verifier = random();
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    ),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  let sessionHash: string | null = null;
  if (c.env.AUTH_MODE === 'password_totp' && !isLocalAuth(c.env, url)) {
    const token = getCookie(
      c,
      c.env.ENVIRONMENT === 'local' ? 'rcloud-session' : '__Host-rcloud-session',
    );
    if (!token || !/^[0-9a-f]{64}$/.test(token)) fail(401, '请登录 RCloud');
    sessionHash = await digest(token);
  }
  const inserted = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM google_drive_oauth WHERE expires_at<=?').bind(now()),
    c.env.DB.prepare(
      'INSERT INTO google_drive_oauth(state_hash,nonce_hash,verifier_cipher,origin,admin_session_hash,generation,expires_at) SELECT ?,?,?,?,?,generation,? FROM google_drive_generation WHERE id=1 AND ' +
        (previous
          ? 'EXISTS(SELECT 1 FROM google_drive_connections WHERE connection_id=?)'
          : 'NOT EXISTS(SELECT 1 FROM google_drive_connections)'),
    ).bind(
      await digest(state),
      await digest(nonce),
      await seal(c.env, verifier, 'pkce'),
      browserOrigin,
      sessionHash,
      now() + 600000,
      ...(previous ? [previous.connection_id] : []),
    ),
  ]);
  if (!inserted[1].meta.changes) fail(409, 'Google Drive 连接已变化，请刷新');
  setCookie(c, nonceName(c.env), nonce, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'local',
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: browserOrigin + GOOGLE_CALLBACK,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return c.json({ data: { url: auth.href } });
}
interface OauthState {
  verifier_cipher: string;
  origin: string;
  generation: number;
}
export async function googleDriveCallback(c: AppContext) {
  c.header('Cache-Control', 'private, no-store');
  await rateLimit(c.env, 'google-callback', c.req.header('CF-Connecting-IP') || 'local', 20, 300);
  const state = c.req.query('state') ?? '',
    nonce = getCookie(c, nonceName(c.env)) ?? '';
  if (!/^[0-9a-f]{64}$/.test(state) || !/^[0-9a-f]{64}$/.test(nonce))
    fail(400, '授权请求已失效，请重新连接');
  const origin = new URL(c.req.url).origin;
  if (!siteOriginAllowed(c.env, origin) && !isLocalAuth(c.env, new URL(c.req.url)))
    fail(403, '授权来源无效');
  const stateHash = await digest(state),
    nonceHash = await digest(nonce);
  const candidate = await c.env.DB.prepare(
    'SELECT origin FROM google_drive_oauth WHERE state_hash=? AND nonce_hash=? AND expires_at>?',
  )
    .bind(stateHash, nonceHash, now())
    .first<{ origin: string }>();
  if (
    !candidate ||
    (origin !== candidate.origin && origin !== c.env.ADMIN_ORIGIN) ||
    (!siteOriginAllowed(c.env, candidate.origin) &&
      !(isLocalAuth(c.env, new URL(c.req.url)) && candidate.origin === origin))
  )
    fail(400, '授权请求已失效，请重新连接');
  // The Lax nonce is the callback browser binding. The Strict login cookie is intentionally not required here.
  const record = await c.env.DB.prepare(
    `DELETE FROM google_drive_oauth WHERE state_hash=? AND nonce_hash=? AND origin=? AND expires_at>?
    AND generation=(SELECT generation FROM google_drive_generation WHERE id=1)
    AND (admin_session_hash IS NULL OR EXISTS(SELECT 1 FROM admin_sessions WHERE token_hash=admin_session_hash AND expires_at>?))
    RETURNING verifier_cipher,origin,generation`,
  )
    .bind(stateHash, nonceHash, candidate.origin, now(), now())
    .first<OauthState>();
  if (!record) fail(400, '授权请求已失效，请重新连接');
  deleteCookie(c, nonceName(c.env), { path: '/', secure: c.env.ENVIRONMENT !== 'local' });
  const destination = (result: string) =>
    record.origin + '/drive/?google_drive=' + result + '#google-drive';
  if (c.req.query('error')) return c.redirect(destination('cancelled'), 303);
  const code = c.req.query('code');
  if (!code || code.length > 4096) fail(400, 'Google 授权码无效');
  const tokens = await tokenRequest(c.env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: record.origin + GOOGLE_CALLBACK,
    code_verifier: await unseal(c.env, record.verifier_cipher, 'pkce'),
  });
  if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(DRIVE_SCOPE))
    fail(403, '请授予 Google Drive 完整文件权限后重新连接');
  const about = await upstream(
    'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
    { headers: { Authorization: 'Bearer ' + tokens.access_token } },
  );
  if (!about.ok) await googleError(about);
  const result = (await about.json()) as { user?: GoogleDriveStatus['account'] };
  if (!result.user?.emailAddress) fail(502, 'Google 账户信息无效');
  const connectionId = uuid();
  // Replace only the connection generation that initiated OAuth; disconnect invalidates outstanding callbacks.
  const guard = 'EXISTS(SELECT 1 FROM google_drive_generation WHERE id=1 AND generation=?)';
  const saved = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM google_drive_uploads WHERE ' + guard).bind(record.generation),
    c.env.DB.prepare('DELETE FROM google_drive_connections WHERE ' + guard).bind(record.generation),
    c.env.DB.prepare(
      'INSERT INTO google_drive_connections(id,connection_id,account_json,refresh_cipher,access_cipher,access_expires,created_at) SELECT 1,?,?,?,?,?,? WHERE ' +
        guard,
    ).bind(
      connectionId,
      JSON.stringify(result.user),
      await seal(c.env, tokens.refresh_token, 'refresh'),
      await seal(c.env, tokens.access_token, 'access'),
      now() + Math.min(tokens.expires_in, 86400) * 1000,
      now(),
      record.generation,
    ),
    c.env.DB.prepare(
      'UPDATE google_drive_generation SET generation=generation+1 WHERE id=1 AND generation=?',
    ).bind(record.generation),
  ]);
  if (!saved[2].meta.changes) fail(409, '连接状态已变化，请重新连接');
  return c.redirect(destination('connected'), 303);
}
export async function disconnectGoogle(c: AppContext) {
  const current = await mutationConnection(c);
  // Detaching must never delete Drive files. Remove every local credential and invalidate in-flight OAuth.
  const removed = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE google_drive_generation SET generation=generation+1 WHERE id=1 AND EXISTS(SELECT 1 FROM google_drive_connections WHERE connection_id=?)',
    ).bind(current.connection_id),
    c.env.DB.prepare(
      'DELETE FROM google_drive_oauth WHERE EXISTS(SELECT 1 FROM google_drive_connections WHERE connection_id=?)',
    ).bind(current.connection_id),
    c.env.DB.prepare('DELETE FROM google_drive_uploads WHERE connection_id=?').bind(
      current.connection_id,
    ),
    c.env.DB.prepare('DELETE FROM google_drive_connections WHERE connection_id=?').bind(
      current.connection_id,
    ),
  ]);
  if (!removed[3].meta.changes) fail(409, 'Google Drive 连接已变化，请刷新');
  return c.json({ data: { connected: false } });
}
