import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request } from './helpers';
import { testEnv } from './setup';
import { cleanup } from '../worker/storage';

async function credential() {
  return data<{ credential: { id: string }; password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'Long-running mount audit' }),
  );
}

function dav(
  password: string,
  path: string,
  method = 'GET',
  body?: string,
  headers: Record<string, string> = {},
) {
  return app.request(
    'http://localhost/dav/' + path,
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

const lockBody =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';

describe('Long-running DAV client regressions', () => {
  it('supports a filename rename that changes only letter case', async () => {
    const { password } = await credential();
    expect((await dav(password, 'report.txt', 'PUT', 'original')).status).toBe(201);
    const original = await testEnv.DB.prepare(
      'SELECT id,object_key FROM files WHERE deleted_at IS NULL',
    ).first<{ id: string; object_key: string }>();
    const share = await data<{ url: string }>(
      await request('/api/admin/shares', 'POST', { file_id: original!.id }),
    );
    const renamed = await dav(password, 'report.txt', 'MOVE', undefined, {
      Destination: '/dav/Report.txt',
    });
    expect(renamed.status).toBe(204);
    const row = await testEnv.DB.prepare(
      'SELECT id,name,object_key FROM files WHERE deleted_at IS NULL',
    ).first<{ id: string; name: string; object_key: string }>();
    expect(row).toEqual({ ...original, name: 'Report.txt' });
    expect(await (await dav(password, 'Report.txt')).text()).toBe('original');
    expect((await request(new URL(share.url).pathname)).status).toBe(200);
  });

  it('keeps overwrite, identity, ancestor and locking safeguards during case-only renames', async () => {
    const { password } = await credential();
    expect((await dav(password, 'Folder/', 'MKCOL')).status).toBe(201);
    expect((await dav(password, 'Folder/report.txt', 'PUT', 'original')).status).toBe(201);
    const lock = await dav(password, 'Folder/', 'LOCK', lockBody, { Depth: 'infinity' });
    const token = lock.headers.get('Lock-Token')!;
    expect(lock.status).toBe(200);
    expect(
      (
        await dav(password, 'folder/report.txt', 'MOVE', undefined, {
          Destination: '/dav/folder/Report.txt',
        })
      ).status,
    ).toBe(423);
    expect(
      (
        await dav(password, 'folder/report.txt', 'MOVE', undefined, {
          Destination: '/dav/folder/Report.txt',
          Overwrite: 'F',
          If: `(${token})`,
        })
      ).status,
    ).toBe(412);
    for (const method of ['MOVE', 'COPY']) {
      expect(
        (
          await dav(password, 'Folder/', method, undefined, {
            Destination: '/dav/folder/nested',
            If: `(${token})`,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await dav(password, 'folder/report.txt', 'COPY', undefined, {
          Destination: '/dav/folder/Report.txt',
          If: `(${token})`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await dav(password, 'folder/report.txt', 'MOVE', undefined, {
          Destination: '/dav/folder/Report.txt',
          If: `(${token})`,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await dav(password, 'folder/', 'MOVE', undefined, {
          Destination: '/dav/FOLDER/',
          If: `(${token})`,
        })
      ).status,
    ).toBe(204);
    expect(await (await dav(password, 'FOLDER/Report.txt')).text()).toBe('original');
    expect(await testEnv.DB.prepare('SELECT name FROM folders').first<string>('name')).toBe(
      'FOLDER',
    );
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_locks').first<number>('n'),
    ).toBe(0);
  });

  it('keeps an old but still valid credential visible after 100 revoked newer credentials', async () => {
    const created = await credential();
    const stamp = Date.now();
    await testEnv.DB.prepare('UPDATE webdav_credentials SET created_at=? WHERE id=?')
      .bind(stamp - 200000, created.credential.id)
      .run();
    const history = Array.from({ length: 150 }, (_, i) => ({
      id: crypto.randomUUID(),
      hash: crypto.randomUUID(),
      timestamp: stamp - 100000 + i,
    }));
    await testEnv.DB.prepare(
      `INSERT INTO webdav_credentials(id,name,prefix,password_hash,created_at,expires_at,revoked_at)
      SELECT json_extract(value,'$.id'),'Old device','history',json_extract(value,'$.hash'),
        json_extract(value,'$.timestamp'),?,? FROM json_each(?)`,
    )
      .bind(stamp + 86400000, stamp, JSON.stringify(history))
      .run();
    expect((await dav(created.password, '', 'PROPFIND', undefined, { Depth: '0' })).status).toBe(
      207,
    );
    const listed = await data<{ credentials: { id: string }[] }>(
      await request('/api/admin/webdav'),
    );
    expect(listed.credentials.some((entry) => entry.id === created.credential.id)).toBe(true);
    expect(listed.credentials[0].id).toBe(created.credential.id);
    expect(listed.credentials).toHaveLength(101);
  });

  it('requires timeout or administrative revocation to release an expired credential editing lock', async () => {
    const original = await credential();
    const replacement = await credential();
    expect((await dav(original.password, 'locked.txt', 'PUT', 'original')).status).toBe(201);
    expect(
      (
        await dav(original.password, 'locked.txt', 'LOCK', lockBody, {
          Depth: '0',
          Timeout: 'Second-3600',
        })
      ).status,
    ).toBe(200);
    await testEnv.DB.prepare('UPDATE webdav_credentials SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1, original.credential.id)
      .run();
    expect((await dav(original.password, 'locked.txt', 'PUT', 'expired')).status).toBe(401);
    expect((await dav(replacement.password, 'locked.txt', 'PUT', 'new credential')).status).toBe(
      423,
    );
    expect((await request(`/api/admin/webdav/${original.credential.id}`, 'DELETE')).status).toBe(
      200,
    );
    expect((await dav(replacement.password, 'locked.txt', 'PUT', 'new credential')).status).toBe(
      204,
    );
  });

  it.each([false, true])(
    'keeps an in-flight DAV object tracked when cleanup overlaps a timed-out upload (lost R2 response: %s)',
    async (lostResponse) => {
      const created = await credential();
      let entered!: () => void, resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const bucket = new Proxy(testEnv.BUCKET, {
        get(target, key) {
          if (key === 'put')
            return async (...args: Parameters<R2Bucket['put']>) => {
              entered();
              await blocked;
              const result = await target.put(...args);
              if (lostResponse) throw new Error('simulated lost storage response');
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const inFlight = app.request(
        'http://localhost/dav/slow.txt',
        {
          method: 'PUT',
          headers: {
            Authorization: 'Basic ' + btoa('rcloud:' + created.password),
            'Content-Length': '4',
          },
          body: 'slow',
        },
        { ...testEnv, BUCKET: bucket },
      );
      await started;
      try {
        // Simulate the state of a request still streaming after the one-hour cleanup grace.
        await testEnv.DB.batch([
          testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=?').bind(Date.now() - 7200000),
          testEnv.DB.prepare('UPDATE storage_write_lease SET expires_at=0 WHERE id=1'),
        ]);
        await cleanup(testEnv);
      } finally {
        resume();
      }
      expect((await inFlight).status).toBe(lostResponse ? 502 : 423);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files').first<number>('n')).toBe(
        0,
      );
      const objects = await testEnv.BUCKET.list();
      expect(objects.objects).toHaveLength(1);
      const key = objects.objects[0].key;
      const tracking = await testEnv.DB.prepare(
        'SELECT a.size FROM cleanup_tasks c JOIN storage_allocations a ON a.object_key=c.object_key WHERE c.object_key=?',
      )
        .bind(key)
        .first<{ size: number }>();
      expect(tracking?.size).toBe(4);
      expect(
        await testEnv.DB.prepare(
          'SELECT used_bytes FROM storage_quota_state WHERE id=1',
        ).first<number>('used_bytes'),
      ).toBe(4);
      await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=?')
        .bind(Date.now() - 7200000)
        .run();
      await cleanup(testEnv);
      expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
      expect(
        await testEnv.DB.prepare(
          'SELECT used_bytes FROM storage_quota_state WHERE id=1',
        ).first<number>('used_bytes'),
      ).toBe(0);
    },
  );

  it('returns 412 for stale If-Match on GET and HEAD, and 304 only for matching If-None-Match', async () => {
    const { password } = await credential();
    const created = await dav(password, 'conditions.txt', 'PUT', 'original');
    const etag = created.headers.get('ETag')!;
    for (const method of ['GET', 'HEAD']) {
      expect(
        (await dav(password, 'conditions.txt', method, undefined, { 'If-Match': '"stale"' }))
          .status,
      ).toBe(412);
      expect(
        (await dav(password, 'conditions.txt', method, undefined, { 'If-None-Match': etag }))
          .status,
      ).toBe(304);
    }
  });
});
