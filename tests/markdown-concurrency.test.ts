import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { createMarkdown, data, request } from './helpers';
import { testEnv } from './setup';

describe('concurrent initial Markdown publication', () => {
  it('keeps the page identity and attachment permissions when another first publish wins the insert', async () => {
    const file = await createMarkdown();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await data<{ id: string; reference: string }>(
      await app.request(
        `http://localhost/api/admin/markdown/${file.id}/attachments?name=image.png`,
        {
          method: 'POST',
          headers: { Origin: 'http://localhost', 'X-Drive-Request': '1', 'X-File-Size': '8' },
          body: png,
        },
        testEnv,
      ),
    );
    await request(`/api/admin/markdown/${file.id}`, 'PUT', {
      content: `# Article\n![Image](${attachment.reference})`,
      version: 1,
    });
    const input = { title: 'Article', slug: 'latest-publication', version: 2 };
    let otherPage: { id: string } | undefined;
    let earlierSnapshot: string | null = null;
    let intercepted = false;
    const bucket = new Proxy(testEnv.BUCKET, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            if (!intercepted) {
              intercepted = true;
              // Let a second request finish its initial publication before the first
              // one commits its snapshot (and after its old code checked for a page).
              otherPage = await data<{ id: string }>(
                await request(`/api/admin/markdown/${file.id}/publish`, 'POST', {
                  ...input,
                  slug: 'earlier-publication',
                }),
              );
              earlierSnapshot = await testEnv.DB.prepare(
                'SELECT snapshot_key FROM markdown_pages WHERE file_id=?',
              )
                .bind(file.id)
                .first<string>('snapshot_key');
            }
            return target.put(...args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const latestPage = await data<{ id: string }>(
      await request(`/api/admin/markdown/${file.id}/publish`, 'POST', input, {
        ...testEnv,
        BUCKET: bucket,
      }),
    );
    const stored = await testEnv.DB.prepare('SELECT id FROM markdown_pages WHERE file_id=?')
      .bind(file.id)
      .first<{ id: string }>();

    expect(latestPage.id).toBe(stored!.id);
    expect(latestPage.id).toBe(otherPage!.id);
    expect(earlierSnapshot).not.toBeNull();
    expect(
      await testEnv.DB.prepare('SELECT object_key FROM cleanup_tasks WHERE object_key=?')
        .bind(earlierSnapshot)
        .first(),
    ).not.toBeNull();
    const page = await request('/p/latest-publication');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(
      `/api/public/pages/latest-publication/attachments/${attachment.id}`,
    );
    expect(
      (await request(`/api/public/pages/latest-publication/attachments/${attachment.id}`)).status,
    ).toBe(200);
  });
});
