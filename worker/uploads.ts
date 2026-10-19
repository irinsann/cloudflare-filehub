import { checkWriteLease } from './write-lease';
import { deleteObject } from './quota';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AppContext } from './env';
import { requireUploadOwner, uploadOwnerStatements, uploadMetadata } from './upload-access';
import { now, uuid } from './env';
import { filename, identifier } from '../shared/validation';
import { fail } from './errors';
import { activeFolder, getFile, logStatement } from './files';
import { reserve, releaseStatement, mimeFor, isText, sniff } from './storage';
export const PART_SIZE = 16 * 1024 * 1024;

interface Session {
  id: string;
  file_id: string;
  upload_id: string;
  object_key: string;
  size: number;
  expires_at: number;
}
function missingMultipart(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return (
    code === 10024 ||
    code === '10024' ||
    code === 'NoSuchUpload' ||
    (error instanceof Error && /\(10024\)$/.test(error.message))
  );
}
async function recoverCompletedObject(c: AppContext, s: Session) {
  // Workers multipart part ETags are opaque tokens, not content hashes. The metadata set
  // when creating this exact multipart upload proves which session produced the object.
  const object = await c.env.BUCKET.head(s.object_key);
  if (!object) fail(410, '上传对象不存在，请重新上传');
  if (
    object.key !== s.object_key ||
    object.size !== s.size ||
    object.customMetadata?.rcloud_upload !== s.id ||
    object.customMetadata?.rcloud_file !== s.file_id ||
    object.customMetadata?.rcloud_size !== String(s.size)
  )
    fail(409, '无法确认上传对象所属任务，请取消任务后重新上传');
  return object;
}
async function session(c: AppContext, id: string) {
  identifier.parse(id);
  const row = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?')
    .bind(id)
    .first<Session>();
  if (row && c.get('apiTokenId')) await requireUploadOwner(c, row.file_id);
  if (!row || row.expires_at <= now()) fail(410, '上传任务已过期，请重新上传');
  return row;
}
export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.post('/uploads', async (c) => {
  const input = z
    .object({
      name: filename,
      size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      folder_id: identifier.nullable().default(null),
    })
    .parse(await c.req.json().catch(() => fail(400, 'JSON 格式无效')));
  await activeFolder(c.env, input.folder_id);
  const id = uuid(),
    fileId = uuid(),
    key = await reserve(c.env, input.size);
  const mpu = await c.env.BUCKET.createMultipartUpload(key, {
    customMetadata: {
      rcloud_upload: id,
      rcloud_file: fileId,
      rcloud_size: String(input.size),
    },
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO files(id,name,object_key,folder_id,mime,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).bind(fileId, input.name, key, input.folder_id, mimeFor(input.name), now(), now()),
      c.env.DB.prepare(
        'INSERT INTO upload_sessions(id,file_id,upload_id,object_key,size,expires_at) VALUES(?,?,?,?,?,?)',
      ).bind(id, fileId, mpu.uploadId, key, input.size, now() + 86400000),
      ...uploadOwnerStatements(c, fileId),
    ]);
  } catch (e) {
    await mpu.abort();
    throw e;
  }
  return c.json({ data: { id, fileId, partSize: PART_SIZE } }, 201);
});
uploadRoutes.get('/uploads/:id', async (c) => {
  const s = await session(c, c.req.param('id'));
  const parts = await c.env.DB.prepare(
    'SELECT part_number AS partNumber,size FROM upload_parts WHERE session_id=? ORDER BY part_number',
  )
    .bind(s.id)
    .all();
  return c.json({
    data: {
      id: s.id,
      fileId: s.file_id,
      size: s.size,
      partSize: PART_SIZE,
      expires_at: s.expires_at,
      parts: parts.results,
    },
  });
});
uploadRoutes.put('/uploads/:id/parts/:part', async (c) => {
  const s = await session(c, c.req.param('id'));
  const part = Number(c.req.param('part'));
  const count = Math.ceil(s.size / PART_SIZE);
  if (!Number.isInteger(part) || part < 1 || part > count) fail(400, '分片编号无效');
  const expected = Math.min(PART_SIZE, s.size - (part - 1) * PART_SIZE);
  if (Number(c.req.header('X-File-Size')) !== expected || !c.req.raw.body)
    fail(400, '分片大小无效');
  const fixed = new FixedLengthStream(expected);
  const pump = c.req.raw.body.pipeTo(fixed.writable);
  let uploaded: R2UploadedPart;
  try {
    [uploaded] = await Promise.all([
      c.env.BUCKET.resumeMultipartUpload(s.object_key, s.upload_id).uploadPart(
        part,
        fixed.readable,
      ),
      pump,
    ]);
  } catch {
    fail(400, '分片上传中断或实际大小不匹配');
  }
  await checkWriteLease(c);
  await c.env.DB.prepare(
    'INSERT INTO upload_parts(session_id,part_number,etag,size) VALUES(?,?,?,?) ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size',
  )
    .bind(s.id, part, uploaded.etag, expected)
    .run();
  return c.json({ data: { partNumber: part } });
});
uploadRoutes.post('/uploads/:id/complete', async (c) => {
  const s = await session(c, c.req.param('id'));
  const file = await c.env.DB.prepare('SELECT name,folder_id FROM files WHERE id=?')
    .bind(s.file_id)
    .first<{ name: string; folder_id: string | null }>();
  if (!file) fail(410, '上传文件已移除');
  await activeFolder(c.env, file.folder_id);
  const parts = await c.env.DB.prepare(
    'SELECT part_number,etag,size FROM upload_parts WHERE session_id=? ORDER BY part_number',
  )
    .bind(s.id)
    .all<{ part_number: number; etag: string; size: number }>();
  if (
    parts.results.length !== Math.ceil(s.size / PART_SIZE) ||
    parts.results.some(
      (p, i) => p.part_number !== i + 1 || p.size !== Math.min(PART_SIZE, s.size - i * PART_SIZE),
    )
  )
    fail(409, '分片未上传完整');
  let object: R2Object;
  try {
    object = await c.env.BUCKET.resumeMultipartUpload(s.object_key, s.upload_id).complete(
      parts.results.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
  } catch (error) {
    if (!missingMultipart(error)) throw error;
    object = await recoverCompletedObject(c, s);
  }
  if (object.size !== s.size) fail(400, '文件大小校验失败');
  let mime = mimeFor(file.name);
  if (!isText(mime) && mime !== 'application/octet-stream') {
    const head = await c.env.BUCKET.get(s.object_key, {
      range: { offset: 0, length: Math.min(s.size, 32) },
    });
    if (!head || sniff(new Uint8Array(await head.arrayBuffer())) !== mime)
      mime = 'application/octet-stream';
  }
  await checkWriteLease(c);
  const completedAt = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE files SET size=?,mime=?,etag=?,status='ready',updated_at=?
      WHERE id=? AND object_key=? AND status='pending' AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM upload_sessions WHERE id=? AND file_id=files.id
        AND upload_id=? AND object_key=files.object_key AND size=? AND expires_at=? AND expires_at>?)`,
    ).bind(
      object.size,
      mime,
      object.etag,
      completedAt,
      s.file_id,
      s.object_key,
      s.id,
      s.upload_id,
      s.size,
      s.expires_at,
      completedAt,
    ),
    c.env.DB.prepare(
      `DELETE FROM upload_sessions WHERE id=? AND file_id=? AND upload_id=?
      AND object_key=? AND size=? AND expires_at=? AND expires_at>?
      AND EXISTS(SELECT 1 FROM files WHERE id=upload_sessions.file_id
        AND object_key=upload_sessions.object_key AND status='ready')`,
    ).bind(s.id, s.file_id, s.upload_id, s.object_key, s.size, s.expires_at, completedAt),
    // Cancellation may already have removed the pending row. In that case the completed
    // R2 object still needs its cleanup task, especially when cancellation's delete failed.
    c.env.DB.prepare(
      "DELETE FROM cleanup_tasks WHERE object_key=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND object_key=? AND status='ready')",
    ).bind(s.object_key, s.file_id, s.object_key),
    logStatement(c.env, 'file.upload', s.file_id),
  ]);
  const completed = await getFile(c.env, s.file_id);
  if (
    completed.object_key !== s.object_key ||
    completed.size !== object.size ||
    completed.etag !== object.etag
  )
    fail(409, '上传文件状态已改变，请刷新后重试');
  return c.json({ data: uploadMetadata(c, completed) }, 201);
});
uploadRoutes.delete('/uploads/:id', async (c) => {
  const s = await session(c, c.req.param('id'));
  try {
    await c.env.BUCKET.resumeMultipartUpload(s.object_key, s.upload_id).abort();
  } catch (error) {
    // A transient failure is not proof that the multipart parts were removed.
    // Keep the upload ID and capacity reservation so cancellation or cleanup can retry.
    if (!missingMultipart(error)) fail(502, '存储服务暂时无法取消上传，请重试');
  }
  await checkWriteLease(c);
  const removed = await c.env.DB.prepare(
    "DELETE FROM files WHERE id=? AND status='pending' RETURNING id",
  )
    .bind(s.file_id)
    .first();
  if (removed) {
    await deleteObject(c.env, s.object_key);
    await releaseStatement(c.env, s.object_key).run();
  }
  return c.json({ data: { id: s.id } });
});
