import { z } from 'zod';
import type { AppContext, Env } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import {
  GOOGLE_DRIVE_CHUNK_SIZE,
  type GoogleDriveFile,
  type GoogleDriveUpload,
} from '../shared/google-drive';
import {
  accessToken,
  invalidateAccessToken,
  connection,
  driveId,
  driveName,
  driveJson,
  getDriveFile,
  googleError,
  FILE_FIELDS,
  DRIVE_UPLOAD,
  jsonBody,
  seal,
  unseal,
  upstream,
  writableFolder,
  presentFile,
} from './google-drive-client';

interface UploadRow {
  id: string;
  connection_id: string;
  session_cipher: string;
  file_id: string;
  size: number;
  offset: number;
  result_json: string | null;
  expires_at: number;
  cancelled: number;
}
const uploadId = z.uuid();
const input = z
  .object({
    connectionId: z.uuid(),
    name: driveName,
    parentId: driveId.default('root'),
    size: z
      .number()
      .int()
      .min(0)
      .max(5 * 1024 ** 4),
    mime: z
      .string()
      .max(150)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
      .default('application/octet-stream')
      .refine((v) => !v.startsWith('application/vnd.google-apps.'), '请使用普通文件格式上传'),
    fileId: driveId.optional(),
  })
  .strict();
export function uploadSessionUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== 'https://www.googleapis.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/upload\/drive\/v3\/files(?:\/[a-zA-Z0-9_-]+)?$/.test(url.pathname) ||
    url.searchParams.get('uploadType') !== 'resumable' ||
    !url.searchParams.get('upload_id')
  )
    fail(502, 'Google 上传会话无效');
  return url.href;
}
function progress(row: UploadRow): GoogleDriveUpload {
  return {
    id: row.id,
    chunkSize: GOOGLE_DRIVE_CHUNK_SIZE,
    offset: row.offset,
    complete: !!row.result_json,
    ...(row.result_json ? { file: JSON.parse(row.result_json) as GoogleDriveFile } : {}),
  };
}
async function uploadFetch(
  env: Env,
  url: string,
  init: RequestInit,
  connectionId: string,
  streaming = false,
) {
  const auth = await accessToken(env, connectionId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + auth.token);
  let response = await upstream(url, { ...init, headers }, streaming ? 10 * 60000 : 30000);
  if (response.status === 401) {
    await response.body?.cancel();
    await invalidateAccessToken(env, auth);
    // Consumed upload bodies cannot be replayed. The client must probe Google's acknowledged offset first.
    if (streaming) fail(503, 'Google 上传授权需刷新，请查询进度后继续');
    const refreshed = await accessToken(env, connectionId);
    headers.set('Authorization', 'Bearer ' + refreshed.token);
    response = await upstream(url, { ...init, headers });
  }
  return response;
}
async function getUpload(c: AppContext) {
  const id = uploadId.parse(c.req.param('id'));
  const row = await c.env.DB.prepare(
    'SELECT * FROM google_drive_uploads WHERE id=? AND cancelled=0 AND expires_at>?',
  )
    .bind(id, now())
    .first<UploadRow>();
  if (!row) fail(410, '上传会话已失效或已取消');
  await connection(c.env, row.connection_id);
  return row;
}
async function locked<T>(
  c: AppContext,
  row: UploadRow,
  action: (owner: string) => Promise<T>,
): Promise<T> {
  const owner = uuid();
  const acquired = await c.env.DB.prepare(
    'UPDATE google_drive_uploads SET owner=?,lock_until=? WHERE id=? AND connection_id=? AND cancelled=0 AND lock_until<=? AND expires_at>?',
  )
    .bind(owner, now() + 15 * 60000, row.id, row.connection_id, now(), now())
    .run();
  if (!acquired.meta.changes) {
    c.header('Retry-After', '2');
    fail(423, '此上传正在处理，请稍后重试');
  }
  try {
    return await action(owner);
  } finally {
    await c.env.DB.prepare(
      'UPDATE google_drive_uploads SET owner=NULL,lock_until=0 WHERE id=? AND owner=?',
    )
      .bind(row.id, owner)
      .run();
  }
}
async function saveProgress(
  c: AppContext,
  row: UploadRow,
  owner: string,
  response: Response,
): Promise<GoogleDriveUpload> {
  let offset: number, file: GoogleDriveFile | undefined;
  if (response.status === 308) {
    const range = response.headers.get('Range');
    if (range && !/^bytes=0-\d+$/.test(range)) fail(502, 'Google 上传进度响应无效');
    offset = range ? Number(range.slice(8)) + 1 : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.size)
      fail(502, 'Google 上传进度响应无效');
    await response.body?.cancel();
  } else if (response.ok) {
    file = presentFile((await response.json()) as GoogleDriveFile);
    // Google is authoritative for completion, but only the exact expected file can satisfy this session.
    if (file.id !== row.file_id || Number(file.size) !== row.size || !file.name || !file.mimeType)
      fail(502, 'Google 上传完成响应无效');
    offset = row.size;
  } else if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    // For overwrite sessions a matching old size cannot prove completion. Only completed responses are accepted.
    fail(410, 'Google 上传会话已过期，请检查目标文件后重新上传');
  } else return googleError(response);
  const updated = await c.env.DB.prepare(
    `UPDATE google_drive_uploads SET offset=?,result_json=? WHERE id=? AND connection_id=? AND owner=? AND lock_until>? AND cancelled=0 AND expires_at>?
    AND EXISTS(SELECT 1 FROM google_drive_connections WHERE connection_id=?)`,
  )
    .bind(
      offset,
      file ? JSON.stringify(file) : null,
      row.id,
      row.connection_id,
      owner,
      now(),
      now(),
      row.connection_id,
    )
    .run();
  if (!updated.meta.changes) fail(410, '上传会话已失效，请检查目标文件');
  return progress({ ...row, offset, result_json: file ? JSON.stringify(file) : null });
}
export async function startDriveUpload(c: AppContext) {
  const body = input.parse(await c.req.json());
  const current = await connection(c.env, body.connectionId);
  let fileId = body.fileId;
  if (fileId) {
    const target = await getDriveFile(c.env, fileId, current.connection_id);
    if (
      target.trashed ||
      target.mimeType.startsWith('application/vnd.google-apps.') ||
      !target.capabilities?.canEdit
    )
      fail(403, '该文件不能覆盖上传');
  } else {
    await writableFolder(c.env, body.parentId, current.connection_id);
    const generated = await driveJson<{ ids: string[] }>(
      c.env,
      'files/generateIds?count=1&space=drive&type=files',
      {},
      current.connection_id,
    );
    fileId = driveId.parse(generated.ids?.[0]);
  }
  const id = uuid();
  const metadata = {
    name: body.name,
    mimeType: body.mime,
    ...(!body.fileId ? { id: fileId, parents: [body.parentId] } : {}),
  };
  const endpoint = DRIVE_UPLOAD + (body.fileId ? '/' + body.fileId : '');
  let sessionCipher = '',
    resultJson: string | null = null;
  if (body.size === 0) {
    // Zero-byte files use a bounded multipart request; probing a zero-length resumable session is ambiguous.
    const boundary = 'rcloud_' + id.replace(/-/g, '');
    const response = await uploadFetch(
      c.env,
      endpoint +
        '?uploadType=multipart&supportsAllDrives=true&fields=' +
        encodeURIComponent(FILE_FIELDS),
      {
        method: body.fileId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'multipart/related; boundary=' + boundary,
        },
        body:
          '--' +
          boundary +
          '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          '\r\n--' +
          boundary +
          '\r\nContent-Type: ' +
          body.mime +
          '\r\n\r\n\r\n--' +
          boundary +
          '--',
      },
      current.connection_id,
    );
    if (!response.ok) return googleError(response);
    const file = presentFile((await response.json()) as GoogleDriveFile);
    if (file.id !== fileId || Number(file.size) !== 0) fail(502, 'Google 上传完成响应无效');
    resultJson = JSON.stringify(file);
  } else {
    const response = await uploadFetch(
      c.env,
      endpoint +
        '?uploadType=resumable&supportsAllDrives=true&fields=' +
        encodeURIComponent(FILE_FIELDS),
      {
        method: body.fileId ? 'PATCH' : 'POST',
        ...jsonBody(metadata),
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': body.mime,
          'X-Upload-Content-Length': String(body.size),
        },
      },
      current.connection_id,
    );
    if (!response.ok) return googleError(response);
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (!location) fail(502, 'Google 未返回上传会话');
    sessionCipher = await seal(c.env, uploadSessionUrl(location), 'upload:' + id);
  }
  const expiry = now() + 7 * 86400000;
  const saved = await c.env.DB.prepare(
    'INSERT INTO google_drive_uploads(id,connection_id,session_cipher,file_id,size,result_json,expires_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM google_drive_connections WHERE connection_id=?)',
  )
    .bind(
      id,
      current.connection_id,
      sessionCipher,
      fileId,
      body.size,
      resultJson,
      expiry,
      current.connection_id,
    )
    .run();
  if (!saved.meta.changes) fail(409, 'Google Drive 连接已变更');
  return c.json(
    {
      data: progress({
        id,
        connection_id: current.connection_id,
        session_cipher: sessionCipher,
        file_id: fileId,
        size: body.size,
        offset: 0,
        result_json: resultJson,
        expires_at: expiry,
        cancelled: 0,
      }),
    },
    201,
  );
}
export async function getDriveUpload(c: AppContext) {
  const row = await getUpload(c);
  if (row.result_json) return c.json({ data: progress(row) });
  return locked(c, row, async (owner) => {
    const current = await getUpload(c);
    if (current.result_json) return c.json({ data: progress(current) });
    const response = await uploadFetch(
      c.env,
      uploadSessionUrl(await unseal(c.env, row.session_cipher, 'upload:' + row.id)),
      {
        method: 'PUT',
        headers: {
          'Content-Range': 'bytes */' + row.size,
          'Content-Length': '0',
        },
        body: '',
      },
      row.connection_id,
    );
    return c.json({ data: await saveProgress(c, row, owner, response) });
  });
}
export async function putDriveUpload(c: AppContext) {
  const row = await getUpload(c);
  const offset = Number(c.req.query('offset'));
  if (!/^\d+$/.test(c.req.query('offset') ?? '') || !Number.isSafeInteger(offset))
    fail(400, '上传偏移无效');
  const declared = c.req.header('X-File-Size') ?? c.req.header('Content-Length') ?? '';
  if (!/^\d+$/.test(declared)) fail(411, '请提供分片大小');
  const length = Number(declared);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > GOOGLE_DRIVE_CHUNK_SIZE ||
    offset + length > row.size ||
    (offset + length !== row.size && length % (256 * 1024) !== 0)
  )
    fail(400, '上传分片大小无效');
  if (!c.req.raw.body) fail(400, '上传内容为空');
  return locked(c, row, async (owner) => {
    const current = await getUpload(c);
    if (current.result_json) return c.json({ data: progress(current) });
    if (current.offset !== offset) fail(409, '上传偏移已变化，请查询进度后继续');
    const stream = new FixedLengthStream(length);
    const pipeController = new AbortController();
    const pumping = c.req.raw.body!.pipeTo(stream.writable, { signal: pipeController.signal });
    // Attach a rejection handler immediately; the upstream may terminate before the pipe does.
    const piped = pumping.then(
      () => true,
      () => false,
    );
    let response: Response;
    try {
      response = await uploadFetch(
        c.env,
        uploadSessionUrl(await unseal(c.env, row.session_cipher, 'upload:' + row.id)),
        {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${offset}-${offset + length - 1}/${row.size}`,
          },
          body: stream.readable,
        },
        row.connection_id,
        true,
      );
    } catch (error) {
      pipeController.abort();
      throw error;
    }
    if (!response.ok && response.status !== 308) {
      pipeController.abort();
      return c.json({ data: await saveProgress(c, current, owner, response) });
    }
    if (!(await piped)) {
      await response.body?.cancel();
      fail(400, '上传内容与分片大小不一致');
    }
    return c.json({ data: await saveProgress(c, current, owner, response) });
  });
}
export async function cancelDriveUpload(c: AppContext) {
  const row = await getUpload(c);
  return locked(c, row, async (owner) => {
    const current = await getUpload(c);
    if (current.result_json)
      return c.json({
        data: {
          cancelled: false,
          complete: true,
          file: JSON.parse(current.result_json) as GoogleDriveFile,
        },
      });
    const response = await uploadFetch(
      c.env,
      uploadSessionUrl(await unseal(c.env, row.session_cipher, 'upload:' + row.id)),
      {
        method: 'PUT',
        headers: {
          'Content-Range': 'bytes */' + row.size,
          'Content-Length': '0',
        },
        body: '',
      },
      row.connection_id,
    );
    const checked = await saveProgress(c, current, owner, response);
    if (checked.complete)
      return c.json({ data: { cancelled: false, complete: true, file: checked.file } });
    // Never remove a completed remote file. Unfinished Google sessions expire naturally.
    await c.env.DB.prepare('DELETE FROM google_drive_uploads WHERE id=? AND connection_id=?')
      .bind(row.id, row.connection_id)
      .run();
    return c.json({ data: { cancelled: true } });
  });
}
export async function cleanupGoogleDrive(env: Env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM google_drive_oauth WHERE expires_at<=?').bind(now()),
    env.DB.prepare('DELETE FROM google_drive_uploads WHERE expires_at<=? AND lock_until<=?').bind(
      now(),
      now(),
    ),
  ]);
}
