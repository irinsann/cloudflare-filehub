import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request, upload, createMarkdown } from './helpers';
import { testEnv } from './setup';
import type { FileRecord, FolderRecord } from '../shared/types';

async function lock(path: string, depth = '0', expiresAt = Date.now() + 600000) {
  const id = crypto.randomUUID();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      'INSERT INTO webdav_credentials(id,name,prefix,password_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)',
    ).bind(id, 'test', 'test', id, Date.now(), Date.now() + 86400000),
    testEnv.DB.prepare(
      'INSERT INTO webdav_locks(path,token,credential_id,depth,expires_at) VALUES(?,?,?,?,?)',
    ).bind(path, 'urn:uuid:' + id, id, depth, expiresAt),
  ]);
}
const folder = async (name: string, parent_id: string | null = null) =>
  data<FolderRecord>(await request('/api/admin/folders', 'POST', { name, parent_id }));
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

describe('web writes respect the affected DAV namespace', () => {
  it('allows unrelated raw uploads and cached JSON edits while protecting source and destination names', async () => {
    const locked = await data<FileRecord>(await upload('locked.txt', 'keep'));
    const free = await data<FileRecord>(await upload('free.txt', 'free'));
    await lock('/dav/LOCKED.txt');
    expect((await upload('another.txt', 'unrelated bytes')).status).toBe(201);
    expect(
      (await request(`/api/admin/files/${free.id}`, 'PATCH', { name: 'renamed.txt' })).status,
    ).toBe(200);
    expect(
      (await request(`/api/admin/files/${locked.id}`, 'PATCH', { name: 'escape.txt' })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/files/${free.id}`, 'PATCH', { name: 'locked.txt' })).status,
    ).toBe(423);
    expect((await upload('locked.txt', 'duplicate')).status).toBe(423);
    expect((await request(`/api/admin/files/${locked.id}`, 'DELETE')).status).toBe(423);
    expect(await (await request(`/api/admin/files/${locked.id}/download`)).text()).toBe('keep');
    // A denied request releases its lease, so a different file remains editable immediately.
    expect((await request(`/api/admin/files/${free.id}`, 'DELETE')).status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
    ).toBe(0);
  });

  it('protects collection membership without turning a depth-zero directory lock into a subtree lock', async () => {
    const docs = await folder('docs');
    const nested = await folder('nested', docs.id);
    const note = await data<FileRecord>(await upload('note.md', '# before', docs.id));
    const free = await data<FileRecord>(await upload('free.txt', 'free'));
    await lock('/dav/docs', '0');
    expect((await upload('new.txt', 'new', docs.id)).status).toBe(423);
    expect(
      (await request('/api/admin/folders', 'POST', { name: 'new', parent_id: docs.id })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/files/${free.id}`, 'PATCH', { folder_id: docs.id })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/markdown/${note.id}`, 'PUT', { content: '# after', version: 1 }))
        .status,
    ).toBe(200);
    expect((await upload('grandchild.txt', 'fine', nested.id)).status).toBe(201);
    expect((await upload('root.txt', 'fine')).status).toBe(201);
  });

  it('checks locked descendants when moving ancestors and locked destination parents for folder moves', async () => {
    const parent = await folder('parent');
    const nested = await folder('nested', parent.id);
    const other = await folder('other');
    await lock('/dav/parent/nested/locked.txt');
    expect(
      (await request(`/api/admin/folders/${parent.id}`, 'PATCH', { name: 'renamed' })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/folders/${nested.id}`, 'PATCH', { parent_id: null })).status,
    ).toBe(423);
    await lock('/dav/destination', 'infinity');
    expect(
      (await request(`/api/admin/folders/${other.id}`, 'PATCH', { name: 'destination' })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/folders/${other.id}`, 'PATCH', { name: 'unrelated' })).status,
    ).toBe(200);
  });

  it('resolves multipart sessions to pending file paths without consuming their part streams', async () => {
    const target = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'pending.txt', size: 4 }),
    );
    await lock('/dav/pending.txt');
    expect(
      (await request('/api/admin/uploads', 'POST', { name: 'pending.txt', size: 4 })).status,
    ).toBe(423);
    const other = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'other.txt', size: 4 }),
    );
    const part = (id: string) =>
      app.request(
        `http://localhost/api/admin/uploads/${id}/parts/1`,
        {
          method: 'PUT',
          headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': '4' },
          body: 'test',
        },
        testEnv,
      );
    expect((await part(target.id)).status).toBe(423);
    expect((await request(`/api/admin/uploads/${target.id}/complete`, 'POST')).status).toBe(423);
    expect((await request(`/api/admin/uploads/${target.id}`, 'DELETE')).status).toBe(423);
    expect((await part(other.id)).status).toBe(200);
    const complete = await data<FileRecord>(
      await request(`/api/admin/uploads/${other.id}/complete`, 'POST'),
    );
    expect(await (await request(`/api/admin/files/${complete.id}/download`)).text()).toBe('test');
  });

  it('uses the actual Markdown directory and protects edits and publication of locked documents', async () => {
    const note = await createMarkdown('# original', 'note.md');
    await lock('/dav/Markdown/note.md');
    expect(
      (await request('/api/admin/markdown', 'POST', { name: 'note.md', folder_id: null })).status,
    ).toBe(423);
    expect(
      (await request(`/api/admin/markdown/${note.id}`, 'PUT', { content: '# bypass', version: 1 }))
        .status,
    ).toBe(423);
    expect(
      (
        await request(`/api/admin/markdown/${note.id}/publish`, 'POST', {
          title: 'note',
          slug: 'note',
          version: 1,
        })
      ).status,
    ).toBe(423);
    expect((await request('/api/admin/markdown', 'POST', { name: 'unrelated.md' })).status).toBe(
      201,
    );
  });

  it('protects image source files and unknown MD5 destinations without blocking unrelated file writes', async () => {
    const source = await data<FileRecord>(await upload('original.png', png));
    await lock('/dav/original.png');
    expect((await request('/api/admin/images', 'POST', { file_id: source.id })).status).toBe(423);
    await testEnv.DB.prepare('DELETE FROM webdav_locks').run();
    await lock('/dav/Image-hosting/' + 'a'.repeat(32) + '.png');
    expect((await request('/api/admin/images', 'POST', { file_id: source.id })).status).toBe(423);
    expect((await upload('unrelated.txt', 'fine')).status).toBe(201);
  });

  it('protects moved hosted images from restore, purge, revoke and deduplication', async () => {
    const source = await data<FileRecord>(await upload('original.png', png));
    const image = await data<{ name: string; file_id: string }>(
      await request('/api/admin/images', 'POST', { file_id: source.id }),
    );
    await request(`/api/admin/files/${image.file_id}`, 'PATCH', {
      folder_id: null,
      name: 'moved.png',
    });
    await request(`/api/admin/images/${image.name}`, 'DELETE');
    const duplicate = await data<FileRecord>(await upload('duplicate.png', png));
    await lock('/dav/moved.png');
    expect((await request(`/api/admin/images/${image.name}/restore`, 'POST')).status).toBe(423);
    expect((await request(`/api/admin/images/${image.name}`, 'DELETE')).status).toBe(423);
    expect((await request(`/api/admin/images/${image.name}/permanent`, 'DELETE')).status).toBe(423);
    expect((await request('/api/admin/images', 'POST', { file_id: duplicate.id })).status).toBe(
      423,
    );
    expect((await request('/api/admin/images/folder', 'POST')).status).toBe(200);
  });

  it('ignores expired locks but rejects web writes while DAV holds the exclusive lease', async () => {
    await lock('/dav/', 'infinity', Date.now() - 1);
    expect((await upload('expired-lock.txt', 'fine')).status).toBe(201);
    await testEnv.DB.prepare('UPDATE storage_write_lease SET owner=?,expires_at=? WHERE id=1')
      .bind('another-request', Date.now() + 60000)
      .run();
    const blocked = await upload('unrelated.txt', 'blocked');
    expect(blocked.status).toBe(423);
    expect(blocked.headers.get('Retry-After')).toBe('2');
    expect((await request('/api/admin/files')).status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT owner FROM storage_write_lease WHERE id=1').first<string>(
        'owner',
      ),
    ).toBe('another-request');
  });

  it('allows concurrent web uploads but excludes DAV until every web registration is released', async () => {
    const { password } = await data<{ password: string }>(
      await request('/api/admin/webdav', 'POST', { name: 'concurrency', expires_in_days: 30 }),
    );
    const dav = () =>
      app.request(
        'http://localhost/dav/created-by-dav',
        {
          method: 'MKCOL',
          headers: { Authorization: 'Basic ' + btoa('rcloud:' + password) },
        },
        testEnv,
      );
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, key) {
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            entered();
            await paused;
            return target.put(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const inFlight = app.request(
      'http://localhost/api/admin/files/upload?name=slow.txt',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': '4' },
        body: 'slow',
      },
      { ...testEnv, BUCKET: bucket },
    );
    try {
      await started;
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
      ).toBe(1);
      expect((await upload('parallel.txt', 'parallel')).status).toBe(201);
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
      ).toBe(1);
      expect((await dav()).status).toBe(423);
    } finally {
      resume();
      expect((await inFlight).status).toBe(201);
    }
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
    ).toBe(0);
    // Expired registrations from a crashed web request cannot permanently block DAV.
    await testEnv.DB.prepare('INSERT INTO storage_web_writes(owner,expires_at) VALUES(?,?)')
      .bind('crashed', Date.now() - 1)
      .run();
    expect((await dav()).status).toBe(201);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM storage_web_writes').first<number>('n'),
    ).toBe(0);
    expect((await upload('after-dav.txt', 'fine')).status).toBe(201);
  });
});
