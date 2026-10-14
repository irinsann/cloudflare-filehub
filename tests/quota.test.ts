import { describe, it, expect } from 'vitest';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import { STORAGE_LIMIT, initializeQuota, storageUsage } from '../worker/quota';
import { cleanup, cleanupPurgedObjects, cleanupStatement } from '../worker/storage';
import type { FileRecord } from '../shared/types';
describe('global storage quota', () => {
  it('inventories pre-existing objects', async () => {
    await testEnv.BUCKET.put('existing', 'hello');
    const usage = await storageUsage(testEnv);
    expect(usage.storageUsedBytes).toBe(5);
    expect(usage.storageLimitBytes).toBe(STORAGE_LIMIT);
  });
  it('reserves capacity atomically across parallel uploads, and releases cancellation', async () => {
    await initializeQuota(testEnv);
    const size = 30 * 1024 ** 3;
    const results = await Promise.all(
      [1, 2].map((i) => request('/api/admin/uploads', 'POST', { name: i + '.bin', size })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 413]);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(size);
    const session = await data<{ id: string }>(results.find((r) => r.status === 201)!);
    await request('/api/admin/uploads/' + session.id, 'DELETE');
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });
  it('counts trash until actual object deletion and counts Markdown copies', async () => {
    const file = await data<FileRecord>(await upload('small.txt', '12345'));
    await request('/api/admin/files/' + file.id, 'DELETE');
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(5);
    await request('/api/admin/files/' + file.id + '/permanent', 'DELETE');
    // The durable cleanup queue also supports deferred purge routes.
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
    await cleanup(testEnv);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
    const md = await data<FileRecord>(
      await request('/api/admin/markdown', 'POST', { name: 'quota.md', content: 'hello' }),
    );
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(5);
    const published = await request('/api/admin/markdown/' + md.id + '/publish', 'POST', {
      version: md.version,
      title: 'Quota',
      slug: 'quota',
      description: '',
      allow_source: false,
      allow_index: false,
    });
    expect(published.status).toBe(200);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);
  });
  it('blocks all write paths when full without altering existing contents', async () => {
    await initializeQuota(testEnv);
    await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
      .bind('full', STORAGE_LIMIT)
      .run();
    expect((await upload('small.txt', 'a')).status).toBe(413);
    expect(
      (await request('/api/admin/markdown', 'POST', { name: 'full.md', content: 'a' })).status,
    ).toBe(413);
    expect((await request('/api/admin/uploads', 'POST', { name: 'one.bin', size: 1 })).status).toBe(
      413,
    );
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(STORAGE_LIMIT);
  });
  it('emptying trash immediately removes R2 files, attachments and published snapshots', async () => {
    const keep = await data<FileRecord>(await upload('keep.txt', 'keep'));
    const file = await data<FileRecord>(
      await request('/api/admin/markdown', 'POST', { name: 'purge.md', content: 'hello' }),
    );
    await request('/api/admin/markdown/' + file.id + '/publish', 'POST', {
      version: file.version,
      title: 'Purge',
      slug: 'purge',
      description: '',
      allow_source: false,
      allow_index: false,
    });
    // An attachment remains part of a document even if it is not in the published text.
    await testEnv.BUCKET.put('test-attachment', 'image');
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        'INSERT INTO markdown_attachments(id,file_id,object_key,mime,size,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(crypto.randomUUID(), file.id, 'test-attachment', 'image/png', 5, Date.now()),
      testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)').bind(
        'test-attachment',
        5,
      ),
    ]);
    await request('/api/admin/files/' + file.id, 'DELETE');
    const result = await data<{ files: number }>(await request('/api/admin/trash', 'DELETE'));
    expect(result.files).toBe(1);
    expect((await testEnv.BUCKET.list()).objects.map((o) => o.key)).toEqual([keep.object_key]);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(4);
    await request('/api/admin/files/' + keep.id, 'DELETE');
    await request('/api/admin/trash', 'DELETE');
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });
  it('purge cleanup preserves referenced files and active uploads, retries R2 failures without hiding quota', async () => {
    const keep = await data<FileRecord>(await upload('keep.txt', 'keep'));
    const session = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'active.bin', size: 10 }),
    );
    const pending = await testEnv.DB.prepare('SELECT object_key FROM upload_sessions WHERE id=?')
      .bind(session.id)
      .first<{ object_key: string }>();
    await cleanupStatement(testEnv, keep.object_key).run();
    await cleanupPurgedObjects(testEnv, [keep.object_key, pending!.object_key]);
    expect(await testEnv.BUCKET.head(keep.object_key)).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(14);
    await request('/api/admin/files/' + keep.id, 'DELETE');
    const failing = new Proxy(testEnv.BUCKET, {
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
      (await request('/api/admin/trash', 'DELETE', undefined, { ...testEnv, BUCKET: failing }))
        .status,
    ).toBe(200);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(14);
    expect(await testEnv.BUCKET.head(keep.object_key)).not.toBeNull();
    await cleanupPurgedObjects(testEnv, [keep.object_key]);
    expect(await testEnv.BUCKET.head(keep.object_key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);
  });
  it('reuses the existing root Markdown folder regardless of requested folder', async () => {
    const folder = await data<{ id: string }>(
      await request('/api/admin/folders', 'POST', { name: 'Markdown', parent_id: null }),
    );
    const other = await data<{ id: string }>(
      await request('/api/admin/folders', 'POST', { name: 'Other', parent_id: null }),
    );
    const file = await data<FileRecord>(
      await request('/api/admin/markdown', 'POST', {
        name: 'new.md',
        content: 'hello',
        folder_id: other.id,
      }),
    );
    expect(file.folder_id).toBe(folder.id);
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM folders WHERE name='Markdown' AND parent_id IS NULL",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
