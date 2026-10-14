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
  await testEnv.DB.batch(
    [
      'page_attachments',
      'markdown_attachments',
      'markdown_pages',
      'file_shares',
      'image_hosts',
      'upload_parts',
      'upload_sessions',
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
