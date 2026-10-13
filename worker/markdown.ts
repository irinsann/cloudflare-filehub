import { Hono } from 'hono';
import type { AppEnv, AppContext } from './env';
import { now, uuid, limit } from './env';
import { fail } from './errors';
import { getFile, activeFolder, logStatement } from './files';
import {
  releaseStatement,
  textObject,
  writeText,
  reserve,
  uploadStream,
  serveObject,
  isMarkdown,
} from './storage';
import {
  identifier,
  markdownInput,
  markdownUpdate,
  publishInput,
  filename,
} from '../shared/validation';
import type { PageRecord, AttachmentRecord } from '../shared/types';
import { attachmentIds, renderMarkdown, escapeHtml } from '../shared/markdown';
import { htmlPage } from './html';
export const markdownRoutes = new Hono<AppEnv>();
async function markdownFile(c: AppContext, id: string) {
  const file = await getFile(c.env, id);
  if (!isMarkdown(file.name)) fail(415, '请选择 Markdown 文件');
  return file;
}
markdownRoutes.get('/markdown', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT f.id,f.name,f.version,f.updated_at,p.slug,p.title,p.published,p.published_at,p.published_version,p.views FROM files f LEFT JOIN markdown_pages p ON p.file_id=f.id WHERE f.status='ready' AND f.deleted_at IS NULL AND (lower(f.name) LIKE '%.md' OR lower(f.name) LIKE '%.markdown') ORDER BY f.updated_at DESC LIMIT 100",
  ).all();
  return c.json({ data: rows.results });
});
markdownRoutes.post('/markdown', async (c) => {
  const input = markdownInput.parse(await c.req.json());
  if (!isMarkdown(input.name)) fail(400, '文件名应以 .md 结尾');
  await activeFolder(c.env, input.folder_id);
  const object = await writeText(c.env, input.content),
    id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO files(id,name,object_key,folder_id,mime,size,etag,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'ready',?,?)",
    ).bind(
      id,
      input.name,
      object.key,
      input.folder_id,
      'text/markdown',
      object.size,
      object.etag,
      now(),
      now(),
    ),
    releaseStatement(c.env, object.key),
    logStatement(c.env, 'markdown.create', id),
  ]);
  return c.json({ data: await getFile(c.env, id) }, 201);
});
markdownRoutes.get('/markdown/:id', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  const page = await c.env.DB.prepare('SELECT * FROM markdown_pages WHERE file_id=?')
    .bind(file.id)
    .first<PageRecord>();
  return c.json({ data: { file, content: await textObject(c.env, file.object_key), page } });
});
markdownRoutes.put('/markdown/:id', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  const input = markdownUpdate.parse(await c.req.json());
  if (input.version !== file.version) fail(409, '文档已被另一窗口修改，请先另存草稿再重新载入');
  const object = await writeText(c.env, input.content);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE files SET object_key=?,size=?,etag=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL AND status='ready' RETURNING version",
    ).bind(object.key, object.size, object.etag, now(), file.id, input.version),
    c.env.DB.prepare(
      'DELETE FROM cleanup_tasks WHERE object_key=? AND EXISTS(SELECT id FROM files WHERE id=? AND object_key=?)',
    ).bind(object.key, file.id, object.key),
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT ?,? WHERE EXISTS(SELECT id FROM files WHERE id=? AND object_key=?)',
    ).bind(file.object_key, now(), file.id, object.key),
  ]);
  if (!result[0].results.length) fail(409, '保存冲突，请保留本地草稿后重新载入');
  await logStatement(c.env, 'markdown.save', file.id).run();
  return c.json({ data: { version: input.version + 1, updated_at: now() } });
});
markdownRoutes.post('/markdown/:id/attachments', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  const name = filename.parse(c.req.query('name'));
  const key = await reserve(c.env);
  const object = await uploadStream(c.env, c.req.raw, key, name);
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(object.mime))
    fail(415, '附件仅支持通过签名检查的 PNG、JPEG、GIF、WebP 图片');
  const id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO markdown_attachments(id,file_id,object_key,mime,size,created_at) VALUES(?,?,?,?,?,?)',
    ).bind(id, file.id, key, object.mime, object.size, now()),
    releaseStatement(c.env, key),
    logStatement(c.env, 'markdown.attachment', file.id),
  ]);
  return c.json({ data: { id, reference: `attachment:${id}` } }, 201);
});
markdownRoutes.get('/markdown/:id/attachments/:attachmentId', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  const id = identifier.parse(c.req.param('attachmentId'));
  const attachment = await c.env.DB.prepare(
    'SELECT * FROM markdown_attachments WHERE id=? AND file_id=?',
  )
    .bind(id, file.id)
    .first<AttachmentRecord>();
  if (!attachment) fail(404, '附件不存在');
  return serveObject(c.env, c.req.raw, attachment.object_key, 'image', attachment.mime, true);
});
markdownRoutes.post('/markdown/:id/publish', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  const input = publishInput.parse(await c.req.json());
  if (input.version !== file.version)
    fail(409, '文档已在另一窗口更新，请重新载入并确认要发布的正文');
  const source = await textObject(c.env, file.object_key);
  const ids = attachmentIds(source);
  if (ids.length > 20) fail(400, '单篇文章最多 20 张受控附件');
  if (ids.length) {
    const owned = await c.env.DB.prepare(
      `SELECT id FROM markdown_attachments WHERE file_id=? AND id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(file.id, ...ids)
      .all<{ id: string }>();
    if (owned.results.length !== ids.length) fail(403, '文章引用了不属于它的私人附件');
  }
  const existing = await c.env.DB.prepare('SELECT * FROM markdown_pages WHERE file_id=?')
    .bind(file.id)
    .first<PageRecord>();
  const id = existing?.id ?? uuid();
  const object = await writeText(c.env, source);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO markdown_pages(id,file_id,title,slug,description,published,published_at,updated_at,snapshot_key,published_version,allow_source,allow_index) SELECT ?,?,?,?,?,1,?,?,?,?,?,? WHERE EXISTS(SELECT id FROM files WHERE id=? AND version=? AND deleted_at IS NULL AND status='ready') ON CONFLICT(file_id) DO UPDATE SET title=excluded.title,slug=excluded.slug,description=excluded.description,published=1,published_at=COALESCE(markdown_pages.published_at,excluded.published_at),updated_at=excluded.updated_at,snapshot_key=excluded.snapshot_key,published_version=excluded.published_version,allow_source=excluded.allow_source,allow_index=excluded.allow_index",
    ).bind(
      id,
      file.id,
      input.title,
      input.slug,
      input.description,
      now(),
      now(),
      object.key,
      file.version,
      Number(input.allow_source),
      Number(input.allow_index),
      file.id,
      input.version,
    ),
    c.env.DB.prepare(
      'DELETE FROM page_attachments WHERE page_id=? AND EXISTS(SELECT id FROM markdown_pages WHERE id=? AND snapshot_key=?)',
    ).bind(id, id, object.key),
    ...ids.map((a) =>
      c.env.DB.prepare(
        'INSERT INTO page_attachments(page_id,attachment_id) SELECT ?,? WHERE EXISTS(SELECT id FROM markdown_pages WHERE id=? AND snapshot_key=?)',
      ).bind(id, a, id, object.key),
    ),
    c.env.DB.prepare(
      'DELETE FROM cleanup_tasks WHERE object_key=? AND EXISTS(SELECT id FROM markdown_pages WHERE snapshot_key=?)',
    ).bind(object.key, object.key),
    ...(existing?.snapshot_key
      ? [
          c.env.DB.prepare(
            'INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) SELECT ?,? WHERE EXISTS(SELECT id FROM markdown_pages WHERE id=? AND snapshot_key=?)',
          ).bind(existing.snapshot_key, now(), id, object.key),
        ]
      : []),
  ]);
  if (!results[0].meta.changes) fail(409, '文档状态已变化，请重新载入后再发布');
  await logStatement(c.env, 'markdown.publish', file.id).run();
  return c.json({ data: { id, slug: input.slug, url: articleUrl(c, input.slug) } });
});
markdownRoutes.post('/markdown/:id/unpublish', async (c) => {
  const file = await markdownFile(c, c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE markdown_pages SET published=0,updated_at=? WHERE file_id=?').bind(
      now(),
      file.id,
    ),
    logStatement(c.env, 'markdown.unpublish', file.id),
  ]);
  return c.json({ data: { id: file.id } });
});
export const articleUrl = (c: AppContext, slug: string) =>
  `${c.env.ADMIN_ORIGIN || new URL(c.req.url).origin}/p/${slug}`;
export async function publishedPage(c: AppContext, slug: string) {
  const page = await c.env.DB.prepare(
    "SELECT p.* FROM markdown_pages p JOIN files f ON f.id=p.file_id WHERE p.slug=? AND p.published=1 AND f.deleted_at IS NULL AND f.status='ready'",
  )
    .bind(slug)
    .first<PageRecord>();
  if (!page?.snapshot_key) fail(404, '文章不存在或已取消发布');
  await getFile(c.env, page.file_id);
  return page;
}
export async function readPage(c: AppContext, requestedSlug?: string) {
  const slug = requestedSlug ?? c.req.param('slug') ?? '';
  const page = await publishedPage(c, slug);
  const source = await textObject(c.env, page.snapshot_key!);
  const attachments = await c.env.DB.prepare(
    'SELECT attachment_id FROM page_attachments WHERE page_id=?',
  )
    .bind(page.id)
    .all<{ attachment_id: string }>();
  const allowed = new Set(attachments.results.map((a) => a.attachment_id));
  const { html, headings } = await renderMarkdown(source, (id) =>
    allowed.has(id) ? `/api/public/pages/${encodeURIComponent(slug)}/attachments/${id}` : null,
  );
  const url = articleUrl(c, page.slug);
  const e = escapeHtml;
  const meta = `<meta name="description" content="${e(page.description)}"><meta property="og:title" content="${e(page.title)}"><meta property="og:description" content="${e(page.description)}"><meta property="og:type" content="article"><link rel="canonical" href="${e(url)}"><meta name="robots" content="${page.allow_index ? 'index,follow' : 'noindex,nofollow'}">`;
  const output = htmlPage(
    page.title,
    `<main class="layout"><article class="reader"><div class="eyebrow">PUBLISHED NOTE</div><h1 class="title">${e(page.title)}</h1><p class="description">${e(page.description)}</p><div class="meta">更新于 ${e(new Date(page.updated_at).toISOString().slice(0, 10))}${page.allow_source ? ` · <a href="/api/public/pages/${slug}/source">下载 Markdown</a>` : ''}</div><div class="prose">${html}</div></article><aside class="toc"><b>本文目录</b>${headings.map((h) => `<a href="#${encodeURIComponent(h.id)}">${e(h.text)}</a>`).join('')}</aside></main>`,
    undefined,
    meta,
  );
  if (c.req.method === 'GET')
    await c.env.DB.prepare('UPDATE markdown_pages SET views=views+1 WHERE id=? AND published=1')
      .bind(page.id)
      .run();
  return new Response(c.req.method === 'HEAD' ? null : output.html, { headers: output.headers });
}
export const publicPageRoutes = new Hono<AppEnv>();
publicPageRoutes.on(['GET', 'HEAD'], '/:slug/source', async (c) => {
  const page = await publishedPage(c, c.req.param('slug'));
  if (!page.allow_source) fail(403, '作者未开启原文下载');
  return serveObject(
    c.env,
    c.req.raw,
    page.snapshot_key!,
    `${page.slug}.md`,
    'text/markdown',
    false,
  );
});
publicPageRoutes.on(['GET', 'HEAD'], '/:slug/attachments/:id', async (c) => {
  const page = await publishedPage(c, c.req.param('slug'));
  const id = identifier.parse(c.req.param('id'));
  const attachment = await c.env.DB.prepare(
    'SELECT a.* FROM markdown_attachments a JOIN page_attachments p ON p.attachment_id=a.id WHERE p.page_id=? AND a.id=? AND a.file_id=?',
  )
    .bind(page.id, id, page.file_id)
    .first<AttachmentRecord>();
  if (!attachment) fail(404, '附件未授权');
  return serveObject(c.env, c.req.raw, attachment.object_key, 'image', attachment.mime, true);
});
export async function enforceJsonLimit(c: AppContext, next: () => Promise<void>) {
  if (
    ['POST', 'PUT', 'PATCH'].includes(c.req.method) &&
    c.req.header('Content-Type')?.includes('application/json')
  ) {
    const declared = Number(c.req.header('Content-Length'));
    const max = limit(c.env.MAX_TEXT_BYTES, 1048576) * 6 + 4096;
    if (declared > max) fail(413, '请求正文过大');
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel();
          fail(413, '请求正文过大');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      c.req.raw = new Request(c.req.raw, { body: bytes });
    }
  }
  await next();
}
