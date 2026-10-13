import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { verifyAdmin, isLocalAuth } from '../worker/security';
import { request } from './helpers';
describe('Access JWT 与请求边界', () => {
  const production = {
    ...testEnv,
    ENVIRONMENT: 'production',
    LOCAL_AUTH: 'true',
    ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ADMIN_EMAILS: 'admin@example.test',
  };
  it('生产无 JWT、伪造 JWT 和缺失配置不会跳过认证', async () => {
    expect((await app.request('https://example.test/api/admin/files', {}, production)).status).toBe(
      401,
    );
    expect(
      (
        await app.request(
          'https://example.test/api/admin/files',
          { headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' } },
          production,
        )
      ).status,
    ).toBe(401);
    expect(isLocalAuth(production, new URL('http://localhost'))).toBe(false);
    expect(isLocalAuth(testEnv, new URL('https://example.test'))).toBe(false);
    expect(
      (
        await app.request(
          'http://localhost/api/admin/files',
          {},
          { ...testEnv, LOCAL_AUTH: 'false' },
        )
      ).status,
    ).toBe(401);
  });
  it('签名、issuer、audience、到期时间和管理员邮箱均被验证', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const sign = (
      email: string,
      issuer = 'https://example.cloudflareaccess.com',
      audience = 'test-audience',
      expiration = '1h',
    ) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('identity')
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(expiration)
        .sign(privateKey);
    expect(await verifyAdmin(await sign('admin@example.test'), production, publicKey)).toBe(
      'admin@example.test',
    );
    await expect(
      verifyAdmin(await sign('visitor@example.test'), production, publicKey),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      verifyAdmin(await sign('admin@example.test', 'https://attacker.test'), production, publicKey),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyAdmin(await sign('admin@example.test', undefined, 'bad'), production, publicKey),
    ).rejects.toMatchObject({ status: 401 });
    const other = await generateKeyPair('RS256');
    await expect(
      verifyAdmin(await sign('admin@example.test'), production, other.publicKey),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyAdmin(
        await sign('admin@example.test', undefined, undefined, '-1h'),
        production,
        publicKey,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('完整管理员 API 接受真实签名与 JWKS，拒绝非管理员', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const { exportJWK } = await import('jose');
    const jwk = await exportJWK(publicKey);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe(
        'https://middleware-test.cloudflareaccess.com/cdn-cgi/access/certs',
      );
      return new Response(
        JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const env = { ...production, ACCESS_TEAM_DOMAIN: 'middleware-test.cloudflareaccess.com' };
    const sign = (email: string) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject('user')
        .setIssuer('https://middleware-test.cloudflareaccess.com')
        .setAudience('test-audience')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    try {
      expect(
        (
          await app.request(
            'https://example.test/api/admin/settings',
            { headers: { 'Cf-Access-Jwt-Assertion': await sign('admin@example.test') } },
            env,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(
            'https://example.test/api/admin/settings',
            { headers: { 'Cf-Access-Jwt-Assertion': await sign('visitor@example.test') } },
            env,
          )
        ).status,
      ).toBe(403);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('本地模拟显式启用，CSRF 来源和请求头必需；公开 API 无须管理员', async () => {
    expect((await request('/api/admin/settings')).status).toBe(200);
    expect(
      (
        await app.request(
          'http://localhost/api/admin/folders',
          {
            method: 'POST',
            headers: {
              Origin: 'https://evil.test',
              'Content-Type': 'application/json',
              'X-Drive-Request': '1',
            },
            body: JSON.stringify({ name: 'bad' }),
          },
          testEnv,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          'http://localhost/api/admin/folders',
          { method: 'POST', headers: { Origin: 'http://localhost' }, body: '{}' },
          testEnv,
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request('https://example.test/api/public/share/not-a-token', {}, production))
        .status,
    ).toBe(404);
  });
});
