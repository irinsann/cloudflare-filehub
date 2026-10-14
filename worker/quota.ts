import type { Env } from './env';
import { now } from './env';
import { fail } from './errors';
export const STORAGE_LIMIT = 50 * 1024 * 1024 * 1024;
// Before accepting writes, inventory existing objects and in-flight multipart reservations.
export async function initializeQuota(env: Env) {
  const state = await env.DB.prepare('SELECT ready FROM storage_quota_state WHERE id=1').first<{
    ready: number;
  }>();
  if (state?.ready) return;
  const locked = await env.DB.prepare(
    'UPDATE storage_quota_state SET lock_until=? WHERE id=1 AND ready=0 AND lock_until<?',
  )
    .bind(now() + 300000, now())
    .run();
  if (!locked.meta.changes) fail(503, '正在统计存储容量，请稍后重试');
  try {
    let cursor: string | undefined;
    do {
      const list = await env.BUCKET.list({ cursor, limit: 1000 });
      for (let start = 0; start < list.objects.length; start += 80) {
        await env.DB.batch(
          list.objects
            .slice(start, start + 80)
            .map((o) =>
              env.DB.prepare(
                'INSERT INTO storage_allocations(object_key,size) VALUES(?,?) ON CONFLICT(object_key) DO UPDATE SET size=excluded.size',
              ).bind(o.key, o.size),
            ),
        );
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO storage_allocations(object_key,size) SELECT object_key,size FROM upload_sessions',
      ),
      env.DB.prepare('UPDATE storage_quota_state SET ready=1,lock_until=0 WHERE id=1'),
    ]);
  } catch (error) {
    await env.DB.prepare('UPDATE storage_quota_state SET lock_until=0 WHERE id=1').run();
    throw error;
  }
}
export async function allocate(env: Env, key: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 0) fail(400, '文件大小无效');
  await initializeQuota(env);
  // SQLite serializes this statement, so concurrent uploads cannot overbook the quota.
  const result = await env.DB.prepare(
    'INSERT INTO storage_allocations(object_key,size) SELECT ?,? WHERE COALESCE((SELECT SUM(size) FROM storage_allocations),0)+?<=?',
  )
    .bind(key, size, size, STORAGE_LIMIT)
    .run();
  if (!result.meta.changes) fail(413, '存储容量不足（总容量 50GB）');
}
export async function storageUsage(env: Env) {
  await initializeQuota(env);
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(size),0) AS used FROM storage_allocations',
  ).first<{ used: number }>();
  return {
    storageUsedBytes: row!.used,
    storageLimitBytes: STORAGE_LIMIT,
    storageAvailableBytes: Math.max(0, STORAGE_LIMIT - row!.used),
  };
}
export async function deleteObject(env: Env, key: string) {
  await initializeQuota(env);
  await env.BUCKET.delete(key);
  await env.DB.prepare('DELETE FROM storage_allocations WHERE object_key=?').bind(key).run();
}
