import { describe, expect, it } from 'vitest';
import { testEnv } from './setup';
import { cleanup, recoverUploadReservation, reserve, uploadStream } from '../worker/storage';
import { initializeQuota, STORAGE_LIMIT, storageUsage } from '../worker/quota';
import { createMarkdown, data, request } from './helpers';

async function orphan(key: string, age: number) {
  await testEnv.BUCKET.put(key, 'orphan');
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,6)').bind(key),
    testEnv.DB.prepare('INSERT INTO cleanup_tasks(object_key,created_at) VALUES(?,?)').bind(
      key,
      age,
    ),
  ]);
}

function measuredDatabase() {
  let statements = 0;
  let requests = 0;
  const wrap = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return (...args: unknown[]) => {
            statements++;
            requests++;
            return Reflect.apply(Reflect.get(target, key, target), target, args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const DB = new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch')
        return (batch: D1PreparedStatement[]) => {
          statements += batch.length;
          requests++;
          return target.batch(batch);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { DB, counts: () => ({ statements, requests }) };
}

describe('long-running storage recovery regressions', () => {
  it('eventually attempts a later deletable object despite older persistent failures', async () => {
    await initializeQuota(testEnv);
    for (let index = 0; index < 9; index++) await orphan('audit/' + index, index);
    const attempted: string[] = [];
    const BUCKET = new Proxy(testEnv.BUCKET, {
      get(target, key) {
        if (key === 'delete')
          return async (object: string) => {
            attempted.push(object);
            if (object !== 'audit/8') throw new Error('persistent deletion failure');
            return target.delete(object);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    for (let pass = 0; pass < 3; pass++) await cleanup({ ...testEnv, BUCKET });
    expect(attempted).toContain('audit/8');
    expect(await testEnv.BUCKET.head('audit/8')).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(48);
  });

  it('eventually reclaims a long-expired pending single upload with no active writer or references', async () => {
    await initializeQuota(testEnv);
    const key = 'audit/crashed-single';
    await orphan(key, 0);
    await testEnv.DB.prepare(
      "INSERT INTO files(id,name,object_key,mime,size,status,created_at,updated_at) VALUES(?,?,?,'application/octet-stream',0,'pending',0,0)",
    )
      .bind(crypto.randomUUID(), 'crashed.bin', key)
      .run();
    for (let pass = 0; pass < 3; pass++) await cleanup(testEnv);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM upload_sessions').first<number>('n'),
    ).toBe(0);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
    ).toBe(0);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE object_key=?')
        .bind(key)
        .first<string>('status'),
    ).toBeNull();
    expect(await testEnv.BUCKET.head(key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });

  it('batches a full ordinary cleanup run instead of issuing queries per object', async () => {
    await initializeQuota(testEnv);
    for (let index = 0; index < 8; index++) await orphan('audit/' + index, index);
    const measured = measuredDatabase();
    await cleanup({ ...testEnv, DB: measured.DB });
    expect(measured.counts()).toEqual({ statements: 11, requests: 5 });
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
  });

  it('keeps a full ordinary cleanup batch within the documented free-tier fifty-query budget', async () => {
    await initializeQuota(testEnv);
    for (let index = 0; index < 8; index++) await orphan('audit/' + index, index);
    const measured = measuredDatabase();
    await cleanup({ ...testEnv, DB: measured.DB });
    expect(measured.counts().requests).toBeLessThanOrEqual(50);
    expect(measured.counts().statements).toBeLessThanOrEqual(50);
  });

  it('keeps expired multipart aborts plus a full object batch within the same budget', async () => {
    await initializeQuota(testEnv);
    for (let index = 0; index < 2; index++)
      await data(
        await request('/api/admin/uploads', 'POST', { name: `old-${index}.bin`, size: 6 }),
      );
    for (let index = 0; index < 8; index++) await orphan('audit/' + index, index);
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE upload_sessions SET expires_at=0'),
      testEnv.DB.prepare('UPDATE files SET created_at=0,updated_at=0'),
      testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0'),
    ]);
    const measured = measuredDatabase();
    await cleanup({ ...testEnv, DB: measured.DB });
    expect(measured.counts().requests).toBeLessThanOrEqual(50);
    expect(measured.counts().statements).toBeLessThanOrEqual(50);
  });

  it('uses a live writer rather than file age to protect an ongoing single upload', async () => {
    await initializeQuota(testEnv);
    const key = 'audit/slow-live';
    await orphan(key, 0);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO files(id,name,object_key,mime,status,created_at,updated_at) VALUES(?,'slow.bin',?,'application/octet-stream','pending',0,0)",
      ).bind(crypto.randomUUID(), key),
      testEnv.DB.prepare(
        "UPDATE cleanup_tasks SET writer_owner='still-live' WHERE object_key=?",
      ).bind(key),
      testEnv.DB.prepare(
        "INSERT INTO storage_web_writes(owner,expires_at) VALUES('still-live',?)",
      ).bind(Date.now() + 60000),
    ]);
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(key)).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(6);
    await testEnv.DB.prepare(
      "UPDATE storage_web_writes SET expires_at=0 WHERE owner='still-live'",
    ).run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });

  it('cancels and settles an unread request body when R2 refuses the upload', async () => {
    await initializeQuota(testEnv);
    const key = await reserve(testEnv);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const BUCKET = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        if (property === 'put')
          return async () => {
            throw new Error('R2 unavailable');
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const incoming = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'X-File-Size': '6' },
      body,
    });
    await expect(
      uploadStream({ ...testEnv, BUCKET }, incoming, key, 'failed.bin'),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(6);
  });

  it('restores accepted bytes even if another upload filled the quota during cleanup', async () => {
    await initializeQuota(testEnv);
    await orphan('audit/late', 0);
    await cleanup(testEnv);
    await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
      .bind('filled-capacity', STORAGE_LIMIT)
      .run();
    await testEnv.BUCKET.put('audit/late', 'orphan');
    await recoverUploadReservation(testEnv, 'audit/late', 6);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(STORAGE_LIMIT + 6);
    await testEnv.DB.prepare(
      "UPDATE cleanup_tasks SET created_at=0 WHERE object_key='audit/late'",
    ).run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head('audit/late')).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(STORAGE_LIMIT);
  });

  it('does not acknowledge a new reservation using an older cleanup generation', async () => {
    await initializeQuota(testEnv);
    const key = 'audit/late-generation';
    await orphan(key, 0);
    const BUCKET = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        if (property === 'delete')
          return async (object: string) => {
            await target.delete(object);
            // A second cleanup finished first, then a delayed writer stored its object.
            await cleanup(testEnv);
            await target.put(object, 'orphan');
            await recoverUploadReservation(testEnv, object, 6);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await cleanup({ ...testEnv, BUCKET });
    expect(await testEnv.BUCKET.head(key)).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(6);
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0 WHERE object_key=?')
      .bind(key)
      .run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });

  it('keeps a cleanup task that was referenced when selected but detached by a concurrent edit', async () => {
    const file = await createMarkdown('# old');
    await testEnv.DB.prepare('INSERT INTO cleanup_tasks(object_key,created_at) VALUES(?,0)')
      .bind(file.object_key)
      .run();
    let edited = false;
    const DB = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!edited) {
              edited = true;
              // The editor uses INSERT OR IGNORE to requeue the now-unreferenced old key.
              const response = await request('/api/admin/markdown/' + file.id, 'PUT', {
                content: '# new',
                version: file.version,
              });
              expect(response.status).toBe(200);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await cleanup({ ...testEnv, DB });
    expect(edited).toBe(true);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(file.object_key)
        .first(),
    ).not.toBeNull();
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
    const current = await testEnv.DB.prepare('SELECT object_key FROM files WHERE id=?')
      .bind(file.id)
      .first<string>('object_key');
    expect(await (await testEnv.BUCKET.get(current!))?.text()).toBe('# new');
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(5);
  });

  it.each([false, true])(
    'tracks a delayed Markdown write after its lease expired (lost response=%s)',
    async (lostResponse) => {
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const BUCKET = new Proxy(testEnv.BUCKET, {
        get(target, property) {
          if (property === 'put')
            return async (...args: Parameters<R2Bucket['put']>) => {
              enter();
              await blocked;
              const result = await target.put(...args);
              if (lostResponse) throw new Error('R2 response lost after storing Markdown');
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const uploading = request(
        '/api/admin/markdown',
        'POST',
        { name: 'slow.md', content: '# late' },
        { ...testEnv, BUCKET },
      );
      await entered;
      try {
        await testEnv.DB.batch([
          testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0'),
          testEnv.DB.prepare('UPDATE storage_web_writes SET expires_at=0'),
        ]);
        await cleanup(testEnv);
        expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
      } finally {
        resume();
      }
      expect((await uploading).status).toBe(lostResponse ? 500 : 423);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files').first<number>('n')).toBe(
        0,
      );
      const objects = (await testEnv.BUCKET.list()).objects;
      expect(objects).toHaveLength(1);
      expect(
        await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
          .bind(objects[0].key)
          .first(),
      ).not.toBeNull();
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(6);
      await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
      await cleanup(testEnv);
      expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
    },
  );
});
