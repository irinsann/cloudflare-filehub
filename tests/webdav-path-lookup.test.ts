import { describe, expect, it } from 'vitest';
import { resolve } from '../worker/webdav-store';
import { testEnv } from './setup';

describe('indexed WebDAV path resolution', () => {
  it('resolves a large directory case-insensitively while retaining pending and ambiguity checks', async () => {
    await testEnv.DB.prepare(
      `WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      INSERT INTO files(id,name,object_key,mime,size,status,created_at,updated_at)
      SELECT 'path-'||n,'path-'||n||'.txt','path-objects/'||n,'text/plain',0,'ready',1,1 FROM seq`,
    ).run();
    const resolved = await resolve(testEnv, '/dav/PATH-1000.txt');
    expect(resolved?.row.id).toBe('path-1000');
    expect(resolved?.path).toBe('/dav/path-1000.txt');
    expect(await resolve(testEnv, '/dav/missing.txt')).toBeNull();
    expect(await resolve(testEnv, '/dav/path-1000.txt/child')).toBeNull();

    await testEnv.DB.prepare("UPDATE files SET status='pending' WHERE id='path-1000'").run();
    await expect(resolve(testEnv, '/dav/path-1000.txt')).rejects.toMatchObject({ status: 423 });
    await testEnv.DB.prepare("UPDATE files SET status='ready' WHERE id='path-1000'").run();
    await testEnv.DB.prepare("UPDATE files SET name='PATH-1000.txt' WHERE id='path-999'").run();
    await expect(resolve(testEnv, '/dav/path-1000.txt')).rejects.toMatchObject({ status: 409 });
    await testEnv.DB.prepare("UPDATE files SET deleted_at=1 WHERE id='path-999'").run();
    expect((await resolve(testEnv, '/dav/path-1000.txt'))?.row.id).toBe('path-1000');

    await testEnv.DB.prepare(
      "INSERT INTO folders(id,name,created_at,updated_at) VALUES('collision','PATH-1000.txt',1,1)",
    ).run();
    await expect(resolve(testEnv, '/dav/path-1000.txt')).rejects.toMatchObject({ status: 409 });
  });
});
