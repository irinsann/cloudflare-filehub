import { describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import preview from '../preview/ui-worker';
import { files, images } from '../preview/fixtures';
import configText from '../wrangler.ui-preview.jsonc?raw';

function environment() {
  const fetch = vi.fn(async () => new Response('<html>UI assets</html>'));
  return { env: { ASSETS: { fetch } as unknown as Fetcher }, fetch };
}
const request = (path: string, method = 'GET') =>
  new Request('https://preview.example.test' + path, { method });

describe('isolated UI preview', () => {
  it('has only static assets and no production bindings or routes', () => {
    const config = parse(configText);
    expect(config).toMatchObject({ name: 'rcloud-ui-preview', workers_dev: true });
    expect(config.assets.binding).toBe('ASSETS');
    for (const name of ['d1_databases', 'r2_buckets', 'vars', 'routes', 'account_id', 'triggers'])
      expect(config[name]).toBeUndefined();
  });

  it('serves fictional API shapes on its own origin without any asset or external fetch', async () => {
    const { env, fetch } = environment();
    const settings = (await (await preview.fetch(request('/api/admin/settings'), env)).json()) as {
      data: { email: string; adminOrigin: string; filesOrigin: string };
    };
    expect(settings.data.email).toBe('preview@example.invalid');
    expect(settings.data.adminOrigin).toBe('https://preview.example.test');
    expect(settings.data.filesOrigin).toBe(settings.data.adminOrigin);
    const listing = (await (
      await preview.fetch(request('/api/admin/files?view=recent'), env)
    ).json()) as { data: { total: number; files: unknown[] } };
    expect(listing.data.files).toHaveLength(files.length - 1);
    expect(listing.data.total).toBe(listing.data.files.length);
    const gallery = (await (await preview.fetch(request('/api/admin/images'), env)).json()) as {
      data: { url: string }[];
    };
    expect(gallery.data).toHaveLength(10);
    expect(gallery.data.every((entry) => entry.url.startsWith(settings.data.adminOrigin))).toBe(
      true,
    );
    expect(await (await preview.fetch(request('/api/admin/images?page=2'), env)).json()).toEqual({
      data: [],
    });
    expect(await (await preview.fetch(request('/api/admin/webdav'), env)).json()).toEqual({
      data: { credentials: [], username: 'rcloud', path: '/dav/', maxUploadBytes: 100000000 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects every write before touching assets, including login and upload routes', async () => {
    const { env, fetch } = environment();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/admin/files', '/api/auth/login', '/api/v1/images', '/drive/']) {
        const response = await preview.fetch(request(path, method), env);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('演示模式');
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders sample images, the editor document and login without production data', async () => {
    const { env, fetch } = environment();
    const image = await preview.fetch(
      request(`/api/admin/files/${images[0].id}/download?preview=1`),
      env,
    );
    expect(image.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(await image.text()).toContain('示例几何构成');
    const head = await preview.fetch(request(`/i/${images[0].name}`, 'HEAD'), env);
    expect(await head.text()).toBe('');
    expect((await preview.fetch(request(`/i/${images[7].name}`), env)).status).toBe(404);
    const document = (await (
      await preview.fetch(request(`/api/admin/markdown/${files[0].id}`), env)
    ).json()) as { data: { content: string } };
    expect(document.data.content).toContain('/preview/images/0.svg');
    const login = await preview.fetch(request('/login'), env);
    expect(await login.text()).toContain('演示模式，不会提交登录信息');
    expect(login.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps the actual Vite asset base without forwarding to any production origin', async () => {
    const { env, fetch } = environment();
    const response = await preview.fetch(request('/drive/assets/example.js'), env);
    expect(response.headers.get('X-RCloud-Preview')).toBe('true');
    expect(fetch).toHaveBeenCalledOnce();
    const assetRequest = fetch.mock.calls[0] as unknown as [Request];
    expect(assetRequest[0].url).toBe('https://preview.example.test/assets/example.js');
    expect((await preview.fetch(request('/'), env)).headers.get('Location')).toBe(
      'https://preview.example.test/drive/',
    );
  });
});
