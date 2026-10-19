import { describe, expect, it } from 'vitest';
import { data, request } from './helpers';
import { testEnv } from './setup';
import { storageUsage } from '../worker/quota';

function abortFailure(error: unknown) {
  return new Proxy(testEnv.BUCKET, {
    get(target, key) {
      if (key === 'resumeMultipartUpload')
        return () => ({
          abort: async () => {
            throw error;
          },
        });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function pendingUpload() {
  const session = await data<{ id: string; fileId: string }>(
    await request('/api/admin/uploads', 'POST', { name: 'cancel.bin', size: 10 }),
  );
  const row = await testEnv.DB.prepare(
    'SELECT object_key,upload_id FROM upload_sessions WHERE id=?',
  )
    .bind(session.id)
    .first<{ object_key: string; upload_id: string }>();
  const multipart = testEnv.BUCKET.resumeMultipartUpload(row!.object_key, row!.upload_id);
  await multipart.uploadPart(1, new Uint8Array(10));
  return { ...session, ...row!, multipart };
}

describe('multipart upload cancellation recovery', () => {
  it('retains the session, pending file, cleanup task and capacity after a transient abort failure', async () => {
    const upload = await pendingUpload();
    const response = await request('/api/admin/uploads/' + upload.id, 'DELETE', undefined, {
      ...testEnv,
      BUCKET: abortFailure(new Error('R2 temporarily unavailable (10001)')),
    });
    expect(response.status).toBe(502);
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?').bind(upload.id).first(),
    ).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT status FROM files WHERE id=?')
        .bind(upload.fileId)
        .first<string>('status'),
    ).toBe('pending');
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(upload.object_key)
        .first(),
    ).not.toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(10);

    // Retained metadata lets the next cancellation actually abort the R2 multipart upload.
    expect((await request('/api/admin/uploads/' + upload.id, 'DELETE')).status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?').bind(upload.id).first(),
    ).toBeNull();
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
    await expect(upload.multipart.uploadPart(1, new Uint8Array(10))).rejects.toThrow();
  });

  it.each([
    new Error('The specified multipart upload does not exist. (10024)'),
    { code: 10024 },
    { code: '10024' },
    { code: 'NoSuchUpload' },
  ])('safely releases an upload whose abort is confirmed complete: %j', async (error) => {
    const upload = await pendingUpload();
    await upload.multipart.abort();
    expect(
      (
        await request('/api/admin/uploads/' + upload.id, 'DELETE', undefined, {
          ...testEnv,
          BUCKET: abortFailure(error),
        })
      ).status,
    ).toBe(200);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
    expect(
      await testEnv.DB.prepare('SELECT id FROM files WHERE id=?').bind(upload.fileId).first(),
    ).toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(upload.object_key)
        .first(),
    ).toBeNull();
  });
});
