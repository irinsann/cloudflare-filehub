import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import type { Env } from '../worker/env';
import type { FileRecord, FolderRecord } from '../shared/types';
import { STORAGE_LIMIT } from '../worker/quota';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

async function fixture(count: number) {
  const { password } = await data<{ password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'Copy test', expires_in_days: 30 }),
  );
  const folder = await data<FolderRecord>(
    await request('/api/admin/folders', 'POST', { name: 'source' }),
  );
  const files: FileRecord[] = [];
  for (let index = 0; index < count; index++)
    files.push(
      await data<FileRecord>(await upload(`file-${index}.txt`, `content ${index}`, folder.id)),
    );
  return { password, folder, files };
}
function copy(password: string, target: string, env: Env = testEnv) {
  return app.request(
    'http://localhost/dav/source/',
    {
      method: 'COPY',
      headers: {
        Authorization: 'Basic ' + btoa('rcloud:' + password),
        Destination: 'http://localhost/dav/' + target,
      },
    },
    env,
  );
}
async function totals() {
  return {
    used: await testEnv.DB.prepare(
      'SELECT COALESCE(SUM(size),0) AS n FROM storage_allocations',
    ).first<number>('n'),
    queued: await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM cleanup_tasks').first<number>('n'),
    files: await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files').first<number>('n'),
    folders: await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM folders').first<number>('n'),
  };
}

describe('bounded transactional WebDAV copy', () => {
  it('copies twelve nodes within fifty D1/R2 calls and releases only successful reservations', async () => {
    const { password, files } = await fixture(11);
    const calls = { db: 0, r2: 0 };
    const database = new Proxy(testEnv.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'prepare')
          return (...args: Parameters<D1Database['prepare']>) => {
            calls.db++;
            return target.prepare(...args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (['get', 'put', 'head', 'delete', 'list'].includes(String(property)))
          return (...args: unknown[]) => {
            calls.r2++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const before = await totals();
    expect(
      (await copy(password, 'copied/', { ...testEnv, DB: database, BUCKET: bucket })).status,
    ).toBe(201);
    expect(calls.r2).toBe(22);
    expect(calls.db + calls.r2).toBeLessThanOrEqual(50);
    const folder = await testEnv.DB.prepare("SELECT id FROM folders WHERE name='copied'").first<{
      id: string;
    }>();
    const copied = (
      await testEnv.DB.prepare('SELECT * FROM files WHERE folder_id=?')
        .bind(folder!.id)
        .all<FileRecord>()
    ).results;
    expect(copied).toHaveLength(11);
    for (const file of copied) {
      const source = files.find((entry) => entry.name === file.name)!;
      expect(file.id).not.toBe(source.id);
      expect(file.object_key).not.toBe(source.object_key);
      expect(await (await testEnv.BUCKET.get(file.object_key))!.text()).toBe(
        `content ${file.name.match(/\d+/)![0]}`,
      );
    }
    expect(await totals()).toMatchObject({
      used: before.used! + files.reduce((sum, file) => sum + file.size, 0),
      queued: before.queued,
    });
  });

  it('rejects thirteen nodes before touching an overwrite target or reserving destination storage', async () => {
    const { password } = await fixture(12);
    const target = await data<FileRecord>(await upload('target.txt', 'keep target'));
    const before = await totals();
    expect((await copy(password, 'target.txt')).status).toBe(507);
    expect(await totals()).toEqual(before);
    expect(
      await testEnv.DB.prepare('SELECT deleted_at FROM files WHERE id=?')
        .bind(target.id)
        .first<number>('deleted_at'),
    ).toBeNull();
    expect(await (await testEnv.BUCKET.get(target.object_key))!.text()).toBe('keep target');
  });

  it('preserves the source and overwrite target while retaining failed-copy objects in the cleanup quota', async () => {
    const { password, files } = await fixture(2);
    const target = await data<FileRecord>(await upload('target.txt', 'original target'));
    const before = await totals();
    let written = 0;
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        if (property === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            if (++written === 2) throw new Error('Simulated second-copy failure');
            return target.put(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await copy(password, 'target.txt', { ...testEnv, BUCKET: bucket })).status).toBe(502);
    expect(await totals()).toEqual({
      ...before,
      used: before.used! + files.reduce((sum, file) => sum + file.size, 0),
      queued: before.queued! + 2,
    });
    expect(
      await testEnv.DB.prepare('SELECT deleted_at FROM files WHERE id=?')
        .bind(target.id)
        .first<number>('deleted_at'),
    ).toBeNull();
    expect(await (await testEnv.BUCKET.get(target.object_key))!.text()).toBe('original target');
    for (const file of files) expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
  });

  it('reserves the whole copy quota atomically before reading or writing any object', async () => {
    const { password } = await fixture(2);
    const before = await totals();
    await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
      .bind('objects/quota-fixture', STORAGE_LIMIT - before.used! - 1)
      .run();
    const full = await totals();
    let objectCalls = 0;
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'get' || property === 'put')
          return (...args: unknown[]) => {
            objectCalls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await copy(password, 'quota-copy/', { ...testEnv, BUCKET: bucket })).status).toBe(507);
    expect(objectCalls).toBe(0);
    expect(await totals()).toEqual(full);
  });
});
