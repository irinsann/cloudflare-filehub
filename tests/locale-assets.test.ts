import { describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { htmlPage } from '../worker/html';
import { requestLocale } from '../worker/locale';
import { digest } from '../worker/auth-crypto';
import { testEnv } from './setup';
import type { Env } from '../worker/env';

const production: Env = {
  ...testEnv,
  ENVIRONMENT: 'production',
  LOCAL_AUTH: 'false',
  AUTH_MODE: 'password_totp',
  ADMIN_ORIGIN: 'https://cloud.example.com',
  ADMIN_EMAILS: 'owner@example.com',
};
describe('language and static asset boundaries', () => {
  it('uses saved language for documents and explicit UI language for API requests', () => {
    const headers = { Cookie: 'rcloud-locale=en', 'Accept-Language': 'zh-CN' };
    expect(requestLocale(new Request('https://cloud.example.com/login', { headers }))).toBe('en');
    expect(
      requestLocale(new Request('https://cloud.example.com/api/admin/files', { headers })),
    ).toBe('zh');
    expect(
      requestLocale(
        new Request('https://cloud.example.com/login', {
          headers: { 'Accept-Language': 'en-US,en;q=0.9' },
        }),
      ),
    ).toBe('en');
  });
  it('renders setup fields in English without changing content titles or the setup flow', async () => {
    const response = await app.request(
      'https://cloud.example.com/login',
      { headers: { 'Accept-Language': 'en' } },
      production,
    );
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Set up your account');
    expect(html).toContain('At least 12 characters');
    expect(html).toContain('id="qr"');
    expect(html).toContain('id="password"');
    expect(html).toContain('rcloud-locale');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const article = htmlPage(
      '文件分享',
      '<main>User content: 文件分享</main>',
      undefined,
      '',
      '',
      'en',
    );
    expect(article.html).toContain('<title>文件分享 · RCloud</title>');
    expect(article.html).toContain('<main>User content: 文件分享</main>');
  });
  it('returns localized authorization errors and rejects retired APIs', async () => {
    const unauthorized = await app.request(
      'https://cloud.example.com/api/admin/files',
      { headers: { 'Accept-Language': 'en' } },
      production,
    );
    expect(unauthorized.status).toBe(401);
    expect(JSON.stringify(await unauthorized.json())).not.toMatch(/[\u4e00-\u9fff]/);
    expect((await app.request('http://localhost/api/admin/google-drive', {}, testEnv)).status).toBe(
      404,
    );
    expect(
      (await app.request('http://localhost/api/oauth/google/callback', {}, testEnv)).status,
    ).toBe(404);
    const tables = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'google_drive_%'",
    ).all();
    expect(tables.results).toHaveLength(0);
  });
  it('serves only build assets without a session read and never caches the private shell', async () => {
    const assets = vi.fn(
      async (request: Request) =>
        new Response(
          new URL(request.url).pathname.endsWith('.js')
            ? 'export const ok=true'
            : '<html>app</html>',
          {
            headers: {
              'Content-Type': new URL(request.url).pathname.endsWith('.js')
                ? 'application/javascript'
                : 'text/html',
            },
          },
        ),
    );
    const env = { ...production, ASSETS: { fetch: assets } as unknown as Fetcher };
    const query = vi.spyOn(testEnv.DB, 'prepare');
    const response = await app.request(
      'https://cloud.example.com/drive/assets/index-abcdefgh.js',
      {},
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    const unchanged = await app.request(
      'https://cloud.example.com/drive/assets/index-abcdefgh.js',
      { headers: { 'If-None-Match': '"build-hash"' } },
      {
        ...env,
        ASSETS: {
          fetch: async () => new Response(null, { status: 304, headers: { ETag: '"build-hash"' } }),
        } as unknown as Fetcher,
      },
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('ETag')).toBe('"build-hash"');
    expect(
      (await app.request('https://cloud.example.com/drive/assets/index.html', {}, env)).status,
    ).toBe(404);
    expect(
      (await app.request('https://cloud.example.com/drive/assets/missing-abcdefgh.css', {}, env))
        .status,
    ).toBe(404);
    const token = 'a'.repeat(64);
    await testEnv.DB.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)')
      .bind(await digest(token), Date.now() + 60000)
      .run();
    const sessionQuery = vi.spyOn(testEnv.DB, 'prepare');
    const shell = await app.request(
      'https://cloud.example.com/drive/',
      { headers: { Cookie: `__Host-rcloud-session=${token}` } },
      env,
    );
    expect(shell.status).toBe(200);
    expect(shell.headers.get('Cache-Control')).toBe('private, no-store');
    expect(
      sessionQuery.mock.calls.filter(([sql]) => sql.includes('FROM admin_sessions')),
    ).toHaveLength(1);
    sessionQuery.mockRestore();
  });
});
