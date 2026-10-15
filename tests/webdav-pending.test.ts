import { expect, it } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { request, data } from './helpers';

it('reserves the path of unfinished multipart uploads across DAV requests', async () => {
  const { password } = await data<{ password: string }>(
    await request('/api/admin/webdav', 'POST', { name: 'pending' }),
  );
  const folder = await data<{ id: string }>(
    await request('/api/admin/folders', 'POST', { name: 'Uploading' }),
  );
  const upload = await data<{ id: string }>(
    await request('/api/admin/uploads', 'POST', {
      name: 'in-progress.txt',
      size: 16,
      folder_id: folder.id,
    }),
  );
  const headers = { Authorization: 'Basic ' + btoa('rcloud:' + password) };
  for (const method of ['GET', 'DELETE', 'MKCOL', 'LOCK']) {
    const response = await app.request(
      'http://localhost/dav/Uploading/in-progress.txt',
      { method, headers },
      testEnv,
    );
    expect(response.status).toBe(423);
  }
  expect(
    (
      await app.request(
        'http://localhost/dav/Uploading/in-progress.txt',
        { method: 'PUT', headers: { ...headers, 'Content-Length': '1' }, body: 'x' },
        testEnv,
      )
    ).status,
  ).toBe(423);
  expect(
    (await app.request('http://localhost/dav/Uploading', { method: 'DELETE', headers }, testEnv))
      .status,
  ).toBe(423);
  expect((await request('/api/admin/uploads/' + upload.id, 'DELETE')).status).toBe(200);
  expect(
    (await app.request('http://localhost/dav/Uploading', { method: 'DELETE', headers }, testEnv))
      .status,
  ).toBe(204);
});

it('cleans dead DAV properties when an empty folder is permanently removed', async () => {
  const folder = await data<{ id: string }>(
    await request('/api/admin/folders', 'POST', { name: 'Properties' }),
  );
  await testEnv.DB.prepare(
    'INSERT INTO webdav_properties(resource_id,namespace,name,value) VALUES(?,?,?,?)',
  )
    .bind('folder:' + folder.id, 'urn:test', 'label', 'value')
    .run();
  expect((await request('/api/admin/folders/' + folder.id, 'DELETE')).status).toBe(200);
  expect((await request('/api/admin/folders/' + folder.id + '/permanent', 'DELETE')).status).toBe(
    200,
  );
  expect(
    await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webdav_properties').first<number>('n'),
  ).toBe(0);
});
