import { describe, expect, it } from 'vitest';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{color:#234}</style><h1>分享页面</h1><button onclick="this.textContent='已点击'">点击</button><script>document.documentElement.dataset.loaded='yes'</script></html>`;

async function createShare(fileId: string, options: Record<string, unknown> = {}) {
  const link = await data<{ id: string; url: string; directUrl: string }>(
    await request('/api/admin/shares', 'POST', { file_id: fileId, ...options }),
  );
  return { ...link, token: link.url.split('/').pop()! };
}

function expectIsolatedHtml(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  const directives = new Set(
    response.headers
      .get('Content-Security-Policy')!
      .split(';')
      .map((part) => part.trim()),
  );
  expect(directives).toContain('sandbox allow-scripts');
  expect(directives).toContain("default-src 'none'");
  expect(directives).toContain("script-src 'unsafe-inline'");
  expect(directives).toContain("style-src 'unsafe-inline'");
  expect(directives).toContain('img-src data: blob:');
  expect(directives).toContain("connect-src 'none'");
  expect(directives).toContain("frame-src 'none'");
  expect(directives).toContain("worker-src 'none'");
  expect(directives).toContain("object-src 'none'");
  expect(directives).toContain("base-uri 'none'");
  expect(directives).toContain("form-action 'none'");
  expect(directives).toContain("frame-ancestors 'self'");
  expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
}

describe('HTML 分享的隔离预览', () => {
  it.each(['page.html', 'page.HTM'])(
    '%s 保持文本存储，仅分享预览以隔离 HTML 返回，下载与 Range 权限不变',
    async (name) => {
      const file = await data<FileRecord>(await upload(name, html));
      expect(file.mime).toBe('text/plain');
      const link = await createShare(file.id);
      const api = `/api/public/share/${link.token}`;
      const meta = await data<{ mime: string; preview_type: string }>(await request(api));
      expect(meta).toMatchObject({ mime: 'text/plain', preview_type: 'html' });

      const preview = await request(`${api}/preview`);
      expect(preview.status).toBe(200);
      expectIsolatedHtml(preview);
      expect(await preview.text()).toBe(html);

      const head = await request(`${api}/preview`, 'HEAD');
      expectIsolatedHtml(head);
      expect(head.headers.get('Content-Length')).toBe(
        String(new TextEncoder().encode(html).length),
      );
      expect(await head.text()).toBe('');

      const range = await request(`${api}/preview`, 'GET', undefined, testEnv, {
        Range: 'bytes=0-14',
      });
      expect(range.status).toBe(206);
      expectIsolatedHtml(range);
      expect(await range.text()).toBe('<!doctype html>');

      for (const path of [`${api}/download`, `/d/${link.token}`]) {
        const download = await request(path);
        expect(download.status).toBe(200);
        expect(download.headers.get('Content-Type')).toBe('text/plain');
        expect(download.headers.get('Content-Disposition')).toMatch(/^attachment;/);
        expect(download.headers.get('Content-Security-Policy')).not.toContain('allow-scripts');
        expect(await download.text()).toBe(html);
      }

      const shell = await request(`/s/${link.token}`);
      const shellHtml = await shell.text();
      expect(shellHtml).toContain("e.setAttribute('sandbox','allow-scripts')");
      expect(shellHtml).not.toContain('allow-same-origin');
      expect(shellHtml).not.toContain(html);
      const nonce = /script-src 'nonce-([^']+)'/.exec(
        shell.headers.get('Content-Security-Policy')!,
      )![1];
      const scripts = [...shellHtml.matchAll(/<script([^>]*)>/g)];
      expect(scripts.length).toBe(2);
      for (const script of scripts) expect(script[1]).toContain(`nonce="${nonce}"`);
    },
  );

  it('旧 octet-stream HTM 支持仅预览分享，密码、改密、撤销、过期仍逐次校验', async () => {
    const file = await data<FileRecord>(await upload('legacy.htm', html));
    await testEnv.DB.prepare("UPDATE files SET mime='application/octet-stream' WHERE id=?")
      .bind(file.id)
      .run();
    const link = await createShare(file.id, {
      allow_download: false,
      password: 'html-preview-password',
      expires_at: Date.now() + 60000,
    });
    const api = `/api/public/share/${link.token}`;
    const locked = await request(`${api}/preview`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain('分享页面');
    expect((await request(`${api}/preview`, 'HEAD')).status).toBe(401);
    expect(await (await request(`/s/${link.token}`)).text()).not.toContain('legacy.htm');

    const unlock = await request(`${api}/unlock`, 'POST', { password: 'html-preview-password' });
    expect(unlock.status).toBe(200);
    const cookie = { Cookie: unlock.headers.get('Set-Cookie')!.split(';')[0] };
    const preview = await request(`${api}/preview`, 'GET', undefined, testEnv, cookie);
    expect(preview.status).toBe(200);
    expectIsolatedHtml(preview);
    expect(await preview.text()).toBe(html);
    expect((await request(`${api}/download`, 'GET', undefined, testEnv, cookie)).status).toBe(403);
    expect((await request(`/d/${link.token}`, 'GET', undefined, testEnv, cookie)).status).toBe(403);

    await request(`/api/admin/shares/${link.id}`, 'PATCH', { password: 'changed-html-password' });
    expect((await request(`${api}/preview`, 'GET', undefined, testEnv, cookie)).status).toBe(401);
    await request(`/api/admin/shares/${link.id}`, 'DELETE');
    expect((await request(`${api}/preview`, 'GET', undefined, testEnv, cookie)).status).toBe(410);

    const expiring = await createShare(file.id, {
      allow_download: false,
      expires_at: Date.now() + 60000,
    });
    await testEnv.DB.prepare('UPDATE file_shares SET expires_at=1 WHERE id=?')
      .bind(expiring.id)
      .run();
    expect((await request(`/api/public/share/${expiring.token}/preview`)).status).toBe(410);
    expect((await request(`/s/${expiring.token}`)).status).toBe(410);
  });

  it('文本和 SVG 不会因内容包含 HTML 而被提升为可执行预览，删除 HTML 文件立即撤销分享', async () => {
    for (const name of ['notes.html.txt', 'picture.svg']) {
      const file = await data<FileRecord>(await upload(name, html));
      const link = await createShare(file.id);
      const api = `/api/public/share/${link.token}`;
      expect(await data<{ preview_type: null }>(await request(api))).toMatchObject({
        preview_type: null,
      });
      const preview = await request(`${api}/preview`);
      expect(preview.headers.get('Content-Type')).toBe('text/plain');
      expect(preview.headers.get('Content-Security-Policy')).not.toContain('allow-scripts');
      expect(await preview.text()).toBe(html);
    }
    const file = await data<FileRecord>(await upload('deleted.html', html));
    const link = await createShare(file.id);
    await request(`/api/admin/files/${file.id}`, 'DELETE');
    expect((await request(`/api/public/share/${link.token}/preview`)).status).toBe(410);
    await request(`/api/admin/files/${file.id}/restore`, 'POST');
    expect((await request(`/api/public/share/${link.token}/preview`)).status).toBe(410);
  });
});
