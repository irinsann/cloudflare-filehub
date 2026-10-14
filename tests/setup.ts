import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import type { Env } from '../worker/env';
export const testEnv = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
beforeEach(async () => {
  let cursor: string | undefined;
  do {
    const objects = await testEnv.BUCKET.list({ cursor });
    if (objects.objects.length) await testEnv.BUCKET.delete(objects.objects.map((o) => o.key));
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  await testEnv.DB.prepare('UPDATE storage_quota_state SET ready=0,lock_until=0 WHERE id=1').run();
  await testEnv.DB.batch(
    [
      'storage_allocations',
      'page_attachments',
      'markdown_attachments',
      'markdown_pages',
      'file_shares',
      'image_hosts',
      'upload_parts',
      'upload_sessions',
      'api_file_owners',
      'api_tokens',
      'files',
      'folders',
      'operations',
      'cleanup_tasks',
      'rate_limits',
      'admin_sessions',
      'admin_setup',
      'admin_recovery',
      'admin_account',
    ].map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)),
  );
});
