import type { ShareRecord } from '../shared/types';
import type { Env } from './env';
import { fail } from './errors';

type ShareIdentity = Pick<ShareRecord, 'id' | 'token_hash'>;
const tokenPattern =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;
const encoder = new TextEncoder();

async function signingKey(env: Env) {
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

function payload(share: ShareIdentity) {
  // Separate link capabilities from password-session signatures using the same secret.
  return encoder.encode(`rcloud:share-link:v1\0${share.id}\0${share.token_hash}`);
}

export function parseShareLinkToken(token: string) {
  const match = tokenPattern.exec(token);
  return match ? { id: match[1], signature: match[2] } : null;
}

export async function shareLinkToken(share: ShareIdentity, env: Env) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(env), payload(share)),
  );
  const signature = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v1.${share.id}.${signature}`;
}

export async function validShareLinkToken(token: string, share: ShareIdentity, env: Env) {
  const parsed = parseShareLinkToken(token);
  if (!parsed || parsed.id !== share.id) return false;
  const signature = Uint8Array.from(parsed.signature.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', await signingKey(env), signature, payload(share));
}
