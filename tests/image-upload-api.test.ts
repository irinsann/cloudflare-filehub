import { describe, it, expect } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { request, data, upload } from './helpers';
import { sharexConfig } from '../shared/sharex';
import { storageUsage, STORAGE_LIMIT } from '../worker/quota';
import { PART_SIZE } from '../worker/uploads';
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a33sAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
async function token(scope = 'images:upload') {
  return data<{ id: string; token: string; scope: string }>(
    await request('/api/admin/api-tokens', 'POST', { name: 'ShareX test', scope }),
  );
}
async function formRequest(
  key: string,
  options: {
    bytes?: Uint8Array;
    field?: string;
    second?: boolean;
    cut?: boolean;
    missingLength?: boolean;
  } = {},
) {
  const form = new FormData();
  form.append(
    options.field || 'file',
    new Blob([(options.bytes || png).slice().buffer], { type: 'image/png' }),
    '截图 中文.png',
  );
  if (options.second) form.append('file', new Blob([png.slice().buffer]), 'second.png');
  const serialized = new Request('http://localhost', { method: 'POST', body: form });
  let body = new Uint8Array(await serialized.arrayBuffer());
  if (options.cut) body = body.slice(0, -12);
  return app.request(
    'http://localhost/api/v1/images',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': serialized.headers.get('Content-Type')!,
        ...(options.missingLength ? {} : { 'Content-Length': String(body.length) }),
      },
      body: body.slice().buffer,
    },
    { ...testEnv, FILES_ORIGIN: 'https://s.irin.im' },
  );
}
describe('ShareX image upload API', () => {
  it('matches the SXCU request and returns a working MD5 direct URL in Image-hosting', async () => {
    const t = await token(),
      config = sharexConfig('https://s.irin.im', t.token);
    expect(config).toMatchObject({
      DestinationType: 'ImageUploader',
      RequestMethod: 'POST',
      Body: 'MultipartFormData',
      FileFormName: 'file',
      URL: '{json:data.url}',
      ErrorMessage: '{json:error.message}',
    });
    const r = await formRequest(t.token);
    expect(r.status).toBe(201);
    const image = await data<{ name: string; file_id: string; url: string }>(r);
    expect(image.name).toBe('39dd1aed58e76c360216335fda25d0cf.png');
    expect(image.url).toBe('https://s.irin.im/i/' + image.name);
    const file = await testEnv.DB.prepare(
      'SELECT f.name,f.object_key,d.name AS folder FROM files f JOIN folders d ON d.id=f.folder_id WHERE f.id=?',
    )
      .bind(image.file_id)
      .first<{ name: string; object_key: string; folder: string }>();
    expect(file?.folder).toBe('Image-hosting');
    expect(file?.name).toBe(image.name);
    expect(file?.object_key).toMatch(/^Image-hosting\//);
    const publicFile = await request('/i/' + image.name);
    expect(publicFile.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await publicFile.arrayBuffer())).toEqual(png);
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(png.length);
    expect(
      (await testEnv.DB.prepare('SELECT count(*) AS n FROM upload_sessions').first<{ n: number }>())
        ?.n,
    ).toBe(0);
  });
  it('reuses web-hosted images and cleans duplicate source files', async () => {
    const old = await data<{ id: string }>(await upload('web.png', png));
    const web = await data<{ name: string; file_id: string }>(
      await request('/api/admin/images', 'POST', { file_id: old.id }),
    );
    const t = await token();
    for (let i = 0; i < 2; i++) {
      const r = await formRequest(t.token);
      expect(r.status).toBe(200);
      const result = await data<{ file_id: string; duplicate: boolean }>(r);
      expect(result.file_id).toBe(web.file_id);
      expect(result.duplicate).toBe(true);
    }
    expect(
      (await testEnv.DB.prepare('SELECT count(*) AS n FROM files').first<{ n: number }>())?.n,
    ).toBe(1);
  });
  it('isolates image and private-file tokens, rejects revoked keys', async () => {
    const files = await token('files:upload');
    expect((await formRequest(files.token)).status).toBe(403);
    const images = await token();
    expect(
      (
        await app.request(
          'http://localhost/api/v1/uploads',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + images.token,
              'Content-Type': 'application/json',
            },
            body: '{"name":"private","size":1}',
          },
          testEnv,
        )
      ).status,
    ).toBe(403);
    await request('/api/admin/api-tokens/' + images.id, 'DELETE');
    expect((await formRequest(images.token)).status).toBe(401);
    expect((await formRequest('bad')).status).toBe(401);
  });
  it('rejects malformed, duplicate, wrong-field and non-image uploads without leftover quota', async () => {
    const t = await token();
    for (const options of [
      { field: 'wrong' },
      { second: true },
      { cut: true },
      { bytes: new TextEncoder().encode('<svg>not accepted</svg>') },
      { bytes: new Uint8Array() },
    ]) {
      const r = await formRequest(t.token, options);
      expect([400, 415]).toContain(r.status);
      expect((await storageUsage(testEnv)).storageUsedBytes).toBe(0);
      expect(
        (await testEnv.DB.prepare('SELECT count(*) AS n FROM files').first<{ n: number }>())?.n,
      ).toBe(0);
    }
    expect((await formRequest(t.token, { missingLength: true })).status).toBe(411);
  });
  it('streams images across R2 parts and returns exact bytes', async () => {
    const t = await token(),
      bytes = new Uint8Array(PART_SIZE + 11);
    bytes.set(png);
    bytes[bytes.length - 1] = 42;
    const r = await formRequest(t.token, { bytes });
    expect(r.status).toBe(201);
    const image = await data<{ name: string }>(r);
    const downloaded = await (await request('/i/' + image.name)).arrayBuffer();
    expect(downloaded.byteLength).toBe(bytes.length);
    expect(new Uint8Array(await crypto.subtle.digest('SHA-256', downloaded))).toEqual(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    );
    expect((await storageUsage(testEnv)).storageUsedBytes).toBe(bytes.length);
  });
  it('enforces the shared quota before accepting multipart bytes', async () => {
    const t = await token();
    await storageUsage(testEnv);
    await testEnv.DB.prepare('INSERT INTO storage_allocations(object_key,size) VALUES(?,?)')
      .bind('test-quota', STORAGE_LIMIT)
      .run();
    expect((await formRequest(t.token)).status).toBe(413);
  });
});
