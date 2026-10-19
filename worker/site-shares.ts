import { Hono } from 'hono';
import { z } from 'zod';
import { paginationParams } from '../shared/pagination';
import type { SiteShareListItem } from '../shared/site-shares';
import { identifier } from '../shared/validation';
import { checkPassword, hashPassword, rateLimit } from './auth-crypto';
import type { AppContext, AppEnv } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { activeFolder, logStatement } from './files';
import { htmlPage } from './html';
import { writeOriginAllowed } from './origins';
import {
  encodedSitePath,
  parseSitePath,
  resolveSiteFile,
  siteMime,
  validateSiteTree,
  type SitePath,
} from './site-shares-files';
import {
  parseSiteToken,
  siteGrantToken,
  siteResourceCsp,
  siteShareToken,
  validSiteGrant,
  validSiteToken,
  type SiteShareRecord,
} from './site-shares-security';
import { serveObject } from './storage';

async function inputJson(c: AppContext) {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, '请求内容为空');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) {
      await reader.cancel();
      fail(413, '请求内容过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    fail(400, '请求内容无效');
  }
}

async function listItem(
  c: AppContext,
  row: SiteShareRecord & { name: string },
): Promise<SiteShareListItem> {
  const origin = c.env.FILES_ORIGIN || new URL(c.req.url).origin;
  return {
    id: row.id,
    folder_id: row.folder_id,
    name: row.name,
    url: `${origin}/site/${await siteShareToken(row, c.env)}/`,
    enabled: !!row.enabled,
    password_protected: !!row.password_hash,
    created_at: row.created_at,
    expires_at: row.expires_at,
    views: row.views,
    last_access_at: row.last_access_at,
  };
}

const createInput = z.object({
  folder_id: identifier,
  password: z.string().max(128).optional(),
  expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
});

export const siteShareAdminRoutes = new Hono<AppEnv>();
siteShareAdminRoutes.get('/site-shares', async (c) => {
  const { page, limit, offset } = paginationParams(c.req.query());
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*,f.name FROM site_shares s JOIN folders f ON f.id=s.folder_id
       ORDER BY s.created_at DESC,s.id ASC LIMIT ? OFFSET ?`,
    )
      .bind(limit, offset)
      .all<SiteShareRecord & { name: string }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM site_shares').first<number>('total'),
  ]);
  return c.json({
    data: await Promise.all(rows.results.map((row) => listItem(c, row))),
    total: total ?? 0,
    page,
    limit,
  });
});

siteShareAdminRoutes.post('/site-shares', async (c) => {
  const input = createInput.parse(await inputJson(c));
  await activeFolder(c.env, input.folder_id);
  await validateSiteTree(c.env, input.folder_id);
  const folder = await c.env.DB.prepare('SELECT name FROM folders WHERE id=?')
    .bind(input.folder_id)
    .first<{ name: string }>();
  if (!folder) fail(404, '文件夹不存在');
  const row: SiteShareRecord & { name: string } = {
    id: uuid(),
    folder_id: input.folder_id,
    name: folder.name,
    token_seed: uuid(),
    password_hash: input.password ? await hashPassword(input.password) : null,
    grant_version: 1,
    created_at: now(),
    expires_at: input.expires_in_days ? now() + input.expires_in_days * 86400000 : null,
    enabled: 1,
    views: 0,
    last_access_at: null,
  };
  const result = await listItem(c, row);
  const saved = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO site_shares(id,folder_id,token_seed,password_hash,created_at,expires_at)
       SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM folders WHERE id=? AND deleted_at IS NULL)
       AND NOT EXISTS(
         WITH RECURSIVE chain(id,parent_id,deleted_at) AS (
           SELECT id,parent_id,deleted_at FROM folders WHERE id=?
           UNION SELECT f.id,f.parent_id,f.deleted_at FROM folders f JOIN chain c ON f.id=c.parent_id
         ) SELECT 1 FROM chain WHERE deleted_at IS NOT NULL
       )`,
    ).bind(
      row.id,
      row.folder_id,
      row.token_seed,
      row.password_hash,
      row.created_at,
      row.expires_at,
      row.folder_id,
      row.folder_id,
    ),
    logStatement(c.env, 'site-share.create', row.id),
  ]);
  if (!saved[0].meta.changes) fail(409, '文件夹状态已变化，请刷新后重试');
  return c.json({ data: result }, 201);
});

siteShareAdminRoutes.delete('/site-shares/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const result = await c.env.DB.prepare(
    'UPDATE site_shares SET enabled=0,grant_version=grant_version+1 WHERE id=?',
  )
    .bind(id)
    .run();
  if (!result.meta.changes) fail(404, '网站分享不存在');
  await logStatement(c.env, 'site-share.revoke', id).run();
  return c.json({ data: { id } });
});

async function lookup(c: AppContext) {
  const token = c.req.param('token') ?? '';
  const parsed = parseSiteToken(token);
  if (!parsed) fail(404, '网站分享不存在');
  const row = await c.env.DB.prepare('SELECT * FROM site_shares WHERE id=?')
    .bind(parsed.id)
    .first<SiteShareRecord>();
  if (!row || !(await validSiteToken(token, row, c.env))) fail(404, '网站分享不存在');
  if (!row.enabled || (row.expires_at !== null && row.expires_at <= now()))
    fail(410, '网站分享已过期或已撤销');
  await activeFolder(c.env, row.folder_id);
  return { token, base: parsed.base, row };
}

function jsonScript(value: string) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function unlockPage(c: AppContext, base: string, path: SitePath) {
  const endpoint = `/site/${base}`;
  const next = encodedSitePath(path);
  const script = `const form=document.getElementById('unlock');
form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const button=form.querySelector('button');
  const message=document.getElementById('message');
  button.disabled=true;message.textContent='';
  try{
    const response=await fetch(${jsonScript(endpoint)},{method:'POST',headers:{'Content-Type':'application/json','X-Drive-Request':'1'},body:JSON.stringify({password:document.getElementById('password').value,path:${jsonScript(next)},query:location.search})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error?.message||'解锁失败');
    location.replace(result.data.url);
  }catch(error){message.textContent=error.message||'解锁失败';button.disabled=false}
});`;
  const page = htmlPage(
    '网站分享',
    '<main class="card"><h1>网站分享</h1><form id="unlock"><input id="password" type="password" aria-label="访问密码" placeholder="访问密码" autocomplete="current-password" required maxlength="128"><button type="submit">打开网站</button></form><p id="message" role="alert"></p></main>',
    script,
    '<meta name="robots" content="noindex,nofollow">',
  );
  return new Response(c.req.method === 'HEAD' ? null : page.html, { headers: page.headers });
}

function resourceHeaders(headers: Headers, c: AppContext, token: string) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, ETag, Accept-Ranges',
  );
  headers.set('Content-Security-Policy', siteResourceCsp(new URL(c.req.url).origin, token, c.env));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
}

export const siteSharePublicRoutes = new Hono<AppEnv>();
siteSharePublicRoutes.post('/:token', async (c) => {
  if (!writeOriginAllowed(c.env, c.req.raw) || c.req.header('X-Drive-Request') !== '1')
    fail(403, '请求来源校验失败');
  await rateLimit(c.env, 'site-unlock', c.req.header('CF-Connecting-IP') || 'local', 10, 300);
  const { row } = await lookup(c);
  const input = z
    .object({
      password: z.string().max(128),
      path: z.string().max(4096).default(''),
      query: z.string().max(2048).default(''),
    })
    .parse(await inputJson(c));
  if (!row.password_hash || !(await checkPassword(input.password, row.password_hash)))
    fail(401, '密码错误');
  const path = parseSitePath(input.path);
  const query = new URLSearchParams(input.query).toString();
  const token = await siteGrantToken(row, c.env, now());
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: { url: `/site/${token}/${encodedSitePath(path)}${query ? '?' + query : ''}` },
  });
});

siteSharePublicRoutes.on(['GET', 'HEAD', 'OPTIONS'], ['/:token', '/:token/*'], async (c) => {
  const { token, base, row } = await lookup(c);
  const prefix = `/site/${token}`;
  const pathname = new URL(c.req.url).pathname;
  if (pathname !== prefix && !pathname.startsWith(prefix + '/')) fail(400, '网站路径无效');
  const path = parseSitePath(pathname.slice(prefix.length));
  if (row.password_hash && !(await validSiteGrant(token, row, c.env, now()))) {
    if (
      c.req.method !== 'OPTIONS' &&
      (!path.segments.length ||
        /\.html?$/i.test(path.segments.at(-1) ?? '') ||
        c.req.header('Sec-Fetch-Dest') === 'document')
    )
      return unlockPage(c, base, path);
    fail(401, '请输入网站分享密码');
  }
  const { file, directory } = await resolveSiteFile(c.env, row.folder_id, path);
  if (directory && !pathname.endsWith('/') && c.req.method !== 'OPTIONS') {
    const response = c.redirect(
      `${prefix}/${encodedSitePath({ ...path, trailingSlash: true })}${new URL(c.req.url).search}`,
      308,
    );
    resourceHeaders(response.headers, c, token);
    return response;
  }
  if (c.req.method === 'OPTIONS') {
    const headers = new Headers();
    resourceHeaders(headers, c, token);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range');
    return new Response(null, { status: 204, headers });
  }
  const mime = siteMime(file.name);
  const response = await serveObject(c.env, c.req.raw, file.object_key, file.name, mime, true);
  resourceHeaders(response.headers, c, token);
  if (c.req.method === 'GET' && response.status === 200 && mime.startsWith('text/html')) {
    await c.env.DB.prepare('UPDATE site_shares SET views=views+1,last_access_at=? WHERE id=?')
      .bind(now(), row.id)
      .run();
  }
  return response;
});
