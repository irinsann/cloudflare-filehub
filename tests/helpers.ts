import { app } from '../worker/index';
import type { Env } from '../worker/env';
import { testEnv } from './setup';
export function request(
  path: string,
  method = 'GET',
  body?: unknown,
  env: Env = testEnv,
  headers: Record<string, string> = {},
) {
  return app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
export async function data<T>(response: Response) {
  const result = (await response.json()) as { data: T; error?: unknown };
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result.error)}`);
  return result.data;
}
export async function createMarkdown(content = '# 初稿', name = 'note.md') {
  return data<import('../shared/types').FileRecord>(
    await request('/api/admin/markdown', 'POST', { name, content }),
  );
}
export async function upload(name: string, content: string | Uint8Array, folderId?: string) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const params = new URLSearchParams({ name });
  if (folderId) params.set('folder_id', folderId);
  return app.request(
    `http://localhost/api/admin/files/upload?${params}`,
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'X-Drive-Request': '1',
        'X-File-Size': String(bytes.byteLength),
      },
      body: bytes.slice().buffer,
    },
    testEnv,
  );
}
