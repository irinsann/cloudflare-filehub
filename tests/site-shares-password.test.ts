import { describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import type { FolderRecord } from '../shared/types';
import type { SiteShareListItem } from '../shared/site-shares';
import { hashPassword } from '../worker/auth-crypto';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

async function protectedSite(password = 'correct-password') {
  const folder = await data<FolderRecord>(
    await request('/api/admin/folders', 'POST', { name: 'protected' }),
  );
  await upload('index.html', '<h1>Private website content</h1>', folder.id);
  await upload('module.mjs', 'export const secret="private-module"', folder.id);
  await upload('data.json', '{"secret":"private-json"}', folder.id);
  const share = await data<SiteShareListItem>(
    await request('/api/admin/site-shares', 'POST', {
      folder_id: folder.id,
      password,
    }),
  );
  const url = new URL(share.url).pathname;
  return { share, url, endpoint: url.slice(0, -1) };
}

describe('password-protected static websites', () => {
  it('protects every resource and grants only the unlocked website via a short-lived path', async () => {
    const { url, endpoint } = await protectedSite();
    const locked = await request(url);
    expect(locked.status).toBe(200);
    const html = await locked.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Private website content');
    expect(locked.headers.has('Access-Control-Allow-Origin')).toBe(false);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect((await request(url + 'module.mjs', method)).status).toBe(401);
      expect((await request(url + 'data.json', method)).status).toBe(401);
    }
    const wrong = await request(endpoint, 'POST', { password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { message: '密码错误' } });
    const unlocked = await request(endpoint, 'POST', { password: 'correct-password' });
    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.has('Set-Cookie')).toBe(false);
    const grant = await data<{ url: string }>(unlocked);
    expect(grant.url).toMatch(/^\/site\/s1\.[^/]+~g1\.[0-9]{13}\.[0-9a-f]{64}\/$/);
    const allowed = await request(grant.url, 'GET', undefined, testEnv, { Origin: 'null' });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('<h1>Private website content</h1>');
    for (const name of ['module.mjs', 'data.json']) {
      const response = await request(grant.url + name, 'GET', undefined, testEnv, {
        Origin: 'null',
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
      expect(response.headers.get('Content-Security-Policy')).toContain(
        `connect-src http://localhost${grant.url}`,
      );
    }
    expect((await request(url + 'module.mjs')).status).toBe(401);
    expect(
      (await request('/api/admin/files', 'POST', {}, testEnv, { Origin: 'null' })).status,
    ).toBe(403);
  });

  it('validates password unlock origin, request size, and encoded return paths', async () => {
    const { endpoint } = await protectedSite();
    const invalidHeaders: Record<string, string>[] = [
      { Origin: 'null' },
      { Origin: 'https://attacker.invalid' },
      { 'X-Drive-Request': '' },
    ];
    for (const headers of invalidHeaders) {
      expect(
        (await request(endpoint, 'POST', { password: 'correct-password' }, testEnv, headers))
          .status,
      ).toBe(403);
    }
    expect((await request(endpoint, 'POST', { password: 'a'.repeat(5000) })).status).toBe(413);
    expect(
      (await request(endpoint, 'POST', { password: 'correct-password', path: '../api/admin' }))
        .status,
    ).toBe(400);
    expect(
      (await request(endpoint, 'POST', { password: 'correct-password', path: '//evil.invalid' }))
        .status,
    ).toBe(400);
    const safe = await data<{ url: string }>(
      await request(endpoint, 'POST', {
        password: 'correct-password',
        path: encodeURIComponent('子页面.html'),
        query: '?lang=zh&name=hello%20world',
      }),
    );
    expect(safe.url).toContain('/%E5%AD%90%E9%A1%B5%E9%9D%A2.html');
    expect(safe.url.startsWith('/site/')).toBe(true);
    expect(new URL(safe.url, 'http://localhost').searchParams.get('name')).toBe('hello world');
    const malformed = await app.request(
      'http://localhost' + endpoint,
      {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'X-Drive-Request': '1',
          'Content-Type': 'application/json',
        },
        body: '{broken',
      },
      testEnv,
    );
    expect(malformed.status).toBe(400);
  });

  it('expires grants and rejects altered signatures without making assets public', async () => {
    const { endpoint } = await protectedSite();
    const { url } = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'correct-password' }),
    );
    const originalToken = url.split('/')[2];
    const forged = originalToken.slice(0, -1) + (originalToken.endsWith('0') ? '1' : '0');
    expect((await request(`/site/${forged}/module.mjs`)).status).toBe(401);
    const future = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600001);
    try {
      expect((await request(url + 'data.json')).status).toBe(401);
      const document = await request(url);
      expect(await document.text()).toContain('type="password"');
    } finally {
      future.mockRestore();
    }
  });

  it('invalidates grants after password/version changes, expiry and revocation', async () => {
    const { share, endpoint } = await protectedSite();
    const first = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'correct-password' }),
    );
    await testEnv.DB.prepare('UPDATE site_shares SET password_hash=? WHERE id=?')
      .bind(await hashPassword('new-password'), share.id)
      .run();
    expect((await request(first.url + 'data.json')).status).toBe(401);
    expect((await request(endpoint, 'POST', { password: 'correct-password' })).status).toBe(401);
    const second = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'new-password' }),
    );
    expect((await request(second.url + 'data.json')).status).toBe(200);
    await testEnv.DB.prepare('UPDATE site_shares SET grant_version=grant_version+1 WHERE id=?')
      .bind(share.id)
      .run();
    expect((await request(second.url + 'data.json')).status).toBe(401);
    const third = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'new-password' }),
    );
    await testEnv.DB.prepare('UPDATE site_shares SET expires_at=1 WHERE id=?').bind(share.id).run();
    expect((await request(third.url + 'data.json')).status).toBe(410);
    await testEnv.DB.prepare('UPDATE site_shares SET expires_at=NULL WHERE id=?')
      .bind(share.id)
      .run();
    await request('/api/admin/site-shares/' + share.id, 'DELETE');
    expect((await request(third.url + 'data.json')).status).toBe(410);
    expect((await request(endpoint, 'POST', { password: 'new-password' })).status).toBe(410);
  });

  it('does not reuse an unlock grant for a different website or extend its expiration', async () => {
    const { share, endpoint } = await protectedSite();
    const folder = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'other' }),
    );
    await upload('index.html', '<p>Other content</p>', folder.id);
    await upload('data.json', 'other secret', folder.id);
    const other = await data<SiteShareListItem>(
      await request('/api/admin/site-shares', 'POST', {
        folder_id: folder.id,
        password: 'correct-password',
      }),
    );
    const unlocked = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'correct-password' }),
    );
    const grant = unlocked.url.split('~')[1].slice(0, -1);
    const otherBase = new URL(other.url).pathname.slice(0, -1);
    expect((await request(`${otherBase}~${grant}/data.json`)).status).toBe(401);
    const extended = unlocked.url.replace(
      /(~g1\.)([0-9]+)/,
      (_, prefix: string, expiry: string) => prefix + String(Number(expiry) + 3600000),
    );
    expect((await request(extended + 'data.json')).status).toBe(401);
    await testEnv.DB.prepare('UPDATE site_shares SET expires_at=? WHERE id=?')
      .bind(Date.now() + 10000, share.id)
      .run();
    const short = await data<{ url: string }>(
      await request(endpoint, 'POST', { password: 'correct-password' }),
    );
    const expires = Number(/~g1\.([0-9]+)/.exec(short.url)![1]);
    expect(expires).toBeLessThanOrEqual(Date.now() + 10000);
  });

  it('limits password attempts independently of normal site assets', async () => {
    const { endpoint } = await protectedSite();
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await request(endpoint, 'POST', { password: 'wrong' })).status).toBe(401);
    const blocked = await request(endpoint, 'POST', { password: 'correct-password' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: { message: expect.stringContaining('频繁') },
    });
  });
});
