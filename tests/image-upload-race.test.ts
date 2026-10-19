import { expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request } from './helpers';
import { testEnv } from './setup';
import { storageUsage } from '../worker/quota';
import { cleanup } from '../worker/storage';

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function publishDatabase(before: () => Promise<void>, after: () => Promise<void>) {
  let batches = 0;
  return new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          // uploadImage batches: pending metadata, ready metadata, image publication.
          const publishing = ++batches === 3;
          if (publishing) await before();
          const result = await target.batch(statements);
          if (publishing) await after();
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function uploadImage(token: string, db: D1Database) {
  const form = new FormData();
  form.append('file', new Blob([png.slice().buffer]), 'same.png');
  const serialized = new Request('http://localhost', { method: 'POST', body: form });
  const body = await serialized.arrayBuffer();
  return app.request(
    'http://localhost/api/v1/images',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': serialized.headers.get('Content-Type')!,
        'Content-Length': String(body.byteLength),
      },
      body,
    },
    { ...testEnv, DB: db },
  );
}

it('does not orphan an image object when simultaneous duplicate API uploads publish before source cleanup', async () => {
  const token = await data<{ token: string }>(
    await request('/api/admin/api-tokens', 'POST', { name: 'Race audit', scope: 'images:upload' }),
  );
  await storageUsage(testEnv);
  const firstPublishing = signal(),
    secondPublishing = signal();
  const firstCommitted = signal(),
    secondCommitted = signal();
  const firstDb = publishDatabase(
    async () => {
      firstPublishing.resolve();
      await secondPublishing.promise;
    },
    async () => {
      firstCommitted.resolve();
      await secondCommitted.promise;
    },
  );
  const secondDb = publishDatabase(
    async () => {
      secondPublishing.resolve();
      await firstCommitted.promise;
    },
    async () => {
      secondCommitted.resolve();
    },
  );
  const first = uploadImage(token.token, firstDb);
  await firstPublishing.promise;
  const second = uploadImage(token.token, secondDb);
  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response.status)).toEqual([201, 200]);
  const results = await Promise.all(
    responses.map((response) => data<{ file_id: string; url: string }>(response)),
  );
  expect(results[0].file_id).toBe(results[1].file_id);
  expect(results[0].url).toBe(results[1].url);
  await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
  await cleanup(testEnv);
  const objects = (await testEnv.BUCKET.list()).objects;
  expect(objects).toHaveLength(1);
  expect((await storageUsage(testEnv)).storageUsedBytes).toBe(png.byteLength);
  for (const object of objects) {
    const referenced = await testEnv.DB.prepare('SELECT id FROM files WHERE object_key=?')
      .bind(object.key)
      .first();
    expect(referenced, 'Untracked R2 object: ' + object.key).not.toBeNull();
  }
});
