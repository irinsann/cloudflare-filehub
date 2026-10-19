import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { digest } from '../worker/auth-crypto';
import { testEnv } from './setup';

const production = {
  ...testEnv,
  LOCAL_AUTH: 'false',
  ENVIRONMENT: 'production',
  AUTH_MODE: 'password_totp',
  ADMIN_ORIGIN: 'https://233334.xyz',
  TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
  ADMIN_EMAILS: 'owner@example.test',
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
};

async function sessionCookie() {
  const token = 'a'.repeat(64);
  await testEnv.DB.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)')
    .bind(await digest(token), Date.now() + 60000)
    .run();
  return `__Host-rcloud-session=${token}`;
}

describe('independent storage and public-site boundaries', () => {
  it('protects both new management APIs on the CDN and proxy origins', async () => {
    for (const origin of ['https://233334.xyz', 'https://s.irin.im']) {
      for (const path of ['/api/admin/google-drive', '/api/admin/site-shares']) {
        const response = await app.request(origin + path, {}, production);
        expect(response.status).toBe(401);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      }
    }
  });

  it('rejects opaque-origin scripts even when a valid administrator cookie is supplied', async () => {
    const cookie = await sessionCookie();
    for (const path of ['/api/admin/google-drive/connect', '/api/admin/site-shares']) {
      const response = await app.request(
        'https://233334.xyz' + path,
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'null',
            'X-Drive-Request': '1',
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
        production,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('keeps R2 available when Google has not been configured', async () => {
    const headers = { Cookie: await sessionCookie() };
    for (const origin of ['https://233334.xyz', 'https://s.irin.im']) {
      const drive = await app.request(origin + '/api/admin/google-drive', { headers }, production);
      expect(drive.status).toBe(200);
      expect(await drive.json()).toMatchObject({ data: { configured: false, connected: false } });
      const files = await app.request(origin + '/api/admin/files', { headers }, production);
      expect(files.status).toBe(200);
      const settings = await app.request(origin + '/api/admin/settings', { headers }, production);
      expect(settings.status).toBe(200);
      expect(await settings.json()).toMatchObject({
        data: { storageLimitBytes: 50 * 1024 ** 3, storageUsedBytes: 0 },
      });
    }
  });
});
