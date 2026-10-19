import type { Env } from './env';
import { fail } from './errors';

async function encryptionKey(env: Env) {
  if (!env.AUTH_ENCRYPTION_KEY || env.AUTH_ENCRYPTION_KEY.length < 32)
    fail(503, '认证加密密钥未配置');
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.AUTH_ENCRYPTION_KEY)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

// Retain the existing TOTP ciphertext format so upgrades need no credential migration.
export async function encryptSecret(secret: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await encryptionKey(env),
      new TextEncoder().encode(secret),
    ),
  );
  return JSON.stringify({ iv: Array.from(iv), data: Array.from(data) });
}

export async function decryptSecret(cipher: string, env: Env) {
  const value = JSON.parse(cipher);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(value.iv) },
      await encryptionKey(env),
      new Uint8Array(value.data),
    ),
  );
}
