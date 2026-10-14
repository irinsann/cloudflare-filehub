import Busboy from '@fastify/busboy';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { imageFolder, publishImage } from './images';
import { reserve, releaseStatement, sniff } from './storage';
import { deleteObject } from './quota';
import { PART_SIZE } from './uploads';

export async function uploadImage(c: AppContext) {
  const type = c.req.header('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(type)) fail(415, '请使用 multipart/form-data 上传图片');
  const declared = Number(c.req.header('Content-Length'));
  if (!Number.isSafeInteger(declared) || declared <= 0) fail(411, '请提供 Content-Length');
  if (!c.req.raw.body) fail(400, '上传内容为空');
  let parser: InstanceType<typeof Busboy>;
  try {
    parser = new Busboy({
      headers: { 'content-type': type },
      fileHwm: 64 * 1024,
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        headerSize: 8192,
        headerPairs: 20,
        fileSize: declared,
      },
    });
  } catch {
    fail(400, '表单 boundary 无效');
  }
  const folderId = await imageFolder(c.env);
  // Reserve the envelope size as an upper bound, then shrink to actual file bytes.
  const key = await reserve(c.env, declared),
    fileId = uuid();
  let mpu: R2MultipartUpload | undefined;
  let fileWork: Promise<void> | undefined;
  let activeFile: Readable | undefined;
  let size = 0;
  let received = 0;
  let completed = false;
  const parts: R2UploadedPart[] = [];
  const discard = async () => {
    await c.env.DB.prepare(
      'DELETE FROM files WHERE id=? AND NOT EXISTS(SELECT 1 FROM image_hosts WHERE file_id=?)',
    )
      .bind(fileId, fileId)
      .run();
    await deleteObject(c.env, key);
    await releaseStatement(c.env, key).run();
  };
  try {
    mpu = await c.env.BUCKET.createMultipartUpload(key);
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO files(id,name,object_key,folder_id,mime,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        fileId,
        `upload-${fileId}.bin`,
        key,
        folderId,
        'application/octet-stream',
        now(),
        now(),
      ),
      c.env.DB.prepare(
        'INSERT INTO upload_sessions(id,file_id,upload_id,object_key,size,expires_at) VALUES(?,?,?,?,?,?)',
      ).bind(uuid(), fileId, mpu.uploadId, key, declared, now() + 86400000),
    ]);
    const rejectForm = () =>
      parser.destroy(new HTTPException(400, { message: '表单只允许一个名为 file 的图片文件' }));
    parser.on('filesLimit', rejectForm).on('fieldsLimit', rejectForm).on('partsLimit', rejectForm);
    parser.on('file', (name, file, filename) => {
      activeFile = file;
      if (name !== 'file' || !filename || fileWork) {
        file.resume();
        rejectForm();
        return;
      }
      file.on('limit', () =>
        parser.destroy(new HTTPException(400, { message: '文件超过声明的请求长度' })),
      );
      fileWork = (async () => {
        let buffer = new Uint8Array(PART_SIZE),
          used = 0;
        for await (const chunk of file) {
          const bytes = chunk as Uint8Array;
          for (let offset = 0; offset < bytes.length; ) {
            const count = Math.min(PART_SIZE - used, bytes.length - offset);
            buffer.set(bytes.subarray(offset, offset + count), used);
            used += count;
            offset += count;
            size += count;
            if (used === PART_SIZE) {
              parts.push(await mpu!.uploadPart(parts.length + 1, buffer));
              buffer = new Uint8Array(PART_SIZE);
              used = 0;
            }
          }
        }
        if (used) parts.push(await mpu!.uploadPart(parts.length + 1, buffer.subarray(0, used)));
        if (!size) fail(415, '图片为空');
      })();
      void fileWork.catch((error) =>
        parser.destroy(error instanceof Error ? error : new Error('图片接收失败')),
      );
    });
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > declared) callback(new HTTPException(400, { message: '请求长度不匹配' }));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream<Uint8Array>),
        counter,
        parser,
      );
      if (!fileWork) fail(400, '缺少 file 图片字段');
      await fileWork;
      if (received !== declared) fail(400, '请求长度不匹配');
    } catch (error) {
      activeFile?.destroy(error instanceof Error ? error : new Error('图片接收失败'));
      if (fileWork) await fileWork.catch(() => {});
      if (error instanceof HTTPException) throw error;
      fail(400, '图片表单不完整或上传中断');
    }
    const object = await mpu.complete(parts);
    completed = true;
    const head = await c.env.BUCKET.get(key, { range: { offset: 0, length: Math.min(32, size) } });
    const mime = head ? sniff(new Uint8Array(await head.arrayBuffer())) : null;
    if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
      fail(415, '仅支持 PNG、JPEG、GIF 和 WebP 图片');
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE files SET size=?,mime=?,etag=?,status='ready' WHERE id=?").bind(
        object.size,
        mime,
        object.etag,
        fileId,
      ),
      c.env.DB.prepare('UPDATE storage_allocations SET size=? WHERE object_key=?').bind(
        object.size,
        key,
      ),
      c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id=?').bind(fileId),
    ]);
    const result = await publishImage(c, fileId);
    // Same duplicate-source cleanup as the web image uploader, without exposing a delete API.
    try {
      await discard();
    } catch {
      /* Durable cleanup tasks retry object deletion. */
    }
    return c.json({ data: result }, result.duplicate ? 200 : 201);
  } catch (error) {
    if (mpu && !completed) {
      try {
        await mpu.abort();
      } catch {
        throw error;
      } // Keep session/reservation for scheduled cleanup.
    }
    try {
      await discard();
    } catch {
      /* Keep durable cleanup tasks for retry. */
    }
    throw error;
  }
}
