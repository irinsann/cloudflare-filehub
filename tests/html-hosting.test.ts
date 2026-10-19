import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import type { Env } from '../worker/env';
import type { FileRecord, FolderRecord } from '../shared/types';
import type { HtmlHostingItem, HtmlHostingListing } from '../shared/html-hosting';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

const html =
  '<!doctype html><title>Hosted</title><h1>Original HTML</h1><script>document.title="Ready"</script>';
async function folder() {
  return (await data<{ id: string }>(await request('/api/admin/html-hosting/folder', 'POST'))).id;
}
async function publish(fileId: string, env: Env = testEnv) {
  return request('/api/admin/html-hosting', 'POST', { file_id: fileId }, env);
}
async function hosted(name = 'page.html') {
  const file = await data<FileRecord>(await upload(name, html, await folder()));
  const item = await data<HtmlHostingItem>(await publish(file.id));
  return { file, item };
}
function page(item: HtmlHostingItem) {
  return new URL(item.url).pathname;
}
async function count(table: 'html_hosts' | 'file_shares' | 'files' | 'folders') {
  return testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
}
async function item(fileId: string) {
  return data<HtmlHostingItem>(await request('/api/admin/html-hosting/' + fileId));
}
function beforeBatch(action: () => Promise<void>) {
  let called = false;
  return new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!called) {
            called = true;
            await action();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('HTML hosting uses the existing file upload and isolated sharing protocols', () => {
  it('coordinates folder creation with WebDAV leases while share-only revocation remains available', async () => {
    await testEnv.DB.prepare('UPDATE storage_write_lease SET owner=?,expires_at=? WHERE id=1')
      .bind('dav-write', Date.now() + 60000)
      .run();
    expect((await request('/api/admin/html-hosting/folder', 'POST')).status).toBe(423);
    expect(await count('folders')).toBe(0);
    await testEnv.DB.prepare(
      'UPDATE storage_write_lease SET owner=NULL,expires_at=0 WHERE id=1',
    ).run();
    const { file, item: initial } = await hosted();
    await testEnv.DB.prepare('UPDATE storage_write_lease SET owner=?,expires_at=? WHERE id=1')
      .bind('dav-write', Date.now() + 60000)
      .run();
    expect(
      (await request('/api/admin/html-hosting/' + file.id, 'DELETE', { version: initial.version }))
        .status,
    ).toBe(200);
    expect((await request(page(initial))).status).toBe(410);
  });

  it('respects a WebDAV root membership lock and does not block reuse of an existing folder', async () => {
    const credentials = await data<{ password: string }>(
      await request('/api/admin/webdav', 'POST', { name: 'HTML folder lock', expires_in_days: 30 }),
    );
    const auth = { Authorization: 'Basic ' + btoa('rcloud:' + credentials.password) };
    const lock = await app.request(
      'http://localhost/dav/',
      {
        method: 'LOCK',
        headers: { ...auth, Depth: '0', 'Content-Type': 'application/xml' },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      },
      testEnv,
    );
    expect(lock.status).toBe(200);
    expect((await request('/api/admin/html-hosting/folder', 'POST')).status).toBe(423);
    expect(await count('folders')).toBe(0);
    expect(
      (
        await app.request(
          'http://localhost/dav/',
          { method: 'UNLOCK', headers: { ...auth, 'Lock-Token': lock.headers.get('Lock-Token')! } },
          testEnv,
        )
      ).status,
    ).toBe(204);
    const existing = await folder();
    const relock = await app.request(
      'http://localhost/dav/',
      {
        method: 'LOCK',
        headers: { ...auth, Depth: 'infinity', 'Content-Type': 'application/xml' },
        body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      },
      testEnv,
    );
    expect(relock.status).toBe(200);
    expect(await folder()).toBe(existing);
  });

  it('ensures the exact live root folder, without touching existing folders or objects', async () => {
    const existing = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'Html-hosting' }),
    );
    const before = await testEnv.DB.prepare('SELECT * FROM folders WHERE id=?')
      .bind(existing.id)
      .first();
    const ids = await Promise.all([folder(), folder(), folder()]);
    expect(ids).toEqual([existing.id, existing.id, existing.id]);
    expect(await count('folders')).toBe(1);
    expect(
      await testEnv.DB.prepare('SELECT * FROM folders WHERE id=?').bind(existing.id).first(),
    ).toEqual(before);
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
  });

  it('does not restore a trashed folder or overwrite a root file with the same name', async () => {
    const original = await folder();
    expect((await request('/api/admin/folders/' + original, 'DELETE')).status).toBe(200);
    const replacement = await folder();
    expect(replacement).not.toBe(original);
    expect(
      await testEnv.DB.prepare('SELECT deleted_at FROM folders WHERE id=?')
        .bind(original)
        .first<number>('deleted_at'),
    ).not.toBeNull();
    await request('/api/admin/folders/' + replacement, 'DELETE');
    const collision = await data<FileRecord>(await upload('Html-hosting', 'keep me'));
    expect((await request('/api/admin/html-hosting/folder', 'POST')).status).toBe(409);
    expect(await (await request('/api/admin/files/' + collision.id + '/download')).text()).toBe(
      'keep me',
    );
  });

  it('publishes a real multipart HTML larger than the text editor cap, preserving exact bytes and sandbox isolation', async () => {
    const body = html + '<!--' + 'x'.repeat(1024 * 1024 + 17) + '-->';
    const bytes = new TextEncoder().encode(body);
    const session = await data<{ id: string; fileId: string }>(
      await request('/api/admin/uploads', 'POST', {
        name: 'large.HTM',
        size: bytes.byteLength,
        folder_id: await folder(),
      }),
    );
    const part = await app.request(
      `http://localhost/api/admin/uploads/${session.id}/parts/1`,
      {
        method: 'PUT',
        headers: {
          Origin: 'http://localhost',
          'X-Drive-Request': '1',
          'X-File-Size': String(bytes.byteLength),
        },
        body: bytes.buffer,
      },
      testEnv,
    );
    expect(part.status).toBe(200);
    const file = await data<FileRecord>(
      await request(`/api/admin/uploads/${session.id}/complete`, 'POST'),
    );
    const object = await testEnv.BUCKET.head(file.object_key);
    const response = await publish(file.id);
    expect(response.status).toBe(201);
    const link = await data<HtmlHostingItem>(response);
    const rendered = await request(page(link));
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(rendered.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(rendered.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(rendered.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    expect(await rendered.text()).toBe(body);
    const download = await request(new URL(link.directUrl).pathname);
    expect(download.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(await download.text()).toBe(body);
    expect((await testEnv.BUCKET.head(file.object_key))?.version).toBe(object?.version);
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(1);
    expect(await count('files')).toBe(1);
    expect(await item(file.id)).toMatchObject({ size: bytes.byteLength, views: 1, downloads: 1 });
  });

  it('retries publication without duplicate shares, objects or operations and leaves old shares unchanged', async () => {
    const file = await data<FileRecord>(await upload('same.html', html, await folder()));
    const oldShare = await data<{ id: string; url: string }>(
      await request('/api/admin/shares', 'POST', { file_id: file.id, password: 'old-password' }),
    );
    const oldRow = await testEnv.DB.prepare('SELECT * FROM file_shares WHERE id=?')
      .bind(oldShare.id)
      .first();
    const beforeFile = await testEnv.DB.prepare('SELECT * FROM files WHERE id=?')
      .bind(file.id)
      .first();
    const results = await Promise.all([publish(file.id), publish(file.id), publish(file.id)]);
    const published = await Promise.all(results.map((response) => data<HtmlHostingItem>(response)));
    expect(new Set(published.map((row) => row.share_id)).size).toBe(1);
    expect(new Set(published.map((row) => row.url)).size).toBe(1);
    expect(published[0].share_id).not.toBe(oldShare.id);
    expect(await count('html_hosts')).toBe(1);
    expect(await count('file_shares')).toBe(2);
    expect((await publish(file.id)).status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT * FROM file_shares WHERE id=?').bind(oldShare.id).first(),
    ).toEqual(oldRow);
    expect(
      await testEnv.DB.prepare('SELECT * FROM files WHERE id=?').bind(file.id).first(),
    ).toEqual(beforeFile);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM operations WHERE action='html.publish'",
      ).first<number>('n'),
    ).toBe(1);
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(1);
  });

  it('keeps duplicate filenames as independent files and only lists registered HTML hosts', async () => {
    const first = await hosted('same.html');
    const second = await hosted('same.html');
    const unregistered = await data<FileRecord>(
      await upload('old.html', html, first.file.folder_id!),
    );
    await request('/api/admin/shares', 'POST', { file_id: unregistered.id });
    expect(second.file.id).not.toBe(first.file.id);
    expect(second.item.url).not.toBe(first.item.url);
    const result = (await (
      await request('/api/admin/html-hosting?limit=1&page=1')
    ).json()) as HtmlHostingListing;
    const other = (await (
      await request('/api/admin/html-hosting?limit=1&page=2')
    ).json()) as HtmlHostingListing;
    expect(result).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(result.data).toHaveLength(1);
    expect(other.data).toHaveLength(1);
    expect(new Set([result.data[0].file_id, other.data[0].file_id])).toEqual(
      new Set([first.file.id, second.file.id]),
    );
    expect(JSON.stringify(result)).not.toMatch(/token_hash|password_hash|object_key/);
    expect((await request('/api/admin/html-hosting/' + unregistered.id)).status).toBe(404);
  });

  it('rejects non-HTML, other directories, incomplete and trashed files without creating shares', async () => {
    const root = await data<FileRecord>(await upload('root.html', html));
    const id = await folder();
    const text = await data<FileRecord>(await upload('not.html.txt', html, id));
    const trashed = await data<FileRecord>(await upload('trashed.html', html, id));
    await request('/api/admin/files/' + trashed.id, 'DELETE');
    const pending = await data<{ fileId: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'pending.html', size: 1, folder_id: id }),
    );
    expect((await publish(root.id)).status).toBe(409);
    expect((await publish(text.id)).status).toBe(415);
    expect((await publish(trashed.id)).status).toBe(404);
    expect((await publish(pending.fileId)).status).toBe(404);
    expect(await count('html_hosts')).toBe(0);
    expect(await count('file_shares')).toBe(0);
  });

  it('revokes and restores the stable link without stale retries reopening a newer revocation', async () => {
    const { file, item: initial } = await hosted();
    const revoked = await data<HtmlHostingItem>(
      await request('/api/admin/html-hosting/' + file.id, 'DELETE', { version: initial.version }),
    );
    expect(revoked).toMatchObject({
      enabled: false,
      version: initial.version + 1,
      url: initial.url,
    });
    expect((await request(page(initial))).status).toBe(410);
    expect(await data<HtmlHostingItem>(await publish(file.id))).toMatchObject({
      enabled: false,
      version: revoked.version,
    });
    expect(
      await data<HtmlHostingItem>(
        await request('/api/admin/html-hosting/' + file.id, 'DELETE', { version: initial.version }),
      ),
    ).toEqual(revoked);
    const restored = await data<HtmlHostingItem>(
      await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
        version: revoked.version,
      }),
    );
    expect(restored).toMatchObject({
      enabled: true,
      version: revoked.version + 1,
      url: initial.url,
    });
    expect(await (await request(page(restored))).text()).toBe(html);
    expect(
      (
        await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
          version: revoked.version,
        })
      ).status,
    ).toBe(200);
    const last = await data<HtmlHostingItem>(
      await request('/api/admin/html-hosting/' + file.id, 'DELETE', { version: restored.version }),
    );
    expect(last.enabled).toBe(false);
    expect(
      (
        await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
          version: revoked.version,
        })
      ).status,
    ).toBe(409);
    expect((await item(file.id)).enabled).toBe(false);
    expect(
      ((await (await request('/api/admin/html-hosting')).json()) as HtmlHostingListing).data,
    ).toHaveLength(1);
  });

  it('preserves existing sharing restrictions and invalidates stale actions when ordinary sharing settings change', async () => {
    const { file, item: initial } = await hosted();
    const expiry = Date.now() + 600000;
    expect(
      (
        await request('/api/admin/shares/' + initial.share_id, 'PATCH', {
          password: 'still-private',
          expires_at: expiry,
          allow_download: false,
          enabled: false,
        })
      ).status,
    ).toBe(200);
    const changed = await item(file.id);
    expect(changed).toMatchObject({
      enabled: false,
      password_protected: true,
      expires_at: expiry,
      version: initial.version + 1,
    });
    expect(
      (
        await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
          version: initial.version,
        })
      ).status,
    ).toBe(409);
    const restored = await data<HtmlHostingItem>(
      await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
        version: changed.version,
      }),
    );
    expect(restored).toMatchObject({ enabled: true, password_protected: true, expires_at: expiry });
    expect(await (await request(page(restored))).text()).toContain('type="password"');
    expect(
      await testEnv.DB.prepare('SELECT allow_download FROM file_shares WHERE id=?')
        .bind(initial.share_id)
        .first<number>('allow_download'),
    ).toBe(0);
    await testEnv.DB.prepare('UPDATE file_shares SET enabled=0,expires_at=1 WHERE id=?')
      .bind(initial.share_id)
      .run();
    expect(
      (
        await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
          version: (await item(file.id)).version,
        })
      ).status,
    ).toBe(409);
  });

  it('ordinary trash revokes, file restore stays private, and permanent deletion cascades only the hosted file', async () => {
    const { file, item: initial } = await hosted();
    const unrelated = await data<FileRecord>(await upload('keep.txt', 'keep'));
    expect((await request('/api/admin/files/' + file.id, 'DELETE')).status).toBe(200);
    expect((await request(page(initial))).status).toBe(410);
    expect(
      (
        await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
          version: initial.version + 1,
        })
      ).status,
    ).toBe(404);
    expect(
      ((await (await request('/api/admin/html-hosting')).json()) as HtmlHostingListing).total,
    ).toBe(0);
    await request('/api/admin/files/' + file.id + '/restore', 'POST');
    expect((await item(file.id)).enabled).toBe(false);
    expect((await request(page(initial))).status).toBe(410);
    await request('/api/admin/html-hosting/' + file.id + '/restore', 'POST', {
      version: (await item(file.id)).version,
    });
    expect(await (await request(page(initial))).text()).toBe(html);
    await request('/api/admin/files/' + file.id, 'DELETE');
    expect((await request('/api/admin/files/' + file.id + '/permanent', 'DELETE')).status).toBe(
      200,
    );
    expect(await count('html_hosts')).toBe(0);
    expect(await count('file_shares')).toBe(0);
    expect(await testEnv.BUCKET.head(file.object_key)).toBeNull();
    expect(await (await request('/api/admin/files/' + unrelated.id + '/download')).text()).toBe(
      'keep',
    );
  });

  it.each(['move', 'trash', 'rename'])(
    'does not publish when the file changes before the transaction: %s',
    async (change) => {
      const file = await data<FileRecord>(await upload('race.html', html, await folder()));
      const db = beforeBatch(async () => {
        const sql =
          change === 'move'
            ? 'UPDATE files SET folder_id=NULL WHERE id=?'
            : change === 'trash'
              ? 'UPDATE files SET deleted_at=1 WHERE id=?'
              : "UPDATE files SET name='race.txt' WHERE id=?";
        await testEnv.DB.prepare(sql).bind(file.id).run();
      });
      expect((await publish(file.id, { ...testEnv, DB: db })).status).toBe(409);
      expect(await count('html_hosts')).toBe(0);
      expect(await count('file_shares')).toBe(0);
    },
  );

  it('does not restore after a concurrent generic revocation/settings change', async () => {
    const { file, item: initial } = await hosted();
    await request('/api/admin/html-hosting/' + file.id, 'DELETE', { version: initial.version });
    const revoked = await item(file.id);
    const db = beforeBatch(async () => {
      await testEnv.DB.prepare('UPDATE file_shares SET allow_download=0 WHERE id=?')
        .bind(initial.share_id)
        .run();
    });
    expect(
      (
        await request(
          '/api/admin/html-hosting/' + file.id + '/restore',
          'POST',
          { version: revoked.version },
          { ...testEnv, DB: db },
        )
      ).status,
    ).toBe(409);
    expect((await item(file.id)).enabled).toBe(false);
  });
});
