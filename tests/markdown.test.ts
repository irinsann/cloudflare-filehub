import { describe, it, expect } from 'vitest';
import { request, data, createMarkdown } from './helpers';
import { app } from '../worker/index';
import { testEnv } from './setup';
import { renderMarkdown } from '../shared/markdown';
const publish = async (id: string, slug = 'my-note', extra: Record<string, unknown> = {}) =>
  request(`/api/admin/markdown/${id}/publish`, 'POST', {
    title: '我的文章',
    slug,
    description: '公开介绍',
    version: (await data<{ file: { version: number } }>(await request('/api/admin/markdown/' + id)))
      .file.version,
    ...extra,
  });
describe('Markdown 发布与快照隔离', () => {
  it('新建、保存、发布、草稿隔离、原 URL 更新、源文件权限和取消发布', async () => {
    const file = await createMarkdown('# 第一版\n\n公开正文');
    expect(await testEnv.BUCKET.head(file.object_key)).not.toBeNull();
    expect((await request('/p/my-note')).status).toBe(404);
    expect((await publish(file.id)).status).toBe(200);
    const first = await request('/p/my-note');
    const firstHtml = await first.text();
    expect(firstHtml).toContain('公开正文');
    expect(firstHtml).toContain('og:title');
    expect(firstHtml).toContain('canonical');
    expect(first.headers.get('Cache-Control')).toContain('no-store');
    expect((await request('/api/public/pages/my-note/source')).status).toBe(403);
    expect(
      (
        await request(`/api/admin/markdown/${file.id}`, 'PUT', {
          content: '# 第二版\n\n未发布机密',
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(await (await request('/p/my-note')).text()).not.toContain('未发布机密');
    expect((await publish(file.id, 'my-note', { allow_source: true })).status).toBe(200);
    expect(await (await request('/p/my-note')).text()).toContain('未发布机密');
    expect(await (await request('/api/public/pages/my-note/source')).text()).toContain('第二版');
    await request(`/api/admin/markdown/${file.id}/unpublish`, 'POST');
    expect((await request('/p/my-note')).status).toBe(404);
    expect((await request('/api/public/pages/my-note/source')).status).toBe(404);
    expect((await request(`/api/admin/markdown/${file.id}`)).status).toBe(200);
  });
  it('检测版本冲突、非法 Slug、重复 Slug、旧 Slug 失效', async () => {
    const a = await createMarkdown();
    const b = await createMarkdown();
    await publish(a.id);
    expect((await publish(b.id)).status).toBe(409);
    expect((await publish(b.id, '../bad')).status).toBe(400);
    expect((await publish(b.id, 'api')).status).toBe(400);
    await request(`/api/admin/markdown/${a.id}`, 'PUT', { content: '新草稿', version: 1 });
    expect(
      (await request(`/api/admin/markdown/${a.id}`, 'PUT', { content: '冲突草稿', version: 1 }))
        .status,
    ).toBe(409);
    expect((await publish(a.id, 'new-address')).status).toBe(200);
    expect((await request('/p/my-note')).status).toBe(404);
    expect((await request('/p/new-address')).status).toBe(200);
  });
  it('过期窗口不能发布其他窗口保存的新草稿', async () => {
    const file = await createMarkdown('# 旧正文');
    await publish(file.id);
    await request(`/api/admin/markdown/${file.id}`, 'PUT', {
      content: '另一窗口的私有草稿',
      version: 1,
    });
    expect((await publish(file.id, 'my-note', { version: 1 })).status).toBe(409);
    expect(await (await request('/p/my-note')).text()).not.toContain('另一窗口的私有草稿');
  });
  it('安全处理 GFM、脚本、事件属性、JavaScript URL、SVG 和不受控图片', async () => {
    const result = await renderMarkdown(
      '# 标题\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n![private](/api/admin/files/private/download)\n\n![svg](data:image/svg+xml,evil)\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1\n```',
    );
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('onerror');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).not.toContain('src="/api/admin');
    expect(result.html).not.toContain('data:image');
    expect(result.html).toContain('<table>');
    expect(result.html).toContain('hljs');
    expect(result.headings[0].text).toBe('标题');
  });
  it('只有文章自身的已发布附件可公开访问，撤销后图片失效', async () => {
    const a = await createMarkdown(),
      b = await createMarkdown();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const attachment = await data<{ id: string; reference: string }>(
      await app.request(
        `http://localhost/api/admin/markdown/${a.id}/attachments?name=a.png`,
        {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            'X-Drive-Request': '1',
            'X-File-Size': String(png.length),
          },
          body: png,
        },
        testEnv,
      ),
    );
    const imagePath = `/api/public/pages/my-note/attachments/${attachment.id}`;
    expect((await request(imagePath)).status).toBe(404);
    await request(`/api/admin/markdown/${a.id}`, 'PUT', {
      content: `# 图片\n![A](${attachment.reference})`,
      version: 1,
    });
    await publish(a.id);
    const response = await request(imagePath);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(png.length);
    await request(`/api/admin/markdown/${b.id}`, 'PUT', {
      content: `![stolen](${attachment.reference})`,
      version: 1,
    });
    expect((await publish(b.id, 'stolen')).status).toBe(403);
    await request(`/api/admin/markdown/${a.id}/unpublish`, 'POST');
    expect((await request(imagePath)).status).toBe(404);
  });
  it('草稿新附件不会因旧文章已发布就自动公开', async () => {
    const file = await createMarkdown();
    await publish(file.id);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await data<{ id: string }>(
      await app.request(
        `http://localhost/api/admin/markdown/${file.id}/attachments?name=a.png`,
        {
          method: 'POST',
          headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': '8' },
          body: png,
        },
        testEnv,
      ),
    );
    expect((await request(`/api/public/pages/my-note/attachments/${attachment.id}`)).status).toBe(
      404,
    );
  });
  it('配置 md 独立域名的根路径可直接阅读，公开域名禁止管理员 API', async () => {
    const file = await createMarkdown();
    await publish(file.id);
    const env = {
      ...testEnv,
      ADMIN_ORIGIN: 'https://ps.irin.im',
      MARKDOWN_ORIGIN: 'https://md.irin.im',
      FILES_ORIGIN: 'https://s.irin.im',
    };
    const response = await app.request('https://md.irin.im/my-note', {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://md.irin.im/my-note');
    expect((await app.request('https://md.irin.im/api/admin/files', {}, env)).status).toBe(403);
  });
});
