export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Drive-Request', '1');
  if (options.body && typeof options.body === 'string')
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/admin${path}`, { ...options, headers });
  const result = (await response.json()) as { data: T; error?: { message: string } };
  if (!response.ok) throw new ApiError(response.status, result.error?.message ?? '请求失败');
  return result.data;
}
export const send = <T>(path: string, method: string, data?: unknown) =>
  api<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
export const fileUrl = (id: string, preview = false) =>
  `/api/admin/files/${id}/download${preview ? '?preview=1' : ''}`;
export const sizeLabel = (n: number) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} B`;
export const dateLabel = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(n);
export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
