import type { FileRecord } from '../shared/types';
import type { Env } from './env';
import { fail } from './errors';

export interface SitePath {
  segments: string[];
  trailingSlash: boolean;
}

export function parseSitePath(path: string): SitePath {
  if (new TextEncoder().encode(path).length > 4096) fail(414, '网站路径过长');
  const trailingSlash = path.endsWith('/');
  const values = path.split('/');
  if (values[0] === '') values.shift();
  if (values.at(-1) === '') values.pop();
  if (values.length > 64) fail(414, '网站目录层级过深');
  const segments = values.map((value) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      fail(400, '网站路径编码无效');
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      /[\\/\u0000-\u001f\u007f]/.test(decoded) ||
      /%(?:2e|2f|5c|00)/i.test(decoded)
    )
      fail(400, '网站路径无效');
    return decoded;
  });
  return { segments, trailingSlash };
}

export function encodedSitePath(path: SitePath) {
  return (
    path.segments.map((segment) => encodeURIComponent(segment)).join('/') +
    (path.trailingSlash && path.segments.length ? '/' : '')
  );
}

async function fileByName(env: Env, folderId: string, name: string) {
  const rows = await env.DB.prepare(
    "SELECT * FROM files WHERE folder_id=? AND name=? AND deleted_at IS NULL AND status='ready' LIMIT 2",
  )
    .bind(folderId, name)
    .all<FileRecord>();
  if (rows.results.length > 1) fail(409, '网站目录内存在重名文件');
  return rows.results[0] ?? null;
}

async function folderByName(env: Env, folderId: string, name: string) {
  return env.DB.prepare(
    'SELECT id FROM folders WHERE parent_id=? AND name=? AND deleted_at IS NULL',
  )
    .bind(folderId, name)
    .first<{ id: string }>();
}

export async function siteEntry(env: Env, folderId: string) {
  const file = await fileByName(env, folderId, 'index.html');
  if (!file) fail(404, '文件夹中没有 index.html');
  return file;
}

export async function resolveSiteFile(env: Env, root: string, path: SitePath) {
  const parents = path.segments.slice(0, -1);
  const resolved = await env.DB.prepare(
    `WITH RECURSIVE route(id,depth) AS (
      SELECT ?,0 UNION ALL
      SELECT f.id,r.depth+1 FROM folders f JOIN route r ON f.parent_id=r.id
      WHERE f.deleted_at IS NULL AND r.depth<? AND f.name=json_extract(?,'$['||r.depth||']')
    ) SELECT id FROM route WHERE depth=?`,
  )
    .bind(root, parents.length, JSON.stringify(parents), parents.length)
    .first<{ id: string }>();
  if (!resolved) fail(404, '网站资源不存在');
  const folder = resolved.id;
  const name = path.segments.at(-1);
  if (!name) return { file: await siteEntry(env, folder), directory: true };
  const child = await folderByName(env, folder, name);
  const file = await fileByName(env, folder, name);
  if (file && child) fail(409, '网站目录内存在重名文件和文件夹');
  if (child) return { file: await siteEntry(env, child.id), directory: true };
  if (!file || path.trailingSlash) fail(404, '网站资源不存在');
  return { file, directory: false };
}

export async function validateSiteTree(env: Env, root: string) {
  await siteEntry(env, root);
  const duplicate = await env.DB.prepare(
    `WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id
      WHERE f.deleted_at IS NULL
    ), names(parent,name) AS (
      SELECT f.folder_id,f.name FROM files f JOIN tree t ON f.folder_id=t.id
      WHERE f.deleted_at IS NULL AND f.status='ready'
      UNION ALL
      SELECT f.parent_id,f.name FROM folders f JOIN tree t ON f.parent_id=t.id
      WHERE f.deleted_at IS NULL
    ) SELECT name FROM names GROUP BY parent,name HAVING COUNT(*)>1 LIMIT 1`,
  )
    .bind(root)
    .first<{ name: string }>();
  if (duplicate) fail(409, '网站目录内存在重名文件或文件夹');
}

// Only site shares opt in to executable MIME types. Ordinary drive previews remain inert.
export function siteMime(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    wasm: 'application/wasm',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
  };
  return types[extension] ?? 'application/octet-stream';
}
