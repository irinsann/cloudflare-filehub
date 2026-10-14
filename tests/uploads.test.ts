import { describe, it, expect } from 'vitest';
import { app } from '../worker/index';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';
import { PART_SIZE } from '../worker/uploads';
import { STORAGE_LIMIT } from '../worker/quota';
async function part(id: string, n: number, bytes: Uint8Array, declared = bytes.length) {
  return app.request(
    'http://localhost/api/admin/uploads/' + id + '/parts/' + n,
    {
      method: 'PUT',
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        'X-File-Size': String(declared),
        'Content-Type': 'application/octet-stream',
      },
      body: bytes.slice().buffer,
    },
    testEnv,
  );
}
describe('RCloud uploads and direct links', () => {
  it('accepts files above 1GB, rejects over total quota, rejects missing and wrong-size parts', async () => {
    const s = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'large.bin', size: 2 * 1024 ** 3 }),
    );
    expect(
      (
        await request('/api/admin/uploads', 'POST', {
          name: 'too-large.bin',
          size: STORAGE_LIMIT + 1,
        })
      ).status,
    ).toBe(413);
    expect((await request('/api/admin/uploads/' + s.id + '/complete', 'POST')).status).toBe(409);
    expect((await part(s.id, 1, new Uint8Array(1))).status).toBe(400);
    expect((await part(s.id, 0, new Uint8Array(1))).status).toBe(400);
    await request('/api/admin/uploads/' + s.id, 'DELETE');
  });
  it('uploads multiple parts, retries a part, completes and returns exact bytes', async () => {
    const s = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'two.bin', size: PART_SIZE + 3 }),
    );
    const first = new Uint8Array(PART_SIZE);
    first[0] = 42;
    expect((await part(s.id, 1, first)).status).toBe(200);
    expect((await part(s.id, 1, first)).status).toBe(200);
    expect((await part(s.id, 2, new Uint8Array([1, 2, 3]))).status).toBe(200);
    const f = await data<FileRecord>(
      await request('/api/admin/uploads/' + s.id + '/complete', 'POST'),
    );
    expect(f.size).toBe(PART_SIZE + 3);
    const r = await request('/api/admin/files/' + f.id + '/download', 'GET', undefined, testEnv, {
      Range: 'bytes=' + PART_SIZE + '-',
    });
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await part(s.id, 1, first)).status).toBe(410);
  });
  it('direct links support range and are revoked with a share or trashed file', async () => {
    const f = await data<FileRecord>(await upload('direct.txt', 'abcdef'));
    const s = await data<{ id: string; directUrl: string }>(
      await request('/api/admin/shares', 'POST', { file_id: f.id }),
    );
    const path = new URL(s.directUrl).pathname;
    const range = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=1-3' });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('bcd');
    await request('/api/admin/shares/' + s.id, 'DELETE');
    expect((await request(path)).status).toBe(410);
  });
  it('empties all trash atomically, deletes objects, keeps active files', async () => {
    const keep = await data<FileRecord>(await upload('keep.txt', 'keep'));
    const gone = await data<FileRecord>(await upload('gone.txt', 'gone'));
    await request('/api/admin/files/' + gone.id, 'DELETE');
    const result = await data<{ files: number }>(await request('/api/admin/trash', 'DELETE'));
    expect(result.files).toBe(1);
    expect((await request('/api/admin/files/' + gone.id + '/restore', 'POST')).status).toBe(404);
    expect((await request('/api/admin/files/' + keep.id)).status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(gone.object_key)
        .first(),
    ).toBeNull();
    expect(await testEnv.BUCKET.head(gone.object_key)).toBeNull();
  });
});
