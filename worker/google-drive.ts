import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './env';
import { fail } from './errors';
import { rateLimit } from './auth-crypto';
import {
  GOOGLE_DRIVE_FOLDER,
  type GoogleDriveFile,
  type GoogleDriveListing,
  type GoogleDriveStatus,
} from '../shared/google-drive';
import {
  configured,
  connection,
  mutationConnection,
  driveId,
  driveName,
  driveJson,
  driveRequest,
  FILE_FIELDS,
  getDriveFile,
  jsonBody,
  presentFile,
  writableFolder,
} from './google-drive-client';
import { beginGoogleConnect, disconnectGoogle, redirectUris } from './google-drive-oauth';
import {
  startDriveUpload,
  getDriveUpload,
  putDriveUpload,
  cancelDriveUpload,
} from './google-drive-uploads';
export { googleDriveCallback } from './google-drive-oauth';
export { cleanupGoogleDrive } from './google-drive-uploads';

export const googleDriveRoutes = new Hono<AppEnv>();
googleDriveRoutes.use('/google-drive/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Retry-After', '2');
  await next();
});
googleDriveRoutes.get('/google-drive', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT connection_id,account_json FROM google_drive_connections WHERE id=1',
  ).first<{ connection_id: string; account_json: string }>();
  const result: GoogleDriveStatus = {
    configured: configured(c.env),
    connected: !!row,
    redirectUris: redirectUris(c.env),
  };
  if (row) {
    result.connectionId = row.connection_id;
    result.account = JSON.parse(row.account_json);
    try {
      const about = await driveJson<{
        user: GoogleDriveStatus['account'];
        storageQuota: GoogleDriveStatus['storageQuota'];
      }>(c.env, 'about?fields=user(displayName,emailAddress),storageQuota', {}, row.connection_id);
      result.account = about.user;
      result.storageQuota = about.storageQuota;
    } catch (error) {
      result.needsReconnect = error instanceof HTTPException && error.status === 424;
      result.error = error instanceof HTTPException ? error.message : 'Google Drive 暂时无法连接';
    }
  }
  return c.json({ data: result });
});
googleDriveRoutes.post('/google-drive/connect', async (c) => {
  await rateLimit(c.env, 'google-connect', c.get('email'), 12, 300);
  return beginGoogleConnect(c);
});
googleDriveRoutes.delete('/google-drive/connection', disconnectGoogle);
googleDriveRoutes.get('/google-drive/files', async (c) => {
  const parent = driveId.parse(c.req.query('parent') || 'root'),
    q = z
      .string()
      .max(200)
      .parse(c.req.query('q') ?? '');
  const pageToken = z
    .string()
    .max(4096)
    .parse(c.req.query('page_token') ?? '');
  const trash = c.req.query('trashed') === '1';
  const conditions = [trash ? 'trashed = true' : 'trashed = false'];
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (!trash) conditions.push(`'${escape(parent)}' in parents`);
  if (q) conditions.push(`name contains '${escape(q)}'`);
  const params = new URLSearchParams({
    q: conditions.join(' and '),
    pageSize: '100',
    fields: 'nextPageToken,files(' + FILE_FIELDS + ')',
    orderBy: 'folder,name_natural',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const result = await driveJson<GoogleDriveListing>(c.env, 'files?' + params);
  return c.json({
    data: {
      files: (result.files ?? []).map(presentFile),
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    },
  });
});
googleDriveRoutes.post('/google-drive/folders', async (c) => {
  const body = z
    .object({ name: driveName, parentId: driveId.default('root') })
    .strict()
    .parse(await c.req.json());
  const current = await mutationConnection(c);
  await writableFolder(c.env, body.parentId, current.connection_id);
  const file = await driveJson<GoogleDriveFile>(
    c.env,
    'files?supportsAllDrives=true&fields=' + encodeURIComponent(FILE_FIELDS),
    {
      method: 'POST',
      ...jsonBody({ name: body.name, parents: [body.parentId], mimeType: GOOGLE_DRIVE_FOLDER }),
    },
    current.connection_id,
  );
  return c.json({ data: presentFile(file) }, 201);
});
googleDriveRoutes.patch('/google-drive/files/:id', async (c) => {
  const body = z
    .object({
      name: driveName.optional(),
      parentId: driveId.optional(),
      trashed: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, '请提供修改内容')
    .parse(await c.req.json());
  const current = await mutationConnection(c),
    id = driveId.parse(c.req.param('id'));
  const file = await getDriveFile(c.env, id, current.connection_id),
    caps = file.capabilities ?? {};
  if (body.name !== undefined && !caps.canRename) fail(403, '该文件不能重命名');
  if (body.trashed === true && !caps.canTrash) fail(403, '该文件不能移入回收站');
  if (body.trashed === false && !caps.canUntrash) fail(403, '该文件不能恢复');
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: FILE_FIELDS });
  if (body.parentId !== undefined) {
    if (!caps.canMoveItemWithinDrive || file.trashed || body.trashed === true)
      fail(403, '该文件不能移动');
    if (body.parentId === id) fail(400, '不能移动到自身');
    const destination = await writableFolder(c.env, body.parentId, current.connection_id);
    if (!file.parents?.includes(destination.id)) {
      params.set('addParents', destination.id);
      if (file.parents?.length) params.set('removeParents', file.parents.join(','));
    }
  }
  const metadata = {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.trashed === undefined ? {} : { trashed: body.trashed }),
  };
  return c.json({
    data: presentFile(
      await driveJson<GoogleDriveFile>(
        c.env,
        'files/' + id + '?' + params,
        { method: 'PATCH', ...jsonBody(metadata) },
        current.connection_id,
      ),
    ),
  });
});
googleDriveRoutes.delete('/google-drive/files/:id', async (c) => {
  const current = await mutationConnection(c),
    id = driveId.parse(c.req.param('id'));
  const file = await getDriveFile(c.env, id, current.connection_id);
  if (!file.trashed) fail(409, '请先将文件移入回收站');
  if (!file.capabilities?.canDelete) fail(403, '该文件不能彻底删除');
  const response = await driveRequest(
    c.env,
    'files/' + id + '?supportsAllDrives=true',
    { method: 'DELETE' },
    current.connection_id,
  );
  await response.body?.cancel();
  return c.json({ data: { deleted: true } });
});
googleDriveRoutes.on(['GET', 'HEAD'], '/google-drive/files/:id/download', async (c) => {
  const current = await connection(c.env),
    id = driveId.parse(c.req.param('id'));
  const file = await getDriveFile(c.env, id, current.connection_id);
  if (file.trashed || !file.capabilities?.canDownload || file.mimeType === GOOGLE_DRIVE_FOLDER)
    fail(403, '该文件不可下载');
  const format = c.req.query('format'),
    native = file.mimeType.startsWith('application/vnd.google-apps.');
  const selected = native ? file.exportFormats?.find((f) => f.id === format) : undefined;
  if (native && !selected) fail(400, '请选择支持的导出格式，或在 Google Drive 打开文件');
  const range = c.req.header('Range');
  if (native && range) fail(416, 'Google 文档导出不支持分段下载');
  if (range && !/^bytes=(\d+-\d*|-\d+)$/.test(range)) fail(416, '下载范围无效');
  // Google's media Range support does not document If-Range semantics. Without a provable
  // shared validator, return the full entity so a download client cannot concatenate revisions.
  const effectiveRange = c.req.header('If-Range') ? undefined : range;
  const response = await driveRequest(
    c.env,
    selected
      ? `files/${id}/export?mimeType=${encodeURIComponent(selected.mime)}`
      : `files/${id}?alt=media&supportsAllDrives=true`,
    { headers: effectiveRange ? { Range: effectiveRange } : {} },
    current.connection_id,
  );
  const headers = new Headers({
    'Content-Type': selected?.mime ?? file.mimeType ?? 'application/octet-stream',
    'Content-Disposition':
      "attachment; filename*=UTF-8''" +
      encodeURIComponent(file.name + (selected ? '.' + selected.extension : '')),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  for (const name of [
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
    'ETag',
    'Last-Modified',
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (c.req.method === 'HEAD') {
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
});
googleDriveRoutes.post('/google-drive/uploads', startDriveUpload);
googleDriveRoutes.get('/google-drive/uploads/:id', getDriveUpload);
googleDriveRoutes.put('/google-drive/uploads/:id', putDriveUpload);
googleDriveRoutes.delete('/google-drive/uploads/:id', cancelDriveUpload);
