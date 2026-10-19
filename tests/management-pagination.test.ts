import { describe, expect, it } from 'vitest';
import type { PaginatedResult } from '../shared/pagination';
import type { ShareListItem } from '../shared/types';
import { paginationParams } from '../shared/pagination';
import { digest } from '../worker/auth-crypto';
import { createMarkdown, data, request } from './helpers';
import { testEnv } from './setup';

type Document = { id: string; published: number | null; slug: string | null };

async function page<T>(path: string) {
  const response = await request(path);
  expect(response.status).toBe(200);
  return response.json() as Promise<PaginatedResult<T>>;
}

async function seedDocuments(count: number, published: boolean) {
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index++) {
    const id = crypto.randomUUID();
    statements.push(
      testEnv.DB.prepare(
        "INSERT INTO files(id,name,object_key,mime,status,created_at,updated_at) VALUES(?,?,?,'text/markdown','ready',1,?)",
      ).bind(id, `${id}.md`, `fixtures/${id}`, published ? 1 : index + 1000),
    );
    if (published)
      statements.push(
        testEnv.DB.prepare(
          'INSERT INTO markdown_pages(id,file_id,title,slug,published,updated_at) VALUES(?,?,?,?,1,1)',
        ).bind(crypto.randomUUID(), id, 'Published article', id),
      );
  }
  await testEnv.DB.batch(statements);
}

describe('bounded management pagination', () => {
  it('filters published articles before paging so newer private drafts cannot hide them', async () => {
    const file = await createMarkdown('# A published article');
    await data(
      await request(`/api/admin/markdown/${file.id}/publish`, 'POST', {
        title: 'Published article',
        slug: 'old-article',
        version: 1,
      }),
    );
    await testEnv.DB.prepare('UPDATE files SET updated_at=1 WHERE id=?').bind(file.id).run();
    await seedDocuments(120, false);

    const oldApi = await page<Document>('/api/admin/markdown');
    expect(oldApi.data).toHaveLength(100);
    expect(oldApi.total).toBe(121);
    expect(oldApi.data.some((row) => row.id === file.id)).toBe(false);
    const visible = await page<Document>('/api/admin/markdown?published=1&page=1&limit=40');
    expect(visible).toMatchObject({ page: 1, limit: 40, total: 1 });
    expect(visible.data).toMatchObject([{ id: file.id, published: 1, slug: 'old-article' }]);

    await seedDocuments(100, true);
    const pages = await Promise.all(
      [1, 2, 3].map((n) => page<Document>(`/api/admin/markdown?published=1&page=${n}&limit=40`)),
    );
    expect(pages.map((result) => result.data.length)).toEqual([40, 40, 21]);
    expect(pages.every((result) => result.total === 101)).toBe(true);
    expect(new Set(pages.flatMap((result) => result.data.map((row) => row.id))).size).toBe(101);
    expect((await page<Document>('/api/admin/markdown?published=1&page=2&limit=40')).data).toEqual(
      pages[1].data,
    );
  });

  it('returns every share beyond the old hundred-row cap with stable usable copy links', async () => {
    const file = await createMarkdown('shared content');
    await testEnv.DB.batch(
      await Promise.all(
        Array.from({ length: 121 }, async (_, index) =>
          testEnv.DB.prepare(
            'INSERT INTO file_shares(id,file_id,token_hash,created_at) VALUES(?,?,?,1)',
          ).bind(crypto.randomUUID(), file.id, await digest(`share fixture ${index}`)),
        ),
      ),
    );
    const original = await page<ShareListItem>('/api/admin/shares');
    expect(original).toMatchObject({ page: 1, limit: 100, total: 121 });
    expect(original.data).toHaveLength(100);
    const pages = await Promise.all(
      [1, 2, 3, 4].map((n) => page<ShareListItem>(`/api/admin/shares?page=${n}&limit=40`)),
    );
    expect(pages.map((result) => result.data.length)).toEqual([40, 40, 40, 1]);
    expect(new Set(pages.flatMap((result) => result.data.map((row) => row.id))).size).toBe(121);
    expect((await page<ShareListItem>('/api/admin/shares?page=4&limit=40')).data).toEqual(
      pages[3].data,
    );
    const oldShare = pages[3].data[0];
    const direct = await request(new URL(oldShare.directUrl).pathname);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe('shared content');
    expect(JSON.stringify(oldShare)).not.toContain('token_hash');
    const end = await page<ShareListItem>('/api/admin/shares?page=5&limit=40');
    expect(end.total).toBe(121);
    expect(end.data).toEqual([]);
  });

  it('normalizes page bounds to finite integers without allowing unbounded queries', () => {
    expect(paginationParams({})).toEqual({ page: 1, limit: 100, offset: 0 });
    expect(paginationParams({ page: '2.9', limit: '40.8' })).toEqual({
      page: 2,
      limit: 40,
      offset: 40,
    });
    expect(paginationParams({ page: 'Infinity', limit: 'NaN' }, 40)).toEqual({
      page: 1,
      limit: 40,
      offset: 0,
    });
    expect(paginationParams({ page: '-3', limit: '-20' })).toEqual({
      page: 1,
      limit: 1,
      offset: 0,
    });
    expect(paginationParams({ page: '999999', limit: '999999' })).toEqual({
      page: 100000,
      limit: 100,
      offset: 9999900,
    });
  });
});
