import { describe, it, expect } from 'vitest';
import { request, data, upload } from './helpers';
import type { FileRecord, Listing, FolderRecord } from '../shared/types';
import { testEnv } from './setup';
import { parseRange, disposition, cleanup, reserve } from '../worker/storage';
describe('真实 D1 / R2 文件流程', () => {
  it('创建目录、流式上传、查询、重命名、移动、下载、删除和恢复', async () => {
    const folder = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: '资料' }),
    );
    const file = await data<FileRecord>(await upload('中文 空格.txt', 'Hello world', folder.id));
    expect(file.size).toBe(11);
    expect(file.object_key).toMatch(/^objects\//);
    const listing = await data<Listing>(await request(`/api/admin/files?folder_id=${folder.id}`));
    expect(listing.files[0].id).toBe(file.id);
    expect(
      (
        await request(`/api/admin/files/${file.id}`, 'PATCH', {
          name: '新名字.txt',
          folder_id: null,
        })
      ).status,
    ).toBe(200);
    const download = await request(`/api/admin/files/${file.id}/download`);
    expect(await download.text()).toBe('Hello world');
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect((await request(`/api/admin/files/${file.id}`, 'DELETE')).status).toBe(200);
    expect((await request(`/api/admin/files/${file.id}/download`)).status).toBe(404);
    expect((await data<Listing>(await request('/api/admin/files?view=trash'))).files).toHaveLength(
      1,
    );
    expect((await request(`/api/admin/files/${file.id}/restore`, 'POST')).status).toBe(200);
    expect((await request(`/api/admin/files/${file.id}/download`)).status).toBe(200);
  });
  it('防止文件夹循环、重名及非空删除；空目录软删除与恢复', async () => {
    const a = await data<FolderRecord>(await request('/api/admin/folders', 'POST', { name: 'A' }));
    const b = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'B', parent_id: a.id }),
    );
    expect((await request(`/api/admin/folders/${a.id}`, 'PATCH', { parent_id: b.id })).status).toBe(
      409,
    );
    expect((await request(`/api/admin/folders/${a.id}`, 'PATCH', { parent_id: a.id })).status).toBe(
      409,
    );
    expect((await request('/api/admin/folders', 'POST', { name: 'A' })).status).toBe(409);
    expect((await request(`/api/admin/folders/${a.id}`, 'DELETE')).status).toBe(409);
    expect(
      (await request(`/api/admin/folders/${b.id}`, 'PATCH', { name: '新目录', parent_id: null }))
        .status,
    ).toBe(200);
    expect((await request(`/api/admin/folders/${a.id}`, 'DELETE')).status).toBe(200);
    expect((await request(`/api/admin/folders/${a.id}/restore`, 'POST')).status).toBe(200);
  });
  it('永久删除移除对象，失败任务可重试，清理不删除仍被引用的对象', async () => {
    const file = await data<FileRecord>(await upload('a.txt', 'private'));
    expect((await request(`/api/admin/files/${file.id}/permanent`, 'DELETE')).status).toBe(409);
    await request(`/api/admin/files/${file.id}`, 'DELETE');
    await request(`/api/admin/files/${file.id}/permanent`, 'DELETE');
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
    const abandoned = await reserve(testEnv);
    await testEnv.BUCKET.put(abandoned, 'orphan');
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0 WHERE object_key=?')
      .bind(abandoned)
      .run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(abandoned)).toBeNull();
    const active = await data<FileRecord>(await upload('active.txt', 'keep'));
    await testEnv.DB.prepare('INSERT INTO cleanup_tasks(object_key,created_at) VALUES(?,0)')
      .bind(active.object_key)
      .run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(active.object_key)).not.toBeNull();
  });
  it('验证大小限制、路径、真实 MIME 和分页搜索', async () => {
    expect((await upload('../bad.txt', 'x')).status).toBe(400);
    const fake = await data<FileRecord>(await upload('malicious.png', '<script>alert(1)</script>'));
    expect(fake.mime).toBe('application/octet-stream');
    const response = await request(`/api/admin/files/${fake.id}/download?preview=1`);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
    await response.arrayBuffer();
    const result = await data<Listing>(await request('/api/admin/files?search=malicious&limit=1'));
    expect(result.total).toBe(1);
    expect(result.files).toHaveLength(1);
    const oversized = await import('../worker/index').then(({ app }) =>
      app.request(
        'http://localhost/api/admin/files/upload?name=big.txt',
        {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            'X-Drive-Request': '1',
            'X-File-Size': '999999999',
          },
          body: 'x',
        },
        testEnv,
      ),
    );
    expect(oversized.status).toBe(413);
  });
  it('正确响应字节 Range、HEAD 和不可满足的区间', async () => {
    const file = await data<FileRecord>(await upload('a.txt', 'abcdefghij'));
    const response = await request(
      `/api/admin/files/${file.id}/download`,
      'GET',
      undefined,
      testEnv,
      { Range: 'bytes=2-5' },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('cdef');
    const suffix = await request(
      `/api/admin/files/${file.id}/download`,
      'GET',
      undefined,
      testEnv,
      { Range: 'bytes=-3' },
    );
    expect(await suffix.text()).toBe('hij');
    expect(
      (
        await request(`/api/admin/files/${file.id}/download`, 'GET', undefined, testEnv, {
          Range: 'bytes=20-',
        })
      ).status,
    ).toBe(416);
    const head = await request(`/api/admin/files/${file.id}/download`, 'HEAD');
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(await head.text()).toBe('');
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(disposition('你好.txt', false)).toContain('%E4%BD%A0');
  });
  it('R2 删除故障保留持久清理任务，后续可恢复', async () => {
    const file = await data<FileRecord>(await upload('retry.txt', 'retry me'));
    await request(`/api/admin/files/${file.id}`, 'DELETE');
    const failingBucket = new Proxy(testEnv.BUCKET, {
      get(target, key) {
        if (key === 'delete')
          return async () => {
            throw new Error('temporary failure');
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(
      (
        await request(`/api/admin/files/${file.id}/permanent`, 'DELETE', undefined, {
          ...testEnv,
          BUCKET: failingBucket,
        })
      ).status,
    ).toBe(200);
    expect((await request(`/api/admin/files/${file.id}/download`)).status).toBe(404);
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(file.object_key)
        .first(),
    ).not.toBeNull();
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0 WHERE object_key=?')
      .bind(file.object_key)
      .run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
  });
  it('数据库触发器阻断竞争更新造成的循环和非空目录删除', async () => {
    const a = await data<FolderRecord>(await request('/api/admin/folders', 'POST', { name: 'A' })),
      b = await data<FolderRecord>(await request('/api/admin/folders', 'POST', { name: 'B' }));
    await testEnv.DB.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(b.id, a.id).run();
    await expect(
      testEnv.DB.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(a.id, b.id).run(),
    ).rejects.toThrow(/folder cycle/);
    await expect(
      testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(b.id).run(),
    ).rejects.toThrow(/folder not empty/);
  });
  it('声明大小与实际流不匹配时拒绝发布文件，并清理 pending 元数据', async () => {
    const { app } = await import('../worker/index');
    const response = await app.request(
      'http://localhost/api/admin/files/upload?name=mismatch.txt',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': '4' },
        body: 'too long',
      },
      testEnv,
    );
    expect(response.status).toBe(400);
    expect((await data<Listing>(await request('/api/admin/files'))).files).toHaveLength(0);
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
    await cleanup(testEnv);
    expect(
      (await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM files').first<{ count: number }>())
        ?.count,
    ).toBe(0);
  });
});
