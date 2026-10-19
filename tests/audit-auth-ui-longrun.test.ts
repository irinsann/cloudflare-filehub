import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { useUploads, type UploadItem } from '../src/hooks/useUploads';
import type { FileRecord, Settings } from '../shared/types';
import { data, request, upload } from './helpers';
import { testEnv } from './setup';

const hookState = vi.hoisted(() => ({ items: [] as UploadItem[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: UploadItem[]) => {
    hookState.items = initial;
    return [
      initial,
      (update: UploadItem[] | ((items: UploadItem[]) => UploadItem[])) => {
        hookState.items = typeof update === 'function' ? update(hookState.items) : update;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload retry and image revocation regressions in isolated storage', () => {
  it('keeps an image revoked when an earlier publication request is replayed', async () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const file = await data<FileRecord>(await upload('private.png', bytes));
    const image = await data<{ name: string; url: string }>(
      await request('/api/admin/images', 'POST', { file_id: file.id }),
    );
    expect((await request('/api/admin/images/' + image.name, 'DELETE')).status).toBe(200);
    expect((await request(new URL(image.url).pathname)).status).toBe(404);

    // A client repeats the original POST after its response was lost. No restore is requested.
    await request('/api/admin/images', 'POST', { file_id: file.id });
    expect((await request(new URL(image.url).pathname)).status).toBe(404);
  });

  it('reconciles an uncertain upload commit before retrying the ordinary queue', async () => {
    let offline = true;
    const committed = new Set<string>();
    vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
      if (offline && /^\/api\/admin\/files\/[^/]+$/.test(path))
        throw new TypeError('Simulated network outage during confirmation');
      const headers = new Headers(init.headers);
      headers.set('Origin', 'http://localhost');
      const response = await app.request('http://localhost' + path, { ...init, headers }, testEnv);
      if (offline && /\/uploads\/[^/]+\/complete$/.test(path)) {
        if (response.ok) committed.add((await data<FileRecord>(response)).id);
        throw new TypeError('Simulated lost completion response');
      }
      return response;
    });
    class PartRequest {
      method = '';
      path = '';
      headers = new Headers({ Origin: 'http://localhost' });
      status = 0;
      responseText = '';
      upload = {};
      onload = () => {};
      onerror = () => {};
      open(method: string, path: string) {
        this.method = method;
        this.path = path;
      }
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send(body: Blob) {
        void body
          .arrayBuffer()
          .then(async (bytes) => {
            const result = await app.request(
              'http://localhost' + this.path,
              { method: this.method, headers: this.headers, body: bytes },
              testEnv,
            );
            this.status = result.status;
            this.responseText = await result.text();
            this.onload();
          })
          .catch(() => this.onerror());
      }
    }
    vi.stubGlobal('XMLHttpRequest', PartRequest);
    const notify = vi.fn();
    const queue = useUploads({} as Settings, vi.fn(), notify);
    queue.add([new File(['abc'], 'long-running-upload.bin')], null);
    await vi.waitFor(() => expect(hookState.items[0]?.state).toBe('error'), { timeout: 5000 });
    expect(committed.size).toBe(1);
    offline = false;
    queue.retry(hookState.items[0]);
    await vi.waitFor(() => expect(hookState.items[0]?.state).toBe('success'), { timeout: 5000 });
    const rows = await testEnv.DB.prepare(
      "SELECT id,name,size FROM files WHERE status='ready' AND deleted_at IS NULL",
    ).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results.map((row) => ({ name: row.name, size: row.size }))).toEqual([
      { name: 'long-running-upload.bin', size: 3 },
    ]);
  });

  it.each(['before-request', 'after-commit'])(
    'retries an empty file with one stable ID after a lost response %s',
    async (failure) => {
      let offline = true;
      const requestIds: string[] = [];
      vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Origin', 'http://localhost');
        const uploading = path.startsWith('/api/admin/files/upload?');
        if (uploading) requestIds.push(headers.get('X-Upload-Id')!);
        if (uploading && offline && failure === 'before-request')
          throw new TypeError('Request never reached the server');
        const response = await app.request(
          'http://localhost' + path,
          { ...init, headers },
          testEnv,
        );
        if (uploading && offline) throw new TypeError('Committed response was lost');
        return response;
      });
      const queue = useUploads({} as Settings, vi.fn(), vi.fn());
      queue.add([new File([], 'empty.txt')], null);
      await vi.waitFor(() => expect(hookState.items[0]?.state).toBe('error'));
      const originalId = hookState.items[0].receipt.fileId;
      expect(originalId).toMatch(/^[0-9a-f-]{36}$/);
      offline = false;
      queue.retry(hookState.items[0]);
      await vi.waitFor(() => expect(hookState.items[0]?.state).toBe('success'));
      expect(new Set(requestIds)).toEqual(new Set([originalId]));
      expect(
        await testEnv.DB.prepare("SELECT id,name,size FROM files WHERE status='ready'").all(),
      ).toMatchObject({ results: [{ id: originalId, name: 'empty.txt', size: 0 }] });
    },
  );
});
