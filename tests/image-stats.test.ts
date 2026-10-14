import { describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { recordImageAccess } from '../worker/image-stats';
import type { FileRecord } from '../shared/types';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);
interface ImageStats {
  views: number;
  downloads: number;
  last_access_at: number | null;
}
async function hosted() {
  const file = await data<FileRecord>(await upload('stats.png', png));
  return data<{ name: string; file_id: string; url: string; duplicate: boolean }>(
    await request('/api/admin/images', 'POST', { file_id: file.id }),
  );
}
async function stats(name: string) {
  return testEnv.DB.prepare('SELECT views,downloads,last_access_at FROM image_hosts WHERE name=?')
    .bind(name)
    .first<ImageStats>();
}
async function imageResponse(path: string, disposition: 'inline' | 'attachment') {
  const response = await request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Disposition')).toMatch(new RegExp(`^${disposition};`));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
}

describe('图床引用与下载统计', () => {
  it('仅成功的完整公开 GET 计引用，列表、私有预览、HEAD、206、416和失败不计数', async () => {
    const image = await hosted();
    expect(await stats(image.name)).toEqual({ views: 0, downloads: 0, last_access_at: null });
    const listing = await data<(ImageStats & { name: string })[]>(
      await request('/api/admin/images'),
    );
    expect(listing[0]).toMatchObject({
      name: image.name,
      views: 0,
      downloads: 0,
      last_access_at: null,
    });
    await imageResponse(`/api/admin/files/${image.file_id}/download?preview=1`, 'inline');
    expect(await stats(image.name)).toEqual({ views: 0, downloads: 0, last_access_at: null });

    const started = Date.now();
    const path = '/i/' + image.name;
    await imageResponse(path, 'inline');
    const accessed = await stats(image.name);
    expect(accessed).toMatchObject({ views: 1, downloads: 0 });
    expect(accessed!.last_access_at).toBeGreaterThanOrEqual(started);
    expect(accessed!.last_access_at).toBeLessThanOrEqual(Date.now());
    const head = await request(path, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const partial = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=0-7' });
    expect(partial.status).toBe(206);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(png.slice(0, 8));
    const invalid = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=9999-' });
    expect(invalid.status).toBe(416);
    expect(await invalid.text()).toBe('');
    expect((await request('/i/' + '0'.repeat(32) + '.png')).status).toBe(404);
    const file = await data<FileRecord>(await request('/api/admin/files/' + image.file_id));
    await testEnv.BUCKET.delete(file.object_key);
    expect((await request(path)).status).toBe(404);
    expect(await stats(image.name)).toEqual(accessed);
  });

  it('公开显式下载与管理员图床下载单独计数，撤销后管理员仍可下载且恢复保留统计', async () => {
    const image = await hosted();
    const publicDownload = `/i/${image.name}?download=1`;
    const adminDownload = `/api/admin/images/${image.name}/download`;
    for (const path of [publicDownload, adminDownload]) {
      await imageResponse(path, 'attachment');
      const head = await request(path, 'HEAD');
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      const partial = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=0-7' });
      expect(partial.status).toBe(206);
      expect(new Uint8Array(await partial.arrayBuffer())).toEqual(png.slice(0, 8));
    }
    expect(await stats(image.name)).toMatchObject({ views: 0, downloads: 2 });
    await request('/api/admin/images/' + image.name, 'DELETE');
    const revokedStats = await stats(image.name);
    expect((await request(publicDownload)).status).toBe(404);
    expect(await stats(image.name)).toEqual(revokedStats);
    await imageResponse(adminDownload, 'attachment');
    const afterDownload = await stats(image.name);
    expect(afterDownload).toMatchObject({ views: 0, downloads: 3 });
    const listing = await data<(ImageStats & { enabled: number })[]>(
      await request('/api/admin/images'),
    );
    expect(listing[0]).toMatchObject({ ...afterDownload, enabled: 0 });
    await imageResponse(`/api/admin/files/${image.file_id}/download?preview=1`, 'inline');
    expect(await stats(image.name)).toEqual(afterDownload);
    expect((await request(`/api/admin/images/${image.name}/restore`, 'POST')).status).toBe(200);
    expect(await stats(image.name)).toEqual(afterDownload);
    await imageResponse('/i/' + image.name, 'inline');
    expect(await stats(image.name)).toMatchObject({ views: 1, downloads: 3 });
  });

  it('重复上传复用统计，同名替换后旧对象的在途响应不会污染新对象计数', async () => {
    const first = await hosted();
    await imageResponse('/i/' + first.name, 'inline');
    await imageResponse(`/i/${first.name}?download=1`, 'attachment');
    const before = await stats(first.name);
    const original = await data<FileRecord>(await request('/api/admin/files/' + first.file_id));
    await request('/api/admin/images/' + first.name, 'DELETE');
    const duplicate = await hosted();
    expect(duplicate).toMatchObject({ name: first.name, file_id: first.file_id, duplicate: true });
    expect(await stats(first.name)).toEqual(before);

    await request('/api/admin/files/' + first.file_id, 'DELETE');
    const replacement = await hosted();
    expect(replacement.name).toBe(first.name);
    expect(replacement.file_id).not.toBe(first.file_id);
    expect(await stats(first.name)).toEqual(before);
    await recordImageAccess(
      testEnv,
      first.name,
      'reference',
      new Request('http://localhost/i/' + first.name),
      new Response(png),
      original.object_key,
    );
    expect(await stats(first.name)).toEqual(before);
    await imageResponse('/i/' + replacement.name, 'inline');
    expect(await stats(first.name)).toMatchObject({ views: 2, downloads: 1 });
  });

  it('不累计对象键已不一致或已进入回收站的失败响应', async () => {
    const image = await hosted();
    const file = await data<FileRecord>(await request('/api/admin/files/' + image.file_id));
    await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
      .bind('changed-object', file.id)
      .run();
    expect((await request('/i/' + image.name)).status).toBe(410);
    expect((await request(`/api/admin/images/${image.name}/download`)).status).toBe(410);
    await recordImageAccess(
      testEnv,
      image.name,
      'download',
      new Request('http://localhost/i/' + image.name),
      new Response(png),
      file.object_key,
    );
    expect(await stats(image.name)).toEqual({ views: 0, downloads: 0, last_access_at: null });
    await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
      .bind(file.object_key, file.id)
      .run();
    await request('/api/admin/files/' + file.id, 'DELETE');
    expect((await request(`/api/admin/images/${image.name}/download`)).status).toBe(404);
    expect(await stats(image.name)).toEqual({ views: 0, downloads: 0, last_access_at: null });
  });

  it('配置的 s.irin.im 公开域名正常累计，未经认证的管理下载不计数', async () => {
    const image = await hosted();
    const env = {
      ...testEnv,
      ADMIN_ORIGIN: 'http://localhost',
      FILES_ORIGIN: 'https://s.irin.im',
      TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
    };
    const listing = await data<{ url: string }[]>(
      await request('/api/admin/images', 'GET', undefined, env),
    );
    expect(listing[0].url).toBe('https://s.irin.im/i/' + image.name);
    const reference = await app.request(listing[0].url, {}, env);
    expect(reference.status).toBe(200);
    expect(new Uint8Array(await reference.arrayBuffer())).toEqual(png);
    const download = await app.request(listing[0].url + '?download=1', {}, env);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
    const before = await stats(image.name);
    expect(before).toMatchObject({ views: 1, downloads: 1 });
    expect(
      (await app.request(`https://s.irin.im/api/admin/images/${image.name}/download`, {}, env))
        .status,
    ).toBe(401);
    expect((await app.request(`https://unknown.test/i/${image.name}`, {}, env)).status).toBe(404);
    expect(await stats(image.name)).toEqual(before);
  });

  it('并发引用与下载原子累加，不相互覆盖', async () => {
    const image = await hosted();
    await Promise.all([
      ...Array.from({ length: 5 }, () => imageResponse('/i/' + image.name, 'inline')),
      ...Array.from({ length: 3 }, () =>
        imageResponse(`/i/${image.name}?download=1`, 'attachment'),
      ),
    ]);
    expect(await stats(image.name)).toMatchObject({ views: 5, downloads: 3 });
  });

  it('统计写入失败仍返回图片，只记录不含请求和异常内容的诊断信息', async () => {
    const image = await hosted();
    const failingDB = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            if (/^UPDATE image_hosts SET (views|downloads)=/.test(query)) {
              throw new Error('Simulated database failure with sensitive diagnostic details');
            }
            return target.prepare(query);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [path, kind] of [
        ['/i/' + image.name, 'reference'],
        [`/i/${image.name}?download=1`, 'download'],
        [`/api/admin/images/${image.name}/download`, 'download'],
      ]) {
        const response = await request(path, 'GET', undefined, { ...testEnv, DB: failingDB });
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
        expect(diagnostic).toHaveBeenLastCalledWith({
          event: 'image.stats_failed',
          kind,
          errorType: 'Error',
        });
      }
      expect(diagnostic).toHaveBeenCalledTimes(3);
      expect(await stats(image.name)).toEqual({ views: 0, downloads: 0, last_access_at: null });
    } finally {
      diagnostic.mockRestore();
    }
  });
});
