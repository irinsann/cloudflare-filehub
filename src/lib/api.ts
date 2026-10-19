import { tr } from './i18n';
import type { PaginatedResult } from '../../shared/pagination';
import { getLocale } from './i18n';
import { formatBytes, formatDate } from '../../shared/i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Drive-Request', '1');
  headers.set('Accept-Language', getLocale());
  if (options.body && typeof options.body === 'string')
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/admin${path}`, { ...options, headers });
  if (response.status === 401) location.assign('/login');
  const result = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok)
    throw new ApiError(response.status, result.error?.message ?? tr('请求失败', 'Request failed'));
  return result;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await requestJson<{ data: T }>(path, options)).data;
}
export const apiPage = <T>(path: string, options: RequestInit = {}) =>
  requestJson<PaginatedResult<T>>(path, options);
export const send = <T>(path: string, method: string, data?: unknown) =>
  api<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
export const fileUrl = (id: string, preview = false) =>
  `/api/admin/files/${id}/download${preview ? '?preview=1' : ''}`;
export const sizeLabel = (n: number) => formatBytes(getLocale(), n);
export const dateLabel = (n: number) => formatDate(getLocale(), n);
export async function copy(text: string) {
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.writeText !== 'function')
    throw new Error(
      tr('当前浏览器无法自动复制', 'Automatic copying is unavailable in this browser'),
    );
  await clipboard.writeText(text);
}
