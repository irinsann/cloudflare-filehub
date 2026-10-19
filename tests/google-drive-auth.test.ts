import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { data } from './helpers';
import { driveEnv, driveCall, seedConnection, mockGoogle, json } from './google-drive-helpers';
import {
  accessToken,
  DRIVE_SCOPE,
  seal,
  unseal,
  upstream,
  driveJson,
} from '../worker/google-drive-client';
import { digest } from '../worker/auth-crypto';
import type { GoogleDriveStatus } from '../shared/google-drive';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('Google Drive connection security', () => {
  it('reports missing credentials without calling Google', async () => {
    const env = { ...driveEnv(), GOOGLE_CLIENT_SECRET: undefined };
    const fetch = mockGoogle(() => {
      throw new Error('No network expected');
    });
    const status = await data<GoogleDriveStatus>(await driveCall('', 'GET', undefined, env));
    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.redirectUris).toEqual(['https://s.irin.im/api/oauth/google/callback']);
    expect((await driveCall('/connect', 'POST', {}, env)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires an encryption key before reporting configured', async () => {
    const env = { ...driveEnv(), AUTH_ENCRYPTION_KEY: undefined };
    expect(
      (await data<GoogleDriveStatus>(await driveCall('', 'GET', undefined, env))).configured,
    ).toBe(false);
  });
  it('encrypts credentials and rejects substitution between secret purposes', async () => {
    const env = driveEnv(),
      cipher = await seal(env, 'sensitive-refresh-value', 'refresh');
    expect(cipher).not.toContain('sensitive-refresh-value');
    expect(await unseal(env, cipher, 'refresh')).toBe('sensitive-refresh-value');
    await expect(unseal(env, cipher, 'access')).rejects.toThrow();
  });
  it('refreshes expired tokens once and stores only encrypted credentials', async () => {
    const env = driveEnv();
    await seedConnection(env, 0);
    const fetch = mockGoogle((url, init) => {
      expect(url.href).toBe('https://oauth2.googleapis.com/token');
      expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('refresh-test');
      return json({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });
    });
    expect((await accessToken(env)).token).toBe('new-access');
    expect((await accessToken(env)).token).toBe('new-access');
    expect(fetch).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare(
      'SELECT access_cipher,refresh_cipher,refresh_owner FROM google_drive_connections',
    ).first<{ access_cipher: string; refresh_cipher: string; refresh_owner: string | null }>();
    expect(row!.access_cipher).not.toContain('new-access');
    expect(await unseal(env, row!.refresh_cipher, 'refresh')).toBe('rotated-refresh');
    expect(row!.refresh_owner).toBeNull();
  });
  it('does not start concurrent refreshes', async () => {
    const env = driveEnv();
    await seedConnection(env, 0);
    await env.DB.prepare('UPDATE google_drive_connections SET refresh_owner=?,refresh_until=?')
      .bind('other', Date.now() + 60000)
      .run();
    const fetch = mockGoogle(() => json({}));
    await expect(accessToken(env)).rejects.toMatchObject({ status: 423 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not restore a connection disconnected during token refresh', async () => {
    const env = driveEnv();
    await seedConnection(env, 0);
    mockGoogle(async () => {
      await driveCall('/connection', 'DELETE', undefined, env);
      return json({ access_token: 'late-access', expires_in: 3600 });
    });
    await expect(accessToken(env)).rejects.toMatchObject({ status: 409 });
    expect(await env.DB.prepare('SELECT * FROM google_drive_connections').first()).toBeNull();
  });
  it('surfaces revoked refresh tokens without retry loops', async () => {
    const env = driveEnv();
    await seedConnection(env, 0);
    const fetch = mockGoogle(() => json({ error: 'invalid_grant' }, 400));
    await expect(accessToken(env)).rejects.toMatchObject({ status: 424 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not invalidate a newer token on a stale 401 response', async () => {
    const env = driveEnv();
    await seedConnection(env);
    let calls = 0;
    const fetch = mockGoogle(async (url, init) => {
      expect(url.pathname).toBe('/drive/v3/files');
      calls++;
      if (calls === 1) {
        await env.DB.prepare('UPDATE google_drive_connections SET access_cipher=?,access_expires=?')
          .bind(await seal(env, 'newer-token', 'access'), Date.now() + 3600000)
          .run();
        return json({}, 401);
      }
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer newer-token');
      return json({ files: [] });
    });
    expect(await driveJson(env, 'files')).toEqual({ files: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('clears the header timeout while keeping a download response stream alive', async () => {
    let signal: AbortSignal | null | undefined;
    mockGoogle((_url, init) => {
      signal = init.signal;
      return new Response('download');
    });
    vi.useFakeTimers();
    const response = await upstream('https://www.googleapis.com/drive/v3/files/test');
    await vi.advanceTimersByTimeAsync(60000);
    expect(signal!.aborted).toBe(false);
    expect(await response.text()).toBe('download');
  });
  it('rejects foreign API hosts before sending credentials', async () => {
    const env = driveEnv();
    await seedConnection(env);
    const fetch = mockGoogle(() => json({}));
    await expect(driveJson(env, 'https://evil.test/drive/v3/files')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function oauthStart(origin = 'https://233334.xyz', upstreamOrigin = origin) {
  const env = {
    ...driveEnv(),
    ADMIN_ORIGIN: 'https://233334.xyz',
    ENVIRONMENT: 'production',
    LOCAL_AUTH: 'false',
    AUTH_MODE: 'password_totp',
    ADMIN_EMAILS: 'admin@example.test',
  };
  const session = 'a'.repeat(64);
  await env.DB.prepare('INSERT OR REPLACE INTO admin_sessions(token_hash,expires_at) VALUES(?,?)')
    .bind(await digest(session), Date.now() + 3600000)
    .run();
  const response = await app.request(
    upstreamOrigin + '/api/admin/google-drive/connect',
    {
      method: 'POST',
      headers: {
        Cookie: '__Host-rcloud-session=' + session,
        Origin: origin,
        'X-Drive-Request': '1',
      },
    },
    env,
  );
  const { url } = await data<{ url: string }>(response);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  return { env, auth: new URL(url), cookie, session };
}
describe('Google OAuth callback', () => {
  it('preserves Hong Kong browser origin when the reverse proxy uses the primary upstream host', async () => {
    const { env, auth, cookie } = await oauthStart('https://s.irin.im', 'https://233334.xyz');
    expect(auth.searchParams.get('redirect_uri')).toBe(
      'https://s.irin.im/api/oauth/google/callback',
    );
    mockGoogle((url, init) => {
      if (url.hostname === 'oauth2.googleapis.com') {
        expect(new URLSearchParams(String(init.body)).get('redirect_uri')).toBe(
          'https://s.irin.im/api/oauth/google/callback',
        );
        return json({
          access_token: 'proxy-access',
          refresh_token: 'proxy-refresh',
          expires_in: 3600,
          scope: DRIVE_SCOPE,
        });
      }
      return json({ user: { emailAddress: 'proxy@example.test' } });
    });
    const response = await app.request(
      'https://233334.xyz/api/oauth/google/callback?code=test&state=' +
        auth.searchParams.get('state'),
      { headers: { Cookie: cookie } },
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://s.irin.im/drive/?google_drive=connected#google-drive',
    );
  });
  it('rejects a forged browser origin even when the request arrives through the primary host', async () => {
    const { env, session } = await oauthStart();
    const response = await app.request(
      'https://233334.xyz/api/admin/google-drive/connect',
      {
        method: 'POST',
        headers: {
          Cookie: '__Host-rcloud-session=' + session,
          Origin: 'https://evil.test',
          'X-Drive-Request': '1',
          'X-Forwarded-Host': 's.irin.im',
        },
      },
      env,
    );
    expect(response.status).toBe(403);
  });
  it.each(['https://233334.xyz', 'https://s.irin.im'])(
    'binds authorization to %s with PKCE and a separate Lax cookie',
    async (origin) => {
      const { auth, cookie } = await oauthStart(origin);
      expect(auth.origin).toBe('https://accounts.google.com');
      expect(auth.searchParams.get('redirect_uri')).toBe(origin + '/api/oauth/google/callback');
      expect(auth.searchParams.get('scope')).toBe(DRIVE_SCOPE);
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie).toContain('__Host-rcloud-google-oauth=');
    },
  );
  it('completes without a Strict login cookie, consumes state once, and never exposes tokens', async () => {
    const { env, auth, cookie } = await oauthStart();
    const fetch = mockGoogle((url, init) => {
      if (url.hostname === 'oauth2.googleapis.com') {
        expect(new URLSearchParams(String(init.body)).get('code_verifier')).toHaveLength(64);
        return json({
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh',
          expires_in: 3600,
          scope: DRIVE_SCOPE,
        });
      }
      return json({ user: { emailAddress: 'drive@example.test', displayName: 'Test Drive' } });
    });
    const callback =
      'https://233334.xyz/api/oauth/google/callback?code=test-code&state=' +
      auth.searchParams.get('state');
    const response = await app.request(callback, { headers: { Cookie: cookie } }, env);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://233334.xyz/drive/?google_drive=connected#google-drive',
    );
    const row = await env.DB.prepare('SELECT * FROM google_drive_connections').first();
    expect(JSON.stringify(row)).not.toContain('oauth-refresh');
    expect((await app.request(callback, { headers: { Cookie: cookie } }, env)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['missing-nonce', 'wrong-origin', 'logout', 'disconnect'])(
    'rejects callback after %s',
    async (reason) => {
      const { env, auth, cookie } = await oauthStart();
      if (reason === 'logout') await env.DB.prepare('DELETE FROM admin_sessions').run();
      if (reason === 'disconnect')
        await env.DB.prepare('UPDATE google_drive_generation SET generation=generation+1').run();
      const fetch = mockGoogle(() => json({}));
      const origin = reason === 'wrong-origin' ? 'https://s.irin.im' : 'https://233334.xyz';
      const response = await app.request(
        origin + '/api/oauth/google/callback?code=test&state=' + auth.searchParams.get('state'),
        { headers: reason === 'missing-nonce' ? {} : { Cookie: cookie } },
        env,
      );
      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('rejects partial permission consent without replacing the old connection', async () => {
    const { env, auth, cookie } = await oauthStart();
    const id = await seedConnection(env);
    mockGoogle(() =>
      json({
        access_token: 'new',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
      }),
    );
    const response = await app.request(
      'https://233334.xyz/api/oauth/google/callback?code=test&state=' +
        auth.searchParams.get('state'),
      { headers: { Cookie: cookie } },
      env,
    );
    expect(response.status).toBe(403);
    expect(
      (await env.DB.prepare('SELECT connection_id FROM google_drive_connections').first<{
        connection_id: string;
      }>())!.connection_id,
    ).toBe(id);
  });
  it('requires RCloud login and same-origin writes on the public deployment', async () => {
    const env = {
      ...driveEnv(),
      ADMIN_ORIGIN: 'https://233334.xyz',
      ENVIRONMENT: 'production',
      LOCAL_AUTH: 'false',
      AUTH_MODE: 'password_totp',
    };
    expect((await app.request('https://233334.xyz/api/admin/google-drive', {}, env)).status).toBe(
      401,
    );
    expect(
      (
        await app.request(
          'https://233334.xyz/api/admin/google-drive/connect',
          { method: 'POST', headers: { Origin: 'https://evil.test', 'X-Drive-Request': '1' } },
          env,
        )
      ).status,
    ).toBe(403);
  });
});
