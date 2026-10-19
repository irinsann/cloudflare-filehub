import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request } from './helpers';
import { testEnv } from './setup';

async function credential() {
  return data<{ password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'Client compatibility' }),
  );
}

function dav(
  password: string,
  path: string,
  method = 'GET',
  body?: string | Uint8Array,
  headers: Record<string, string> = {},
) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return app.request(
    'http://localhost/dav/' + path,
    {
      method,
      headers: {
        Authorization: 'Basic ' + btoa('rcloud:' + password),
        ...(bytes ? { 'Content-Length': String(bytes.byteLength) } : {}),
        ...headers,
      },
      body: bytes?.slice().buffer,
    },
    testEnv,
  );
}

describe('WebDAV desktop client conditional writes and temporary-file saves', () => {
  it.each(['PUT', 'DELETE', 'MOVE'])(
    'refuses a stale If-Unmodified-Since before %s changes a file',
    async (method) => {
      const { password } = await credential();
      await dav(password, 'document.txt', 'PUT', 'newer server version');
      const response = await dav(
        password,
        'document.txt',
        method,
        method === 'PUT' ? 'stale local version' : undefined,
        {
          'If-Unmodified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT',
          ...(method === 'MOVE' ? { Destination: '/dav/renamed.txt' } : {}),
        },
      );
      expect(response.status).toBe(412);
      expect(await (await dav(password, 'document.txt')).text()).toBe('newer server version');
    },
  );

  it.each(['MOVE', 'COPY'])(
    'recognizes a signature-verified image saved through a temporary name using %s',
    async (method) => {
      const { password } = await credential();
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
      expect((await dav(password, 'temporary.tmp', 'PUT', png)).status).toBe(201);
      expect(
        (
          await dav(password, 'temporary.tmp', method, undefined, {
            Destination: '/dav/photo.png',
          })
        ).status,
      ).toBe(201);
      const file = await testEnv.DB.prepare(
        "SELECT id,mime FROM files WHERE name='photo.png' AND deleted_at IS NULL",
      ).first<{ id: string; mime: string }>();
      expect(file?.mime).toBe('image/png');
      const preview = await request('/api/admin/files/' + file!.id + '/download?preview=1');
      expect(preview.headers.get('Content-Type')).toBe('image/png');
      expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
    },
  );

  it('uses a matching If-Match in preference to an older date condition', async () => {
    const { password } = await credential();
    const created = await dav(password, 'document.txt', 'PUT', 'original');
    expect(
      (
        await dav(password, 'document.txt', 'PUT', 'new version', {
          'If-Match': created.headers.get('ETag')!,
          'If-Unmodified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await dav(password, 'document.txt', 'DELETE', undefined, {
          'If-Match': created.headers.get('ETag')!,
          'If-Unmodified-Since': 'Fri, 01 Jan 2100 00:00:00 GMT',
        })
      ).status,
    ).toBe(412);
    expect(await (await dav(password, 'document.txt')).text()).toBe('new version');
  });

  it.each([
    'not a date',
    '2000-01-01T00:00:00.000Z',
    'Sat, 01 Jan 2000 00:00:00 GMT, Sun, 02 Jan 2000 00:00:00 GMT',
    'Mon, 30 Feb 2026 00:00:00 GMT',
  ])('ignores an invalid HTTP date: %s', async (invalid) => {
    const { password } = await credential();
    await dav(password, 'document.txt', 'PUT', 'original');
    expect(
      (
        await dav(password, 'document.txt', 'PUT', 'updated', {
          'If-Unmodified-Since': invalid,
        })
      ).status,
    ).toBe(204);
  });

  it.each([
    'Mon, 19 Oct 2026 12:00:00 GMT',
    'Monday, 19-Oct-26 12:00:00 GMT',
    'Mon Oct 19 12:00:00 2026',
  ])('accepts the same modification second using HTTP date %s', async (date) => {
    const { password } = await credential();
    await dav(password, 'document.txt', 'PUT', 'original');
    await testEnv.DB.prepare("UPDATE files SET updated_at=? WHERE name='document.txt'")
      .bind(Date.UTC(2026, 9, 19, 12, 0, 0, 999))
      .run();
    expect(
      (
        await dav(password, 'document.txt', 'PUT', 'same-second allowed', {
          'If-Unmodified-Since': date,
        })
      ).status,
    ).toBe(204);
    await testEnv.DB.prepare("UPDATE files SET updated_at=? WHERE name='document.txt'")
      .bind(Date.UTC(2026, 9, 19, 12, 0, 1))
      .run();
    expect(
      (
        await dav(password, 'document.txt', 'PUT', 'next-second rejected', {
          'If-Unmodified-Since': date,
        })
      ).status,
    ).toBe(412);
    expect(await (await dav(password, 'document.txt')).text()).toBe('same-second allowed');
  });

  it.each(['MOVE', 'COPY'])(
    'does not promote invalid image bytes when a temporary file is saved with %s',
    async (method) => {
      const { password } = await credential();
      await dav(password, 'temporary.tmp', 'PUT', 'not an image');
      expect(
        (
          await dav(password, 'temporary.tmp', method, undefined, {
            Destination: '/dav/photo.png',
          })
        ).status,
      ).toBe(201);
      expect((await dav(password, 'photo.png')).headers.get('Content-Type')).toBe(
        'application/octet-stream',
      );
    },
  );

  it('retains a verified image content type when changing its filename extension', async () => {
    const { password } = await credential();
    await dav(
      password,
      'photo.png',
      'PUT',
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
    );
    expect(
      (await dav(password, 'photo.png', 'MOVE', undefined, { Destination: '/dav/photo.txt' }))
        .status,
    ).toBe(201);
    expect((await dav(password, 'photo.txt')).headers.get('Content-Type')).toBe('image/png');
  });

  it('recognizes text uploaded under a temporary filename after moving it into place', async () => {
    const { password } = await credential();
    await dav(password, 'temporary.tmp', 'PUT', 'text preview');
    expect(
      (await dav(password, 'temporary.tmp', 'MOVE', undefined, { Destination: '/dav/note.txt' }))
        .status,
    ).toBe(201);
    expect((await dav(password, 'note.txt')).headers.get('Content-Type')).toBe('text/plain');
  });

  it('keeps a destination lock usable across a temporary-file replacement and Windows property update', async () => {
    const { password } = await credential();
    await dav(password, 'document.txt', 'PUT', 'original');
    const lock = await dav(
      password,
      'document.txt',
      'LOCK',
      '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      { Depth: '0' },
    );
    expect(lock.status).toBe(200);
    const token = lock.headers.get('Lock-Token')!;
    await dav(password, 'temporary.tmp', 'PUT', 'replacement');
    expect(
      (
        await dav(password, 'temporary.tmp', 'MOVE', undefined, {
          Destination: '/dav/document.txt',
          If: `</dav/document.txt> (${token})`,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await dav(password, 'document.txt', 'LOCK', undefined, {
          If: `(${token})`,
          Timeout: 'Second-1200',
        })
      ).status,
    ).toBe(200);
    const properties =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop>' +
      '<Z:Win32CreationTime>Sun, 18 Oct 2026 12:00:00 GMT</Z:Win32CreationTime>' +
      '<Z:Win32LastModifiedTime>Mon, 19 Oct 2026 12:00:00 GMT</Z:Win32LastModifiedTime>' +
      '<Z:Win32FileAttributes>00000020</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>';
    expect(
      (
        await dav(password, 'document.txt', 'PROPPATCH', properties, {
          If: `(${token})`,
        })
      ).status,
    ).toBe(207);
    const listed = await dav(password, 'document.txt', 'PROPFIND', undefined, { Depth: '0' });
    expect(await listed.text()).toContain('Mon, 19 Oct 2026 12:00:00 GMT');
    expect((await dav(password, 'document.txt', 'PUT', 'blocked')).status).toBe(423);
    expect(
      (
        await dav(password, 'document.txt', 'UNLOCK', undefined, {
          'Lock-Token': token,
        })
      ).status,
    ).toBe(204);
    expect(await (await dav(password, 'document.txt')).text()).toBe('replacement');
  });
});
