import { describe, expect, it } from 'vitest';
import type { FileRecord, ShareListItem } from '../shared/types';
import { digest, hashPassword } from '../worker/auth-crypto';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

async function legacyShare(password?: string) {
  const file = await data<FileRecord>(await upload('existing.txt', 'already shared content'));
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const id = crypto.randomUUID();
  const tokenHash = await digest(token);
  await testEnv.DB.prepare(
    'INSERT INTO file_shares(id,file_id,token_hash,password_hash,created_at,allow_download) VALUES(?,?,?,?,?,1)',
  )
    .bind(id, file.id, tokenHash, password ? await hashPassword(password) : null, Date.now())
    .run();
  return { id, file, token, tokenHash };
}

async function listing() {
  return data<ShareListItem[]>(await request('/api/admin/shares'));
}

function tokenFrom(url: string) {
  return new URL(url).pathname.split('/').pop()!;
}

describe('分享管理中的可重复复制链接', () => {
  it('新分享创建与列表返回相同稳定链接，读取列表不新建分享、不增加访问量', async () => {
    const file = await data<FileRecord>(await upload('new.txt', 'new file content'));
    const created = await data<{ id: string; url: string; directUrl: string }>(
      await request('/api/admin/shares', 'POST', { file_id: file.id }),
    );
    const first = await listing();
    const second = await listing();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ ...created, views: 0, downloads: 0, last_access_at: null });
    expect(first[0].url).toContain(`/s/v1.${created.id}.`);
    expect(first[0].directUrl).toContain(`/d/v1.${created.id}.`);
    expect(await (await request(new URL(first[0].directUrl).pathname)).text()).toBe(
      'new file content',
    );
    expect((await listing())[0].downloads).toBe(1);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM file_shares').first('count'),
    ).toBe(1);
  });

  it('旧分享不需要原始令牌即可复制新地址，两个地址保持有效并共用统计', async () => {
    const legacy = await legacyShare();
    const [item] = await listing();
    expect(item.id).toBe(legacy.id);
    const copiedToken = tokenFrom(item.url);
    expect(copiedToken).not.toBe(legacy.token);
    for (const token of [legacy.token, copiedToken]) {
      const metadata = await data<{ name: string }>(await request(`/api/public/share/${token}`));
      expect(metadata.name).toBe(legacy.file.name);
      expect((await request(`/s/${token}`, 'HEAD')).status).toBe(200);
      expect(await (await request(`/d/${token}`)).text()).toBe('already shared content');
    }
    const [updated] = await listing();
    expect(updated).toMatchObject({ id: legacy.id, views: 2, downloads: 2 });
    expect(updated.url).toBe(item.url);
    const raw = JSON.stringify(updated);
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain(legacy.tokenHash);
    expect(raw).not.toContain(legacy.token);
    expect(
      await testEnv.DB.prepare('SELECT token_hash FROM file_shares WHERE id=?')
        .bind(legacy.id)
        .first('token_hash'),
    ).toBe(legacy.tokenHash);
  });

  it('签名绑定分享记录与原令牌哈希，篡改或把哈希当作签名均不能读取文件', async () => {
    const legacy = await legacyShare();
    const other = await legacyShare();
    const item = (await listing()).find((row) => row.id === legacy.id)!;
    const token = tokenFrom(item.url);
    const signature = token.split('.')[2];
    const invalid = [
      `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`,
      `v1.${other.id}.${signature}`,
      `v1.${legacy.id}.${legacy.tokenHash}`,
      `v1.${legacy.id}.${await digest(legacy.id + legacy.tokenHash)}`,
      `v1.${legacy.id}.${legacy.token}`,
      token.replace('v1.', 'v2.'),
      legacy.id,
      legacy.tokenHash,
    ];
    for (const candidate of invalid) {
      const response = await request(`/api/public/share/${candidate}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(legacy.file.name);
    }
    await testEnv.DB.prepare('UPDATE file_shares SET token_hash=? WHERE id=?')
      .bind(await digest('replacement token'), legacy.id)
      .run();
    expect((await request(`/d/${token}`)).status).toBe(404);
    expect((await request(`/d/${legacy.token}`)).status).toBe(404);
  });

  it('旧链接与复制链接共用密码会话、下载权限、有效期和撤销状态', async () => {
    const legacy = await legacyShare('share-password');
    const [item] = await listing();
    expect(item.password_protected).toBe(1);
    expect(JSON.stringify(item)).not.toContain('share-password');
    const copiedToken = tokenFrom(item.url);
    for (const token of [legacy.token, copiedToken])
      expect((await request(`/api/public/share/${token}`)).status).toBe(401);
    const unlocked = await request(`/api/public/share/${legacy.token}/unlock`, 'POST', {
      password: 'share-password',
    });
    expect(unlocked.status).toBe(200);
    const cookie = { Cookie: unlocked.headers.get('Set-Cookie')!.split(';')[0] };
    expect(
      await (await request(`/d/${copiedToken}`, 'GET', undefined, testEnv, cookie)).text(),
    ).toBe('already shared content');
    await request(`/api/admin/shares/${legacy.id}`, 'PATCH', { allow_download: false });
    for (const token of [legacy.token, copiedToken])
      expect((await request(`/d/${token}`, 'GET', undefined, testEnv, cookie)).status).toBe(403);
    await testEnv.DB.prepare('UPDATE file_shares SET expires_at=1 WHERE id=?')
      .bind(legacy.id)
      .run();
    for (const token of [legacy.token, copiedToken])
      expect((await request(`/s/${token}`, 'HEAD')).status).toBe(410);
    await request(`/api/admin/shares/${legacy.id}`, 'PATCH', { expires_at: null });
    await request(`/api/admin/shares/${legacy.id}`, 'DELETE');
    for (const token of [legacy.token, copiedToken])
      expect((await request(`/api/public/share/${token}`)).status).toBe(410);
    expect((await listing())[0]).toMatchObject({ url: item.url, enabled: 0 });
  });

  it('未登录不能获取链接列表，密钥轮换仅影响签名链接且密钥缺失时不创建无效记录', async () => {
    const legacy = await legacyShare();
    const [item] = await listing();
    const response = await request('/api/admin/shares', 'GET', undefined, {
      ...testEnv,
      LOCAL_AUTH: 'false',
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(item.url);

    const rotatedEnv = {
      ...testEnv,
      SHARE_SESSION_SECRET: 'test-rotated-session-secret-at-least-32-bytes',
    };
    expect(
      (await request(new URL(item.directUrl).pathname, 'GET', undefined, rotatedEnv)).status,
    ).toBe(404);
    expect((await request(`/d/${legacy.token}`, 'HEAD', undefined, rotatedEnv)).status).toBe(200);
    const missingEnv = { ...testEnv, SHARE_SESSION_SECRET: '' };
    expect((await request('/api/admin/shares', 'GET', undefined, missingEnv)).status).toBe(503);
    expect(
      (await request('/api/admin/shares', 'POST', { file_id: legacy.file.id }, missingEnv)).status,
    ).toBe(503);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM file_shares').first('count'),
    ).toBe(1);
  });
});
