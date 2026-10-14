import { allocate } from './quota';
import { Hono } from 'hono';
import type { AppEnv, AppContext, Env } from './env';
import { now, uuid } from './env';
import { identifier } from '../shared/validation';
import { fail } from './errors';
import { getFile, activeFolder, logStatement } from './files';
import { serveObject, sniff, releaseStatement, cleanupStatement } from './storage';
import { z } from 'zod';
const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
async function folder(env: Env) {
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
export const imageRoutes = new Hono<AppEnv>();
imageRoutes.post('/images/folder', async (c) => c.json({ data: { id: await folder(c.env) } }));
imageRoutes.get('/images', async (c) => {
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page'))) || 1));
  const rows = await c.env.DB.prepare(
    "SELECT i.name,i.file_id,i.enabled,i.created_at,f.size,f.mime FROM image_hosts i JOIN files f ON f.id=i.file_id WHERE f.deleted_at IS NULL AND f.status='ready' ORDER BY i.created_at DESC LIMIT 40 OFFSET ?",
  )
    .bind((page - 1) * 40)
    .all();
  return c.json({
    data: rows.results.map((r) => ({
      ...r,
      url: (c.env.FILES_ORIGIN || c.env.ADMIN_ORIGIN || new URL(c.req.url).origin) + '/i/' + r.name,
    })),
    page,
  });
});
imageRoutes.post('/images', async (c) => {
  const input = z.object({ file_id: identifier }).parse(await c.req.json());
  const file = await getFile(c.env, input.file_id);
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
  const existing = await c.env.DB.prepare('SELECT * FROM image_hosts WHERE name=?')
    .bind(name)
    .first<{ name: string; file_id: string; sha256: string; enabled: number }>();
  if (existing && existing.sha256 !== sha256) fail(409, 'MD5 命名冲突，图片未覆盖');
  if (existing) {
    const old = await c.env.DB.prepare(
      "SELECT id,folder_id FROM files WHERE id=? AND deleted_at IS NULL AND status='ready'",
    )
      .bind(existing.file_id)
      .first<{ id: string; folder_id: string | null }>();
    if (old) {
      await activeFolder(c.env, old.folder_id);
      if (!existing.enabled)
        await c.env.DB.prepare('UPDATE image_hosts SET enabled=1 WHERE name=?').bind(name).run();
      return c.json({
        data: {
          name,
          file_id: old.id,
          url:
            (c.env.FILES_ORIGIN || c.env.ADMIN_ORIGIN || new URL(c.req.url).origin) + '/i/' + name,
          duplicate: old.id !== file.id,
        },
      });
    }
  }
  const folderId = await folder(c.env),
    key = 'Image-hosting/' + uuid() + '/' + name;
  await cleanupStatement(c.env, key).run();
  const source = await c.env.BUCKET.get(file.object_key);
  if (!source || source.etag !== object.etag) fail(409, '图片已修改，请重新上传');
  await allocate(c.env, key, source.size);
  const copy = await c.env.BUCKET.put(key, source.body);
  if (!copy) fail(500, '图片保存失败');
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE files SET name=?,folder_id=?,object_key=?,mime=?,updated_at=? WHERE id=? AND object_key=? AND deleted_at IS NULL',
    ).bind(name, folderId, key, mime, now(), file.id, file.object_key),
    c.env.DB.prepare(
      'INSERT INTO image_hosts(name,file_id,object_key,sha256,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM files WHERE id=? AND object_key=?) ON CONFLICT(name) DO UPDATE SET file_id=excluded.file_id,object_key=excluded.object_key,sha256=excluded.sha256,enabled=1,created_at=excluded.created_at WHERE image_hosts.sha256=excluded.sha256',
    ).bind(name, file.id, key, sha256, now(), file.id, key),
    cleanupStatement(c.env, file.object_key),
    logStatement(c.env, 'image.publish', file.id),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) fail(409, '图片状态已改变，请重试');
  await releaseStatement(c.env, key).run();
  return c.json(
    {
      data: {
        name,
        file_id: file.id,
        url: (c.env.FILES_ORIGIN || c.env.ADMIN_ORIGIN || new URL(c.req.url).origin) + '/i/' + name,
        duplicate: false,
      },
    },
    201,
  );
});
imageRoutes.delete('/images/:name', async (c) => {
  await c.env.DB.prepare('UPDATE image_hosts SET enabled=0 WHERE name=?')
    .bind(c.req.param('name'))
    .run();
  return c.json({ data: { ok: true } });
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
  return serveObject(c.env, c.req.raw, row.object_key, name!, file.mime, true);
}
