import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request } from './helpers';
import { testEnv } from './setup';
import { PART_SIZE } from '../worker/uploads';
import { storageUsage } from '../worker/quota';
import type { FileRecord } from '../shared/types';

function databaseFailure() {
  return new Proxy(testEnv.DB, {
    get(target, key) {
      if (key === 'batch')
        return async () => {
          throw new Error('D1 unavailable after R2 completed');
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function missingMultipart(afterHead?: (head: R2Object | null) => Promise<void>) {
  return new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === 'resumeMultipartUpload')
        return () => ({
          complete: async () => {
            throw new Error('The specified multipart upload does not exist. (10024)');
          },
        });
      if (key === 'head' && afterHead)
        return async (objectKey: string) => {
          const head = await target.head(objectKey);
          await afterHead(head);
          return head;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function completedObjectWithPendingMetadata(size = 10) {
  const session = await data<{ id: string; fileId: string }>(
    await request('/api/admin/uploads', 'POST', { name: 'recovery.bin', size }),
  );
  for (let offset = 0, part = 1; offset < size; offset += PART_SIZE, part++) {
    const bytes = new Uint8Array(Math.min(PART_SIZE, size - offset)).fill(part);
    const response = await app.request(
      `http://localhost/api/admin/uploads/${session.id}/parts/${part}`,
      {
        method: 'PUT',
        headers: {
          Origin: 'http://localhost',
          'X-Drive-Request': '1',
          'X-File-Size': String(bytes.length),
        },
        body: bytes.buffer,
      },
      testEnv,
    );
    expect(response.status).toBe(200);
  }
  const failed = await request(
    '/api/admin/uploads/' + session.id + '/complete',
    'POST',
    undefined,
    {
      ...testEnv,
      DB: databaseFailure(),
    },
  );
  expect(failed.status).toBe(500);
  const key = await testEnv.DB.prepare('SELECT object_key FROM upload_sessions WHERE id=?')
    .bind(session.id)
    .first<string>('object_key');
  expect(key).not.toBeNull();
  const object = await testEnv.BUCKET.head(key!);
  expect(object?.size).toBe(size);
  expect(
    await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
      .bind(session.fileId)
      .first<string>('status'),
  ).toBe('pending');
  return { ...session, key: key!, size, etag: object!.etag, version: object!.version };
}
function retry(id: string, bucket = missingMultipart()) {
  return request('/api/admin/uploads/' + id + '/complete', 'POST', undefined, {
    ...testEnv,
    BUCKET: bucket,
  });
}

describe('multipart completion recovers after the R2 commit and before the D1 commit', () => {
  it.each([10, PART_SIZE + 3])(
    'recovers the original %i-byte object without reuploading or reserving twice',
    async (size) => {
      const session = await completedObjectWithPendingMetadata(size);
      const response = await retry(session.id);
      expect(response.status).toBe(201);
      const file = await data<FileRecord>(response);
      expect(file).toMatchObject({
        id: session.fileId,
        object_key: session.key,
        size,
        etag: session.etag,
        status: 'ready',
      });
      expect((await testEnv.BUCKET.head(session.key))?.version).toBe(session.version);
      expect((await testEnv.BUCKET.list()).objects).toHaveLength(1);
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(size);
      expect(
        await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
          .bind(session.id)
          .first(),
      ).toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
          .bind(session.key)
          .first(),
      ).toBeNull();
      const body = new Uint8Array(
        await (await request('/api/admin/files/' + file.id + '/download')).arrayBuffer(),
      );
      expect(body.length).toBe(size);
      expect(body[0]).toBe(1);
      expect(body.at(-1)).toBe(size > PART_SIZE ? 2 : 1);
      expect((await retry(session.id)).status).toBe(410);
    },
  );

  it.each([10, 11])('does not adopt a replacement object of %i bytes', async (replacementSize) => {
    const session = await completedObjectWithPendingMetadata();
    await testEnv.BUCKET.put(session.key, new Uint8Array(replacementSize).fill(7));
    const response = await retry(session.id);
    expect(response.ok).toBe(false);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(session.fileId)
        .first<string>('status'),
    ).toBe('pending');
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(session.key)
        .first(),
    ).not.toBeNull();
  });

  it.each(['rcloud_upload', 'rcloud_file', 'rcloud_size', 'missing'])(
    'rejects a same-content multipart object with %s identity metadata changed',
    async (field) => {
      const session = await completedObjectWithPendingMetadata();
      const original = await testEnv.BUCKET.head(session.key);
      expect(original?.customMetadata).toEqual({
        rcloud_upload: session.id,
        rcloud_file: session.fileId,
        rcloud_size: String(session.size),
      });
      const metadata = { ...original!.customMetadata };
      if (field === 'missing') {
        for (const key of Object.keys(metadata)) delete metadata[key];
      } else metadata[field] = field === 'rcloud_size' ? '11' : crypto.randomUUID();
      const replacement = await testEnv.BUCKET.createMultipartUpload(session.key, {
        customMetadata: metadata,
      });
      const part = await replacement.uploadPart(1, new Uint8Array(10).fill(1));
      const object = await replacement.complete([part]);
      expect(object.etag).toBe(session.etag);
      expect((await retry(session.id)).status).toBe(409);
      expect(
        await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
          .bind(session.fileId)
          .first<string>('status'),
      ).toBe('pending');
      expect(
        await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
          .bind(session.id)
          .first(),
      ).not.toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
          .bind(session.key)
          .first(),
      ).not.toBeNull();
    },
  );

  it.each(['upload_id', 'object_key', 'size', 'expires_at'])(
    'rechecks the session after R2 HEAD when %s changes concurrently',
    async (column) => {
      const session = await completedObjectWithPendingMetadata();
      let inspected = false;
      const values: Record<string, string | number> = {
        upload_id: 'another-upload',
        object_key: 'another-key',
        size: 11,
        expires_at: 0,
      };
      const bucket = missingMultipart(async () => {
        inspected = true;
        await testEnv.DB.prepare(`UPDATE upload_sessions SET ${column}=? WHERE id=?`)
          .bind(values[column], session.id)
          .run();
      });
      const response = await retry(session.id, bucket);
      expect(inspected).toBe(true);
      expect(response.ok).toBe(false);
      expect(
        await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
          .bind(session.fileId)
          .first<string>('status'),
      ).toBe('pending');
      expect(
        await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
          .bind(session.id)
          .first(),
      ).not.toBeNull();
      expect(
        await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
          .bind(session.key)
          .first(),
      ).not.toBeNull();
    },
  );

  it('does not commit recovery into a file whose object key changed after HEAD', async () => {
    const session = await completedObjectWithPendingMetadata();
    let inspected = false;
    const bucket = missingMultipart(async () => {
      inspected = true;
      await testEnv.DB.prepare('UPDATE files SET object_key=? WHERE id=?')
        .bind('replacement-file-key', session.fileId)
        .run();
    });
    const response = await retry(session.id, bucket);
    expect(inspected).toBe(true);
    expect(response.ok).toBe(false);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(session.fileId)
        .first<string>('status'),
    ).toBe('pending');
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(session.key)
        .first(),
    ).not.toBeNull();
  });

  it('does not recover from unrelated R2 errors and keeps retry metadata intact', async () => {
    const session = await completedObjectWithPendingMetadata();
    let inspected = false;
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, key) {
        if (key === 'resumeMultipartUpload')
          return () => ({
            complete: async () => {
              throw new Error('R2 temporarily unavailable (10001)');
            },
          });
        if (key === 'head')
          return async () => {
            inspected = true;
            return target.head(session.key);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await retry(session.id, bucket)).status).toBeGreaterThanOrEqual(500);
    expect(inspected).toBe(false);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(session.fileId)
        .first<string>('status'),
    ).toBe('pending');
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(session.key)
        .first(),
    ).not.toBeNull();
  });

  it('does not publish when the completed object is missing', async () => {
    const session = await completedObjectWithPendingMetadata();
    await testEnv.BUCKET.delete(session.key);
    expect((await retry(session.id)).ok).toBe(false);
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(session.fileId)
        .first<string>('status'),
    ).toBe('pending');
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(session.id)
        .first(),
    ).not.toBeNull();
  });

  it('never resurrects a cancelled file even when recovery already read a valid HEAD', async () => {
    const session = await completedObjectWithPendingMetadata();
    const bucket = missingMultipart(async () => {
      const cancelled = await request('/api/admin/uploads/' + session.id, 'DELETE');
      expect(cancelled.status).toBe(200);
    });
    const response = await retry(session.id, bucket);
    expect(response.ok).toBe(false);
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(session.fileId).first(),
    ).toBeNull();
    expect(await testEnv.BUCKET.head(session.key)).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
  });
});
