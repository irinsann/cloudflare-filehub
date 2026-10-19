import { checkWriteLease } from './write-lease';
import { allocate } from './quota';
import { Hono } from 'hono';
import type { AppEnv, AppContext, Env } from './env';
import { now, uuid } from './env';
import { identifier } from '../shared/validation';
import { fail } from './errors';
import { getFile, activeFolder, logStatement, purgeFiles } from './files';
import {
  serveObject,
  sniff,
  releaseStatement,
  cleanupStatement,
  cleanupPurgedObjects,
} from './storage';
import { recordImageAccess } from './image-stats';
import { z } from 'zod';
import type { FileRecord } from '../shared/types';
const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
export async function imageFolder(env: Env) {
  const id = uuid();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO folders(id,name,parent_id,created_at,updated_at) VALUES(?,'Image-hosting',NULL,?,?)",
  )
    .bind(id, now(), now())
    .run();
  const row = await env.DB.prepare(
    "SELECT id FROM folders WHERE name='Image-hosting' AND parent_id IS NULL AND deleted_at IS NULL",
  ).first<{ id: string }>();
  if (!row) fail(409, 'Image-hosting 目录不可用');
  return row.id;
}
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
interface HostedImage {
  name: string;
  file_id: string;
  object_key: string;
  sha256: string;
  enabled: number;
}
const imageUrl = (c: AppContext, name: string) =>
  (c.env.FILES_ORIGIN || c.env.ADMIN_ORIGIN || new URL(c.req.url).origin) + '/i/' + name;
async function imageRecord(c: AppContext) {
  const name = c.req.param('name') ?? '';
  if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) fail(404, '图片不存在');
  const row = await c.env.DB.prepare('SELECT * FROM image_hosts WHERE name=?')
    .bind(name)
    .first<HostedImage>();
  if (!row) fail(404, '图片不存在');
  return row;
}
async function enableImage(c: AppContext, image: HostedImage, file: FileRecord) {
  const result = await c.env.DB.prepare(
    `UPDATE image_hosts SET enabled=1
    WHERE name=? AND file_id=? AND object_key=? AND enabled=?
    AND EXISTS(SELECT 1 FROM files f WHERE f.id=image_hosts.file_id
      AND f.object_key=image_hosts.object_key AND f.status='ready' AND f.deleted_at IS NULL
      AND f.folder_id IS ?)
    AND NOT EXISTS(WITH RECURSIVE chain(id,parent_id,deleted_at) AS (
      SELECT id,parent_id,deleted_at FROM folders WHERE id=?
      UNION SELECT f.id,f.parent_id,f.deleted_at FROM folders f JOIN chain c ON f.id=c.parent_id
    ) SELECT 1 FROM chain WHERE deleted_at IS NOT NULL)`,
  )
    .bind(
      image.name,
      image.file_id,
      image.object_key,
      image.enabled,
      file.folder_id,
      file.folder_id,
    )
    .run();
  if (!result.meta.changes) fail(409, '图片状态已改变，请刷新后重试');
}
async function reuseImage(c: AppContext, image: HostedImage, sourceId: string) {
  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id=? AND deleted_at IS NULL AND status='ready'",
  )
    .bind(image.file_id)
    .first<FileRecord>();
  if (!file || file.object_key !== image.object_key || !(await c.env.BUCKET.head(image.object_key)))
    return null;
  await activeFolder(c.env, file.folder_id);
  await enableImage(c, image, file);
  return {
    name: image.name,
    file_id: file.id,
    url: imageUrl(c, image.name),
    duplicate: file.id !== sourceId,
  };
}
export const imageRoutes = new Hono<AppEnv>();
imageRoutes.post('/images/folder', async (c) => c.json({ data: { id: await imageFolder(c.env) } }));
imageRoutes.get('/images', async (c) => {
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page'))) || 1));
  const rows = await c.env.DB.prepare(
    "SELECT i.name,i.file_id,i.enabled,i.created_at,i.views,i.downloads,i.last_access_at,f.size,f.mime FROM image_hosts i JOIN files f ON f.id=i.file_id WHERE f.deleted_at IS NULL AND f.status='ready' ORDER BY i.created_at DESC,i.name ASC LIMIT 40 OFFSET ?",
  )
    .bind((page - 1) * 40)
    .all();
  return c.json({
    data: rows.results.map((r) => ({
      ...r,
      url: imageUrl(c, String(r.name)),
    })),
    page,
  });
});
imageRoutes.post('/images', async (c) => {
  const input = z.object({ file_id: identifier }).parse(await c.req.json());
  const result = await publishImage(c, input.file_id);
  return c.json({ data: result }, result.duplicate ? 200 : 201);
});
export async function publishImage(c: AppContext, fileId: string) {
  const file = await getFile(c.env, fileId);
  if (!file.size) fail(415, '图片为空');
  const head = await c.env.BUCKET.get(file.object_key, {
    range: { offset: 0, length: Math.min(32, file.size) },
  });
  const mime = head ? sniff(new Uint8Array(await head.arrayBuffer())) : null;
  if (!mime || !extensions[mime]) fail(415, '仅支持 PNG、JPEG、GIF 和 WebP 图片');
  const object = await c.env.BUCKET.get(file.object_key);
  if (!object) fail(404, '图片不存在');
  const Digest = (
    crypto as unknown as {
      DigestStream: new (
        algorithm: string,
      ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
    }
  ).DigestStream;
  const md5 = new Digest('MD5'),
    sha = new Digest('SHA-256');
  const a = md5.getWriter(),
    b = sha.getWriter();
  await object.body.pipeTo(
    new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await Promise.all([a.write(chunk), b.write(chunk)]);
      },
      close: async () => {
        await Promise.all([a.close(), b.close()]);
      },
      abort: async (reason) => {
        await Promise.all([a.abort(reason), b.abort(reason)]);
      },
    }),
  );
  const name = hex(await md5.digest) + '.' + extensions[mime],
    sha256 = hex(await sha.digest);
  await checkWriteLease(c);
  const existing = await c.env.DB.prepare('SELECT * FROM image_hosts WHERE name=?')
    .bind(name)
    .first<HostedImage>();
  if (existing && existing.sha256 !== sha256) fail(409, 'MD5 命名冲突，图片未覆盖');
  if (existing) {
    const reused = await reuseImage(c, existing, file.id);
    if (reused) return reused;
  }
  const folderId = await imageFolder(c.env),
    key = 'Image-hosting/' + uuid() + '/' + name;
  await cleanupStatement(c.env, key).run();
  const source = await c.env.BUCKET.get(file.object_key);
  if (!source || source.etag !== object.etag) fail(409, '图片已修改，请重新上传');
  await allocate(c.env, key, source.size);
  const copy = await c.env.BUCKET.put(key, source.body);
  if (!copy) fail(500, '图片保存失败');
  await checkWriteLease(c);
  // Another concurrent upload may have published the same content while this copy streamed.
  // Only replace the image record observed above; otherwise reuse the committed winner.
  const imageState = existing
    ? 'EXISTS(SELECT 1 FROM image_hosts WHERE name=? AND file_id=? AND object_key=?)'
    : 'NOT EXISTS(SELECT 1 FROM image_hosts WHERE name=?)';
  const imageStateArgs = existing ? [name, existing.file_id, existing.object_key] : [name];
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE files SET name=?,folder_id=?,object_key=?,mime=?,updated_at=?
      WHERE id=? AND object_key=? AND deleted_at IS NULL AND status='ready' AND ${imageState}`,
    ).bind(name, folderId, key, mime, now(), file.id, file.object_key, ...imageStateArgs),
    c.env.DB.prepare(
      'INSERT INTO image_hosts(name,file_id,object_key,sha256,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM files WHERE id=? AND object_key=?) ON CONFLICT(name) DO UPDATE SET file_id=excluded.file_id,object_key=excluded.object_key,sha256=excluded.sha256,enabled=1,created_at=excluded.created_at WHERE image_hosts.sha256=excluded.sha256',
    ).bind(name, file.id, key, sha256, now(), file.id, key),
    cleanupStatement(c.env, file.object_key),
    logStatement(c.env, 'image.publish', file.id),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) {
    const winner = await c.env.DB.prepare('SELECT * FROM image_hosts WHERE name=?')
      .bind(name)
      .first<HostedImage>();
    const reused = winner?.sha256 === sha256 ? await reuseImage(c, winner, file.id) : null;
    if (!reused) fail(409, '图片状态已改变，请重试');
    await cleanupPurgedObjects(c.env, [key]);
    return reused;
  }
  await releaseStatement(c.env, key).run();
  return {
    name,
    file_id: file.id,
    url: imageUrl(c, name),
    duplicate: false,
  };
}
imageRoutes.delete('/images/:name', async (c) => {
  await c.env.DB.prepare('UPDATE image_hosts SET enabled=0 WHERE name=?')
    .bind(c.req.param('name'))
    .run();
  return c.json({ data: { ok: true } });
});
imageRoutes.post('/images/:name/restore', async (c) => {
  const image = await imageRecord(c);
  const file = await getFile(c.env, image.file_id);
  if (file.object_key !== image.object_key) fail(409, '图片已修改，无法恢复原直链');
  if (!(await c.env.BUCKET.head(image.object_key))) fail(404, '图片对象不存在，无法恢复');
  await enableImage(c, image, file);
  await logStatement(c.env, 'image.restore', file.id).run();
  return c.json({
    data: { name: image.name, file_id: file.id, url: imageUrl(c, image.name), enabled: 1 },
  });
});
imageRoutes.delete('/images/:name/permanent', async (c) => {
  const image = await imageRecord(c);
  if (image.enabled) fail(409, '请先撤销图片直链');
  const file = await c.env.DB.prepare('SELECT object_key FROM files WHERE id=?')
    .bind(image.file_id)
    .first<{ object_key: string }>();
  if (!file) fail(404, '图片文件不存在');
  const result = await purgeFiles(
    c.env,
    {
      where: `f.id=? AND f.object_key=? AND f.status='ready'
      AND EXISTS(SELECT 1 FROM image_hosts i WHERE i.name=? AND i.file_id=f.id AND i.object_key=? AND i.enabled=0)`,
      values: [image.file_id, file.object_key, image.name, image.object_key],
    },
    'image.purge',
    image.file_id,
  );
  if (!result.files.length) fail(409, '图片状态已改变，请刷新后重试');
  return c.json({ data: { name: image.name, file_id: image.file_id, deleted: true } });
});
imageRoutes.on(['GET', 'HEAD'], '/images/:name/download', async (c) => {
  const image = await imageRecord(c);
  const file = await getFile(c.env, image.file_id);
  if (file.object_key !== image.object_key) fail(410, '图片已修改，原直链失效');
  const response = await serveObject(
    c.env,
    c.req.raw,
    image.object_key,
    image.name,
    file.mime,
    false,
  );
  await recordImageAccess(c.env, image.name, 'download', c.req.raw, response, image.object_key);
  return response;
});
export async function imagePage(c: AppContext) {
  const name = c.req.param('name');
  if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name || '')) fail(404, '图片不存在');
  const row = await c.env.DB.prepare(
    'SELECT file_id,object_key,enabled FROM image_hosts WHERE name=?',
  )
    .bind(name)
    .first<{ file_id: string; object_key: string; enabled: number }>();
  if (!row || !row.enabled) fail(404, '图片不存在或直链已撤销');
  const file = await getFile(c.env, row.file_id);
  if (file.object_key !== row.object_key) fail(410, '图片已修改，原直链失效');
  const download = c.req.query('download') === '1';
  const response = await serveObject(c.env, c.req.raw, row.object_key, name!, file.mime, !download);
  await recordImageAccess(
    c.env,
    name!,
    download ? 'download' : 'reference',
    c.req.raw,
    response,
    row.object_key,
  );
  return response;
}
