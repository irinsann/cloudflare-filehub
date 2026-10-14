import { describe, it, expect } from 'vitest';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import { STORAGE_LIMIT, initializeQuota, storageUsage } from '../worker/quota';
import { cleanup, cleanupPurgedObjects, cleanupStatement } from '../worker/storage';
import type { FileRecord } from '../shared/types';
import { app } from '../worker/index';

function bucketWith(method: keyof R2Bucket, replacement: unknown) {
  return new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === method) return replacement;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function singleUpload(name: string, body: string, bucket: R2Bucket) {
  return app.request(
    `http://localhost/api/admin/files/upload?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        'X-File-Size': String(body.length),
      },
      body,
    },
    { ...testEnv, BUCKET: bucket },
  );
}
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
  it('scheduled cleanup preserves trash, deleting files, all public references and active uploads', async () => {
    const ready = await data<FileRecord>(await upload('ready.txt', 'ready'));
    const trash = await data<FileRecord>(await upload('trash.txt', 'trash'));
    const deleting = await data<FileRecord>(await upload('deleting.txt', 'deleting'));
    const parent = await data<FileRecord>(await upload('parent.txt', 'parent'));
    await request('/api/admin/files/' + trash.id, 'DELETE');
    await testEnv.DB.prepare("UPDATE files SET status='deleting' WHERE id=?")
      .bind(deleting.id)
      .run();
    // A leftover pending flag must not cascade-delete committed child references.
    await testEnv.DB.prepare(
      "UPDATE files SET status='pending',created_at=0,updated_at=0 WHERE id=?",
    )
      .bind(parent.id)
      .run();
    const referenced = ['snapshot-retained', 'attachment-retained', 'image-host-retained'];
    for (const key of referenced) {
      await testEnv.BUCKET.put(key, 'content');
      await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,7)')
        .bind(key)
        .run();
    }
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO markdown_pages(id,file_id,title,slug,published,updated_at,snapshot_key)
        VALUES(?,?,?,?,0,0,?)`,
      ).bind(crypto.randomUUID(), parent.id, 'Snapshot', 'retained', referenced[0]),
      testEnv.DB.prepare(
        `INSERT INTO markdown_attachments(id,file_id,object_key,mime,size,created_at)
        VALUES(?,?,?,'image/png',7,0)`,
      ).bind(crypto.randomUUID(), parent.id, referenced[1]),
      testEnv.DB.prepare(
        `INSERT INTO image_hosts(name,file_id,object_key,sha256,enabled,created_at)
        VALUES(?,?,?,'test',0,0)`,
      ).bind('a'.repeat(32) + '.png', parent.id, referenced[2]),
    ]);
    const session = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'active.bin', size: 10 }),
    );
    const active = await testEnv.DB.prepare('SELECT object_key FROM upload_sessions WHERE id=?')
      .bind(session.id)
      .first<{ object_key: string }>();
    const keys = [
      ready.object_key,
      trash.object_key,
      deleting.object_key,
      parent.object_key,
      ...referenced,
    ];
    for (const key of keys) await cleanupStatement(testEnv, key).run();
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
    const before = (await storageUsage(testEnv)).storageUsedBytes;
    await cleanup(testEnv);
    for (const key of keys) expect(await testEnv.BUCKET.head(key)).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(active!.object_key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(before);
  });
  it('does not reap a slow single-request upload while its R2 response is still pending', async () => {
    let release!: () => void, written!: () => void;
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored = new Promise<void>((resolve) => {
      written = resolve;
    });
    const delayed = bucketWith('put', async (...args: Parameters<R2Bucket['put']>) => {
      const result = await testEnv.BUCKET.put(...args);
      written();
      await finish;
      return result;
    });
    const uploading = singleUpload('slow.txt', 'slow payload', delayed);
    let response: Response | undefined;
    let pending: { id: string; object_key: string } | null = null;
    try {
      await stored;
      pending = await testEnv.DB.prepare(
        "SELECT id,object_key FROM files WHERE name='slow.txt'",
      ).first<{ id: string; object_key: string }>();
      expect(pending).not.toBeNull();
      await testEnv.DB.batch([
        testEnv.DB.prepare('UPDATE files SET created_at=0,updated_at=0 WHERE id=?').bind(
          pending!.id,
        ),
        testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0 WHERE object_key=?').bind(
          pending!.object_key,
        ),
      ]);
      await cleanup(testEnv);
      expect(await testEnv.BUCKET.head(pending!.object_key)).not.toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
          .bind(pending!.id)
          .first<string>('status'),
      ).toBe('pending');
      expect(
        await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
          .bind(pending!.object_key)
          .first(),
      ).not.toBeNull();
    } finally {
      release();
      response = await uploading;
    }
    expect(response.status).toBe(201);
    await cleanup(testEnv);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(pending!.id)
        .first<string>('status'),
    ).toBe('ready');
    expect(await (await testEnv.BUCKET.get(pending!.object_key))?.text()).toBe('slow payload');
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(12);
  });
  it.each([false, true])(
    'cleans known failed uploads but preserves committed files (committed=%s)',
    async (committed) => {
      const failing = bucketWith('put', async (...args: Parameters<R2Bucket['put']>) => {
        await testEnv.BUCKET.put(...args);
        if (committed)
          await testEnv.DB.prepare("UPDATE files SET status='ready',size=6 WHERE object_key=?")
            .bind(args[0])
            .run();
        throw new Error('Response interrupted after object storage');
      });
      const response = await singleUpload('failed.txt', 'failed', failing);
      expect(response.status).toBe(400);
      const file = await testEnv.DB.prepare(
        "SELECT status FROM files WHERE name='failed.txt'",
      ).first<{ status: string }>();
      expect(file?.status ?? null).toBe(committed ? 'ready' : null);
      const task = await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks').first<{
        object_key: string;
      }>();
      expect(task).not.toBeNull();
      expect(await testEnv.BUCKET.head(task!.object_key)).not.toBeNull();
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(6);
      await cleanup(testEnv);
      expect(await testEnv.BUCKET.head(task!.object_key)).not.toBeNull();
      await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
      await cleanup(testEnv);
      expect((await testEnv.BUCKET.head(task!.object_key)) !== null).toBe(committed);
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(committed ? 6 : 0);
    },
  );
  it('retains expired multipart metadata and reserved quota when R2 abort fails, then retries safely', async () => {
    const session = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'expired.bin', size: 10 }),
    );
    const pending = await testEnv.DB.prepare(
      'SELECT file_id,object_key FROM upload_sessions WHERE id=?',
    )
      .bind(session.id)
      .first<{ file_id: string; object_key: string }>();
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE upload_sessions SET expires_at=0 WHERE id=?').bind(session.id),
      testEnv.DB.prepare('UPDATE files SET created_at=0,updated_at=0 WHERE id=?').bind(
        pending!.file_id,
      ),
      testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0'),
    ]);
    const failing = bucketWith('resumeMultipartUpload', () => ({
      abort: async () => {
        throw new Error('R2 temporarily unavailable (10001)');
      },
    }));
    await cleanup({ ...testEnv, BUCKET: failing });
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(pending!.file_id).first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT attempts FROM cleanup_tasks WHERE object_key=?')
        .bind(pending!.object_key)
        .first<number>('attempts'),
    ).toBe(1);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);
    await cleanup(testEnv);
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(pending!.file_id).first(),
    ).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });
  it('releases expired multipart reservations only on confirmed absence and allows an expiry grace period', async () => {
    const recent = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'just-expired.bin', size: 11 }),
    );
    const expired = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'already-aborted.bin', size: 13 }),
    );
    const old = await testEnv.DB.prepare(
      'SELECT file_id,object_key,upload_id FROM upload_sessions WHERE id=?',
    )
      .bind(expired.id)
      .first<{ file_id: string; object_key: string; upload_id: string }>();
    await testEnv.BUCKET.resumeMultipartUpload(old!.object_key, old!.upload_id).abort();
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').bind(
        Date.now() - 1000,
        recent.id,
      ),
      testEnv.DB.prepare('UPDATE upload_sessions SET expires_at=0 WHERE id=?').bind(expired.id),
      testEnv.DB.prepare('UPDATE files SET created_at=0,updated_at=0 WHERE id=?').bind(
        old!.file_id,
      ),
      testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0'),
    ]);
    const absent = bucketWith('resumeMultipartUpload', (objectKey: string) => {
      expect(objectKey).toBe(old!.object_key);
      return {
        abort: async () => {
          throw new Error('The specified multipart upload does not exist. (10024)');
        },
      };
    });
    await cleanup({ ...testEnv, BUCKET: absent });
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(expired.id)
        .first(),
    ).toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?').bind(recent.id).first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(11);
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
