import { deleteObject } from './quota';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
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
async function session(env: Env, id: string) {
  identifier.parse(id);
  const row = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?')
    .bind(id)
    .first<Session>();
  if (!row || row.expires_at <= now()) fail(410, '上传任务已过期，请重新上传');
  return row;
}
export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.post('/uploads', async (c) => {
  const input = z
    .object({
      name: filename,
      size: z.number().int().min(1),
      folder_id: identifier.nullable().default(null),
    })
    .parse(await c.req.json());
  await activeFolder(c.env, input.folder_id);
  const id = uuid(),
    fileId = uuid(),
    key = await reserve(c.env, input.size);
  const mpu = await c.env.BUCKET.createMultipartUpload(key);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO files(id,name,object_key,folder_id,mime,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).bind(fileId, input.name, key, input.folder_id, mimeFor(input.name), now(), now()),
      c.env.DB.prepare(
        'INSERT INTO upload_sessions(id,file_id,upload_id,object_key,size,expires_at) VALUES(?,?,?,?,?,?)',
      ).bind(id, fileId, mpu.uploadId, key, input.size, now() + 86400000),
    ]);
  } catch (e) {
    await mpu.abort();
    throw e;
  }
  return c.json({ data: { id, fileId, partSize: PART_SIZE } }, 201);
});
uploadRoutes.put('/uploads/:id/parts/:part', async (c) => {
  const s = await session(c.env, c.req.param('id'));
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
  await c.env.DB.prepare(
    'INSERT INTO upload_parts(session_id,part_number,etag,size) VALUES(?,?,?,?) ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size',
  )
    .bind(s.id, part, uploaded.etag, expected)
    .run();
  return c.json({ data: { partNumber: part } });
});
uploadRoutes.post('/uploads/:id/complete', async (c) => {
  const s = await session(c.env, c.req.param('id'));
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
  const object = await c.env.BUCKET.resumeMultipartUpload(s.object_key, s.upload_id).complete(
    parts.results.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
  );
  if (object.size !== s.size) fail(400, '文件大小校验失败');
  let mime = mimeFor(file.name);
  if (!isText(mime) && mime !== 'application/octet-stream') {
    const head = await c.env.BUCKET.get(s.object_key, {
      range: { offset: 0, length: Math.min(s.size, 32) },
    });
    if (!head || sniff(new Uint8Array(await head.arrayBuffer())) !== mime)
      mime = 'application/octet-stream';
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE files SET size=?,mime=?,etag=?,status='ready',updated_at=? WHERE id=? AND status='pending'",
    ).bind(object.size, mime, object.etag, now(), s.file_id),
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE id=?').bind(s.id),
    releaseStatement(c.env, s.object_key),
    logStatement(c.env, 'file.upload', s.file_id),
  ]);
  return c.json({ data: await getFile(c.env, s.file_id) }, 201);
});
uploadRoutes.delete('/uploads/:id', async (c) => {
  const s = await session(c.env, c.req.param('id'));
  try {
    await c.env.BUCKET.resumeMultipartUpload(s.object_key, s.upload_id).abort();
  } catch {
    /* An already completed upload remains queued for cleanup. */
  }
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
