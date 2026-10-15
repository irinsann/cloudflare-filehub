import { describe, expect, it, vi } from 'vitest';
import { SaxesParser } from 'saxes';
import { app } from '../worker/index';
import type { Env } from '../worker/env';
import { STORAGE_LIMIT } from '../worker/quota';
import { data, request } from './helpers';
import { testEnv } from './setup';

async function credential() {
  return data<{ credential: { id: string }; password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'Protocol regression' }),
  );
}
function dav(
  password: string,
  path: string,
  method = 'GET',
  body?: string,
  headers: Record<string, string> = {},
  env: Env = testEnv,
) {
  return app.request(
    'http://localhost/dav/' + path,
    {
      method,
      headers: {
        Authorization: 'Basic ' + btoa('rcloud:' + password),
        ...(body === undefined
          ? {}
          : {
              'Content-Length': String(new TextEncoder().encode(body).length),
              'Content-Type': 'application/xml',
            }),
        ...headers,
      },
      body,
    },
    env,
  );
}
const lockBody =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>mailto:client@example.test</D:href></D:owner></D:lockinfo>';
function xmlProperties(source: string) {
  const values = new Map<string, string>();
  const stack: { namespace: string; name: string; text: string }[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => stack.push({ namespace: tag.uri, name: tag.local, text: '' }));
  parser.on('text', (value) => {
    if (stack.length) stack.at(-1)!.text += value;
  });
  parser.on('closetag', () => {
    const value = stack.pop()!;
    values.set(JSON.stringify([value.namespace, value.name]), value.text);
  });
  parser.write(source).close();
  return (namespace: string, name: string) => values.get(JSON.stringify([namespace, name]));
}

describe('WebDAV conditional requests, locks and property integrity', () => {
  it('evaluates an untagged If against the source when copying and moving a locked file', async () => {
    const { password } = await credential();
    await dav(password, 'source.txt', 'PUT', 'original');
    const locked = await dav(password, 'source.txt', 'LOCK', lockBody, { Depth: '0' });
    const token = locked.headers.get('Lock-Token')!;
    expect(
      (
        await dav(password, 'source.txt', 'COPY', undefined, {
          Destination: '/dav/copy.txt',
          If: `(${token})`,
        })
      ).status,
    ).toBe(201);
    expect((await dav(password, 'copy.txt', 'PUT', 'independent')).status).toBe(204);
    expect(
      (
        await dav(password, 'source.txt', 'MOVE', undefined, {
          Destination: '/dav/moved.txt',
          If: `(${token})`,
        })
      ).status,
    ).toBe(201);
    expect((await dav(password, 'moved.txt', 'PUT', 'unlocked')).status).toBe(204);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_locks').first<number>('n'),
    ).toBe(0);
  });

  it.each(['COPY', 'MOVE'])(
    'retains the destination root lock after %s overwrites a file',
    async (method) => {
      const { password } = await credential();
      await dav(password, 'source.txt', 'PUT', 'source bytes');
      await dav(password, 'target.txt', 'PUT', 'target bytes');
      const locked = await dav(password, 'target.txt', 'LOCK', lockBody, { Depth: '0' });
      const token = locked.headers.get('Lock-Token')!;
      // The token's first condition is false for the source, but it is still submitted.
      expect(
        (
          await dav(password, 'source.txt', method, undefined, {
            Destination: '/dav/target.txt',
            If: `(${token}) (Not <DAV:no-lock>)`,
          })
        ).status,
      ).toBe(204);
      expect(await (await dav(password, 'target.txt')).text()).toBe('source bytes');
      expect((await dav(password, 'target.txt', 'PUT', 'blocked')).status).toBe(423);
      expect(
        (await dav(password, 'target.txt', 'PUT', 'allowed', { If: `(${token})` })).status,
      ).toBe(204);
    },
  );

  it('combines tagged If resource lists with OR and validates If on reads and new locks', async () => {
    const { password } = await credential();
    await dav(password, 'item.txt', 'PUT', 'data');
    const ifHeader = '</dav/absent> (["missing"]) </dav/item.txt> (Not <DAV:no-lock>)';
    expect((await dav(password, 'item.txt', 'GET', undefined, { If: ifHeader })).status).toBe(200);
    expect((await dav(password, 'item.txt', 'GET', undefined, { If: '(["wrong"])' })).status).toBe(
      412,
    );
    expect((await dav(password, 'item.txt', 'LOCK', lockBody, { If: '(["wrong"])' })).status).toBe(
      412,
    );
    expect(
      (
        await dav(password, 'item.txt', 'GET', undefined, {
          If: '(Not <DAV:no-lock>) </dav/item.txt> (Not <DAV:no-lock>)',
        })
      ).status,
    ).toBe(400);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_locks').first<number>('n'),
    ).toBe(0);
  });

  it('accepts configured public aliases for Destination and tagged If without accepting other hosts', async () => {
    const { password } = await credential();
    const env = {
      ...testEnv,
      ADMIN_ORIGIN: 'https://233334.xyz',
      TRUSTED_PROXY_ORIGINS: 'https://s.irin.im',
    };
    await dav(password, 'source.txt', 'PUT', 'content');
    const locked = await dav(password, 'source.txt', 'LOCK', lockBody, { Depth: '0' });
    const token = locked.headers.get('Lock-Token')!;
    expect(
      (
        await dav(
          password,
          'source.txt',
          'COPY',
          undefined,
          {
            Destination: 'https://s.irin.im/dav/copied.txt',
            If: ` <https://233334.xyz/dav/source.txt> (${token})`,
          },
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await dav(
          password,
          'source.txt',
          'MOVE',
          undefined,
          {
            Destination: 'https://233334.xyz/dav/moved.txt',
            If: `<https://s.irin.im/dav/source.txt> (${token})`,
          },
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await dav(
          password,
          'moved.txt',
          'COPY',
          undefined,
          { Destination: 'https://evil.example/dav/out.txt' },
          env,
        )
      ).status,
    ).toBe(502);
    expect(
      (
        await dav(
          password,
          'moved.txt',
          'GET',
          undefined,
          { If: '<https://evil.example/dav/moved.txt> (Not <DAV:no-lock>)' },
          env,
        )
      ).status,
    ).toBe(412);
    expect(
      (
        await dav(
          password,
          'moved.txt',
          'COPY',
          undefined,
          { Destination: 'https://user@s.irin.im/dav/out.txt' },
          env,
        )
      ).status,
    ).toBe(502);
    expect(
      (
        await dav(
          password,
          'moved.txt',
          'GET',
          undefined,
          { If: '<https://s.irin.im/dav/moved.txt?query=1> (Not <DAV:no-lock>)' },
          env,
        )
      ).status,
    ).toBe(412);
  });

  it('removes overwritten descendant locks while retaining the destination collection root lock', async () => {
    const { password } = await credential();
    await dav(password, 'source/', 'MKCOL');
    await dav(password, 'source/new.txt', 'PUT', 'new');
    await dav(password, 'target/', 'MKCOL');
    await dav(password, 'target/old.txt', 'PUT', 'old');
    const rootLock = await dav(password, 'target/', 'LOCK', lockBody, { Depth: '0' });
    const childLock = await dav(password, 'target/old.txt', 'LOCK', lockBody, { Depth: '0' });
    const rootToken = rootLock.headers.get('Lock-Token')!;
    const childToken = childLock.headers.get('Lock-Token')!;
    expect(
      (
        await dav(password, 'source/', 'COPY', undefined, {
          Destination: '/dav/target/',
          If: `</dav/target/> (${rootToken}) </dav/target/old.txt> (${childToken})`,
        })
      ).status,
    ).toBe(204);
    expect((await dav(password, 'target/old.txt')).status).toBe(404);
    expect(await (await dav(password, 'target/new.txt')).text()).toBe('new');
    expect(
      (
        await testEnv.DB.prepare('SELECT token FROM webdav_locks').all<{ token: string }>()
      ).results.map((row) => row.token),
    ).toEqual([rootToken.slice(1, -1)]);
    expect((await dav(password, 'target/another.txt', 'PUT', 'blocked')).status).toBe(423);
  });

  it('does not bypass inherited locks using a differently cased parent path for new resources', async () => {
    const { password } = await credential();
    await dav(password, 'Folder/', 'MKCOL');
    await dav(password, 'source.txt', 'PUT', 'source');
    const locked = await dav(password, 'Folder/', 'LOCK', lockBody, { Depth: 'infinity' });
    const token = locked.headers.get('Lock-Token')!;
    expect((await dav(password, 'folder/new.txt', 'PUT', 'blocked')).status).toBe(423);
    expect((await dav(password, 'folder/nested/', 'MKCOL')).status).toBe(423);
    expect(
      (
        await dav(password, 'source.txt', 'COPY', undefined, {
          Destination: '/dav/folder/copy.txt',
        })
      ).status,
    ).toBe(423);
    expect(
      (await dav(password, 'folder/new.txt', 'PUT', 'allowed', { If: `</dav/Folder/> (${token})` }))
        .status,
    ).toBe(201);
  });

  it('preserves DAV href owners and permits refresh and unlock from a member of a lock scope', async () => {
    const { password } = await credential();
    await dav(password, 'folder/', 'MKCOL');
    await dav(password, 'folder/child.txt', 'PUT', 'child');
    const locked = await dav(password, 'folder/', 'LOCK', lockBody, { Depth: 'infinity' });
    const token = locked.headers.get('Lock-Token')!;
    expect(await locked.text()).toContain(
      '<D:owner><D:href>mailto:client@example.test</D:href></D:owner>',
    );
    const refreshed = await dav(password, 'folder/child.txt', 'LOCK', undefined, {
      If: `(${token})`,
      Timeout: 'Second-1200',
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get('Lock-Token')).toBeNull();
    const properties = xmlProperties(await refreshed.text());
    expect(properties('DAV:', 'timeout')).toBe('Second-1200');
    expect(
      (await dav(password, 'folder/child.txt', 'UNLOCK', undefined, { 'Lock-Token': token }))
        .status,
    ).toBe(204);
    expect((await dav(password, 'folder/child.txt', 'PUT', 'updated')).status).toBe(204);
  });

  it('commits an unmapped LOCK file and its lock together when the database rejects the lock', async () => {
    const { password } = await credential();
    await testEnv.DB.prepare(
      "CREATE TRIGGER test_reject_dav_lock BEFORE INSERT ON webdav_locks BEGIN SELECT RAISE(ABORT,'simulated lock write failure'); END",
    ).run();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await dav(password, 'atomic.txt', 'LOCK', lockBody)).status).toBe(500);
      expect(
        await testEnv.DB.prepare("SELECT id FROM files WHERE name='atomic.txt'").first(),
      ).toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_locks').first<number>('n'),
      ).toBe(0);
    } finally {
      logged.mockRestore();
      await testEnv.DB.prepare('DROP TRIGGER test_reject_dav_lock').run();
    }
  });

  it.each(['credential', 'lease'])(
    'rechecks the %s after storing an unmapped LOCK resource',
    async (invalidated) => {
      const created = await credential();
      const bucket = new Proxy(testEnv.BUCKET, {
        get(target, property) {
          if (property === 'put')
            return async (...args: Parameters<R2Bucket['put']>) => {
              const object = await target.put(...args);
              if (invalidated === 'credential')
                await testEnv.DB.prepare('UPDATE webdav_credentials SET revoked_at=? WHERE id=?')
                  .bind(Date.now(), created.credential.id)
                  .run();
              else
                await testEnv.DB.prepare(
                  'UPDATE storage_write_lease SET expires_at=0 WHERE id=1',
                ).run();
              return object;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const response = await dav(
        created.password,
        'cancelled.txt',
        'LOCK',
        lockBody,
        {},
        { ...testEnv, BUCKET: bucket },
      );
      expect(response.status).toBe(invalidated === 'credential' ? 401 : 423);
      expect(
        await testEnv.DB.prepare("SELECT id FROM files WHERE name='cancelled.txt'").first(),
      ).toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_locks').first<number>('n'),
      ).toBe(0);
    },
  );

  it('keeps namespace identities distinct and emits valid XML for unqualified and xml properties', async () => {
    const { password } = await credential();
    await dav(password, 'properties.txt', 'PUT', 'data');
    const patch =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:A="urn:a" xmlns:B="urn:ab"><D:set><D:prop><A:bc>first</A:bc><B:c>second</B:c><plain>none</plain><xml:lang>zh</xml:lang></D:prop></D:set></D:propertyupdate>';
    const written = await dav(password, 'properties.txt', 'PROPPATCH', patch);
    expect(written.status).toBe(207);
    xmlProperties(await written.text());
    const read = await dav(password, 'properties.txt', 'PROPFIND', undefined, { Depth: '0' });
    expect(read.status).toBe(207);
    const values = xmlProperties(await read.text());
    expect(values('urn:a', 'bc')).toBe('first');
    expect(values('urn:ab', 'c')).toBe('second');
    expect(values('', 'plain')).toBe('none');
    expect(values('http://www.w3.org/XML/1998/namespace', 'lang')).toBe('zh');
  });

  it('selects only listed resources before applying the property response limit and copies folder properties', async () => {
    const { password } = await credential();
    await testEnv.DB.prepare(
      "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10002) INSERT INTO webdav_properties(resource_id,namespace,name,value) SELECT 'unrelated','urn:unrelated','p'||n,'not listed' FROM seq",
    ).run();
    await dav(password, 'folder/', 'MKCOL');
    const patch =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:custom"><D:set><D:prop><C:label>folder value</C:label></D:prop></D:set></D:propertyupdate>';
    expect((await dav(password, 'folder/', 'PROPPATCH', patch)).status).toBe(207);
    const read = await dav(password, 'folder/', 'PROPFIND', undefined, { Depth: '0' });
    expect(read.status).toBe(207);
    expect(xmlProperties(await read.text())('urn:custom', 'label')).toBe('folder value');
    expect(
      (
        await dav(password, 'folder/', 'COPY', undefined, {
          Destination: '/dav/copied/',
          Depth: '0',
        })
      ).status,
    ).toBe(201);
    const copied = await dav(password, 'copied/', 'PROPFIND', undefined, { Depth: '0' });
    expect(xmlProperties(await copied.text())('urn:custom', 'label')).toBe('folder value');
  });

  it('batches many dead properties while preserving ordered set/remove semantics', async () => {
    const { password } = await credential();
    await dav(password, 'many.txt', 'PUT', 'data');
    const values = Array.from(
      { length: 70 },
      (_, index) => `<C:p${index}>${index}</C:p${index}>`,
    ).join('');
    const patch = `<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:custom"><D:set><D:prop>${values}</D:prop></D:set><D:remove><D:prop><C:p0/><C:p1/></D:prop></D:remove><D:set><D:prop><C:p1>last</C:p1></D:prop></D:set></D:propertyupdate>`;
    expect((await dav(password, 'many.txt', 'PROPPATCH', patch)).status).toBe(207);
    const properties = xmlProperties(
      await (await dav(password, 'many.txt', 'PROPFIND', undefined, { Depth: '0' })).text(),
    );
    expect(properties('urn:custom', 'p0')).toBeUndefined();
    expect(properties('urn:custom', 'p1')).toBe('last');
    expect(properties('urn:custom', 'p69')).toBe('69');
  });

  it('reports the shared quota including recycled bytes and reserved uploads', async () => {
    const { password } = await credential();
    await dav(password, 'recycled.txt', 'PUT', 'abc');
    await dav(password, 'recycled.txt', 'DELETE');
    await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
      .bind('objects/reserved-test', 100)
      .run();
    const query =
      '<D:propfind xmlns:D="DAV:"><D:prop><D:quota-used-bytes/><D:quota-available-bytes/></D:prop></D:propfind>';
    const result = await dav(password, '', 'PROPFIND', query, { Depth: '0' });
    expect(result.status).toBe(207);
    const properties = xmlProperties(await result.text());
    expect(properties('DAV:', 'quota-used-bytes')).toBe('103');
    expect(properties('DAV:', 'quota-available-bytes')).toBe(String(STORAGE_LIMIT - 103));
  });
});
