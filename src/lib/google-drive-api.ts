import { api, ApiError } from './api';

// Bind every namespace mutation to the connection the user actually saw.
// The backend rejects stale pages instead of applying an action to a new account.
export function driveWrite<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  connectionId: string,
  data?: unknown,
): Promise<T> {
  if (!connectionId)
    return Promise.reject(new ApiError(409, 'Google Drive 连接状态已变化，请刷新后重试'));
  return api<T>('/google-drive' + path, {
    method,
    headers: { 'X-Google-Connection': connectionId },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
