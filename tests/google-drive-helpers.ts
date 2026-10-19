import { vi } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { seal } from '../worker/google-drive-client';
import type { Env } from '../worker/env';
import type { GoogleDriveFile } from '../shared/google-drive';
export const driveEnv = (): Env => ({
  ...testEnv,
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
  AUTH_ENCRYPTION_KEY: 'test-only-google-encryption-key-32bytes',
  ADMIN_ORIGIN: 'http://localhost',
  TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
});
export async function seedConnection(env = driveEnv(), expires = Date.now() + 3600000) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO google_drive_connections(id,connection_id,account_json,refresh_cipher,access_cipher,access_expires,created_at) VALUES(1,?,?,?,?,?,?)',
  )
    .bind(
      id,
      JSON.stringify({ emailAddress: 'test@example.test' }),
      await seal(env, 'refresh-test', 'refresh'),
      await seal(env, 'access-test', 'access'),
      expires,
      Date.now(),
    )
    .run();
  return id;
}
export async function driveCall(path: string, method = 'GET', body?: unknown, env = driveEnv()) {
  const current = await env.DB.prepare(
    'SELECT connection_id FROM google_drive_connections WHERE id=1',
  ).first<{ connection_id: string }>();
  return app.request(
    'http://localhost/api/admin/google-drive' + path,
    {
      method,
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        ...(current ? { 'X-Google-Connection': current.connection_id } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
export function mockGoogle(fn: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!['www.googleapis.com', 'oauth2.googleapis.com'].includes(url.hostname))
      throw new Error('Unexpected provider hostname');
    return fn(url, init ?? {});
  });
}
export const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
export const sampleFile = (extra: Partial<GoogleDriveFile> = {}): GoogleDriveFile => ({
  id: 'file-123',
  name: 'sample.txt',
  mimeType: 'text/plain',
  size: '3',
  parents: ['folder-old'],
  trashed: false,
  capabilities: {
    canEdit: true,
    canDownload: true,
    canTrash: true,
    canUntrash: true,
    canDelete: true,
    canRename: true,
    canMoveItemWithinDrive: true,
  },
  ...extra,
});
export const sampleFolder = (id = 'root') =>
  sampleFile({
    id,
    name: 'Folder',
    mimeType: 'application/vnd.google-apps.folder',
    capabilities: { canAddChildren: true },
  });
