import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';
import type { FileRecord, FolderRecord, Listing } from '../shared/types';

describe('storage audit regressions', () => {
  it('empties nested folders trashed through WebDAV in one operation', async () => {
    const parent = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'Parent' }),
    );
    const child = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'Child', parent_id: parent.id }),
    );
    const grandchild = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'Leaf', parent_id: child.id }),
    );
    await data<FileRecord>(await upload('leaf.txt', 'content', grandchild.id));
    const credential = await data<{ password: string }>(
      await request('/api/admin/webdav', 'POST', { name: 'Storage audit', expires_in_days: 30 }),
    );
    const deleted = await app.request(
      'http://localhost/dav/Parent',
      {
        method: 'DELETE',
        headers: { Authorization: 'Basic ' + btoa('rcloud:' + credential.password) },
      },
      testEnv,
    );
    expect(deleted.status).toBe(204);
    // A parent in a trashed DAV tree still has children; report a conflict, not a D1 failure.
    expect((await request('/api/admin/folders/' + parent.id + '/permanent', 'DELETE')).status).toBe(
      409,
    );
    const result = await data<{ files: number; folders: number }>(
      await request('/api/admin/trash', 'DELETE'),
    );
    expect(result).toEqual({ files: 1, folders: 3 });
    const trash = await data<Listing>(await request('/api/admin/files?view=trash'));
    expect(trash.files).toHaveLength(0);
    expect(trash.folders).toHaveLength(0);
    expect((await testEnv.BUCKET.list()).objects).toHaveLength(0);
  });

  it('preserves folders with retained upload sessions and their ancestors while emptying trash', async () => {
    const parent = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', { name: 'Protected parent' }),
    );
    const child = await data<FolderRecord>(
      await request('/api/admin/folders', 'POST', {
        name: 'Protected child',
        parent_id: parent.id,
      }),
    );
    const pending = await data<{ id: string; fileId: string }>(
      await request('/api/admin/uploads', 'POST', {
        name: 'pending.bin',
        size: 10,
        folder_id: child.id,
      }),
    );
    // Represent retained recovery metadata in a deleted tree; purge excludes active sessions.
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE files SET deleted_at=1 WHERE id=?').bind(pending.fileId),
      testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(child.id),
      testEnv.DB.prepare('UPDATE folders SET deleted_at=1 WHERE id=?').bind(parent.id),
    ]);
    const result = await data<{ files: number; folders: number }>(
      await request('/api/admin/trash', 'DELETE'),
    );
    expect(result).toEqual({ files: 0, folders: 0 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM folders').first<number>('n')).toBe(
      2,
    );
    expect(
      await testEnv.DB.prepare('SELECT id FROM upload_sessions WHERE id=?')
        .bind(pending.id)
        .first(),
    ).not.toBeNull();
    await request('/api/admin/uploads/' + pending.id, 'DELETE');
    const afterCancel = await data<{ files: number; folders: number }>(
      await request('/api/admin/trash', 'DELETE'),
    );
    expect(afterCancel).toEqual({ files: 0, folders: 2 });
  });
});
