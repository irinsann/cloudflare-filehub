import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request } from './helpers';
import { testEnv } from './setup';
import { cleanup } from '../worker/storage';
import { storageUsage } from '../worker/quota';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function uploadedParts() {
  const session = await data<{ id: string; fileId: string }>(
    await request('/api/admin/uploads', 'POST', { name: 'race.bin', size: 10 }),
  );
  const response = await app.request(
    'http://localhost/api/admin/uploads/' + session.id + '/parts/1',
    {
      method: 'PUT',
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        'X-File-Size': '10',
      },
      body: new Uint8Array(10).buffer,
    },
    testEnv,
  );
  expect(response.status).toBe(200);
  const key = await testEnv.DB.prepare('SELECT object_key FROM upload_sessions WHERE id=?')
    .bind(session.id)
    .first<string>('object_key');
  return { ...session, key: key! };
}
function beforeCommit(callback: () => Promise<void>) {
  return new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await callback();
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function cancelBucket(beforeAbort: () => Promise<void>, failDelete = false) {
  return new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === 'resumeMultipartUpload')
        return () => ({
          abort: async () => {
            await beforeAbort();
            throw new Error('The specified multipart upload does not exist. (10024)');
          },
        });
      if (key === 'delete' && failDelete)
        return async () => {
          throw new Error('R2 deletion temporarily unavailable');
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('multipart completion and cancellation races', () => {
  it('retains cleanup after cancellation wins and R2 deletion fails before completion commits', async () => {
    const session = await uploadedParts();
    const completing = signal(),
      resume = signal();
    const db = beforeCommit(async () => {
      completing.resolve();
      await resume.promise;
    });
    const completion = request(
      '/api/admin/uploads/' + session.id + '/complete',
      'POST',
      undefined,
      {
        ...testEnv,
        DB: db,
      },
    );
    await completing.promise;
    expect(await testEnv.BUCKET.head(session.key)).not.toBeNull();
    try {
      const cancelled = await request('/api/admin/uploads/' + session.id, 'DELETE', undefined, {
        ...testEnv,
        BUCKET: cancelBucket(async () => {}, true),
      });
      expect(cancelled.status).toBe(500);
      expect(
        await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(session.fileId).first(),
      ).toBeNull();
    } finally {
      resume.resolve();
    }
    expect((await completion).status).toBe(404);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(session.key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);
    await testEnv.DB.prepare('UPDATE cleanup_tasks SET created_at=0').run();
    await cleanup(testEnv);
    expect(await testEnv.BUCKET.head(session.key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });

  it('keeps a completed file when cancellation resumes after the metadata commit', async () => {
    const session = await uploadedParts();
    const completing = signal(),
      commit = signal(),
      cancelling = signal(),
      abort = signal();
    const completion = request(
      '/api/admin/uploads/' + session.id + '/complete',
      'POST',
      undefined,
      {
        ...testEnv,
        DB: beforeCommit(async () => {
          completing.resolve();
          await commit.promise;
        }),
      },
    );
    await completing.promise;
    const cancellation = request('/api/admin/uploads/' + session.id, 'DELETE', undefined, {
      ...testEnv,
      BUCKET: cancelBucket(async () => {
        cancelling.resolve();
        await abort.promise;
      }),
    });
    await cancelling.promise;
    commit.resolve();
    try {
      expect((await completion).status).toBe(201);
    } finally {
      abort.resolve();
    }
    expect((await cancellation).status).toBe(200);
    expect((await request('/api/admin/files/' + session.fileId)).status).toBe(200);
    expect(await testEnv.BUCKET.head(session.key)).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(session.key)
        .first(),
    ).toBeNull();
  });
});
