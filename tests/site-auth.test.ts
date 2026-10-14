import { describe, it, expect } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { totp, base32 } from '../worker/site-auth';
const env = {
  ...testEnv,
  LOCAL_AUTH: 'false',
  ENVIRONMENT: 'production',
  AUTH_MODE: 'password_totp',
  AUTH_SETUP_EXPIRES: String(Date.now() + 86400000),
  AUTH_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-or-more',
  AUTH_SETUP_SECRET: 'test-setup-secret-32-bytes-or-more',
  ADMIN_ORIGIN: 'https://233334.xyz',
  ADMIN_EMAILS: 'owner@example.test',
};
async function post(path: string, body: unknown, cookie?: string, origin = 'https://233334.xyz') {
  return app.request(
    'https://233334.xyz/api/auth' + path,
    {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Drive-Request': '1',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
const password = 'test-passphrase-long-enough';
async function setup() {
  const start = await post('/setup/start', { token: env.AUTH_SETUP_SECRET });
  const d = (await start.json()) as { data: { token: string; secret: string; qr: string } };
  const counter = Math.floor(Date.now() / 30000);
  const finish = await post('/setup/finish', {
    token: d.data.token,
    password,
    code: await totp(d.data.secret, counter),
  });
  return { secret: d.data.secret, counter, finish };
}
describe('站内密码与验证器认证', () => {
  it('matches RFC 6238 SHA1 vectors', async () => {
    const s = base32(new TextEncoder().encode('12345678901234567890'));
    expect(await totp(s, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(await totp(s, Math.floor(1111111109 / 30), 8)).toBe('07081804');
  });
  it('setup requires invite, password and proof of authenticator, encrypted secret and one-time setup', async () => {
    expect((await post('/setup/start', { token: 'bad' })).status).toBe(403);
    const { finish } = await setup();
    expect(finish.status).toBe(200);
    const cookie = finish.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect((await post('/setup/start', { token: env.AUTH_SETUP_SECRET })).status).toBe(409);
    expect(
      (
        await app.request(
          'https://233334.xyz/api/admin/settings',
          { headers: { Cookie: cookie.split(';')[0] } },
          env,
        )
      ).status,
    ).toBe(200);
    expect((await app.request('https://233334.xyz/api/admin/settings', {}, env)).status).toBe(401);
    expect((await app.request('https://233334.xyz/drive/', {}, env)).headers.get('location')).toBe(
      '/login',
    );
    expect((await post('/logout', {}, cookie.split(';')[0])).status).toBe(200);
    expect(
      (
        await app.request(
          'https://233334.xyz/api/admin/settings',
          { headers: { Cookie: cookie.split(';')[0] } },
          env,
        )
      ).status,
    ).toBe(401);
  });
  it('rejects password errors, cross-site writes, replayed TOTP and reused recovery codes', async () => {
    const { secret, counter, finish } = await setup();
    const d = (await finish.json()) as { data: { recovery: string[] } };
    expect(
      (await post('/login', { password: 'wrong', code: await totp(secret, counter + 1) })).status,
    ).toBe(401);
    expect((await post('/login', { password, code: await totp(secret, counter) })).status).toBe(
      401,
    );
    expect(
      (
        await post(
          '/login',
          { password, code: await totp(secret, counter + 1) },
          undefined,
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    expect((await post('/login', { password, code: await totp(secret, counter + 1) })).status).toBe(
      200,
    );
    expect((await post('/login', { password, code: await totp(secret, counter + 1) })).status).toBe(
      401,
    );
    expect((await post('/login', { password, code: d.data.recovery[0] })).status).toBe(200);
    expect((await post('/login', { password, code: d.data.recovery[0] })).status).toBe(401);
  });
  it('limits oversized bodies and brute force attempts', async () => {
    expect((await post('/login', { password: 'x'.repeat(5000), code: '000000' })).status).toBe(413);
    for (let n = 0; n < 10; n++)
      expect((await post('/login', { password, code: '000000' })).status).toBe(401);
    expect((await post('/login', { password, code: '000000' })).status).toBe(429);
  });
  it('allows only configured proxy origins for login and authenticated writes', async () => {
    const { finish } = await setup();
    const cookie = finish.headers.get('set-cookie')!.split(';')[0];
    const proxyEnv = { ...env, TRUSTED_PROXY_ORIGINS: 'https://s.irin.im' };
    const headers = {
      Origin: 'https://s.irin.im',
      'X-Drive-Request': '1',
      'Content-Type': 'application/json',
      Cookie: cookie,
    };
    const create = await app.request(
      'https://233334.xyz/api/admin/folders',
      { method: 'POST', headers, body: JSON.stringify({ name: 'via-proxy' }) },
      proxyEnv,
    );
    expect(create.status).toBe(201);
    const bad = await app.request(
      'https://233334.xyz/api/auth/login',
      { method: 'POST', headers, body: JSON.stringify({ password: 'wrong', code: '000000' }) },
      proxyEnv,
    );
    expect(bad.status).toBe(401);
    const evil = await app.request(
      'https://233334.xyz/api/auth/login',
      {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.test', 'X-Forwarded-Host': 's.irin.im' },
        body: JSON.stringify({ password, code: '000000' }),
      },
      proxyEnv,
    );
    expect(evil.status).toBe(403);
    const unknown = await app.request(
      'https://233334.xyz/api/admin/folders',
      {
        method: 'POST',
        headers: { ...headers, Origin: 'https://s.irin.im.evil.test' },
        body: JSON.stringify({ name: 'reject' }),
      },
      proxyEnv,
    );
    expect(unknown.status).toBe(403);
  });
});
