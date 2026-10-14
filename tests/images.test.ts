import { describe, it, expect } from 'vitest';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
async function hosted() {
  const file = await data<FileRecord>(await upload('original.png', png));
  const result = await data<{ name: string; file_id: string; url: string; duplicate: boolean }>(
    await request('/api/admin/images', 'POST', { file_id: file.id }),
  );
  return { file, result };
}
describe('Image-hosting 图床', () => {
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
});
