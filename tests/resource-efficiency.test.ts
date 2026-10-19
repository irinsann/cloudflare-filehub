import { describe, expect, it, vi } from 'vitest';
import { testEnv } from './setup';
import { allocate, initializeQuota, storageUsage } from '../worker/quota';
import { serveObject, textObject } from '../worker/storage';
import { rateLimit } from '../worker/auth-crypto';
import { getFile } from '../worker/files';
import { data, request, upload } from './helpers';
import type { FileRecord, FolderRecord } from '../shared/types';

function measuredDatabase() {
  const statements: string[] = [];
  const DB = new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...testEnv, DB }, statements };
}
function measuredBucket() {
  const calls = { get: 0, head: 0 };
  const BUCKET = new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === 'get' || key === 'head')
        return (...args: unknown[]) => {
          calls[key]++;
          return Reflect.apply(target[key], target, args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...testEnv, BUCKET }, calls };
}
async function exactUsage() {
  const actual = await testEnv.DB.prepare(
    'SELECT COALESCE(SUM(size),0) AS used FROM storage_allocations',
  ).first<number>('used');
  const maintained = await testEnv.DB.prepare(
    'SELECT used_bytes FROM storage_quota_state WHERE id=1',
  ).first<number>('used_bytes');
  expect(maintained).toBe(actual);
  return maintained;
}

describe('exact resource accounting without repeated scans', () => {
  it('tracks insert, resize, no-op upsert, delete and rolls back the counter with a failed batch', async () => {
    await initializeQuota(testEnv);
    await testEnv.DB.prepare(
      "INSERT INTO storage_allocations(object_key,size) VALUES('one',7),('two',11)",
    ).run();
    expect(await exactUsage()).toBe(18);
    await testEnv.DB.prepare("UPDATE storage_allocations SET size=3 WHERE object_key='one'").run();
    expect(await exactUsage()).toBe(14);
    await testEnv.DB.prepare(
      "INSERT INTO storage_allocations(object_key,size) VALUES('two',11) ON CONFLICT(object_key) DO UPDATE SET size=excluded.size",
    ).run();
    expect(await exactUsage()).toBe(14);
    await expect(
      testEnv.DB.batch([
        testEnv.DB.prepare(
          "INSERT INTO storage_allocations(object_key,size) VALUES('rollback',100)",
        ),
        testEnv.DB.prepare("INSERT INTO storage_allocations(object_key,size) VALUES('one',999)"),
      ]),
    ).rejects.toThrow();
    expect(await exactUsage()).toBe(14);
    expect(
      await testEnv.DB.prepare(
        "SELECT object_key FROM storage_allocations WHERE object_key='rollback'",
      ).first(),
    ).toBeNull();
    await testEnv.DB.prepare("DELETE FROM storage_allocations WHERE object_key='one'").run();
    expect(await exactUsage()).toBe(11);
    await testEnv.DB.prepare('DELETE FROM storage_allocations').run();
    expect(await exactUsage()).toBe(0);
  });

  it('reads quota and reserves capacity with one statement each, regardless of existing reservations', async () => {
    await initializeQuota(testEnv);
    await testEnv.DB.prepare(
      `WITH RECURSIVE objects(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM objects WHERE n<1000)
      INSERT INTO storage_allocations(object_key,size) SELECT 'existing/'||n,1 FROM objects`,
    ).run();
    const measured = measuredDatabase();
    expect((await storageUsage(measured.env)).storageUsedBytes).toBe(1000);
    expect(measured.statements).toHaveLength(1);
    measured.statements.length = 0;
    await allocate(measured.env, 'new', 23);
    expect(measured.statements).toHaveLength(1);
    expect(measured.statements[0]).not.toMatch(/SUM\(/i);
    expect(await exactUsage()).toBe(1023);
    const old = await testEnv.DB.prepare(
      'SELECT COALESCE(SUM(size),0) FROM storage_allocations',
    ).all();
    const current = await testEnv.DB.prepare(
      'SELECT used_bytes FROM storage_quota_state WHERE id=1',
    ).all();
    expect(old.meta.rows_read).toBeGreaterThanOrEqual(1001);
    expect(current.meta.rows_read).toBe(1);
  });

  it.each([
    ['SELECT 1 FROM markdown_pages WHERE snapshot_key=?', 'pages_snapshot_key'],
    ['SELECT 1 FROM upload_sessions WHERE object_key=?', 'uploads_object_key'],
    ['SELECT 1 FROM image_hosts WHERE object_key=?', 'images_object_key'],
    [
      'SELECT object_key FROM cleanup_tasks WHERE created_at<? ORDER BY created_at LIMIT 8',
      'cleanup_created_at',
    ],
  ])('uses an index for cleanup lookup %s', async (sql, index) => {
    const plan = await testEnv.DB.prepare('EXPLAIN QUERY PLAN ' + sql)
      .bind('missing')
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes(index))).toBe(true);
    expect(plan.results.some((row) => /^SCAN /i.test(row.detail))).toBe(false);
  });

  it('allows exactly the configured rate even under concurrency and makes no further writes when blocked', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(600_000);
    await testEnv.DB.prepare('CREATE TABLE resource_rate_writes(id INTEGER PRIMARY KEY)').run();
    await testEnv.DB.prepare(
      'CREATE TRIGGER resource_rate_update AFTER UPDATE ON rate_limits BEGIN INSERT INTO resource_rate_writes(id) VALUES(NULL); END',
    ).run();
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, () => rateLimit(testEnv, 'efficiency', '127.0.0.1', 3)),
      );
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      for (const result of outcomes)
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429 });
      expect(await testEnv.DB.prepare('SELECT count FROM rate_limits').first<number>('count')).toBe(
        3,
      );
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM resource_rate_writes').first<number>(
          'n',
        ),
      ).toBe(2);
      clock.mockReturnValue(660_000);
      await expect(rateLimit(testEnv, 'efficiency', '127.0.0.1', 3)).resolves.toBeUndefined();
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits').first<number>('n'),
      ).toBe(2);
    } finally {
      clock.mockRestore();
      await testEnv.DB.prepare('DROP TRIGGER resource_rate_update').run();
      await testEnv.DB.prepare('DROP TABLE resource_rate_writes').run();
    }
  });
});

describe('one object read for full downloads and text', () => {
  it('uses one GET for the stream with exact security headers and one HEAD for metadata', async () => {
    const saved = await testEnv.BUCKET.put('body', 'abcdefghij');
    const measured = measuredBucket();
    const response = await serveObject(
      measured.env,
      new Request('http://localhost/file'),
      'body',
      'name.txt',
      'text/plain',
      false,
    );
    expect(await response.text()).toBe('abcdefghij');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('ETag')).toBe(saved!.httpEtag);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(measured.calls).toEqual({ get: 1, head: 0 });
    const head = await serveObject(
      measured.env,
      new Request('http://localhost/file', { method: 'HEAD' }),
      'body',
      'name.txt',
      'text/plain',
      false,
    );
    expect(await head.text()).toBe('');
    expect(measured.calls).toEqual({ get: 1, head: 1 });
    expect(await textObject(measured.env, 'body')).toBe('abcdefghij');
    expect(measured.calls).toEqual({ get: 2, head: 1 });
    await expect(
      textObject({ ...measured.env, MAX_TEXT_BYTES: '5' }, 'body'),
    ).rejects.toMatchObject({ status: 413 });
    expect(measured.calls).toEqual({ get: 3, head: 1 });
  });

  it('preserves suffix range, invalid range, stale If-Range and missing object responses', async () => {
    await testEnv.BUCKET.put('range', 'abcdefghij');
    const measured = measuredBucket();
    const serve = (headers: HeadersInit = {}) =>
      serveObject(
        measured.env,
        new Request('http://localhost/file', { headers }),
        'range',
        'file.bin',
        'application/octet-stream',
        false,
      );
    const partial = await serve({ Range: 'bytes=-3' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await partial.text()).toBe('hij');
    const invalid = await serve({ Range: 'bytes=99-' });
    expect(invalid.status).toBe(416);
    expect(await invalid.text()).toBe('');
    expect(measured.calls).toEqual({ get: 1, head: 2 });
    const stale = await serve({ Range: 'bytes=3-', 'If-Range': '"old"' });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('abcdefghij');
    expect(stale.headers.has('Content-Range')).toBe(false);
    await expect(
      serveObject(
        measured.env,
        new Request('http://localhost/missing'),
        'missing',
        'missing',
        'text/plain',
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('checks file metadata and all folder ancestors in one current database snapshot', async () => {
    const parent = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'parent' }),
    );
    const child = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'child', parent_id: parent.id }),
    );
    const file = await data<FileRecord>(await upload('inside.txt', 'content', child.id));
    const measured = measuredDatabase();
    expect((await getFile(measured.env, file.id)).id).toBe(file.id);
    expect(measured.statements).toHaveLength(1);
    // DAV can leave deleted descendants in the same tree. Access must be denied immediately.
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE files SET deleted_at=1 WHERE id=?').bind(file.id),
      testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(child.id),
      testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(parent.id),
    ]);
    await expect(getFile(measured.env, file.id)).rejects.toMatchObject({ status: 404 });
    expect((await getFile(measured.env, file.id, true)).id).toBe(file.id);
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE folders SET deleted_at=NULL WHERE id=?').bind(parent.id),
      testEnv.DB.prepare('UPDATE folders SET deleted_at=NULL WHERE id=?').bind(child.id),
      testEnv.DB.prepare('UPDATE files SET deleted_at=NULL WHERE id=?').bind(file.id),
    ]);
    expect((await getFile(measured.env, file.id)).id).toBe(file.id);
  });
});
