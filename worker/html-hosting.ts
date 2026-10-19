import { Hono } from 'hono';
import { z } from 'zod';
import { paginationParams } from '../shared/pagination';
import type { HtmlHostingItem } from '../shared/html-hosting';
import { identifier } from '../shared/validation';
import type { FileRecord } from '../shared/types';
import type { AppContext, AppEnv, Env } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { digest } from './auth-crypto';
import { getFile } from './files';
import { shareLinkToken } from './share-links';
import { isHtml } from './storage';

const folderName = 'Html-hosting';
const hostSelect = `SELECT h.file_id,h.share_id,h.version,h.created_at,
  f.name,f.size,s.token_hash,s.enabled,s.expires_at,s.password_hash,s.views,s.downloads,s.last_access_at
  FROM html_hosts h JOIN files f ON f.id=h.file_id JOIN file_shares s ON s.id=h.share_id`;

interface HostedHtml {
  file_id: string;
  share_id: string;
  version: number;
  created_at: number;
  name: string;
  size: number;
  token_hash: string;
  enabled: number;
  expires_at: number | null;
  password_hash: string | null;
  views: number;
  downloads: number;
  last_access_at: number | null;
}

async function rootFolder(env: Env) {
  return env.DB.prepare(
    'SELECT id FROM folders WHERE name=? AND parent_id IS NULL AND deleted_at IS NULL',
  )
    .bind(folderName)
    .first<{ id: string }>();
}

export async function htmlHostingFolder(env: Env) {
  const existing = await rootFolder(env);
  if (existing) return existing.id;
  const collision = await env.DB.prepare(
    'SELECT id FROM files WHERE folder_id IS NULL AND name=? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(folderName)
    .first();
  if (collision) fail(409, '根目录中已有名为 Html-hosting 的文件');
  await env.DB.prepare(
    `INSERT OR IGNORE INTO folders(id,name,parent_id,created_at,updated_at)
     SELECT ?,?,NULL,?,? WHERE NOT EXISTS(
       SELECT 1 FROM files WHERE folder_id IS NULL AND name=? AND deleted_at IS NULL
     )`,
  )
    .bind(uuid(), folderName, now(), now(), folderName)
    .run();
  const created = await rootFolder(env);
  if (!created) fail(409, 'Html-hosting 目录不可用');
  return created.id;
}

async function record(c: AppContext, fileId: string) {
  return c.env.DB.prepare(hostSelect + ' WHERE h.file_id=?')
    .bind(fileId)
    .first<HostedHtml>();
}

async function present(c: AppContext, row: HostedHtml): Promise<HtmlHostingItem> {
  const token = await shareLinkToken({ id: row.share_id, token_hash: row.token_hash }, c.env);
  const origin = c.env.FILES_ORIGIN || c.env.ADMIN_ORIGIN || new URL(c.req.url).origin;
  return {
    file_id: row.file_id,
    share_id: row.share_id,
    name: row.name,
    size: row.size,
    enabled: !!row.enabled,
    version: row.version,
    created_at: row.created_at,
    expires_at: row.expires_at,
    password_protected: !!row.password_hash,
    views: row.views,
    downloads: row.downloads,
    last_access_at: row.last_access_at,
    url: `${origin}/s/${token}`,
    directUrl: `${origin}/d/${token}`,
  };
}

const input = z.object({ file_id: identifier }).strict();
const revision = z
  .object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict();

export const htmlHostingRoutes = new Hono<AppEnv>();
htmlHostingRoutes.post('/html-hosting/folder', async (c) =>
  c.json({ data: { id: await htmlHostingFolder(c.env) } }),
);

htmlHostingRoutes.get('/html-hosting', async (c) => {
  const { page, limit, offset } = paginationParams(c.req.query(), 40);
  const where = " WHERE f.deleted_at IS NULL AND f.status='ready'";
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      hostSelect + where + ' ORDER BY h.created_at DESC,h.file_id ASC LIMIT ? OFFSET ?',
    )
      .bind(limit, offset)
      .all<HostedHtml>(),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS total FROM html_hosts h JOIN files f ON f.id=h.file_id' + where,
    ).first<number>('total'),
  ]);
  return c.json({
    data: await Promise.all(rows.results.map((row) => present(c, row))),
    total: total ?? 0,
    page,
    limit,
  });
});

htmlHostingRoutes.get('/html-hosting/:id', async (c) => {
  const fileId = identifier.parse(c.req.param('id'));
  await getFile(c.env, fileId);
  const row = await record(c, fileId);
  if (!row) fail(404, 'HTML 分享不存在');
  return c.json({ data: await present(c, row) });
});

htmlHostingRoutes.post('/html-hosting', async (c) => {
  const { file_id: fileId } = input.parse(
    await c.req.json().catch(() => fail(400, 'JSON 格式无效')),
  );
  const file = await getFile(c.env, fileId);
  if (!isHtml(file.name)) fail(415, '仅支持 HTML、HTM 文件');
  const existing = await record(c, fileId);
  // A response retry only retrieves the registered share; it never revives a later revocation.
  if (existing) return c.json({ data: await present(c, existing) });
  const folder = await rootFolder(c.env);
  if (!folder || file.folder_id !== folder.id) fail(409, '请先上传到 Html-hosting 文件夹');
  const id = uuid(),
    tokenHash = await digest(uuid() + uuid()),
    createdAt = now();
  // Validate the configured signing secret before creating any persistent share.
  await shareLinkToken({ id, token_hash: tokenHash }, c.env);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO file_shares(id,file_id,token_hash,created_at,allow_download)
       SELECT ?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM html_hosts WHERE file_id=?)
       AND EXISTS(SELECT 1 FROM files f JOIN folders d ON d.id=f.folder_id
         WHERE f.id=? AND f.name=? AND f.object_key=? AND f.version=?
         AND f.deleted_at IS NULL AND f.status='ready' AND f.folder_id=?
         AND d.name=? AND d.parent_id IS NULL AND d.deleted_at IS NULL)`,
    ).bind(
      id,
      file.id,
      tokenHash,
      createdAt,
      file.id,
      file.id,
      file.name,
      file.object_key,
      file.version,
      folder.id,
      folderName,
    ),
    c.env.DB.prepare(
      `INSERT INTO html_hosts(file_id,share_id,created_at)
       SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM file_shares WHERE id=? AND file_id=?)
       ON CONFLICT(file_id) DO NOTHING`,
    ).bind(file.id, id, createdAt, id, file.id),
    c.env.DB.prepare(
      `INSERT INTO operations(id,action,target_id,created_at)
       SELECT ?,'html.publish',?,? WHERE EXISTS(SELECT 1 FROM html_hosts WHERE file_id=? AND share_id=?)`,
    ).bind(uuid(), file.id, createdAt, file.id, id),
  ]);
  const saved = await record(c, file.id);
  if (!saved) fail(409, '文件状态已改变，请刷新后重试');
  return c.json({ data: await present(c, saved) }, result[1].meta.changes ? 201 : 200);
});

async function setEnabled(c: AppContext, enabled: boolean) {
  const fileId = identifier.parse(c.req.param('id'));
  const { version } = revision.parse(await c.req.json().catch(() => fail(400, 'JSON 格式无效')));
  const row = await record(c, fileId);
  if (!row) fail(404, 'HTML 分享不存在');
  let file: FileRecord | undefined;
  if (enabled) {
    file = await getFile(c.env, fileId);
    if (!isHtml(file.name)) fail(415, '仅支持 HTML、HTM 文件');
    if (row.expires_at !== null && row.expires_at <= now())
      fail(409, '分享已过期，请在文件分享中修改有效期');
  }
  if (row.version !== version) {
    if (row.version === version + 1 && !!row.enabled === enabled)
      return c.json({ data: await present(c, row) });
    fail(409, '分享状态已变化，请刷新后重试');
  }
  if (!!row.enabled === enabled) return c.json({ data: await present(c, row) });
  const restoreGuard = enabled
    ? `
    AND EXISTS(SELECT 1 FROM files WHERE id=? AND name=? AND object_key=? AND folder_id IS ?
      AND deleted_at IS NULL AND status='ready')
    AND NOT EXISTS(WITH RECURSIVE chain(id,parent_id,deleted_at) AS (
      SELECT id,parent_id,deleted_at FROM folders WHERE id=?
      UNION SELECT f.id,f.parent_id,f.deleted_at FROM folders f JOIN chain c ON f.id=c.parent_id
    ) SELECT 1 FROM chain WHERE deleted_at IS NOT NULL)`
    : '';
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE file_shares SET enabled=? WHERE id=?
       AND EXISTS(SELECT 1 FROM html_hosts WHERE file_id=? AND share_id=? AND version=?)${restoreGuard}`,
    ).bind(
      Number(enabled),
      row.share_id,
      fileId,
      row.share_id,
      version,
      ...(file ? [file.id, file.name, file.object_key, file.folder_id, file.folder_id] : []),
    ),
    c.env.DB.prepare(
      'INSERT INTO operations(id,action,target_id,created_at) SELECT ?,?,?,? WHERE changes()=1',
    ).bind(uuid(), enabled ? 'html.restore' : 'html.revoke', fileId, now()),
  ]);
  const saved = await record(c, fileId);
  if (!saved || !results[0].meta.changes) fail(409, '分享状态已变化，请刷新后重试');
  return c.json({ data: await present(c, saved) });
}

htmlHostingRoutes.delete('/html-hosting/:id', (c) => setEnabled(c, false));
htmlHostingRoutes.post('/html-hosting/:id/restore', (c) => setEnabled(c, true));
