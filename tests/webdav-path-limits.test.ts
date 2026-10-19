import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { data, request } from './helpers';

async function credential() {
  return data<{ password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'Path limits' }),
  );
}

function dav(
  password: string,
  path: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  return app.request(
    'http://localhost/dav/' + path.split('/').map(encodeURIComponent).join('/'),
    {
      method,
      headers: {
        Authorization: 'Basic ' + btoa('rcloud:' + password),
        ...(body === undefined
          ? {}
          : { 'Content-Length': String(new TextEncoder().encode(body).length) }),
        ...headers,
      },
      body,
    },
    testEnv,
  );
}

async function nestedTarget(depth: number) {
  return targetInside(Array.from({ length: depth }, (_, i) => 'level' + i));
}

async function targetInside(names: string[]) {
  let parentId: string | null = null;
  for (const name of names) {
    const id = crypto.randomUUID();
    await testEnv.DB.prepare(
      'INSERT INTO folders(id,name,parent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
      .bind(id, name, parentId, Date.now(), Date.now())
      .run();
    parentId = id;
  }
  return names.join('/') + '/target';
}

describe('WebDAV preserves addressable paths after moving and copying folders', () => {
  it.each(['MOVE', 'COPY'])(
    'rejects %s if a descendant would exceed the supported path depth',
    async (method) => {
      const { password } = await credential();
      expect((await dav(password, 'source/', 'MKCOL')).status).toBe(201);
      expect((await dav(password, 'source/child.txt', 'PUT', 'retained')).status).toBe(201);
      const target = await nestedTarget(31);
      const response = await dav(password, 'source/', method, undefined, {
        Destination: '/dav/' + target,
      });
      expect(response.status).toBe(409);
      expect((await dav(password, 'source/child.txt', 'GET')).status).toBe(200);
      expect((await dav(password, target, 'PROPFIND')).status).toBe(404);
    },
  );

  it.each(['MOVE', 'COPY'])(
    'allows %s when the deepest descendant is exactly at the path depth limit',
    async (method) => {
      const { password } = await credential();
      await dav(password, 'source/', 'MKCOL');
      await dav(password, 'source/child.txt', 'PUT', 'readable');
      const target = await nestedTarget(30);
      expect(
        (
          await dav(password, 'source/', method, undefined, {
            Destination: '/dav/' + target,
          })
        ).status,
      ).toBe(201);
      expect(await (await dav(password, target + '/child.txt', 'GET')).text()).toBe('readable');
    },
  );

  it('copies only the collection at Depth 0 even when its children would exceed the limit', async () => {
    const { password } = await credential();
    await dav(password, 'source/', 'MKCOL');
    await dav(password, 'source/child.txt', 'PUT', 'source');
    const target = await nestedTarget(31);
    expect(
      (
        await dav(password, 'source/', 'COPY', undefined, {
          Destination: '/dav/' + target,
          Depth: '0',
        })
      ).status,
    ).toBe(201);
    expect((await dav(password, target, 'PROPFIND', undefined, { Depth: '0' })).status).toBe(207);
    expect(await (await dav(password, 'source/child.txt', 'GET')).text()).toBe('source');
  });

  it('rejects a too-deep empty subfolder without replacing an existing destination', async () => {
    const { password } = await credential();
    await dav(password, 'source/', 'MKCOL');
    await dav(password, 'source/child/', 'MKCOL');
    const target = await nestedTarget(31);
    await dav(password, target, 'PUT', 'destination');
    expect(
      (
        await dav(password, 'source/', 'MOVE', undefined, {
          Destination: '/dav/' + target,
        })
      ).status,
    ).toBe(409);
    expect(await (await dav(password, target, 'GET')).text()).toBe('destination');
    expect(
      (await dav(password, 'source/child/', 'PROPFIND', undefined, { Depth: '0' })).status,
    ).toBe(207);
  });

  it.each(['MOVE', 'COPY'])(
    'rejects %s when an encoded descendant URI would exceed the path length limit',
    async (method) => {
      const { password } = await credential();
      await dav(password, 'source/', 'MKCOL');
      const child = '中'.repeat(8) + ' % ' + 'a'.repeat(22);
      await dav(password, 'source/' + child, 'PUT', 'source');
      const target = await targetInside(
        Array.from({ length: 22 }, (_, i) => String(i).padStart(3, '0') + 'a'.repeat(177)),
      );
      expect(('/dav/' + target + '/' + encodeURIComponent(child)).length).toBe(4097);
      expect(
        (
          await dav(password, 'source/', method, undefined, {
            Destination: '/dav/' + target,
          })
        ).status,
      ).toBe(409);
      expect(await (await dav(password, 'source/' + child, 'GET')).text()).toBe('source');
      expect((await dav(password, target, 'PROPFIND')).status).toBe(404);
    },
  );

  it('keeps a mixed encoded descendant readable at exactly 4096 URL characters', async () => {
    const { password } = await credential();
    await dav(password, 'source/', 'MKCOL');
    const child = '中'.repeat(8) + ' % ' + 'a'.repeat(21);
    await dav(password, 'source/' + child, 'PUT', 'boundary');
    const target = await targetInside(
      Array.from({ length: 22 }, (_, i) => String(i).padStart(3, '0') + 'a'.repeat(177)),
    );
    expect(('/dav/' + target + '/' + encodeURIComponent(child)).length).toBe(4096);
    expect(
      (
        await dav(password, 'source/', 'MOVE', undefined, {
          Destination: '/dav/' + target,
        })
      ).status,
    ).toBe(201);
    expect(await (await dav(password, target + '/' + child, 'GET')).text()).toBe('boundary');
  });

  it('includes the collection trailing slash in the path length limit', async () => {
    const { password } = await credential();
    await dav(password, 'source/', 'MKCOL');
    const target = (
      await targetInside(
        Array.from({ length: 22 }, (_, i) => String(i).padStart(3, '0') + 'a'.repeat(177)),
      )
    ).replace(/target$/, 'b'.repeat(109));
    expect(('/dav/' + target).length).toBe(4096);
    expect((await dav(password, target, 'MKCOL')).status).toBe(414);
    for (const method of ['MOVE', 'COPY'])
      expect(
        (
          await dav(password, 'source/', method, undefined, {
            Destination: '/dav/' + target,
            ...(method === 'COPY' ? { Depth: '0' } : {}),
          })
        ).status,
      ).toBe(409);
  });
});
