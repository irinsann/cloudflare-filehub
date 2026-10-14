import { describe, it, expect } from 'vitest';
import { request, data, upload, createMarkdown } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';
import { digest } from '../worker/auth-crypto';
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
async function hosted(env = testEnv) {
  const file = await data<FileRecord>(await upload('original.png', png));
  const result = await data<{ name: string; file_id: string; url: string; duplicate: boolean }>(
    await request('/api/admin/images', 'POST', { file_id: file.id }, env),
  );
  return { file, result };
}
describe('Image-hosting 图床', () => {
  it('paginates every image exactly once when more than two pages share a creation timestamp', async () => {
    const createdAt = Date.now();
    const sameTimeNames = Array.from(
      { length: 81 },
      (_, index) => (index + 1).toString(16).padStart(32, '0') + '.png',
    );
    const newest = 'f'.repeat(32) + '.png';
    const oldest = '0'.repeat(32) + '.png';
    const rows = [
      { name: oldest, time: createdAt - 1 },
      ...[...sameTimeNames].reverse().map((name) => ({ name, time: createdAt })),
      { name: newest, time: createdAt + 1 },
    ];
    await testEnv.DB.batch(
      rows.flatMap(({ name, time }) => {
        const id = crypto.randomUUID();
        const key = 'Image-hosting/pagination/' + name;
        return [
          testEnv.DB.prepare(
            "INSERT INTO files(id,name,object_key,mime,size,status,created_at,updated_at) VALUES(?,?,?,'image/png',1,'ready',?,?)",
          ).bind(id, name, key, time, time),
          testEnv.DB.prepare(
            'INSERT INTO image_hosts(name,file_id,object_key,sha256,created_at) VALUES(?,?,?,?,?)',
          ).bind(name, id, key, 'metadata-only-pagination-fixture', time),
        ];
      }),
    );
    const pages = [];
    for (let page = 1; page <= 4; page++)
      pages.push(await data<{ name: string }[]>(await request('/api/admin/images?page=' + page)));
    expect(pages.map((page) => page.length)).toEqual([40, 40, 3, 0]);
    const names = pages.flat().map((image) => image.name);
    expect(names).toEqual([newest, ...sameTimeNames, oldest]);
    expect(new Set(names).size).toBe(rows.length);
  });
  it('keeps authenticated private previews available after the admin budget is exhausted without counting public access', async () => {
    const { result } = await hosted();
    const bucket = Math.floor(Date.now() / 60000);
    const identity = await digest('local@localhost');
    await testEnv.DB.batch(
      [bucket, bucket + 1].map((value) =>
        testEnv.DB.prepare(
          'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,240,?) ON CONFLICT(key) DO UPDATE SET count=240',
        ).bind(`admin:${identity}:${value}`, (value + 1) * 60000),
      ),
    );
    const path = `/api/admin/files/${result.file_id}/download?preview=1`;
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, method);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toEqual(method === 'GET' ? png : new Uint8Array());
    }
    expect(
      await testEnv.DB.prepare(
        'SELECT views,downloads,last_access_at FROM image_hosts WHERE name=?',
      )
        .bind(result.name)
        .first(),
    ).toEqual({ views: 0, downloads: 0, last_access_at: null });
    expect(
      (await request(path, 'GET', undefined, { ...testEnv, LOCAL_AUTH: 'false' })).status,
    ).toBe(401);
    expect((await request('/api/admin/settings')).status).toBe(429);
    expect(
      (await request(`/api/admin/files/${crypto.randomUUID()}/download?preview=1`)).status,
    ).toBe(404);
    for (const [limitedPath, method] of [
      ['/api/admin/settings?preview=1', 'GET'],
      [`/api/admin/images/${result.name}/download?preview=1`, 'GET'],
      [`/api/admin/files/${result.file_id}/download`, 'GET'],
      [`/api/admin/files/${result.file_id}/download?preview=0`, 'GET'],
      [`/api/admin/files/${result.file_id}/download?preview=1&preview=1`, 'GET'],
      [`/api/admin/files/${result.file_id}/download?preview=1&other=1`, 'GET'],
      ['/api/admin/files/not-a-uuid/download?preview=1', 'GET'],
      [path, 'POST'],
      [path, 'DELETE'],
    ])
      expect((await request(limitedPath, method)).status).toBe(429);
  });
  it('uses the configured public origin for images, shares and direct links', async () => {
    const publicEnv = { ...testEnv, FILES_ORIGIN: 'https://s.irin.im' };
    const file = await data<FileRecord>(await upload('origin.png', png));
    const image = await data<{ name: string; url: string }>(
      await request('/api/admin/images', 'POST', { file_id: file.id }, publicEnv),
    );
    expect(image.url).toBe('https://s.irin.im/i/' + image.name);
    const duplicate = await data<{ url: string }>(
      await request('/api/admin/images', 'POST', { file_id: file.id }, publicEnv),
    );
    expect(duplicate.url).toBe(image.url);
    const listing = await data<{ url: string }[]>(
      await request('/api/admin/images', 'GET', undefined, publicEnv),
    );
    expect(listing[0].url).toBe(image.url);
    const share = await data<{ url: string; directUrl: string }>(
      await request('/api/admin/shares', 'POST', { file_id: file.id }, publicEnv),
    );
    expect(share.url).toMatch(/^https:\/\/s\.irin\.im\/s\//);
    expect(share.directUrl).toMatch(/^https:\/\/s\.irin\.im\/d\//);
  });
  it('uses actual content MD5, stores in Image-hosting and returns inline image direct links', async () => {
    const { file, result } = await hosted();
    expect(result.name).toBe('39dd1aed58e76c360216335fda25d0cf.png');
    const f = await data<FileRecord>(await request('/api/admin/files/' + file.id));
    expect(f.name).toBe(result.name);
    expect(f.object_key).toMatch(/^Image-hosting\//);
    const folder = await testEnv.DB.prepare('SELECT name FROM folders WHERE id=?')
      .bind(f.folder_id)
      .first<{ name: string }>();
    expect(folder?.name).toBe('Image-hosting');
    const r = await request('/i/' + result.name);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-disposition')).toMatch(/^inline/);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(png);
  });
  it('reuses duplicate image URLs, supports range, revokes immediately and honors trash', async () => {
    const first = await hosted(),
      second = await hosted();
    expect(second.result.duplicate).toBe(true);
    expect(second.result.file_id).toBe(first.result.file_id);
    expect(second.result.url).toBe(first.result.url);
    const path = '/i/' + first.result.name;
    const r = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=0-7' });
    expect(r.status).toBe(206);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(png.slice(0, 8));
    await request('/api/admin/images/' + first.result.name, 'DELETE');
    expect((await request(path)).status).toBe(404);
    await hosted();
    expect((await request(path, 'HEAD')).status).toBe(200);
    await request('/api/admin/files/' + first.file.id, 'DELETE');
    expect((await request(path)).status).toBe(404);
  });
  it('rejects disguised non-images and modified image objects', async () => {
    const bad = await data<FileRecord>(await upload('fake.png', '<script>alert(1)</script>'));
    expect((await request('/api/admin/images', 'POST', { file_id: bad.id })).status).toBe(415);
    const { file, result } = await hosted();
    await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
      .bind('changed-key', file.id)
      .run();
    expect((await request('/i/' + result.name)).status).toBe(410);
  });
  it('keeps hosted images public when an article using the direct URL is unpublished', async () => {
    const { result } = await hosted({ ...testEnv, FILES_ORIGIN: 'https://s.irin.im' });
    const document = await createMarkdown(`![Image](<${result.url}>)`);
    expect(
      (
        await request(`/api/admin/markdown/${document.id}/publish`, 'POST', {
          title: 'Hosted image',
          slug: 'hosted-image',
          version: document.version,
        })
      ).status,
    ).toBe(200);
    expect(await (await request('/p/hosted-image')).text()).toContain(result.url);
    expect((await request(`/api/admin/markdown/${document.id}/unpublish`, 'POST')).status).toBe(
      200,
    );
    expect((await request('/p/hosted-image')).status).toBe(404);
    const response = await request('/i/' + result.name);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM markdown_attachments WHERE file_id=?')
        .bind(document.id)
        .first<number>('n'),
    ).toBe(0);
  });
});
