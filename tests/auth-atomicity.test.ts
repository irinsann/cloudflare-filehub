import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { totp } from '../worker/site-auth';
import { data } from './helpers';
import { testEnv } from './setup';

const env = {
  ...testEnv,
  LOCAL_AUTH: 'false',
  ENVIRONMENT: 'production',
  AUTH_MODE: 'password_totp',
  AUTH_SETUP_EXPIRES: String(Date.now() + 86400000),
  AUTH_ENCRYPTION_KEY: 'atomicity-test-encryption-key-32-bytes',
  AUTH_SETUP_SECRET: 'atomicity-test-setup-secret-32-bytes',
  ADMIN_ORIGIN: 'https://233334.xyz',
  ADMIN_EMAILS: 'owner@example.test',
};
const password = 'atomicity-test-passphrase';
async function post(path: string, body: unknown) {
  return app.request(
    'https://233334.xyz/api/auth/' + path,
    {
      method: 'POST',
      headers: {
        Origin: 'https://233334.xyz',
        'X-Drive-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
async function invitation() {
  const setup = await data<{ token: string; secret: string }>(
    await post('setup/start', { token: env.AUTH_SETUP_SECRET }),
  );
  const counter = Math.floor(Date.now() / 30000);
  return { ...setup, counter, code: await totp(setup.secret, counter) };
}
async function failingInsert(
  table: 'admin_recovery' | 'admin_sessions',
  run: () => Promise<Response>,
) {
  await testEnv.DB.prepare(
    `CREATE TRIGGER auth_atomicity_failure BEFORE INSERT ON ${table}
     BEGIN SELECT RAISE(ABORT, 'simulated auth storage failure'); END`,
  ).run();
  try {
    return await run();
  } finally {
    await testEnv.DB.prepare('DROP TRIGGER auth_atomicity_failure').run();
  }
}

describe('authentication writes survive database failures', () => {
  it.each(['admin_recovery', 'admin_sessions'] as const)(
    'setup failure writing %s leaves the invitation retryable and no partial account',
    async (table) => {
      const setup = await invitation();
      const finish = () => post('setup/finish', { token: setup.token, password, code: setup.code });
      const failed = await failingInsert(table, finish);
      expect(failed.status).toBe(500);
      expect(failed.headers.get('Set-Cookie')).toBeNull();
      expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_account').first('COUNT(*)')).toBe(
        0,
      );
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_recovery').first('COUNT(*)'),
      ).toBe(0);
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_sessions').first('COUNT(*)'),
      ).toBe(0);
      const retry = await finish();
      expect(retry.status).toBe(200);
      expect(retry.headers.get('Set-Cookie')).toContain('__Host-rcloud-session=');
      expect((await data<{ recovery: string[] }>(retry)).recovery).toHaveLength(8);
    },
  );

  it.each(['totp', 'recovery'] as const)(
    'failed session insertion does not consume a valid %s credential',
    async (kind) => {
      const setup = await invitation();
      const { recovery } = await data<{ recovery: string[] }>(
        await post('setup/finish', { token: setup.token, password, code: setup.code }),
      );
      const code = kind === 'totp' ? await totp(setup.secret, setup.counter + 1) : recovery[0];
      const login = () => post('login', { password, code });
      const failed = await failingInsert('admin_sessions', login);
      expect(failed.status).toBe(500);
      expect(failed.headers.get('Set-Cookie')).toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT last_counter FROM admin_account WHERE id=1').first(
          'last_counter',
        ),
      ).toBe(setup.counter);
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_recovery').first('COUNT(*)'),
      ).toBe(8);
      const retry = await login();
      expect(retry.status).toBe(200);
      expect((await login()).status).toBe(401);
    },
  );

  it.each(['totp', 'recovery'] as const)(
    'allows only one session from concurrent logins with the same %s credential',
    async (kind) => {
      const setup = await invitation();
      const { recovery } = await data<{ recovery: string[] }>(
        await post('setup/finish', { token: setup.token, password, code: setup.code }),
      );
      const code = kind === 'totp' ? await totp(setup.secret, setup.counter + 1) : recovery[0];
      const results = await Promise.all([
        post('login', { password, code }),
        post('login', { password, code }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(results.filter((r) => r.headers.has('Set-Cookie'))).toHaveLength(1);
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_sessions').first('COUNT(*)'),
      ).toBe(2);
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_recovery').first('COUNT(*)'),
      ).toBe(kind === 'totp' ? 8 : 7);
    },
  );

  it('commits only one account and recovery set when setup finishes concurrently', async () => {
    const setup = await invitation();
    const results = await Promise.all([
      post('setup/finish', { token: setup.token, password, code: setup.code }),
      post('setup/finish', { token: setup.token, password, code: setup.code }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.headers.has('Set-Cookie'))).toHaveLength(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_recovery').first('COUNT(*)')).toBe(
      8,
    );
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM admin_sessions').first('COUNT(*)')).toBe(
      1,
    );
  });
});
