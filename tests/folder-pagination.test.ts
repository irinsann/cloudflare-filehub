import { describe, expect, it } from 'vitest';
import type { FolderRecord, Listing } from '../shared/types';
import type { PaginatedResult } from '../shared/pagination';
import { data, request } from './helpers';
import { testEnv } from './setup';

async function seedFolders(count: number, deleted = false) {
  await testEnv.DB.batch(
    Array.from({ length: count }, (_, index) =>
      testEnv.DB.prepare(
        'INSERT INTO folders(id,name,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        'folder-' + String(index).padStart(3, '0'),
        1,
        1,
        deleted ? 1 : null,
      ),
    ),
  );
}

describe('folder listings beyond one hundred entries', () => {
  it.each(['files', 'trash'])(
    'allows every folder in the %s view to be reached with bounded pages',
    async (view) => {
      await seedFolders(101, view === 'trash');
      const ids: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const listing = await data<Listing>(
          await request(`/api/admin/files?view=${view}&page=${page}`),
        );
        expect(listing.folderTotal).toBe(101);
        expect(listing.total).toBe(0);
        expect(listing.limit).toBe(40);
        expect(listing.folders).toHaveLength(page === 3 ? 21 : 40);
        ids.push(...listing.folders.map((f) => f.id));
      }
      expect(new Set(ids).size).toBe(101);
    },
  );

  it('paginates the move target picker and keeps the default data array compatible', async () => {
    await seedFolders(101);
    const first = (await (
      await request('/api/admin/folders')
    ).json()) as PaginatedResult<FolderRecord>;
    expect(first.data).toHaveLength(100);
    expect(first.total).toBe(101);
    const second = (await (
      await request('/api/admin/folders?page=2')
    ).json()) as PaginatedResult<FolderRecord>;
    expect(second.data.map((f) => f.name)).toEqual(['folder-100']);
    expect(second.page).toBe(2);
    expect(new Set([...first.data, ...second.data].map((f) => f.id)).size).toBe(101);
  });

  it('does not create folder-only pages during file search or the Markdown view', async () => {
    await seedFolders(101);
    for (const path of ['/api/admin/files?search=absent', '/api/admin/files?view=markdown']) {
      const listing = await data<Listing>(await request(path));
      expect(listing.folders).toEqual([]);
      expect(listing.folderTotal).toBe(0);
    }
  });
});
