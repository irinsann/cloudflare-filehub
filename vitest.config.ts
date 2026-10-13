import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./db/migrations'),
          SHARE_SESSION_SECRET: 'test-only-random-session-secret-32-bytes-long',
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
