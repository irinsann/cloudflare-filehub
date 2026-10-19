import { describe, expect, it } from 'vitest';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';
import { cleanup } from '../worker/storage';
import { storageUsage } from '../worker/quota';
import type { FileRecord } from '../shared/types';

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

async function hosted() {
  const uploaded = await data<FileRecord>(await upload('original.png', png));
  const image = await data<{ name: string; file_id: string; url: string }>(
    await request('/api/admin/images', 'POST', { file_id: uploaded.id }),
  );
  const file = await data<FileRecord>(await request('/api/admin/files/' + image.file_id));
  return { image, file };
}
async function cleanQueue() {
  await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
  await cleanup(testEnv);
}
function bucketWith(method: keyof R2Bucket, replacement: unknown) {
  return new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === method) return replacement;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function beforeBatch(callback: () => Promise<void>) {
  let intercepted = false;
  return new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await callback();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function putExtra(key: string, content: string) {
  await testEnv.BUCKET.put(key, content);
  await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
    .bind(key, content.length)
    .run();
}

describe('图床撤销、恢复与永久删除', () => {
  it.each([false, true])(
    'tracks a late image copy after cron reclaimed its expired writer (lost response: %s)',
    async (lostResponse) => {
      const source = await data<FileRecord>(await upload('late-image.png', png));
      let entered!: () => void, resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const bucket = bucketWith('put', async (...args: Parameters<R2Bucket['put']>) => {
        entered();
        await blocked;
        const result = await testEnv.BUCKET.put(...args);
        if (lostResponse) throw new Error('Simulated lost copy response');
        return result;
      });
      const publishing = request(
        '/api/admin/images',
        'POST',
        { file_id: source.id },
        {
          ...testEnv,
          BUCKET: bucket,
        },
      );
      await started;
      try {
        await testEnv.DB.batch([
          testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0'),
          testEnv.DB.prepare('UPDATE storage_web_writes SET expires_at=0'),
        ]);
        await cleanup(testEnv);
      } finally {
        resume();
      }
      expect((await publishing).status).toBe(lostResponse ? 500 : 423);
      const copy = (await testEnv.BUCKET.list()).objects.find((object) =>
        object.key.startsWith('Image-hosting/'),
      );
      expect(copy).toBeDefined();
      expect(
        await testEnv.DB.prepare(
          `SELECT a.size FROM cleanup_tasks c JOIN storage_allocations a
      ON a.object_key=c.object_key WHERE c.object_key=?`,
        )
          .bind(copy!.key)
          .first<number>('size'),
      ).toBe(png.length);
      expect((await request('/api/admin/files/' + source.id)).status).toBe(200);
      await cleanQueue();
      expect(await testEnv.BUCKET.head(copy!.key)).toBeNull();
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(source.size);
    },
  );

  it('rejects a delayed duplicate publication from a source uploaded before revocation', async () => {
    const { image } = await hosted();
    const olderSource = await data<FileRecord>(await upload('delayed.png', png));
    await testEnv.DB.prepare('UPDATE files SET created_at=0 WHERE id=?').bind(olderSource.id).run();
    await request('/api/admin/images/' + image.name, 'DELETE');
    expect((await request('/api/admin/images', 'POST', { file_id: olderSource.id })).status).toBe(
      409,
    );
    expect((await request('/i/' + image.name)).status).toBe(404);
    expect((await request('/api/admin/files/' + olderSource.id)).status).toBe(200);
  });

  it('does not undo a revocation that races a duplicate publication object check', async () => {
    const { image, file } = await hosted();
    let revoked = false;
    const bucket = bucketWith('head', async (key: string) => {
      const head = await testEnv.BUCKET.head(key);
      if (!revoked && key === file.object_key) {
        revoked = true;
        expect((await request('/api/admin/images/' + image.name, 'DELETE')).status).toBe(200);
      }
      return head;
    });
    expect(
      (
        await request(
          '/api/admin/images',
          'POST',
          { file_id: file.id },
          {
            ...testEnv,
            BUCKET: bucket,
          },
        )
      ).status,
    ).toBe(409);
    expect(revoked).toBe(true);
    expect((await request('/i/' + image.name)).status).toBe(404);
  });

  it('does not replace a missing image object after a newer revocation', async () => {
    const { image, file } = await hosted();
    const source = await data<FileRecord>(await upload('replacement.png', png));
    await testEnv.DB.prepare('UPDATE files SET created_at=0 WHERE id=?').bind(source.id).run();
    await testEnv.BUCKET.delete(file.object_key);
    const db = beforeBatch(async () => {
      expect((await request('/api/admin/images/' + image.name, 'DELETE')).status).toBe(200);
    });
    expect(
      (
        await request(
          '/api/admin/images',
          'POST',
          { file_id: source.id },
          {
            ...testEnv,
            DB: db,
          },
        )
      ).status,
    ).toBe(409);
    expect((await request('/i/' + image.name)).status).toBe(404);
    const saved = await data<FileRecord>(await request('/api/admin/files/' + source.id));
    expect(saved.object_key).toBe(source.object_key);
  });

  it('records ordinary file revocation so an old publish cannot enable it after trash restore', async () => {
    const { image, file } = await hosted();
    await request('/api/admin/files/' + file.id, 'DELETE');
    await request('/api/admin/files/' + file.id + '/restore', 'POST');
    expect((await request('/api/admin/images', 'POST', { file_id: file.id })).status).toBe(409);
    expect((await request('/i/' + image.name)).status).toBe(404);
    expect(
      await testEnv.DB.prepare('SELECT revoked_at FROM image_hosts WHERE name=?')
        .bind(image.name)
        .first<number>('revoked_at'),
    ).toBeGreaterThan(0);
  });

  it('restores the original URL without creating another object or allocation', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    const usage = await storageUsage(testEnv);
    await request('/api/admin/images/' + image.name, 'DELETE');
    expect((await request('/i/' + image.name)).status).toBe(404);
    const restored = await data<{ name: string; file_id: string; url: string; enabled: number }>(
      await request('/api/admin/images/' + image.name + '/restore', 'POST'),
    );
    expect(restored).toEqual({
      name: image.name,
      file_id: image.file_id,
      url: image.url,
      enabled: 1,
    });
    expect((await request('/i/' + image.name)).status).toBe(200);
    expect((await testEnv.BUCKET.list()).objects.map((object) => object.key)).toEqual([
      file.object_key,
    ]);
    expect(await storageUsage(testEnv)).toEqual(usage);
    expect((await request('/api/admin/images/' + image.name + '/restore', 'POST')).status).toBe(
      200,
    );
  });

  it('restoring a trashed file keeps its image URL revoked until explicitly restored', async () => {
    const { image, file } = await hosted();
    await request('/api/admin/files/' + file.id, 'DELETE');
    expect((await request('/api/admin/images/' + image.name + '/restore', 'POST')).status).toBe(
      404,
    );
    expect(
      await testEnv.DB.prepare('SELECT enabled FROM image_hosts WHERE name=?')
        .bind(image.name)
        .first<number>('enabled'),
    ).toBe(0);
    await request('/api/admin/files/' + file.id + '/restore', 'POST');
    expect((await request('/i/' + image.name)).status).toBe(404);
    expect((await request('/api/admin/images/' + image.name + '/restore', 'POST')).status).toBe(
      200,
    );
    expect((await request('/i/' + image.name)).status).toBe(200);
  });

  it.each(['missing-object', 'changed-key', 'pending-file'])(
    'rejects restoration of %s without re-enabling the URL',
    async (state) => {
      const { image, file } = await hosted();
      await request('/api/admin/images/' + image.name, 'DELETE');
      if (state === 'missing-object') await testEnv.BUCKET.delete(file.object_key);
      if (state === 'changed-key')
        await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
          .bind('changed', file.id)
          .run();
      if (state === 'pending-file')
        await testEnv.DB.prepare("UPDATE files SET status='pending' WHERE id=?")
          .bind(file.id)
          .run();
      const response = await request('/api/admin/images/' + image.name + '/restore', 'POST');
      expect(response.status).toBe(state === 'changed-key' ? 409 : 404);
      expect(
        await testEnv.DB.prepare('SELECT enabled FROM image_hosts WHERE name=?')
          .bind(image.name)
          .first<number>('enabled'),
      ).toBe(0);
    },
  );

  it('purges current and historical image keys, attachments, snapshots, shares and quota atomically', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    expect((await request('/api/admin/images/' + image.name + '/permanent', 'DELETE')).status).toBe(
      409,
    );
    const share = await data<{ url: string }>(
      await request('/api/admin/shares', 'POST', { file_id: file.id }),
    );
    await putExtra('current-image-key', 'current');
    await putExtra('legacy-image-attachment', 'attachment');
    await putExtra('retained-image-snapshot', 'snapshot');
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?').bind(
        'current-image-key',
        file.id,
      ),
      testEnv.DB.prepare(
        `INSERT INTO markdown_attachments(id,file_id,object_key,mime,size,created_at)
        VALUES(?,?,?,'image/png',10,0)`,
      ).bind(crypto.randomUUID(), file.id, 'legacy-image-attachment'),
      testEnv.DB.prepare(
        `INSERT INTO markdown_pages(id,file_id,title,slug,published,updated_at,snapshot_key)
        VALUES(?,?,'Historical','historical-image',0,0,?)`,
      ).bind(crypto.randomUUID(), file.id, 'retained-image-snapshot'),
    ]);
    await request('/api/admin/images/' + image.name, 'DELETE');
    const result = await data<{ name: string; file_id: string; deleted: boolean }>(
      await request('/api/admin/images/' + image.name + '/permanent', 'DELETE'),
    );
    expect(result).toEqual({ name: image.name, file_id: file.id, deleted: true });
    for (const table of [
      'image_hosts',
      'files',
      'file_shares',
      'markdown_attachments',
      'markdown_pages',
    ]) {
      expect(
        await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'),
      ).toBe(0);
    }
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
    expect((await request('/i/' + image.name)).status).toBe(404);
    expect((await request(new URL(share.url).pathname)).status).toBe(404);
    expect((await request('/api/admin/images/' + image.name + '/restore', 'POST')).status).toBe(
      404,
    );
  });

  it('keeps an object still referenced by another private file', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    const other = await data<FileRecord>(await upload('other.txt', 'other'));
    await testEnv.DB.prepare(
      `INSERT INTO markdown_pages(id,file_id,title,slug,published,updated_at,snapshot_key)
      VALUES(?,?,'Shared key','shared-key',0,0,?)`,
    )
      .bind(crypto.randomUUID(), file.id, other.object_key)
      .run();
    await request('/api/admin/images/' + image.name, 'DELETE');
    expect((await request('/api/admin/images/' + image.name + '/permanent', 'DELETE')).status).toBe(
      200,
    );
    expect(await testEnv.BUCKET.head(other.object_key)).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(other.size);
    expect((await request('/api/admin/files/' + other.id)).status).toBe(200);
  });

  it('retains retry tasks and quota until failed R2 deletions succeed', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    await request('/api/admin/images/' + image.name, 'DELETE');
    const failing = bucketWith('delete', async () => {
      throw new Error('temporary failure');
    });
    expect(
      (
        await request('/api/admin/images/' + image.name + '/permanent', 'DELETE', undefined, {
          ...testEnv,
          BUCKET: failing,
        })
      ).status,
    ).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(file.id).first(),
    ).toBeNull();
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(file.object_key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(file.size);
    await cleanQueue();
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });

  it('does not purge an image re-enabled before the delete transaction', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    await request('/api/admin/images/' + image.name, 'DELETE');
    const db = beforeBatch(async () => {
      expect((await request('/api/admin/images/' + image.name + '/restore', 'POST')).status).toBe(
        200,
      );
    });
    expect(
      (
        await request('/api/admin/images/' + image.name + '/permanent', 'DELETE', undefined, {
          ...testEnv,
          DB: db,
        })
      ).status,
    ).toBe(409);
    expect((await request('/i/' + image.name)).status).toBe(200);
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(file.object_key)
        .first(),
    ).toBeNull();
  });

  it('does not delete a replacement upload that acquires the same image name', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    await request('/api/admin/images/' + image.name, 'DELETE');
    let replacement: Awaited<ReturnType<typeof hosted>> | undefined;
    const db = beforeBatch(async () => {
      await request('/api/admin/files/' + file.id, 'DELETE');
      replacement = await hosted();
    });
    expect(
      (
        await request('/api/admin/images/' + image.name + '/permanent', 'DELETE', undefined, {
          ...testEnv,
          DB: db,
        })
      ).status,
    ).toBe(409);
    expect(replacement!.image.name).toBe(image.name);
    expect(replacement!.file.id).not.toBe(file.id);
    expect((await request('/i/' + image.name)).status).toBe(200);
    expect(await testEnv.BUCKET.head(replacement!.file.object_key)).not.toBeNull();
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
  });

  it('does not resurrect a record deleted while checking its R2 object', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    await request('/api/admin/images/' + image.name, 'DELETE');
    const bucket = bucketWith('head', async (key: string) => {
      const head = await testEnv.BUCKET.head(key);
      expect(
        (await request('/api/admin/images/' + image.name + '/permanent', 'DELETE')).status,
      ).toBe(200);
      return head;
    });
    expect(
      (
        await request('/api/admin/images/' + image.name + '/restore', 'POST', undefined, {
          ...testEnv,
          BUCKET: bucket,
        })
      ).status,
    ).toBe(409);
    expect((await request('/i/' + image.name)).status).toBe(404);
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
  });

  it('a database transaction failure leaves metadata, object and quota intact', async () => {
    const { image, file } = await hosted();
    await cleanQueue();
    await request('/api/admin/images/' + image.name, 'DELETE');
    const db = new Proxy(testEnv.DB, {
      get(target, key) {
        if (key === 'batch')
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target.prepare('INSERT INTO missing_lifecycle_test_table VALUES(1)'),
            ]);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(
      (
        await request('/api/admin/images/' + image.name + '/permanent', 'DELETE', undefined, {
          ...testEnv,
          DB: db,
        })
      ).status,
    ).toBe(500);
    expect(
      await testEnv.DB.prepare('SELECT name FROM image_hosts WHERE name=?')
        .bind(image.name)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(file.id).first(),
    ).not.toBeNull();
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(file.size);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(file.object_key)
        .first(),
    ).toBeNull();
  });

  it.each(['single', 'trash'])(
    'ordinary %s purge also deletes historical image keys',
    async (mode) => {
      const { image, file } = await hosted();
      await cleanQueue();
      await putExtra('new-private-object', 'new');
      await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
        .bind('new-private-object', file.id)
        .run();
      await request('/api/admin/files/' + file.id, 'DELETE');
      const path =
        mode === 'single' ? '/api/admin/files/' + file.id + '/permanent' : '/api/admin/trash';
      expect((await request(path, 'DELETE')).status).toBe(200);
      expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
      expect((await request('/i/' + image.name)).status).toBe(404);
    },
  );
});
