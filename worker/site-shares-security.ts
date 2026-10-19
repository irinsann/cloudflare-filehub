import type { Env } from './env';
import { fail } from './errors';
import { proxyOrigins } from './origins';

export interface SiteShareRecord {
  id: string;
  folder_id: string;
  token_seed: string;
  password_hash: string | null;
  grant_version: number;
  created_at: number;
  expires_at: number | null;
  enabled: number;
  views: number;
  last_access_at: number | null;
}

const encoder = new TextEncoder();
const tokenPattern =
  /^s1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})(?:~g1\.([0-9]{13})\.([0-9a-f]{64}))?$/;

async function key(env: Env) {
  if (!env.SHARE_SESSION_SECRET || env.SHARE_SESSION_SECRET.length < 32)
    fail(503, '分享会话密钥未配置');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SHARE_SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signature(env: Env, text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', await key(env), encoder.encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function valid(env: Env, value: string, text: string) {
  const bytes = Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', await key(env), bytes, encoder.encode(text));
}

function linkPayload(share: SiteShareRecord) {
  return `rcloud:site-link:v1\0${share.id}\0${share.token_seed}`;
}

function grantPayload(share: SiteShareRecord, expires: number) {
  return `rcloud:site-grant:v1\0${share.id}\0${share.token_seed}\0${share.grant_version}\0${share.password_hash}\0${expires}`;
}

export function parseSiteToken(token: string) {
  const match = tokenPattern.exec(token);
  return match
    ? {
        id: match[1],
        signature: match[2],
        base: token.split('~')[0],
        expires: match[3] ? Number(match[3]) : null,
        grant: match[4] || null,
      }
    : null;
}

export async function siteShareToken(share: SiteShareRecord, env: Env) {
  return `s1.${share.id}.${await signature(env, linkPayload(share))}`;
}

export async function validSiteToken(token: string, share: SiteShareRecord, env: Env) {
  const parsed = parseSiteToken(token);
  return !!parsed && parsed.id === share.id && valid(env, parsed.signature, linkPayload(share));
}

export async function siteGrantToken(share: SiteShareRecord, env: Env, time: number) {
  const expires = Math.min(time + 3600000, share.expires_at ?? Infinity);
  return `${await siteShareToken(share, env)}~g1.${expires}.${await signature(env, grantPayload(share, expires))}`;
}

export async function validSiteGrant(
  token: string,
  share: SiteShareRecord,
  env: Env,
  time: number,
) {
  const parsed = parseSiteToken(token);
  return !!(
    parsed?.grant &&
    parsed.expires &&
    parsed.expires > time &&
    (await valid(env, parsed.grant, grantPayload(share, parsed.expires)))
  );
}

export function siteResourceCsp(origin: string, token: string, env: Env) {
  const trusted = new Set([env.ADMIN_ORIGIN, ...proxyOrigins(env)]);
  // A reverse proxy may retain the upstream Host. Permit only configured site origins,
  // never client-controlled Forwarded/X-Forwarded-Host values, and keep the token path exact.
  const origins = [...new Set([origin, ...trusted])].filter((candidate) => {
    try {
      const url = new URL(candidate);
      if (url.origin !== candidate) return false;
      if (trusted.has(candidate) && url.protocol === 'https:') return true;
      return (
        candidate === origin &&
        env.ENVIRONMENT === 'local' &&
        env.LOCAL_AUTH === 'true' &&
        ['http:', 'https:'].includes(url.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      );
    } catch {
      return false;
    }
  });
  if (!origins.length) fail(503, '网站分享域名未配置');
  const source = origins.map((value) => `${value}/site/${token}/`).join(' ');
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${source}`,
    `style-src 'unsafe-inline' ${source}`,
    `img-src ${source} data: blob:`,
    `media-src ${source} data: blob:`,
    `font-src ${source} data:`,
    `connect-src ${source}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
