import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import type { FileRecord, FolderRecord } from '../shared/types';
import type { SiteShareListItem } from '../shared/site-shares';
import { parseSitePath } from '../worker/site-shares-files';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

const page =
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script type="module" src="app.mjs"></script></head><body><h1>Original website</h1><a href="docs/">Docs</a></body></html>';

async function folder(name = 'website', parentId: string | null = null) {
  return data<FolderRecord>(
    await request('/api/admin/folders', 'POST', { name, parent_id: parentId }),
  );
}

async function site(options: Record<string, unknown> = {}) {
  const root = await folder();
  const index = await data<FileRecord>(await upload('index.html', page, root.id));
  const share = await data<SiteShareListItem>(
    await request('/api/admin/site-shares', 'POST', { folder_id: root.id, ...options }),
  );
  const url = new URL(share.url).pathname;
  return { root, index, share, url, token: url.split('/')[2] };
}

function isolated(response: Response, base: string) {
  const policy = response.headers.get('Content-Security-Policy')!;
  expect(policy).toContain('sandbox allow-scripts');
  expect(policy).not.toContain('allow-same-origin');
  expect(policy).toContain(`connect-src http://localhost${base}`);
  expect(policy).toContain("worker-src 'none'");
  expect(policy).toContain("base-uri 'none'");
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

describe('HTML folder website shares', () => {
  it('serves original HTML directly, canonicalizes directory URLs, and keeps asset requests out of view counts', async () => {
    const { root, share, url } = await site();
    const docs = await folder('docs', root.id);
    await upload('index.html', '<h1>Subpage</h1>', docs.id);
    await upload('style.css', 'h1{color:red}', root.id);
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(page);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    isolated(response, url);
    const rootRedirect = await request(url.slice(0, -1));
    expect(rootRedirect.status).toBe(308);
    expect(rootRedirect.headers.get('Location')).toBe(url);
    const redirect = await request(`${url}docs?lang=zh`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('Location')).toBe(`${url}docs/?lang=zh`);
    expect(redirect.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const preflight = await request(`${url}docs`, 'OPTIONS', undefined, testEnv, {
      Origin: 'null',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.has('Location')).toBe(false);
    const nested = await request(`${url}docs/`);
    expect(await nested.text()).toBe('<h1>Subpage</h1>');
    isolated(nested, url);
    const head = await request(url, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const range = await request(url, 'GET', undefined, testEnv, { Range: 'bytes=0-14' });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('<!doctype html>');
    const asset = await request(`${url}style.css`);
    expect(await asset.text()).toBe('h1{color:red}');
    const counts = await testEnv.DB.prepare('SELECT views FROM site_shares WHERE id=?')
      .bind(share.id)
      .first<{ views: number }>();
    expect(counts?.views).toBe(2);
  });

  it('provides executable MIME and anonymous CORS for modules, imported JSON, styles, fonts and media', async () => {
    const { root, url } = await site();
    const assets: [string, string, string][] = [
      ['style.css', 'body{font-family:demo}', 'text/css'],
      ['classic.js', 'window.demo=true', 'text/javascript'],
      ['app.mjs', 'import "./dependency.mjs";fetch("./data.json")', 'text/javascript'],
      ['dependency.mjs', 'export const value=42', 'text/javascript'],
      ['data.json', '{"value":42}', 'application/json'],
      ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
      ['image.avif', 'fixture', 'image/avif'],
      ['font.woff2', 'fixture', 'font/woff2'],
      ['demo.wasm', 'fixture', 'application/wasm'],
    ];
    for (const [name, content, mime] of assets) {
      await upload(name, content, root.id);
      const response = await request(url + name, 'GET', undefined, testEnv, { Origin: 'null' });
      expect(response.status, name).toBe(200);
      expect(response.headers.get('Content-Type'), name).toContain(mime);
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(content);
      isolated(response, url);
    }
    const options = await request(`${url}app.mjs`, 'OPTIONS', undefined, testEnv, {
      Origin: 'null',
      'Access-Control-Request-Method': 'GET',
    });
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(options.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    expect(options.headers.get('Access-Control-Allow-Headers')).toBe('Range');
    expect(
      (
        await request('/api/admin/settings', 'GET', undefined, testEnv, { Origin: 'null' })
      ).headers.has('Access-Control-Allow-Origin'),
    ).toBe(false);
  });

  it('reconstructs the same copyable URL and paginates without returning secrets', async () => {
    const { root, share } = await site({ password: 'share-secret', expires_in_days: 2 });
    expect(share.password_protected).toBe(true);
    expect(share.enabled).toBe(true);
    expect(share.name).toBe(root.name);
    expect(share.expires_at).toBeGreaterThan(Date.now());
    await request('/api/admin/site-shares', 'POST', { folder_id: root.id });
    const response = await request('/api/admin/site-shares?page=1&limit=1');
    const body = (await response.json()) as {
      data: SiteShareListItem[];
      page: number;
      limit: number;
      total: number;
    };
    expect(body).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(body.data).toHaveLength(1);
    const listed = await data<SiteShareListItem[]>(await request('/api/admin/site-shares'));
    expect(listed.find((row) => row.id === share.id)?.url).toBe(share.url);
    expect(JSON.stringify(listed)).not.toMatch(
      /token_seed|password_hash|grant_version|share-secret/,
    );
    expect(
      await data<SiteShareListItem[]>(await request('/api/admin/site-shares?page=3&limit=1')),
    ).toEqual([]);
  });

  it('does not spend rate-limit or view-counter writes on static assets', async () => {
    const { root, share, url } = await site();
    await upload('data.json', '{}', root.id);
    const before = await testEnv.DB.prepare('SELECT key,count FROM rate_limits ORDER BY key').all();
    for (const method of ['GET', 'GET', 'HEAD', 'OPTIONS'])
      expect((await request(url + 'data.json', method)).status).toBe(
        method === 'OPTIONS' ? 204 : 200,
      );
    const after = await testEnv.DB.prepare('SELECT key,count FROM rate_limits ORDER BY key').all();
    expect(after.results).toEqual(before.results);
    expect(
      await testEnv.DB.prepare('SELECT views FROM site_shares WHERE id=?')
        .bind(share.id)
        .first<number>('views'),
    ).toBe(0);
  });

  it('requires an explicit folder and a unique root index.html', async () => {
    const empty = await folder('empty');
    expect((await request('/api/admin/site-shares', 'POST', { folder_id: null })).status).toBe(400);
    expect((await request('/api/admin/site-shares', 'POST', { folder_id: empty.id })).status).toBe(
      404,
    );
    await upload('index.html', page, empty.id);
    await upload('index.html', '<h1>Ambiguous</h1>', empty.id);
    expect((await request('/api/admin/site-shares', 'POST', { folder_id: empty.id })).status).toBe(
      409,
    );
    expect(
      (await request('/api/admin/site-shares', 'POST', { folder_id: empty.id, expires_in_days: 0 }))
        .status,
    ).toBe(400);
  });

  it('does not create a share when the folder is trashed after validation but before commit', async () => {
    const root = await folder();
    await upload('index.html', page, root.id);
    let intercepted = false;
    const database = new Proxy(testEnv.DB, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true;
              await target.prepare('DELETE FROM files WHERE folder_id=?').bind(root.id).run();
              await target
                .prepare('UPDATE folders SET deleted_at=1 WHERE id=?')
                .bind(root.id)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await request(
      '/api/admin/site-shares',
      'POST',
      { folder_id: root.id },
      { ...testEnv, DB: database },
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM site_shares').first<number>('total'),
    ).toBe(0);
  });

  it('detects nested duplicate names both before publication and after a later upload', async () => {
    const { root, url } = await site();
    const assets = await folder('assets', root.id);
    await upload('same.js', 'first', assets.id);
    await upload('same.js', 'second', assets.id);
    expect((await request(url + 'assets/same.js')).status).toBe(409);
    expect((await request('/api/admin/site-shares', 'POST', { folder_id: root.id })).status).toBe(
      409,
    );
    await folder('clash', root.id);
    await upload('clash', 'file', root.id);
    expect((await request(url + 'clash')).status).toBe(409);
  });

  it('resolves encoded Unicode names and never serves siblings or private root files', async () => {
    const { root, url } = await site();
    const nested = await folder('中文 目录', root.id);
    await upload('子页面.html', '<h1>中文</h1>', nested.id);
    await upload('private.json', 'private-root');
    const sibling = await folder('private');
    await upload('secret.json', 'private-sibling', sibling.id);
    const response = await request(
      `${url}${encodeURIComponent(nested.name)}/${encodeURIComponent('子页面.html')}`,
    );
    expect(await response.text()).toBe('<h1>中文</h1>');
    for (const path of [
      'private.json',
      'private/secret.json',
      '../private.json',
      '%2e%2e/private.json',
    ]) {
      const result = await request(url + path);
      expect(result.status, path).toBeGreaterThanOrEqual(400);
      expect(await result.text()).not.toContain('private-root');
    }
    expect((await request(url + 'index.html/')).status).toBe(404);
  });

  it.each(['%2fapi', '%5c..', '%252e%252e', '%252fapi', '%00', '%C3%28', 'a//b'])(
    'rejects unsafe path %s',
    async (path) => {
      const { url } = await site();
      expect((await request(url + path)).status).toBe(400);
    },
  );

  it('bounds path depth and length before resolving folders', () => {
    expect(() => parseSitePath('../private')).toThrow();
    expect(() => parseSitePath(Array.from({ length: 65 }, () => 'a').join('/'))).toThrow();
    expect(() => parseSitePath('a'.repeat(4097))).toThrow();
  });

  it('rejects forged links and applies revoke/expiry to every resource', async () => {
    const { root, share, url, token } = await site();
    await upload('app.js', 'hello', root.id);
    const forged = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect((await request(`/site/${forged}/`)).status).toBe(404);
    expect((await request(`/site/v1.${token.slice(3)}/`)).status).toBe(404);
    await testEnv.DB.prepare('UPDATE site_shares SET expires_at=1 WHERE id=?').bind(share.id).run();
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect((await request(url + 'app.js', method)).status).toBe(410);
    await testEnv.DB.prepare('UPDATE site_shares SET expires_at=NULL WHERE id=?')
      .bind(share.id)
      .run();
    expect((await request('/api/admin/site-shares/' + share.id, 'DELETE')).status).toBe(200);
    expect((await request(url)).status).toBe(410);
    expect((await request(url + 'app.js')).status).toBe(410);
    const listed = await data<SiteShareListItem[]>(await request('/api/admin/site-shares'));
    expect(listed[0].enabled).toBe(false);
    expect(listed[0].url).toBe(share.url);
  });

  it('revokes a trashed root permanently even if the directory and index are restored', async () => {
    const { root, index, share, url } = await site();
    await request(`/api/admin/files/${index.id}`, 'DELETE');
    await request(`/api/admin/files/${index.id}/permanent`, 'DELETE');
    expect((await request(`/api/admin/folders/${root.id}`, 'DELETE')).status).toBe(200);
    expect((await request(url)).status).toBe(410);
    await request(`/api/admin/folders/${root.id}/restore`, 'POST');
    await upload('index.html', page, root.id);
    expect((await request(url)).status).toBe(410);
    const state = await testEnv.DB.prepare(
      'SELECT enabled,grant_version FROM site_shares WHERE id=?',
    )
      .bind(share.id)
      .first<{ enabled: number; grant_version: number }>();
    expect(state).toEqual({ enabled: 0, grant_version: 2 });
  });

  it('revokes descendants if a containing folder is soft-deleted by a future tree operation', async () => {
    const { root, share, url } = await site();
    const parent = await folder('parent');
    await request(`/api/admin/folders/${root.id}`, 'PATCH', { parent_id: parent.id });
    // Current UI disallows nonempty-folder trash. Exercise the share trigger independently.
    const guard = await testEnv.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='folders_empty_before_trash'",
    ).first<string>('sql');
    expect(guard).toBeTruthy();
    await testEnv.DB.prepare('DROP TRIGGER folders_empty_before_trash').run();
    try {
      await testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(parent.id).run();
      expect((await request(url)).status).toBe(410);
      await testEnv.DB.prepare('UPDATE folders SET deleted_at=NULL WHERE id=?')
        .bind(parent.id)
        .run();
      expect((await request(url)).status).toBe(410);
      expect(
        await testEnv.DB.prepare('SELECT enabled FROM site_shares WHERE id=?')
          .bind(share.id)
          .first<number>('enabled'),
      ).toBe(0);
    } finally {
      await testEnv.DB.prepare(guard!).run();
    }
  });

  it('keeps the primary and proxy domain policies tied to the actual request origin', async () => {
    const { url } = await site();
    const runtime = {
      ...testEnv,
      ADMIN_ORIGIN: 'https://233334.xyz',
      TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
    };
    for (const origin of ['https://233334.xyz', 'https://s.irin.im']) {
      const response = await app.request(origin + url, {}, runtime);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toContain(
        `connect-src ${origin}${url}`,
      );
      expect(await response.text()).toBe(page);
    }
  });

  it('allows configured proxy resources even when the proxy keeps the upstream Host', async () => {
    const { url } = await site();
    const runtime = {
      ...testEnv,
      ADMIN_ORIGIN: 'https://233334.xyz',
      TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
    };
    const response = await app.request(
      'https://233334.xyz' + url,
      {
        headers: {
          Origin: 'https://s.irin.im',
          Forwarded: 'host=evil.invalid;proto=https',
          'X-Forwarded-Host': 'evil.invalid',
          'X-Forwarded-Proto': 'http',
        },
      },
      runtime,
    );
    expect(response.status).toBe(200);
    const directives = response.headers
      .get('Content-Security-Policy')!
      .split(';')
      .map((value) => value.trim());
    const sources = `https://233334.xyz${url} https://s.irin.im${url}`;
    expect(directives).toContain('connect-src ' + sources);
    expect(directives).toContain("script-src 'unsafe-inline' " + sources);
    expect(directives).toContain("style-src 'unsafe-inline' " + sources);
    expect(directives).toContain('img-src ' + sources + ' data: blob:');
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain('sandbox allow-scripts');
    expect(directives.join(';')).not.toMatch(/evil\.invalid|\/api\/|allow-same-origin|https:\*/);
    expect(await response.text()).toBe(page);
  });
});
