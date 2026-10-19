import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { GoogleDriveListing, GoogleDriveStatus } from '../shared/google-drive';
afterEach(() => vi.restoreAllMocks());

describe('Google Drive independent file operations', () => {
  it.each([
    ['/folders', 'POST', { name: 'wrong-account' }],
    ['/files/file-123', 'PATCH', { name: 'wrong-account' }],
    ['/files/file-123', 'DELETE', undefined],
    ['/connection', 'DELETE', undefined],
    ['/connect', 'POST', undefined],
  ])('rejects stale-account write %s %s before contacting Google', async (path, method, body) => {
    const env = driveEnv(),
      id = await seedConnection(env),
      fetch = mockGoogle(() => json({}));
    const { app } = await import('../worker/index');
    const response = await app.request(
      'http://localhost/api/admin/google-drive' + path,
      {
        method: String(method),
        headers: {
          Origin: 'http://localhost',
          'X-Drive-Request': '1',
          'X-Google-Connection': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await env.DB.prepare('SELECT connection_id FROM google_drive_connections').first<{
        connection_id: string;
      }>())!.connection_id,
    ).toBe(id);
  });
  it.each(['"old-entity-tag"', 'Mon, 01 Jan 2024 00:00:00 GMT'])(
    'returns a complete representation for an unprovable If-Range validator %s',
    async (validator) => {
      const env = driveEnv();
      await seedConnection(env);
      mockGoogle((url, init) => {
        if (url.searchParams.get('alt') === 'media') {
          expect(new Headers(init.headers).has('Range')).toBe(false);
          return new Response('new-complete-file');
        }
        return json(sampleFile());
      });
      const { app } = await import('../worker/index');
      const response = await app.request(
        'http://localhost/api/admin/google-drive/files/file-123/download',
        { headers: { Range: 'bytes=1-2', 'If-Range': validator } },
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('new-complete-file');
    },
  );
  it('pages Google metadata without mirroring it into the R2 file table', async () => {
    const env = driveEnv();
    await seedConnection(env);
    mockGoogle((url) => {
      expect(url.searchParams.get('pageToken')).toBe('page-next');
      expect(url.searchParams.get('pageSize')).toBe('100');
      expect(url.searchParams.get('q')).toBe(
        "trashed = false and 'root' in parents and name contains 'a\\\'b\\\\c'",
      );
      return json({
        files: [sampleFile(), sampleFile({ id: 'another-id' })],
        nextPageToken: 'later-page',
      });
    });
    const response = await data<GoogleDriveListing>(
      await driveCall('/files?q=' + encodeURIComponent("a'b\\c") + '&page_token=page-next'),
    );
    expect(response.files.map((f) => f.id)).toEqual(['file-123', 'another-id']);
    expect(response.nextPageToken).toBe('later-page');
    expect(await env.DB.prepare('SELECT * FROM files').first()).toBeNull();
    expect((await env.BUCKET.list()).objects).toHaveLength(0);
  });
  it('lists the Google recycle bin without filtering it to My Drive root', async () => {
    await seedConnection();
    mockGoogle((url) => {
      expect(url.searchParams.get('q')).toBe('trashed = true');
      return json({ files: [] });
    });
    expect((await driveCall('/files?trashed=1')).status).toBe(200);
  });
  it('adds a folder only under a writable folder', async () => {
    await seedConnection();
    mockGoogle((url, init) => {
      if (url.pathname.endsWith('/root')) return json(sampleFolder());
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        name: '新目录',
        parents: ['root'],
        mimeType: 'application/vnd.google-apps.folder',
      });
      return json(sampleFolder('new-folder'));
    });
    expect((await driveCall('/folders', 'POST', { name: '新目录', parentId: 'root' })).status).toBe(
      201,
    );
  });
  it('refuses uploading a folder into a read-only parent', async () => {
    await seedConnection();
    const fetch = mockGoogle(() => json(sampleFolder('readonly-folder') as object));
    fetch.mockImplementation(async () =>
      json(
        sampleFile({
          id: 'readonly-folder',
          mimeType: 'application/vnd.google-apps.folder',
          capabilities: { canAddChildren: false },
        }),
      ),
    );
    expect(
      (await driveCall('/folders', 'POST', { name: 'No', parentId: 'readonly-folder' })).status,
    ).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('moves by stable ID and changes only the requested metadata', async () => {
    await seedConnection();
    mockGoogle((url, init) => {
      if (init.method === 'PATCH') {
        expect(url.searchParams.get('addParents')).toBe('folder-new');
        expect(url.searchParams.get('removeParents')).toBe('folder-old');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'renamed.txt' });
        return json(sampleFile({ name: 'renamed.txt', parents: ['folder-new'] }));
      }
      return json(url.pathname.endsWith('/folder-new') ? sampleFolder('folder-new') : sampleFile());
    });
    expect(
      (await driveCall('/files/file-123', 'PATCH', { name: 'renamed.txt', parentId: 'folder-new' }))
        .status,
    ).toBe(200);
  });
  it.each([true, false])('moves into and restores from Google trash: %s', async (trashed) => {
    await seedConnection();
    mockGoogle((_url, init) => {
      if (init.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ trashed });
        return json(sampleFile({ trashed }));
      }
      return json(sampleFile({ trashed: !trashed }));
    });
    expect((await driveCall('/files/file-123', 'PATCH', { trashed })).status).toBe(200);
  });
  it('does not send a mutation when Google reports no capability', async () => {
    await seedConnection();
    const fetch = mockGoogle(() => json(sampleFile({ capabilities: { canRename: false } })));
    expect((await driveCall('/files/file-123', 'PATCH', { name: 'denied' })).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires trash before permanent deletion', async () => {
    await seedConnection();
    const fetch = mockGoogle(() => json(sampleFile()));
    expect((await driveCall('/files/file-123', 'DELETE')).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('permanently deletes only an explicitly selected trashed item', async () => {
    await seedConnection();
    mockGoogle((url, init) => {
      expect(url.pathname).toBe('/drive/v3/files/file-123');
      return init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(sampleFile({ trashed: true }));
    });
    expect((await driveCall('/files/file-123', 'DELETE')).status).toBe(200);
  });
  it('streams files as attachments and preserves range response metadata', async () => {
    const env = driveEnv();
    await seedConnection(env);
    mockGoogle((url, init) => {
      if (url.searchParams.get('alt') === 'media') {
        expect(new Headers(init.headers).get('Range')).toBe('bytes=1-2');
        return new Response('bc', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 1-2/3',
            'Content-Length': '2',
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return json(sampleFile({ name: '文件.html', mimeType: 'text/html' }));
    });
    const { app } = await import('../worker/index');
    const response = await app.request(
      'http://localhost/api/admin/google-drive/files/file-123/download',
      { headers: { Range: 'bytes=1-2' } },
      env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 1-2/3');
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(await response.text()).toBe('bc');
  });
  it('serves HEAD without a response body', async () => {
    await seedConnection();
    mockGoogle((url) =>
      url.searchParams.get('alt') === 'media'
        ? new Response('abc', { headers: { 'Content-Length': '3' } })
        : json(sampleFile()),
    );
    const response = await driveCall('/files/file-123/download', 'HEAD');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Length')).toBe('3');
  });
  it('exports Google documents using the selected allowlisted format', async () => {
    await seedConnection();
    mockGoogle((url) => {
      if (url.pathname.endsWith('/export')) {
        expect(url.searchParams.get('mimeType')).toBe('application/pdf');
        return new Response('pdfbytes');
      }
      return json(sampleFile({ mimeType: 'application/vnd.google-apps.document' }));
    });
    const response = await driveCall('/files/file-123/download?format=pdf');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(await response.text()).toBe('pdfbytes');
  });
  it('rejects unspecified or arbitrary Google document export formats', async () => {
    await seedConnection();
    const fetch = mockGoogle(() =>
      json(sampleFile({ mimeType: 'application/vnd.google-apps.document' })),
    );
    expect((await driveCall('/files/file-123/download?format=arbitrary')).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [429, 'rateLimitExceeded', 429],
    [403, 'storageQuotaExceeded', 409],
    [403, 'exportSizeLimitExceeded', 413],
    [500, 'backendError', 502],
  ])(
    'maps Google failure %s/%s without exposing provider details',
    async (status, reason, expected) => {
      await seedConnection();
      mockGoogle(() =>
        json(
          { error: { message: 'private provider message', errors: [{ reason }] } },
          Number(status),
        ),
      );
      const response = await driveCall('/files');
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain('private provider message');
    },
  );
  it('keeps the account page available after a refresh token has been revoked', async () => {
    await seedConnection(driveEnv(), 0);
    mockGoogle(() => json({ error: 'invalid_grant' }, 400));
    const status = await data<GoogleDriveStatus>(await driveCall(''));
    expect(status.connected).toBe(true);
    expect(status.needsReconnect).toBe(true);
    expect(status.connectionId).toBeTruthy();
    expect(status.account?.emailAddress).toBe('test@example.test');
  });
});
