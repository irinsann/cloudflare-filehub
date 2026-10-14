import { storageUsage } from './quota';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, isNull } from 'drizzle-orm';
import { files as fileTable } from '../db/schema';
import type { AppEnv, AppContext, Env } from './env';
import { uploadOwnerStatements, uploadMetadata } from './upload-access';
import { now, uuid, limit } from './env';
import { fail } from './errors';
import type { FileRecord, FolderRecord } from '../shared/types';
import { filename, filePatch, folderInput, folderPatch, identifier } from '../shared/validation';
import {
  cleanupStatement,
  cleanupPurgedObjects,
  releaseStatement,
  reserve,
  serveObject,
  textObject,
  uploadStream,
  isText,
} from './storage';
export const logStatement = (env: Env, action: string, target: string) =>
  env.DB.prepare('INSERT INTO operations(id,action,target_id,created_at) VALUES(?,?,?,?)').bind(
    uuid(),
    action,
    target,
    now(),
  );
export async function activeFolder(env: Env, id: string | null) {
  if (!id) return;
  identifier.parse(id);
  const row = await env.DB.prepare(
    'WITH RECURSIVE chain(id,parent_id,deleted_at) AS (SELECT id,parent_id,deleted_at FROM folders WHERE id=? UNION SELECT f.id,f.parent_id,f.deleted_at FROM folders f JOIN chain c ON f.id=c.parent_id) SELECT COUNT(*) AS total, SUM(deleted_at IS NOT NULL) AS deleted FROM chain',
  )
    .bind(id)
    .first<{ total: number; deleted: number }>();
  if (!row?.total || row.deleted) fail(404, '文件夹不存在或已删除');
}
export async function getFile(env: Env, id: string, deleted = false) {
  identifier.parse(id);
  const file = await env.DB.prepare("SELECT * FROM files WHERE id=? AND status='ready'")
    .bind(id)
    .first<FileRecord>();
  if (!file || (!deleted && file.deleted_at)) fail(404, '文件不存在');
  if (!deleted) await activeFolder(env, file.folder_id);
  return file;
}
export const fileRoutes = new Hono<AppEnv>();
fileRoutes.get('/settings', async (c) =>
  c.json({
    data: {
      maxUploadBytes: null,
      ...(await storageUsage(c.env)),
      maxTextBytes: limit(c.env.MAX_TEXT_BYTES, 1048576),
      environment: c.env.ENVIRONMENT,
      authMode: c.env.AUTH_MODE || 'access',
      email: c.get('email'),
      filesOrigin: c.env.FILES_ORIGIN,
      markdownOrigin: c.env.MARKDOWN_ORIGIN,
    },
  }),
);
fileRoutes.get('/files', async (c) => {
  const query = c.req.query(),
    page = Math.max(1, Math.min(100000, Number(query.page) || 1)),
    pageSize = Math.max(1, Math.min(100, Number(query.limit) || 40));
  const folder = query.folder_id || null,
    view = query.view || 'files';
  if (folder && view !== 'trash') await activeFolder(c.env, folder);
  const conditions = [
    "status='ready'",
    view === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
  ];
  const args: (string | number | null)[] = [];
  if (view === 'files' && !query.search) {
    conditions.push('folder_id IS ?');
    args.push(folder);
  }
  if (view === 'markdown')
    conditions.push("(lower(name) LIKE '%.md' OR lower(name) LIKE '%.markdown')");
  if (query.search) {
    conditions.push("name LIKE ? ESCAPE '\\'");
    args.push(`%${query.search.slice(0, 180).replace(/[\\%_]/g, '\\$&')}%`);
  }
  const order: Record<string, string> = {
    name: 'name COLLATE NOCASE',
    size: 'size',
    updated_at: 'updated_at',
  };
  const sort = order[query.sort] ?? 'updated_at',
    direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  const where = conditions.join(' AND ');
  const [rows, total, folders] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM files WHERE ${where} ORDER BY ${sort} ${direction}, id LIMIT ? OFFSET ?`,
    )
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all<FileRecord>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM files WHERE ${where}`)
      .bind(...args)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      view === 'trash'
        ? 'SELECT * FROM folders WHERE deleted_at IS NOT NULL ORDER BY name LIMIT 100'
        : 'SELECT * FROM folders WHERE parent_id IS ? AND deleted_at IS NULL ORDER BY name LIMIT 100',
    )
      .bind(...(view === 'trash' ? [] : [folder]))
      .all<FolderRecord>(),
  ]);
  return c.json({
    data: {
      files: rows.results,
      folders: view === 'files' || view === 'trash' ? folders.results : [],
      total: total?.count ?? 0,
      page,
      limit: pageSize,
    },
  });
});
fileRoutes.get('/folders', async (c) => {
  const parent = c.req.query('parent_id') || null;
  await activeFolder(c.env, parent);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM folders WHERE parent_id IS ? AND deleted_at IS NULL ORDER BY name LIMIT 100',
  )
    .bind(parent)
    .all<FolderRecord>();
  return c.json({ data: rows.results });
});
fileRoutes.get('/folders/:id', async (c) => {
  await activeFolder(c.env, c.req.param('id'));
  return c.json({
    data: await c.env.DB.prepare('SELECT * FROM folders WHERE id=?')
      .bind(c.req.param('id'))
      .first(),
  });
});
fileRoutes.post('/folders', async (c) => {
  const input = folderInput.parse(await c.req.json());
  await activeFolder(c.env, input.parent_id);
  const id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO folders(id,name,parent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).bind(id, input.name, input.parent_id, now(), now()),
    logStatement(c.env, 'folder.create', id),
  ]);
  return c.json({ data: { id, ...input } }, 201);
});
fileRoutes.patch('/folders/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  await activeFolder(c.env, id);
  const input = folderPatch.parse(await c.req.json());
  if (input.parent_id !== undefined) {
    await activeFolder(c.env, input.parent_id);
    if (input.parent_id) {
      const cycle = await c.env.DB.prepare(
        'WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id=? UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id) SELECT id FROM tree WHERE id=?',
      )
        .bind(id, input.parent_id)
        .first();
      if (cycle) fail(409, '不能移动到自身或子文件夹');
    }
  }
  const row = await c.env.DB.prepare('SELECT * FROM folders WHERE id=?')
    .bind(id)
    .first<FolderRecord>();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE folders SET name=?,parent_id=?,updated_at=? WHERE id=?').bind(
      input.name ?? row!.name,
      input.parent_id === undefined ? row!.parent_id : input.parent_id,
      now(),
      id,
    ),
    logStatement(c.env, 'folder.update', id),
  ]);
  return c.json({ data: { id } });
});
fileRoutes.delete('/folders/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  await activeFolder(c.env, id);
  const children = await c.env.DB.prepare(
    'SELECT id FROM folders WHERE parent_id=? UNION ALL SELECT id FROM files WHERE folder_id=? LIMIT 1',
  )
    .bind(id, id)
    .first();
  if (children) fail(409, '请先移出或永久删除文件夹中的内容（含回收站内容）');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE folders SET deleted_at=?,updated_at=? WHERE id=?').bind(
      now(),
      now(),
      id,
    ),
    logStatement(c.env, 'folder.trash', id),
  ]);
  return c.json({ data: { id } });
});
fileRoutes.post('/folders/:id/restore', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM folders WHERE id=? AND deleted_at IS NOT NULL')
    .bind(id)
    .first<FolderRecord>();
  if (!row) fail(404, '文件夹不存在');
  await activeFolder(c.env, row.parent_id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE folders SET deleted_at=NULL,updated_at=? WHERE id=?').bind(now(), id),
    logStatement(c.env, 'folder.restore', id),
  ]);
  return c.json({ data: { id } });
});
fileRoutes.delete('/folders/:id/permanent', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const result = await c.env.DB.prepare('DELETE FROM folders WHERE id=? AND deleted_at IS NOT NULL')
    .bind(id)
    .run();
  if (!result.meta.changes) fail(409, '必须先将文件夹移入回收站');
  return c.json({ data: { id } });
});
export async function uploadSingleFile(c: AppContext) {
  const rawSize = c.req.header('X-File-Size');
  const size = Number(rawSize);
  if (rawSize === undefined || !Number.isSafeInteger(size) || size < 0)
    fail(400, '必须提供有效文件大小');
  if (size > 32 * 1024 * 1024) fail(413, '请使用分片上传');
  const name = filename.parse(c.req.query('name')),
    folder = c.req.query('folder_id') || null;
  await activeFolder(c.env, folder);
  const id = uuid(),
    key = await reserve(c.env);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO files(id,name,object_key,folder_id,mime,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(id, name, key, folder, 'application/octet-stream', now(), now()),
    ...uploadOwnerStatements(c, id),
  ]);
  const object = await uploadStream(c.env, c.req.raw, key, name);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE files SET size=?,mime=?,etag=?,status='ready' WHERE id=?").bind(
      object.size,
      object.mime,
      object.etag,
      id,
    ),
    releaseStatement(c.env, key),
    logStatement(c.env, 'file.upload', id),
  ]);
  return c.json({ data: uploadMetadata(c, await getFile(c.env, id)) }, 201);
}
fileRoutes.post('/files/upload', uploadSingleFile);
fileRoutes.get('/files/:id', async (c) =>
  c.json({ data: await getFile(c.env, c.req.param('id')) }),
);
fileRoutes.get('/files/:id/content', async (c) => {
  const file = await getFile(c.env, c.req.param('id'));
  if (!isText(file.mime)) fail(415, '此文件不支持文本预览');
  return c.json({
    data: { content: await textObject(c.env, file.object_key), version: file.version },
  });
});
fileRoutes.on(['GET', 'HEAD'], '/files/:id/download', async (c) => {
  const file = await getFile(c.env, c.req.param('id'));
  return serveObject(
    c.env,
    c.req.raw,
    file.object_key,
    file.name,
    file.mime,
    c.req.query('preview') === '1' && file.mime !== 'application/octet-stream',
  );
});
fileRoutes.patch('/files/:id', async (c) => {
  const file = await getFile(c.env, c.req.param('id'));
  const input = filePatch.parse(await c.req.json());
  if (input.folder_id !== undefined) await activeFolder(c.env, input.folder_id);
  await drizzle(c.env.DB)
    .update(fileTable)
    .set({
      name: input.name ?? file.name,
      folderId: input.folder_id === undefined ? file.folder_id : input.folder_id,
      updatedAt: now(),
    })
    .where(and(eq(fileTable.id, file.id), isNull(fileTable.deletedAt)));
  await logStatement(c.env, 'file.update', file.id).run();
  return c.json({ data: await getFile(c.env, file.id) });
});
fileRoutes.delete('/files/:id', async (c) => {
  const file = await getFile(c.env, c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE files SET deleted_at=?,updated_at=? WHERE id=?').bind(
      now(),
      now(),
      file.id,
    ),
    c.env.DB.prepare('UPDATE file_shares SET enabled=0 WHERE file_id=?').bind(file.id),
    c.env.DB.prepare('UPDATE markdown_pages SET published=0 WHERE file_id=?').bind(file.id),
    logStatement(c.env, 'file.trash', file.id),
  ]);
  return c.json({ data: { id: file.id } });
});
fileRoutes.post('/files/:id/restore', async (c) => {
  const file = await getFile(c.env, c.req.param('id'), true);
  if (!file.deleted_at) fail(409, '文件未删除');
  await activeFolder(c.env, file.folder_id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE files SET deleted_at=NULL,updated_at=? WHERE id=?').bind(
      now(),
      file.id,
    ),
    logStatement(c.env, 'file.restore', file.id),
  ]);
  return c.json({ data: { id: file.id } });
});
fileRoutes.delete('/files/:id/permanent', async (c) => {
  const file = await getFile(c.env, c.req.param('id'), true);
  if (!file.deleted_at) fail(409, '必须先将文件移入回收站');
  const results = await c.env.DB.batch<{ object_key: string }>([
    c.env.DB.prepare(
      'SELECT object_key FROM files WHERE id=? UNION SELECT object_key FROM markdown_attachments WHERE file_id=? UNION SELECT snapshot_key AS object_key FROM markdown_pages WHERE file_id=? AND snapshot_key IS NOT NULL',
    ).bind(file.id, file.id, file.id),
    cleanupStatement(c.env, file.object_key),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT object_key,? FROM markdown_attachments WHERE file_id=?',
    ).bind(now(), file.id),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT snapshot_key,? FROM markdown_pages WHERE file_id=? AND snapshot_key IS NOT NULL',
    ).bind(now(), file.id),
    c.env.DB.prepare('DELETE FROM files WHERE id=?').bind(file.id),
    logStatement(c.env, 'file.purge', file.id),
  ]);
  // Metadata removal revokes access atomically; durable tasks make R2 deletion retryable.
  try {
    await cleanupPurgedObjects(
      c.env,
      results[0].results.map((row) => String(row.object_key)),
    );
  } catch {
    /* Scheduled cleanup retries durable tasks if immediate cleanup fails. */
  }
  return c.json({ data: { id: file.id } });
});

fileRoutes.delete('/trash', async (c) => {
  const timestamp = now();
  const results = await c.env.DB.batch<{ object_key: string }>([
    c.env.DB.prepare(`SELECT object_key FROM files WHERE deleted_at IS NOT NULL
      UNION SELECT a.object_key FROM markdown_attachments a JOIN files f ON f.id=a.file_id WHERE f.deleted_at IS NOT NULL
      UNION SELECT p.snapshot_key AS object_key FROM markdown_pages p JOIN files f ON f.id=p.file_id WHERE f.deleted_at IS NOT NULL AND p.snapshot_key IS NOT NULL`),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT object_key,? FROM files WHERE deleted_at IS NOT NULL',
    ).bind(timestamp),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT a.object_key,? FROM markdown_attachments a JOIN files f ON f.id=a.file_id WHERE f.deleted_at IS NOT NULL',
    ).bind(timestamp),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT p.snapshot_key,? FROM markdown_pages p JOIN files f ON f.id=p.file_id WHERE f.deleted_at IS NOT NULL AND p.snapshot_key IS NOT NULL',
    ).bind(timestamp),
    c.env.DB.prepare('DELETE FROM files WHERE deleted_at IS NOT NULL RETURNING id'),
    c.env.DB.prepare(
      'DELETE FROM folders WHERE deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files WHERE folder_id=folders.id) AND NOT EXISTS(SELECT 1 FROM folders child WHERE child.parent_id=folders.id) RETURNING id',
    ),
    logStatement(c.env, 'trash.empty', 'trash'),
  ]);
  try {
    await cleanupPurgedObjects(
      c.env,
      results[0].results.map((row) => String(row.object_key)),
    );
  } catch {
    /* Metadata is already removed; scheduled cleanup retries the durable queue. */
  }
  return c.json({ data: { files: results[4].results.length, folders: results[5].results.length } });
});
