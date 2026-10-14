import { describe, it, expect } from 'vitest';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { data, request, upload } from './helpers';
import { digest } from '../worker/auth-crypto';

async function token(name = 'script') {
  return data<{ id: string; token: string }>(
    await request('/api/admin/api-tokens', 'POST', { name }),
  );
}
function call(
  key: string,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const binary = body instanceof Uint8Array;
  return app.request(
    'http://localhost/api/v1' + path,
    {
      method,
      headers: {
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
        ...(body === undefined
          ? {}
          : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : binary ? body.slice().buffer : JSON.stringify(body),
    },
    testEnv,
  );
}
describe('upload API tokens', () => {
  it('rejects malformed JSON and rate-limits authenticated API requests', async () => {
    const t = await token();
    const invalid = await app.request(
      'http://localhost/api/v1/uploads',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' },
        body: '{',
      },
      testEnv,
    );
    expect(invalid.status).toBe(400);
    const bucket = Math.floor(Date.now() / 60000);
    await testEnv.DB.prepare('INSERT OR REPLACE INTO rate_limits(key,count,reset_at) VALUES(?,?,?)')
      .bind('upload-api-token:' + (await digest(t.id)) + ':' + bucket, 240, (bucket + 1) * 60000)
      .run();
    expect((await call(t.token, '/uploads', 'POST', { name: 'rate.txt', size: 1 })).status).toBe(
      429,
    );
  });
  it('issues one-time secrets, stores hashes, and rejects expired/revoked credentials', async () => {
    const t = await token();
    expect(t.token).toMatch(/^rcu_[a-f0-9]{64}$/);
    const row = await testEnv.DB.prepare('SELECT token_hash FROM api_tokens WHERE id=?')
      .bind(t.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await digest(t.token));
    const list = await request('/api/admin/api-tokens');
    const text = await list.text();
    expect(text).not.toContain(t.token);
    expect(text).not.toContain('token_hash');
    expect((await call('', '/uploads', 'POST', { name: 'a.txt', size: 1 })).status).toBe(401);
    expect((await call(t.token, '/uploads', 'POST', { name: 'a.txt', size: 1 })).status).toBe(201);
    await request('/api/admin/api-tokens/' + t.id, 'DELETE');
    expect((await call(t.token, '/uploads', 'POST', { name: 'b.txt', size: 1 })).status).toBe(401);
    const old = await token('expired');
    await testEnv.DB.prepare('UPDATE api_tokens SET expires_at=0 WHERE id=?').bind(old.id).run();
    expect((await call(old.token, '/uploads', 'POST', { name: 'b.txt', size: 1 })).status).toBe(
      401,
    );
  });
  it('uploads private files and zero-byte files without cookies, does not expose internal keys', async () => {
    const t = await token();
    const folder = await data<{ id: string }>(
      await request('/api/admin/folders', 'POST', { name: 'API' }),
    );
    const r = await call(
      t.token,
      '/files?name=' + encodeURIComponent('测试.txt') + '&folder_id=' + folder.id,
      'POST',
      new Uint8Array([65, 66]),
      { 'X-File-Size': '2' },
    );
    expect(r.status).toBe(201);
    const f = await data<{ id: string; folder_id: string; object_key?: string }>(r);
    expect(f.folder_id).toBe(folder.id);
    expect(f.object_key).toBeUndefined();
    expect(await (await request('/api/admin/files/' + f.id + '/download')).text()).toBe('AB');
    expect((await call(t.token, '/files/' + f.id)).status).toBe(200);
    const empty = await call(t.token, '/files?name=empty.txt', 'POST', new Uint8Array(), {
      'X-File-Size': '0',
    });
    expect(empty.status).toBe(201);
    expect(
      (await testEnv.DB.prepare('SELECT count(*) AS n FROM file_shares').first<{ n: number }>())?.n,
    ).toBe(0);
    expect((await call(t.token, '/files?name=bad.txt', 'POST', new Uint8Array([1]))).status).toBe(
      400,
    );
    expect(
      (
        await call(t.token, '/files?name=bad-size.txt', 'POST', new Uint8Array([1]), {
          'X-File-Size': '2',
        })
      ).status,
    ).toBe(400);
  });
  it('isolates sessions, allows part retries and status lookup, and preserves admin access', async () => {
    const a = await token('A'),
      b = await token('B');
    const s = await data<{ id: string; fileId: string }>(
      await call(a.token, '/uploads', 'POST', { name: 'parts.txt', size: 3 }),
    );
    expect((await call(b.token, '/uploads/' + s.id)).status).toBe(404);
    expect(
      (
        await call(b.token, '/uploads/' + s.id + '/parts/1', 'PUT', new Uint8Array([1, 2, 3]), {
          'X-File-Size': '3',
        })
      ).status,
    ).toBe(404);
    expect((await call(b.token, '/uploads/' + s.id + '/complete', 'POST')).status).toBe(404);
    expect((await call(b.token, '/uploads/' + s.id, 'DELETE')).status).toBe(404);
    expect((await call(a.token, '/uploads/' + s.id + '/complete', 'POST')).status).toBe(409);
    for (let n = 0; n < 2; n++)
      expect(
        (
          await call(a.token, '/uploads/' + s.id + '/parts/1', 'PUT', new Uint8Array([1, 2, 3]), {
            'X-File-Size': '3',
          })
        ).status,
      ).toBe(200);
    const status = await data<{ parts: unknown[] }>(await call(a.token, '/uploads/' + s.id));
    expect(status.parts).toEqual([{ partNumber: 1, size: 3 }]);
    expect((await call(a.token, '/uploads/' + s.id + '/complete', 'POST')).status).toBe(201);
    expect((await call(a.token, '/files/' + s.fileId)).status).toBe(200);
    expect((await call(b.token, '/files/' + s.fileId)).status).toBe(404);
    expect((await call(a.token, '/uploads/' + s.id)).status).toBe(410);
    const web = await data<{ id: string }>(
      await request('/api/admin/uploads', 'POST', { name: 'web.txt', size: 1 }),
    );
    expect((await call(a.token, '/uploads/' + web.id)).status).toBe(404);
    expect((await request('/api/admin/uploads/' + web.id, 'DELETE')).status).toBe(200);
    const cancel = await data<{ id: string; fileId: string }>(
      await call(a.token, '/uploads', 'POST', { name: 'cancel.txt', size: 1 }),
    );
    expect((await call(a.token, '/uploads/' + cancel.id, 'DELETE')).status).toBe(200);
    expect((await call(a.token, '/files/' + cancel.fileId)).status).toBe(404);
  });
  it('does not grant file reading/deletion or admin privileges; checks browser origins', async () => {
    const t = await token();
    const existing = await data<{ id: string }>(await upload('private.txt', 'private'));
    expect((await call(t.token, '/files/' + existing.id)).status).toBe(404);
    expect((await call(t.token, '/files/' + existing.id + '/download')).status).toBe(404);
    expect((await call(t.token, '/files/' + existing.id, 'DELETE')).status).toBe(404);
    expect((await call(t.token, '/shares', 'POST', { file_id: existing.id })).status).toBe(404);
    expect(
      (
        await call(
          t.token,
          '/uploads',
          'POST',
          { name: 'x', size: 1 },
          { Origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          'https://example.com/api/admin/api-tokens',
          { headers: { Authorization: 'Bearer ' + t.token } },
          {
            ...testEnv,
            ENVIRONMENT: 'production',
            LOCAL_AUTH: 'false',
            AUTH_MODE: 'password_totp',
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          'http://localhost/api/admin/api-tokens',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"name":"CSRF"}',
          },
          testEnv,
        )
      ).status,
    ).toBe(403);
  });
  it('validates token lifetime and enforces the active token limit', async () => {
    expect(
      (await request('/api/admin/api-tokens', 'POST', { name: '', expires_in_days: 30 })).status,
    ).toBe(400);
    expect(
      (await request('/api/admin/api-tokens', 'POST', { name: 'bad', expires_in_days: 366 }))
        .status,
    ).toBe(400);
    for (let i = 0; i < 20; i++) await token('token ' + i);
    expect((await request('/api/admin/api-tokens', 'POST', { name: 'excess' })).status).toBe(409);
  });
});
