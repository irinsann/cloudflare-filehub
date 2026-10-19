import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { data } from './helpers';
import {
  driveEnv,
  driveCall,
  seedConnection,
  mockGoogle,
  json,
  sampleFile,
  sampleFolder,
} from './google-drive-helpers';
import { seal, unseal } from '../worker/google-drive-client';
import { cleanupGoogleDrive } from '../worker/google-drive-uploads';
import type { GoogleDriveUpload } from '../shared/google-drive';
const sessionUrl =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-session-id';
afterEach(() => vi.restoreAllMocks());
async function uploadSession(size = 3) {
  const env = driveEnv(),
    connectionId = await seedConnection(env),
    id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO google_drive_uploads(id,connection_id,session_cipher,file_id,size,expires_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      id,
      connectionId,
      await seal(env, sessionUrl, 'upload:' + id),
      'new-google-file',
      size,
      Date.now() + 86400000,
    )
    .run();
  return { id, env, connectionId, size };
}
async function put(
  id: string,
  offset: number,
  bytes = new Uint8Array([97, 98, 99]),
  size = bytes.length,
) {
  return app.request(
    'http://localhost/api/admin/google-drive/uploads/' + id + '?offset=' + offset,
    {
      method: 'PUT',
      headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': String(size) },
      body: bytes.buffer,
    },
    driveEnv(),
  );
}
const completeFile = (size = 3) => sampleFile({ id: 'new-google-file', size: String(size) });
describe('Google Drive resumable uploads', () => {
  it('refreshes a rejected access token during an upload status probe', async () => {
    const { id } = await uploadSession();
    let attempts = 0;
    mockGoogle((url, init) => {
      if (url.hostname === 'oauth2.googleapis.com')
        return json({ access_token: 'renewed-access', expires_in: 3600 });
      if (attempts++ === 0) return json({}, 401);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer renewed-access');
      return json(completeFile());
    });
    const result = await data<GoogleDriveUpload>(await driveCall('/uploads/' + id));
    expect(result.complete).toBe(true);
    expect(attempts).toBe(2);
  });
  it('does not replay consumed bytes after upload 401 and refreshes on the subsequent progress probe', async () => {
    const { id, env } = await uploadSession();
    let uploadRequests = 0;
    mockGoogle(async (url, init) => {
      if (url.hostname === 'oauth2.googleapis.com')
        return json({ access_token: 'renewed-access', expires_in: 3600 });
      uploadRequests++;
      if (new Headers(init.headers).get('Content-Range') === 'bytes */3') {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer renewed-access');
        return new Response(null, { status: 308 });
      }
      expect(await new Response(init.body).text()).toBe('abc');
      return json({}, 401);
    });
    expect((await put(id, 0)).status).toBe(503);
    expect(uploadRequests).toBe(1);
    expect(
      (await env.DB.prepare('SELECT access_expires FROM google_drive_connections').first<{
        access_expires: number;
      }>())!.access_expires,
    ).toBe(0);
    expect((await data<GoogleDriveUpload>(await driveCall('/uploads/' + id))).offset).toBe(0);
    expect(uploadRequests).toBe(2);
  });
  it('initializes a remote upload with an encrypted session URL and stable pre-generated file ID', async () => {
    const env = driveEnv(),
      connectionId = await seedConnection(env);
    mockGoogle((url, init) => {
      if (url.pathname.endsWith('/root')) return json(sampleFolder());
      if (url.pathname.endsWith('/generateIds')) return json({ ids: ['new-google-file'] });
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body)).id).toBe('new-google-file');
      expect(new Headers(init.headers).get('X-Upload-Content-Length')).toBe('3');
      return new Response(null, { headers: { Location: sessionUrl } });
    });
    const response = await driveCall('/uploads', 'POST', {
      connectionId,
      name: 'new.txt',
      parentId: 'root',
      size: 3,
      mime: 'text/plain',
    });
    expect(response.status).toBe(201);
    const result = await data<GoogleDriveUpload>(response);
    expect(result.chunkSize).toBe(16 * 1024 * 1024);
    expect(result.offset).toBe(0);
    expect(JSON.stringify(result)).not.toContain('upload_id');
    const row = await env.DB.prepare('SELECT session_cipher FROM google_drive_uploads WHERE id=?')
      .bind(result.id)
      .first<{ session_cipher: string }>();
    expect(row!.session_cipher).not.toContain('private-session-id');
    expect(await unseal(env, row!.session_cipher, 'upload:' + result.id)).toBe(sessionUrl);
    expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
    expect((await env.BUCKET.list()).objects).toHaveLength(0);
  });
  it('refuses an upload queued for a previous account before contacting Google', async () => {
    await seedConnection();
    const fetch = mockGoogle(() => json({}));
    expect(
      (
        await driveCall('/uploads', 'POST', {
          connectionId: crypto.randomUUID(),
          name: 'wrong.txt',
          size: 3,
        })
      ).status,
    ).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('creates zero-byte files without an ambiguous resumable status probe', async () => {
    const connectionId = await seedConnection();
    mockGoogle((url, init) => {
      if (url.pathname.endsWith('/root')) return json(sampleFolder());
      if (url.pathname.endsWith('/generateIds')) return json({ ids: ['new-google-file'] });
      expect(url.searchParams.get('uploadType')).toBe('multipart');
      expect(String(init.body)).toContain('empty.txt');
      return json(completeFile(0));
    });
    const result = await data<GoogleDriveUpload>(
      await driveCall('/uploads', 'POST', { connectionId, name: 'empty.txt', size: 0 }),
    );
    expect(result.complete).toBe(true);
    expect(result.file?.size).toBe('0');
  });
  it('does not accept foreign resumable URLs returned from upstream', async () => {
    const connectionId = await seedConnection();
    mockGoogle((url) =>
      url.pathname.endsWith('/root')
        ? json(sampleFolder())
        : url.pathname.endsWith('/generateIds')
          ? json({ ids: ['new-google-file'] })
          : new Response(null, {
              headers: { Location: 'https://evil.test/upload?upload_id=secret' },
            }),
    );
    expect(
      (await driveCall('/uploads', 'POST', { connectionId, name: 'file', size: 3 })).status,
    ).toBe(502);
    expect(await driveEnv().DB.prepare('SELECT * FROM google_drive_uploads').first()).toBeNull();
  });
  it('streams a final chunk with exact Content-Range and verifies its returned file identity', async () => {
    const { id } = await uploadSession();
    mockGoogle(async (_url, init) => {
      expect(init.method).toBe('PUT');
      expect(new Headers(init.headers).get('Content-Range')).toBe('bytes 0-2/3');
      expect(await new Response(init.body).text()).toBe('abc');
      return json(completeFile());
    });
    const result = await data<GoogleDriveUpload>(await put(id, 0));
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(3);
    expect(result.file?.id).toBe('new-google-file');
  });
  it('uses Google acknowledged bytes, not the number of bytes sent, as the next offset', async () => {
    const size = 512 * 1024,
      { id } = await uploadSession(size);
    mockGoogle(async (_url, init) => {
      await new Response(init.body).arrayBuffer();
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-131071' } });
    });
    const result = await data<GoogleDriveUpload>(await put(id, 0, new Uint8Array(256 * 1024)));
    expect(result.offset).toBe(128 * 1024);
    expect(result.complete).toBe(false);
  });
  it('recovers completion after the client lost the final response', async () => {
    const { id } = await uploadSession();
    mockGoogle((_url, init) => {
      expect(new Headers(init.headers).get('Content-Range')).toBe('bytes */3');
      return json(completeFile());
    });
    const result = await data<GoogleDriveUpload>(await driveCall('/uploads/' + id));
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(3);
    vi.restoreAllMocks();
    const fetch = mockGoogle(() => {
      throw new Error('Completed metadata should not poll Google');
    });
    expect((await data<GoogleDriveUpload>(await driveCall('/uploads/' + id))).complete).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects overlapping upload offsets before sending bytes to Google', async () => {
    const { id, env } = await uploadSession();
    await env.DB.prepare('UPDATE google_drive_uploads SET offset=2 WHERE id=?').bind(id).run();
    const fetch = mockGoogle(() => json({}));
    expect((await put(id, 0)).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not finalize an upload using a different file returned by Google', async () => {
    const { id, env } = await uploadSession();
    mockGoogle(() => json(sampleFile()));
    expect((await driveCall('/uploads/' + id)).status).toBe(502);
    expect(
      (await env.DB.prepare('SELECT result_json FROM google_drive_uploads WHERE id=?')
        .bind(id)
        .first<{ result_json: string | null }>())!.result_json,
    ).toBeNull();
  });
  it('rejects concurrent requests while a chunk is being processed', async () => {
    const { id, env } = await uploadSession();
    await env.DB.prepare('UPDATE google_drive_uploads SET owner=?,lock_until=? WHERE id=?')
      .bind('other-request', Date.now() + 60000, id)
      .run();
    const fetch = mockGoogle(() => json({}));
    const response = await driveCall('/uploads/' + id);
    expect(response.status).toBe(423);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not report cancellation when the final chunk has already completed remotely', async () => {
    const { id, env } = await uploadSession();
    mockGoogle(() => json(completeFile()));
    const result = await data<{ cancelled: boolean; complete: boolean }>(
      await driveCall('/uploads/' + id, 'DELETE'),
    );
    expect(result).toMatchObject({ cancelled: false, complete: true });
    expect(
      await env.DB.prepare('SELECT result_json FROM google_drive_uploads WHERE id=?')
        .bind(id)
        .first(),
    ).toBeTruthy();
  });
  it('cancels a confirmed partial session without deleting a remote file', async () => {
    const { id } = await uploadSession();
    const fetch = mockGoogle((_url, init) => {
      expect(init.method).toBe('PUT');
      return new Response(null, { status: 308 });
    });
    expect(await data(await driveCall('/uploads/' + id, 'DELETE'))).toEqual({ cancelled: true });
    expect((await driveCall('/uploads/' + id)).status).toBe(410);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains a session when cancellation cannot verify its remote state', async () => {
    const { id, env } = await uploadSession();
    mockGoogle(() => json({}, 503));
    expect((await driveCall('/uploads/' + id, 'DELETE')).status).toBe(502);
    expect(
      await env.DB.prepare('SELECT * FROM google_drive_uploads WHERE id=?').bind(id).first(),
    ).toBeTruthy();
  });
  it('does not mistake an equal-size old overwrite target for a completed expired upload', async () => {
    const { id } = await uploadSession();
    const fetch = mockGoogle(() => new Response(null, { status: 404 }));
    expect((await driveCall('/uploads/' + id)).status).toBe(410);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('disconnect removes local upload access without deleting Google files', async () => {
    const { id, env } = await uploadSession();
    const fetch = mockGoogle(() => json({}));
    expect((await driveCall('/connection', 'DELETE')).status).toBe(200);
    expect((await driveCall('/uploads/' + id)).status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT * FROM google_drive_connections').first()).toBeNull();
  });
  it('cleans expired state locally without invoking any Google deletion', async () => {
    const { id, env } = await uploadSession();
    await env.DB.prepare('UPDATE google_drive_uploads SET expires_at=0 WHERE id=?').bind(id).run();
    const fetch = mockGoogle(() => json({}));
    await cleanupGoogleDrive(env);
    expect(await env.DB.prepare('SELECT * FROM google_drive_uploads').first()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
