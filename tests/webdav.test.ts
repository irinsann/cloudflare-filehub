import { describe, expect, it } from 'vitest';
import { SaxesParser } from 'saxes';
import { app } from '../worker/index';
import type { Env } from '../worker/env';
import type { FileRecord, FolderRecord, Listing } from '../shared/types';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

interface Credential {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
async function credential(name = 'DAV integration') {
  return data<{ credential: Credential; password: string }>(
    await request('/api/admin/webdav', 'POST', { name, expires_in_days: 30 }),
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
        ...(password ? { Authorization: 'Basic ' + btoa('rcloud:' + password) } : {}),
        ...(body === undefined
          ? {}
          : {
              'Content-Length': String(new TextEncoder().encode(body).length),
              'Content-Type': method === 'PUT' ? 'text/plain' : 'application/xml; charset=utf-8',
            }),
        ...headers,
      },
      body,
    },
    env,
  );
}
async function liveFile(name: string) {
  const row = await testEnv.DB.prepare(
    "SELECT * FROM files WHERE name=? AND deleted_at IS NULL AND status='ready'",
  )
    .bind(name)
    .first<FileRecord>();
  expect(row).not.toBeNull();
  return row!;
}
function xmlValues(xml: string, property: string) {
  const values: string[] = [],
    stack: { local: string; uri: string; text: string }[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => stack.push({ local: tag.local, uri: tag.uri, text: '' }));
  parser.on('text', (text) => {
    if (stack.length) stack[stack.length - 1].text += text;
  });
  parser.on('closetag', () => {
    const entry = stack.pop()!;
    if (entry.uri === 'DAV:' && entry.local === property) values.push(entry.text);
  });
  parser.write(xml).close();
  return values;
}
const lockBody =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>Integration test</D:owner></D:lockinfo>';

describe('WebDAV protocol and shared drive storage', () => {
  it('issues one-time credentials with stable client configuration and rejects revoked or unrelated authentication', async () => {
    const created = await credential();
    expect(created.password).toMatch(/^rcd_[a-zA-Z0-9_-]{32,}$/);
    const response = await request('/api/admin/webdav');
    const text = await response.text();
    expect(text).not.toContain(created.password);
    expect(text).not.toContain('password_hash');
    expect(JSON.parse(text).data).toMatchObject({
      username: 'rcloud',
      path: '/dav/',
      maxUploadBytes: 100000000,
      credentials: [{ id: created.credential.id }],
    });
    const missing = await dav('', '', 'PROPFIND', undefined, { Depth: '0' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toMatch(/^Basic /i);
    expect((await dav(created.password, '', 'PROPFIND', undefined, { Depth: '0' })).status).toBe(
      207,
    );
    const uploadToken = await data<{ token: string }>(
      await request('/api/admin/api-tokens', 'POST', { name: 'Upload only' }),
    );
    expect((await dav(uploadToken.token, '', 'PROPFIND', undefined, { Depth: '0' })).status).toBe(
      401,
    );
    expect((await request(`/api/admin/webdav/${created.credential.id}`, 'DELETE')).ok).toBe(true);
    expect((await dav(created.password, '', 'PROPFIND', undefined, { Depth: '0' })).status).toBe(
      401,
    );
  });

  it('requires HTTPS in production and does not accept DAV credentials as an administrator session', async () => {
    const { password } = await credential();
    const production = { ...testEnv, ENVIRONMENT: 'production', LOCAL_AUTH: 'false' };
    expect(
      (await dav(password, '', 'PROPFIND', undefined, { Depth: '0' }, production)).status,
    ).toBe(403);
    const admin = await app.request(
      'http://localhost/api/admin/settings',
      { headers: { Authorization: 'Basic ' + btoa('rcloud:' + password) } },
      production,
    );
    expect(admin.status).toBe(401);
  });

  it('advertises the supported methods and returns XML directory metadata with finite depth', async () => {
    const { password } = await credential();
    const folder = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: '资料 & 记录' }),
    );
    await upload('根目录.txt', 'root');
    await upload('子文件.txt', 'child', folder.id);
    const options = await dav(password, '', 'OPTIONS');
    expect([200, 204]).toContain(options.status);
    for (const method of [
      'PROPFIND',
      'GET',
      'HEAD',
      'PUT',
      'MKCOL',
      'MOVE',
      'COPY',
      'DELETE',
      'LOCK',
      'UNLOCK',
      'PROPPATCH',
    ])
      expect(options.headers.get('Allow')).toContain(method);
    const shallow = await dav(password, '', 'PROPFIND', undefined, { Depth: '0' });
    expect(shallow.status).toBe(207);
    expect(xmlValues(await shallow.text(), 'href')).toHaveLength(1);
    const listing = await dav(
      password,
      '',
      'PROPFIND',
      '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      { Depth: '1' },
    );
    expect(listing.status).toBe(207);
    expect(listing.headers.get('Content-Type')).toContain('xml');
    const xml = await listing.text();
    const hrefs = xmlValues(xml, 'href').map(decodeURIComponent);
    expect(hrefs).toHaveLength(3);
    expect(hrefs.some((href) => href.endsWith('/资料 & 记录/'))).toBe(true);
    expect(hrefs.some((href) => href.endsWith('/根目录.txt'))).toBe(true);
    expect(hrefs.some((href) => href.includes('子文件'))).toBe(false);
    expect(xmlValues(xml, 'getcontentlength')).toContain('4');
    expect((await dav(password, '', 'PROPFIND', undefined, { Depth: 'infinity' })).status).toBe(
      403,
    );
  });

  it('creates a directory and Unicode file visible in the web drive, with GET, HEAD and Range support', async () => {
    const { password } = await credential();
    expect((await dav(password, 'notes/', 'MKCOL')).status).toBe(201);
    const path = 'notes/' + encodeURIComponent('中文 空格.txt');
    expect((await dav(password, path, 'PUT', 'abcdefghij')).status).toBe(201);
    const file = await liveFile('中文 空格.txt');
    const folder = await testEnv.DB.prepare('SELECT name FROM folders WHERE id=?')
      .bind(file.folder_id)
      .first<{ name: string }>();
    expect(folder?.name).toBe('notes');
    expect(await (await request(`/api/admin/files/${file.id}/download`)).text()).toBe('abcdefghij');
    const head = await dav(password, path, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(head.headers.get('ETag')).toBeTruthy();
    expect(await head.text()).toBe('');
    const partial = await dav(password, path, 'GET', undefined, { Range: 'bytes=2-5' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('cdef');
    expect((await dav(password, path, 'GET', undefined, { Range: 'bytes=20-' })).status).toBe(416);
    expect((await dav(password, 'empty.txt', 'PUT', '')).status).toBe(201);
    expect((await liveFile('empty.txt')).size).toBe(0);
  });

  it('atomically replaces an existing file and protects conditional writes against stale clients', async () => {
    const { password } = await credential();
    await dav(password, 'version.txt', 'PUT', 'version one');
    const before = await liveFile('version.txt');
    const etag = (await dav(password, 'version.txt', 'HEAD')).headers.get('ETag')!;
    expect(
      (await dav(password, 'version.txt', 'PUT', 'stale', { 'If-Match': '"wrong"' })).status,
    ).toBe(412);
    expect(
      (await dav(password, 'version.txt', 'PUT', 'duplicate', { 'If-None-Match': '*' })).status,
    ).toBe(412);
    expect(
      (await dav(password, 'version.txt', 'PUT', 'version two', { 'If-Match': etag })).status,
    ).toBe(204);
    const after = await liveFile('version.txt');
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(before.version + 1);
    expect(after.object_key).not.toBe(before.object_key);
    expect(await (await dav(password, 'version.txt')).text()).toBe('version two');
    expect(
      (await dav(password, 'version.txt', 'PUT', 'old etag', { 'If-Match': etag })).status,
    ).toBe(412);
  });

  it('keeps the original bytes and metadata if replacement storage fails', async () => {
    const { password } = await credential();
    await dav(password, 'durable.txt', 'PUT', 'keep me');
    const before = await liveFile('durable.txt');
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        if (property === 'put')
          return async () => {
            throw new Error('Simulated R2 failure');
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failed = await dav(
      password,
      'durable.txt',
      'PUT',
      'replacement',
      {},
      { ...testEnv, BUCKET: bucket },
    );
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const after = await liveFile('durable.txt');
    expect(after.object_key).toBe(before.object_key);
    expect(after.version).toBe(before.version);
    expect(await (await dav(password, 'durable.txt')).text()).toBe('keep me');
  });

  it('moves and copies files without aliasing their objects and honors Overwrite F', async () => {
    const { password } = await credential();
    await dav(password, 'source.txt', 'PUT', 'source');
    await dav(password, 'target.txt', 'PUT', 'target');
    const source = await liveFile('source.txt');
    expect(
      (
        await dav(password, 'source.txt', 'COPY', undefined, {
          Destination: 'http://localhost/dav/target.txt',
          Overwrite: 'F',
        })
      ).status,
    ).toBe(412);
    expect(await (await dav(password, 'target.txt')).text()).toBe('target');
    expect(
      (
        await dav(password, 'source.txt', 'COPY', undefined, {
          Destination: 'http://localhost/dav/copy.txt',
        })
      ).status,
    ).toBe(201);
    const copy = await liveFile('copy.txt');
    expect(copy.id).not.toBe(source.id);
    expect(copy.object_key).not.toBe(source.object_key);
    expect(await (await dav(password, 'copy.txt')).text()).toBe('source');
    expect(
      (
        await dav(password, 'source.txt', 'MOVE', undefined, {
          Destination: 'http://localhost/dav/moved.txt',
        })
      ).status,
    ).toBe(201);
    expect((await liveFile('moved.txt')).id).toBe(source.id);
    expect((await dav(password, 'source.txt')).status).toBe(404);
    const badDestination = await dav(password, 'moved.txt', 'MOVE', undefined, {
      Destination: 'https://unrelated.example/dav/stolen.txt',
    });
    expect(badDestination.status).toBeGreaterThanOrEqual(400);
    expect(await (await dav(password, 'moved.txt')).text()).toBe('source');
  });

  it('deletes into the shared recycle bin, closes public shares and recursively trashes directories', async () => {
    const { password } = await credential();
    await dav(password, 'parent/', 'MKCOL');
    await dav(password, 'parent/nested/', 'MKCOL');
    await dav(password, 'parent/nested/keep.txt', 'PUT', 'recoverable');
    const file = await liveFile('keep.txt');
    const share = await data<{ url: string }>(
      await request('/api/admin/shares', 'POST', { file_id: file.id }),
    );
    expect((await dav(password, 'parent/', 'DELETE')).status).toBe(204);
    expect((await dav(password, 'parent/nested/keep.txt')).status).toBe(404);
    const trash = await data<Listing>(await request('/api/admin/files?view=trash'));
    expect(trash.files.some((entry) => entry.id === file.id)).toBe(true);
    expect(trash.folders.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['parent', 'nested']),
    );
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect((await request(new URL(share.url).pathname)).status).toBe(410);
    expect((await dav(password, '', 'DELETE')).status).toBe(403);
  });

  it('rejects ambiguous existing names instead of picking or overwriting an arbitrary file', async () => {
    const { password } = await credential();
    await upload('duplicate.txt', 'first');
    await upload('duplicate.txt', 'second');
    for (const method of ['GET', 'HEAD', 'DELETE'])
      expect((await dav(password, 'duplicate.txt', method)).status).toBe(409);
    expect((await dav(password, 'duplicate.txt', 'PUT', 'third')).status).toBe(409);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE name='duplicate.txt' AND deleted_at IS NULL",
      ).first<number>('n'),
    ).toBe(2);
  });

  it('enforces request size and safe paths before adding file metadata', async () => {
    const { password } = await credential();
    expect(
      (await dav(password, 'too-big.bin', 'PUT', 'x', { 'Content-Length': '100000001' })).status,
    ).toBe(413);
    expect((await dav(password, 'bad%2Fname.txt', 'PUT', 'x')).status).toBe(400);
    expect((await dav(password, 'missing/child.txt', 'PUT', 'x')).status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files').first<number>('n')).toBe(0);
  });

  it('persists exclusive locks, refreshes them, rejects conflicting writes and unlocks with the token', async () => {
    const { password } = await credential();
    await dav(password, 'locked.txt', 'PUT', 'before');
    const locked = await dav(password, 'locked.txt', 'LOCK', lockBody, {
      Depth: '0',
      Timeout: 'Second-600',
    });
    expect(locked.status).toBe(200);
    const token = locked.headers.get('Lock-Token')!;
    expect(token).toMatch(/^<urn:uuid:[^>]+>$/);
    expect(xmlValues(await locked.text(), 'href')).toContain(token.slice(1, -1));
    expect((await dav(password, 'locked.txt', 'PUT', 'blocked')).status).toBe(423);
    expect((await dav(password, 'locked.txt', 'DELETE')).status).toBe(423);
    expect(
      (
        await dav(password, 'locked.txt', 'LOCK', undefined, {
          If: `(${token})`,
          Timeout: 'Second-1200',
        })
      ).status,
    ).toBe(200);
    expect((await dav(password, 'locked.txt', 'PUT', 'after', { If: `(${token})` })).status).toBe(
      204,
    );
    expect(await (await dav(password, 'locked.txt')).text()).toBe('after');
    expect(
      (await dav(password, 'locked.txt', 'UNLOCK', undefined, { 'Lock-Token': token })).status,
    ).toBe(204);
    expect((await dav(password, 'locked.txt', 'PUT', 'unlocked')).status).toBe(204);
  });

  it('does not bypass DAV locks through normal web storage APIs', async () => {
    const { password } = await credential();
    await dav(password, 'locked-web.txt', 'PUT', 'before');
    const file = await liveFile('locked-web.txt');
    const locked = await dav(password, 'locked-web.txt', 'LOCK', lockBody, { Depth: '0' });
    expect(locked.status).toBe(200);
    expect(
      (await request(`/api/admin/files/${file.id}`, 'PATCH', { name: 'bypass.txt' })).status,
    ).toBe(423);
    expect((await request(`/api/admin/files/${file.id}`, 'DELETE')).status).toBe(423);
    expect(await (await dav(password, 'locked-web.txt')).text()).toBe('before');
  });

  it('reports protected property changes using WebDAV XML without changing the file', async () => {
    const { password } = await credential();
    await dav(password, 'properties.txt', 'PUT', 'three');
    const patch =
      '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:getcontentlength>999</D:getcontentlength></D:prop></D:set></D:propertyupdate>';
    const response = await dav(password, 'properties.txt', 'PROPPATCH', patch);
    expect(response.status).toBe(207);
    expect(
      xmlValues(await response.text(), 'status').some((status) => status.includes('403')),
    ).toBe(true);
    expect((await liveFile('properties.txt')).size).toBe(5);
    expect(await (await dav(password, 'properties.txt')).text()).toBe('three');
  });

  it('rejects expired credentials and cross-origin browser requests without exposing file data', async () => {
    const created = await credential();
    await dav(created.password, 'private.txt', 'PUT', 'private bytes');
    expect(
      (
        await dav(created.password, 'private.txt', 'GET', undefined, {
          Origin: 'https://unrelated.example',
        })
      ).status,
    ).toBe(403);
    await testEnv.DB.prepare('UPDATE webdav_credentials SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1000, created.credential.id)
      .run();
    expect((await dav(created.password, 'private.txt')).status).toBe(401);
  });

  it('rechecks a credential revoked while upload storage is in flight before publishing its file', async () => {
    const created = await credential();
    let arrived!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        if (property === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            const object = await target.put(...args);
            arrived();
            await blocked;
            return object;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pending = dav(
      created.password,
      'revoked-upload.txt',
      'PUT',
      'must stay private',
      {},
      { ...testEnv, BUCKET: bucket },
    );
    await entered;
    try {
      expect((await request(`/api/admin/webdav/${created.credential.id}`, 'DELETE')).status).toBe(
        200,
      );
    } finally {
      resume();
    }
    expect((await pending).status).toBe(401);
    expect(
      await testEnv.DB.prepare("SELECT id FROM files WHERE name='revoked-upload.txt'").first(),
    ).toBeNull();
  });

  it('copies directory trees into independent files and honors collection Depth zero', async () => {
    const { password } = await credential();
    await dav(password, 'original/', 'MKCOL');
    await dav(password, 'original/nested/', 'MKCOL');
    await dav(password, 'original/nested/content.txt', 'PUT', 'copy content');
    expect(
      (
        await dav(password, 'original/', 'COPY', undefined, {
          Destination: 'http://localhost/dav/empty-copy/',
          Depth: '0',
        })
      ).status,
    ).toBe(201);
    const empty = await dav(password, 'empty-copy/', 'PROPFIND', undefined, { Depth: '1' });
    expect(xmlValues(await empty.text(), 'href')).toEqual(['/dav/empty-copy/']);
    expect(
      (
        await dav(password, 'original/', 'COPY', undefined, {
          Destination: 'http://localhost/dav/full-copy/',
          Depth: 'infinity',
        })
      ).status,
    ).toBe(201);
    expect(await (await dav(password, 'full-copy/nested/content.txt')).text()).toBe('copy content');
    expect(
      (await dav(password, 'full-copy/nested/content.txt', 'PUT', 'changed copy')).status,
    ).toBe(204);
    expect(await (await dav(password, 'original/nested/content.txt')).text()).toBe('copy content');
  });

  it('checks inherited locks and tagged If lists, including ETags and negated conditions', async () => {
    const { password } = await credential();
    const other = await credential('Other client');
    await dav(password, 'locked-folder/', 'MKCOL');
    await dav(password, 'locked-folder/file.txt', 'PUT', 'before');
    const etag = (await dav(password, 'locked-folder/file.txt', 'HEAD')).headers.get('ETag')!;
    const response = await dav(password, 'locked-folder/', 'LOCK', lockBody, { Depth: 'infinity' });
    const token = response.headers.get('Lock-Token')!;
    expect(response.status).toBe(200);
    expect((await dav(password, 'locked-folder/new.txt', 'PUT', 'blocked')).status).toBe(423);
    expect(
      (
        await dav(password, 'locked-folder/file.txt', 'PUT', 'wrong', {
          If: `<http://localhost/dav/locked-folder/file.txt> (${token} ["wrong"])`,
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await dav(password, 'locked-folder/file.txt', 'PUT', 'wrong', {
          If: `<http://localhost/dav/locked-folder/file.txt> (Not ${token})`,
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await dav(other.password, 'locked-folder/file.txt', 'PUT', 'wrong client', {
          If: `(${token})`,
        })
      ).status,
    ).toBe(423);
    expect(
      (
        await dav(password, 'locked-folder/file.txt', 'PUT', 'updated', {
          If: `<http://localhost/dav/locked-folder/file.txt> (["wrong"]) (${token} [${etag}])`,
        })
      ).status,
    ).toBe(204);
    expect(await (await dav(password, 'locked-folder/file.txt')).text()).toBe('updated');
    expect(
      (await dav(password, 'locked-folder/', 'UNLOCK', undefined, { 'Lock-Token': token })).status,
    ).toBe(204);
  });

  it('preserves custom properties and rolls back all changes in a protected-property patch', async () => {
    const { password } = await credential();
    await dav(password, 'custom.txt', 'PUT', 'content');
    const custom =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:rcloud:test"><D:set><D:prop><C:label>safe &lt;value&gt; &amp; text</C:label></D:prop></D:set></D:propertyupdate>';
    const written = await dav(password, 'custom.txt', 'PROPPATCH', custom);
    expect(written.status).toBe(207);
    expect(xmlValues(await written.text(), 'status')).toEqual(['HTTP/1.1 200 OK']);
    const query =
      '<D:propfind xmlns:D="DAV:" xmlns:C="urn:rcloud:test"><D:prop><C:label/></D:prop></D:propfind>';
    const read = await dav(password, 'custom.txt', 'PROPFIND', query, { Depth: '0' });
    expect(await read.text()).toContain('safe &lt;value&gt; &amp; text');
    const invalid =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:rcloud:test"><D:set><D:prop><C:label>changed</C:label><D:getcontentlength>999</D:getcontentlength></D:prop></D:set></D:propertyupdate>';
    const rejected = await dav(password, 'custom.txt', 'PROPPATCH', invalid);
    expect(xmlValues(await rejected.text(), 'status')).toEqual(
      expect.arrayContaining(['HTTP/1.1 424 Failed Dependency', 'HTTP/1.1 403 Forbidden']),
    );
    expect(
      await (await dav(password, 'custom.txt', 'PROPFIND', query, { Depth: '0' })).text(),
    ).toContain('safe &lt;value&gt; &amp; text');
    expect(await (await dav(password, 'custom.txt')).text()).toBe('content');
  });
});
