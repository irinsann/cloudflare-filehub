import { z } from 'zod';
import type { Env, AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { encryptSecret, decryptSecret } from './secret-store';
import type { GoogleDriveFile, GoogleDriveExportFormat } from '../shared/google-drive';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3/';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const driveId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/, 'Google Drive ID 无效');
export const driveName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((s) => !/[\x00-\x1f]/.test(s), '名称无效');
export const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,parents,trashed,webViewLink,capabilities(canEdit,canDownload,canTrash,canUntrash,canDelete,canAddChildren,canRename,canMoveItemWithinDrive),shortcutDetails(targetId,targetMimeType)';
export interface DriveConnection {
  connection_id: string;
  account_json: string;
  refresh_cipher: string;
  access_cipher: string;
  access_expires: number;
}
export async function seal(env: Env, value: string, purpose: string) {
  return encryptSecret(JSON.stringify({ purpose: 'rcloud-google:' + purpose, value }), env);
}
export async function unseal(env: Env, value: string, purpose: string) {
  try {
    const result = JSON.parse(await decryptSecret(value, env)) as {
      purpose?: string;
      value?: string;
    };
    if (result.purpose !== 'rcloud-google:' + purpose || typeof result.value !== 'string')
      throw new Error('Invalid secret purpose');
    return result.value;
  } catch {
    fail(503, 'Google Drive 凭据无法读取，请重新连接');
  }
}
export function configured(env: Env) {
  return !!(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.AUTH_ENCRYPTION_KEY &&
    env.AUTH_ENCRYPTION_KEY.length >= 32
  );
}
export async function connection(env: Env, expectedId?: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM google_drive_connections WHERE id=1',
  ).first<DriveConnection>();
  if (!row || (expectedId && row.connection_id !== expectedId))
    fail(409, 'Google Drive 连接已变更，请刷新');
  return row;
}
export async function upstream(url: string | URL, init: RequestInit = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch {
    fail(502, 'Google Drive 暂时无法连接，请重试');
  } finally {
    // The deadline covers the response headers, never a user's subsequent slow download.
    clearTimeout(timer);
  }
}
export function mutationConnection(c: AppContext) {
  return connection(
    c.env,
    z.uuid('Google Drive 连接标识无效').parse(c.req.header('X-Google-Connection')),
  );
}
export async function googleError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    error?: { errors?: { reason?: string }[] };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason;
  if (response.status === 401) fail(424, 'Google Drive 授权已失效，请重新连接');
  if (response.status === 404) fail(404, 'Google Drive 文件不存在或不可访问');
  if (
    response.status === 429 ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded'
  )
    fail(429, 'Google Drive 请求过于频繁，请稍后重试');
  if (reason === 'storageQuotaExceeded') fail(409, 'Google Drive 存储空间不足');
  if (reason === 'exportSizeLimitExceeded')
    fail(413, '此文档超过 Google 导出大小限制，请在 Google Drive 下载');
  if (response.status === 416) fail(416, '下载范围无效');
  if (response.status === 403) fail(403, 'Google Drive 不允许此操作，请检查文件权限或账户额度');
  if (response.status === 400) fail(400, 'Google Drive 无法执行此操作');
  if (response.status === 412 || response.status === 409)
    fail(409, 'Google Drive 文件已变更，请刷新后重试');
  fail(502, 'Google Drive 暂时无法完成请求，请重试');
}
export async function tokenRequest(env: Env, values: Record<string, string>) {
  if (!configured(env)) fail(503, '请先配置 Google OAuth 客户端');
  const response = await upstream('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      ...values,
    }),
  });
  const result = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  } | null;
  if (!response.ok || !result?.access_token) {
    if (result?.error === 'invalid_grant') fail(424, 'Google Drive 授权已失效，请重新连接');
    fail(502, 'Google 授权暂时无法完成，请重试');
  }
  if (!Number.isFinite(result.expires_in) || result.expires_in! <= 0)
    fail(502, 'Google 授权响应无效');
  return result as typeof result & { access_token: string; expires_in: number };
}
export async function accessToken(
  env: Env,
  expectedId?: string,
): Promise<{ token: string; id: string; cipher: string }> {
  const row = await connection(env, expectedId);
  if (row.access_expires > now() + 60000)
    return {
      token: await unseal(env, row.access_cipher, 'access'),
      id: row.connection_id,
      cipher: row.access_cipher,
    };
  const owner = uuid();
  const acquired = await env.DB.prepare(
    'UPDATE google_drive_connections SET refresh_owner=?,refresh_until=? WHERE connection_id=? AND refresh_until<=?',
  )
    .bind(owner, now() + 60000, row.connection_id, now())
    .run();
  if (!acquired.meta.changes) fail(423, 'Google Drive 正在刷新授权，请稍后重试');
  try {
    // Re-read under the lease: another request may have refreshed immediately before acquisition.
    const current = await connection(env, row.connection_id);
    if (current.access_expires > now() + 60000)
      return {
        token: await unseal(env, current.access_cipher, 'access'),
        id: current.connection_id,
        cipher: current.access_cipher,
      };
    const tokens = await tokenRequest(env, {
      grant_type: 'refresh_token',
      refresh_token: await unseal(env, current.refresh_cipher, 'refresh'),
    });
    const cipher = await seal(env, tokens.access_token, 'access');
    const saved = await env.DB.prepare(
      'UPDATE google_drive_connections SET access_cipher=?,refresh_cipher=?,access_expires=? WHERE connection_id=? AND refresh_owner=? AND refresh_until>?',
    )
      .bind(
        cipher,
        tokens.refresh_token
          ? await seal(env, tokens.refresh_token, 'refresh')
          : current.refresh_cipher,
        now() + Math.min(tokens.expires_in, 86400) * 1000,
        row.connection_id,
        owner,
        now(),
      )
      .run();
    if (!saved.meta.changes) fail(409, 'Google Drive 连接已变更，请刷新');
    return { token: tokens.access_token, id: row.connection_id, cipher };
  } finally {
    await env.DB.prepare(
      'UPDATE google_drive_connections SET refresh_owner=NULL,refresh_until=0 WHERE connection_id=? AND refresh_owner=?',
    )
      .bind(row.connection_id, owner)
      .run();
  }
}
export async function invalidateAccessToken(env: Env, auth: { id: string; cipher: string }) {
  await env.DB.prepare(
    'UPDATE google_drive_connections SET access_expires=0 WHERE connection_id=? AND access_cipher=?',
  )
    .bind(auth.id, auth.cipher)
    .run();
}
export async function driveRequest(
  env: Env,
  path: string,
  init: RequestInit = {},
  expectedId?: string,
) {
  const auth = await accessToken(env, expectedId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + auth.token);
  // Only code-owned API paths are accepted. Session URLs use separate strict validation.
  const url = new URL(path, DRIVE_API);
  if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/'))
    fail(400, 'Google API 路径无效');
  let response = await upstream(url, { ...init, headers });
  if (response.status === 401 && (!init.body || typeof init.body === 'string')) {
    await response.body?.cancel();
    await invalidateAccessToken(env, auth);
    const refreshed = await accessToken(env, auth.id);
    headers.set('Authorization', 'Bearer ' + refreshed.token);
    response = await upstream(url, { ...init, headers });
  }
  if (!response.ok) return googleError(response);
  await connection(env, auth.id);
  return response;
}
export async function driveJson<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
  expectedId?: string,
) {
  const response = await driveRequest(env, path, init, expectedId);
  return response.json() as Promise<T>;
}
export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
  return { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } };
}
const pdf: GoogleDriveExportFormat = {
  id: 'pdf',
  label: 'PDF',
  mime: 'application/pdf',
  extension: 'pdf',
};
const formats: Record<string, GoogleDriveExportFormat[]> = {
  'application/vnd.google-apps.document': [
    pdf,
    {
      id: 'docx',
      label: 'Word',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
    },
    { id: 'txt', label: '文本', mime: 'text/plain', extension: 'txt' },
  ],
  'application/vnd.google-apps.spreadsheet': [
    pdf,
    {
      id: 'xlsx',
      label: 'Excel',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    },
    { id: 'csv', label: 'CSV', mime: 'text/csv', extension: 'csv' },
  ],
  'application/vnd.google-apps.presentation': [
    pdf,
    {
      id: 'pptx',
      label: 'PowerPoint',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
    },
  ],
  'application/vnd.google-apps.drawing': [
    pdf,
    { id: 'png', label: 'PNG', mime: 'image/png', extension: 'png' },
    { id: 'svg', label: 'SVG', mime: 'image/svg+xml', extension: 'svg' },
  ],
};
export function presentFile(file: GoogleDriveFile): GoogleDriveFile {
  const exportFormats = formats[file.mimeType];
  return { ...file, ...(exportFormats ? { exportFormats } : {}) };
}
export async function getDriveFile(env: Env, id: string, expectedId?: string) {
  return presentFile(
    await driveJson<GoogleDriveFile>(
      env,
      'files/' +
        driveId.parse(id) +
        '?supportsAllDrives=true&fields=' +
        encodeURIComponent(FILE_FIELDS),
      {},
      expectedId,
    ),
  );
}
export async function writableFolder(env: Env, id: string, expectedId?: string) {
  const folder = await getDriveFile(env, id, expectedId);
  if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed)
    fail(400, '目标文件夹不可用');
  if (!folder.capabilities?.canAddChildren) fail(403, '目标文件夹不可写入');
  return folder;
}
