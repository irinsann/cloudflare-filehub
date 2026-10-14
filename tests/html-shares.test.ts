import { describe, expect, it } from 'vitest';
import { request, data, upload } from './helpers';
import { testEnv } from './setup';
import type { FileRecord } from '../shared/types';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>原始页面</title><style>body{color:#234}</style></head><body class="original-design" data-page="test"><h1>分享页面</h1><button onclick="this.textContent='已点击'">点击</button><script>document.documentElement.dataset.loaded='yes'</script></body></html>`;
const htmlBytes = new TextEncoder().encode(html);

async function createShare(fileId: string, options: Record<string, unknown> = {}) {
  const link = await data<{ id: string; url: string; directUrl: string }>(
    await request('/api/admin/shares', 'POST', { file_id: fileId, ...options }),
  );
  return { ...link, token: link.url.split('/').pop()! };
}

async function counts(id: string) {
  return testEnv.DB.prepare('SELECT views,downloads FROM file_shares WHERE id=?')
    .bind(id)
    .first<{ views: number; downloads: number }>();
}

function expectIsolatedHtml(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
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
  expect(directives).toContain("frame-ancestors 'none'");
  expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
}

async function expectOriginalHtml(response: Response) {
  expect(response.status).toBe(200);
  expectIsolatedHtml(response);
  expect(response.headers.get('Content-Length')).toBe(String(htmlBytes.length));
  // Exact bytes preserve the original body, style and script without an injected iframe or shell.
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(htmlBytes);
}

async function expectUnlockPage(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('type="password"');
  expect(body).toContain('location.reload()');
  expect(body).not.toContain('legacy.htm');
  expect(body).not.toContain('分享页面');
  expect(body).not.toContain('original-design');
  const nonce = /script-src 'nonce-([^']+)'/.exec(
    response.headers.get('Content-Security-Policy')!,
  )![1];
  const scripts = [...body.matchAll(/<script([^>]*)>/g)];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(script[1]).toContain(`nonce="${nonce}"`);
}

describe('HTML 分享直接展示原网页', () => {
  it.each(['page.html', 'page.HTM'])(
    '%s 的分享地址与预览接口返回原始 HTML，HEAD/Range不计访问，下载仍返回附件',
    async (name) => {
      const file = await data<FileRecord>(await upload(name, html));
      expect(file.mime).toBe('text/plain');
      const link = await createShare(file.id);
      const api = `/api/public/share/${link.token}`;
      const page = `/s/${link.token}`;
      expect(await counts(link.id)).toEqual({ views: 0, downloads: 0 });

      for (const path of [page, `${api}/preview`]) {
        await expectOriginalHtml(await request(path));
        const head = await request(path, 'HEAD');
        expect(head.status).toBe(200);
        expectIsolatedHtml(head);
        expect(head.headers.get('Content-Length')).toBe(String(htmlBytes.length));
        expect(await head.text()).toBe('');

        const range = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=0-14' });
        expect(range.status).toBe(206);
        expectIsolatedHtml(range);
        expect(range.headers.get('Content-Range')).toBe(`bytes 0-14/${htmlBytes.length}`);
        expect(await range.text()).toBe('<!doctype html>');
        const invalid = await request(path, 'GET', undefined, testEnv, {
          Range: 'bytes=999999-',
        });
        expect(invalid.status).toBe(416);
        expect(await invalid.text()).toBe('');
      }
      expect(await counts(link.id)).toEqual({ views: 1, downloads: 0 });

      const meta = await data<{ mime: string; preview_type: string }>(await request(api));
      expect(meta).toMatchObject({ mime: 'text/plain', preview_type: 'html' });
      expect(await counts(link.id)).toEqual({ views: 2, downloads: 0 });

      for (const path of [`${api}/download`, `/d/${link.token}`]) {
        const download = await request(path);
        expect(download.status).toBe(200);
        expect(download.headers.get('Content-Type')).toBe('text/plain');
        expect(download.headers.get('Content-Disposition')).toMatch(/^attachment;/);
        expect(download.headers.get('Content-Security-Policy')).not.toContain('allow-scripts');
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(htmlBytes);
        const head = await request(path, 'HEAD');
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        const range = await request(path, 'GET', undefined, testEnv, { Range: 'bytes=0-14' });
        expect(range.status).toBe(206);
        expect(await range.text()).toBe('<!doctype html>');
      }
      expect(await counts(link.id)).toEqual({ views: 2, downloads: 2 });
    },
  );

  it('旧 octet-stream HTM 解锁前不泄漏文件信息，解锁后直接展示；禁止下载、改密、撤销与过期仍生效', async () => {
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
    const page = `/s/${link.token}`;
    await expectUnlockPage(await request(page));
    const lockedHead = await request(page, 'HEAD');
    expect(lockedHead.status).toBe(200);
    expect(await lockedHead.text()).toBe('');
    const locked = await request(`${api}/preview`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain('分享页面');
    expect((await request(`${api}/preview`, 'HEAD')).status).toBe(401);
    expect(await counts(link.id)).toEqual({ views: 0, downloads: 0 });

    expect((await request(`${api}/unlock`, 'POST', { password: 'wrong-password' })).status).toBe(
      401,
    );
    const unlock = await request(`${api}/unlock`, 'POST', { password: 'html-preview-password' });
    expect(unlock.status).toBe(200);
    expect(unlock.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(unlock.headers.get('Set-Cookie')).toContain('SameSite=Strict');
    const cookie = { Cookie: unlock.headers.get('Set-Cookie')!.split(';')[0] };
    for (const path of [page, `${api}/preview`]) {
      await expectOriginalHtml(await request(path, 'GET', undefined, testEnv, cookie));
      const head = await request(path, 'HEAD', undefined, testEnv, cookie);
      expectIsolatedHtml(head);
      expect(await head.text()).toBe('');
    }
    expect(await counts(link.id)).toEqual({ views: 1, downloads: 0 });
    expect((await request(`${api}/download`, 'GET', undefined, testEnv, cookie)).status).toBe(403);
    expect((await request(`/d/${link.token}`, 'GET', undefined, testEnv, cookie)).status).toBe(403);

    await request(`/api/admin/shares/${link.id}`, 'PATCH', { password: 'changed-html-password' });
    expect((await request(`${api}/preview`, 'GET', undefined, testEnv, cookie)).status).toBe(401);
    await expectUnlockPage(await request(page, 'GET', undefined, testEnv, cookie));
    expect(await counts(link.id)).toEqual({ views: 1, downloads: 0 });
    await request(`/api/admin/shares/${link.id}`, 'DELETE');
    for (const path of [page, `${api}/preview`])
      expect((await request(path, 'GET', undefined, testEnv, cookie)).status).toBe(410);

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

  it('文本/SVG仍使用普通分享界面；删除HTML文件立即撤销，恢复文件不重新开放', async () => {
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
      const shell = await request(`/s/${link.token}`);
      expect(shell.status).toBe(200);
      const shellBody = await shell.text();
      expect(shellBody).toContain('id="view"');
      expect(shellBody).not.toContain('original-design');
    }
    const file = await data<FileRecord>(await upload('deleted.html', html));
    const link = await createShare(file.id);
    await request(`/api/admin/files/${file.id}`, 'DELETE');
    for (const path of [`/s/${link.token}`, `/api/public/share/${link.token}/preview`])
      expect((await request(path)).status).toBe(410);
    await request(`/api/admin/files/${file.id}/restore`, 'POST');
    for (const path of [`/s/${link.token}`, `/api/public/share/${link.token}/preview`])
      expect((await request(path)).status).toBe(410);
  });
});
