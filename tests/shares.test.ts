import { describe, it, expect } from 'vitest';
import { request, data, upload } from './helpers';
import type { FileRecord } from '../shared/types';
import { testEnv } from './setup';
async function share(options: Record<string, unknown> = {}) {
  const file = await data<FileRecord>(await upload('secret.txt', 'private text'));
  const link = await data<{ id: string; url: string }>(
    await request('/api/admin/shares', 'POST', { file_id: file.id, ...options }),
  );
  return { file, ...link, token: link.url.split('/').pop()! };
}
describe('分享权限与会话', () => {
  it('匿名有效分享、哈希存储、下载统计排除预览与 Range、撤销立即生效', async () => {
    const s = await share();
    expect((await request(`/api/public/share/${s.token}`)).status).toBe(200);
    const stored = await testEnv.DB.prepare('SELECT token_hash FROM file_shares WHERE id=?')
      .bind(s.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(s.token);
    await (await request(`/api/public/share/${s.token}/preview`)).text();
    await (
      await request(`/api/public/share/${s.token}/download`, 'GET', undefined, testEnv, {
        Range: 'bytes=0-1',
      })
    ).text();
    expect(
      (
        await testEnv.DB.prepare('SELECT downloads FROM file_shares WHERE id=?')
          .bind(s.id)
          .first<{ downloads: number }>()
      )?.downloads,
    ).toBe(0);
    expect(await (await request(`/api/public/share/${s.token}/download`)).text()).toBe(
      'private text',
    );
    expect(
      (
        await testEnv.DB.prepare('SELECT downloads FROM file_shares WHERE id=?')
          .bind(s.id)
          .first<{ downloads: number }>()
      )?.downloads,
    ).toBe(1);
    await request(`/api/admin/shares/${s.id}`, 'DELETE');
    expect((await request(`/api/public/share/${s.token}/download`)).status).toBe(410);
  });
  it('无效、过期、禁止下载及私人文件不能通过公开路由读取', async () => {
    expect((await request('/api/public/share/bad')).status).toBe(404);
    const s = await share({ expires_at: Date.now() + 60000, allow_download: false });
    expect((await request(`/api/public/share/${s.token}/download`)).status).toBe(403);
    expect((await request(`/api/public/share/${s.file.id}/preview`)).status).toBe(404);
    await testEnv.DB.prepare('UPDATE file_shares SET expires_at=1 WHERE id=?').bind(s.id).run();
    expect((await request(`/api/public/share/${s.token}`)).status).toBe(410);
    expect((await request(`/s/${s.token}`)).status).toBe(410);
  });
  it('密码保护不泄露信息、错误密码、正确密码的 HttpOnly 会话和频率限制', async () => {
    const s = await share({ password: 'correct horse battery' });
    const locked = await request(`/api/public/share/${s.token}`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain('secret.txt');
    expect(
      (await request(`/api/public/share/${s.token}/unlock`, 'POST', { password: 'wrong' })).status,
    ).toBe(401);
    const unlocked = await request(`/api/public/share/${s.token}/unlock`, 'POST', {
      password: 'correct horse battery',
    });
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly');
    const response = await request(
      `/api/public/share/${s.token}/download`,
      'GET',
      undefined,
      testEnv,
      { Cookie: cookie.split(';')[0] },
    );
    expect(await response.text()).toBe('private text');
    await request(`/api/admin/shares/${s.id}`, 'PATCH', { password: 'changed-password' });
    expect(
      (
        await request(`/api/public/share/${s.token}`, 'GET', undefined, testEnv, {
          Cookie: cookie.split(';')[0],
        })
      ).status,
    ).toBe(401);
    for (let i = 0; i < 9; i++)
      await request(`/api/public/share/${s.token}/unlock`, 'POST', { password: 'wrong' });
    expect(
      (await request(`/api/public/share/${s.token}/unlock`, 'POST', { password: 'wrong' })).status,
    ).toBe(429);
  });
  it('删除和恢复文件不重新开启分享', async () => {
    const s = await share();
    await request(`/api/admin/files/${s.file.id}`, 'DELETE');
    await request(`/api/admin/files/${s.file.id}/restore`, 'POST');
    expect((await request(`/api/public/share/${s.token}`)).status).toBe(410);
  });
});
