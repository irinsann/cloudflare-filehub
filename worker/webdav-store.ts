import type { AppContext, Env } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import type { FileRecord, FolderRecord } from '../shared/types';
import { filename } from '../shared/validation';
import { reserve, releaseStatement, cleanupStatement, mimeFor, sniff, isText } from './storage';
import { DAV_MAX_UPLOAD } from './webdav-auth';
import { checkWriteLease } from './write-lease';

export type DavNode =
  | { kind: 'file'; row: FileRecord; path: string }
  | { kind: 'folder'; row: FolderRecord; path: string };
export const rootNode: DavNode = {
  kind: 'folder',
  path: '/dav/',
  row: {
    id: 'root',
    name: 'RCloud',
    parent_id: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  },
};
export function davPath(pathname: string) {
  if (pathname !== '/dav' && !pathname.startsWith('/dav/'))
    fail(403, 'Destination必须位于WebDAV目录');
  if (pathname.length > 4096) fail(414, '路径过长');
  const raw = pathname.slice(5).replace(/\/$/, '');
  if (!raw) return '/dav/';
  const parts = raw.split('/').map((p) => {
    let name: string;
    try {
      name = decodeURIComponent(p);
    } catch {
      return fail(400, '路径编码无效');
    }
    const valid = filename.safeParse(name);
    if (!valid.success || valid.data !== name) fail(400, '文件名无效');
    return name;
  });
  if (parts.length > 32) fail(409, '目录层级过深');
  return '/dav/' + parts.join('/');
}
export const href = (path: string, folder = false) =>
  path.split('/').map(encodeURIComponent).join('/') + (folder && !path.endsWith('/') ? '/' : '');
export const parentPath = (path: string) => {
  const p = path.slice(0, path.lastIndexOf('/'));
  return p === '/dav' || !p ? '/dav/' : p;
};
export const childPath = (path: string, name: string) => `${path.replace(/\/$/, '')}/${name}`;
export const nodeId = (node: DavNode) => `${node.kind}:${node.row.id}`;
export const etag = (node: DavNode) =>
  node.kind === 'file'
    ? `"${node.row.etag || node.row.id}"`
    : `"${node.row.id}-${node.row.updated_at}"`;
export async function children(env: Env, node: DavNode) {
  if (node.kind !== 'folder') fail(409, '父目录不是文件夹');
  const id = node.row.id === 'root' ? null : node.row.id;
  const result = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      'SELECT * FROM folders WHERE parent_id IS ? AND deleted_at IS NULL ORDER BY name LIMIT 2001',
    ).bind(id),
    env.DB.prepare(
      "SELECT * FROM files WHERE folder_id IS ? AND deleted_at IS NULL AND status='ready' ORDER BY name LIMIT 2001",
    ).bind(id),
  ]);
  const rows: DavNode[] = [
    ...result[0].results.map((r) => ({
      kind: 'folder' as const,
      row: r as unknown as FolderRecord,
      path: childPath(node.path, r.name as string),
    })),
    ...result[1].results.map((r) => ({
      kind: 'file' as const,
      row: r as unknown as FileRecord,
      path: childPath(node.path, r.name as string),
    })),
  ];
  if (rows.length > 2000) fail(507, '单目录超过2000项，请在网页中分目录整理');
  const names = rows.map((n) => n.row.name.toLowerCase());
  if (new Set(names).size !== names.length) fail(409, '目录存在同名文件，请在网页中重命名后重试');
  return rows;
}
export async function resolve(env: Env, path: string): Promise<DavNode | null> {
  if (path === '/dav/') return rootNode;
  const parts = path.slice(5).split('/');
  const rows = await env.DB.prepare(
    `WITH RECURSIVE chain(id,path,depth) AS (
    SELECT NULL,'/dav/',0 UNION ALL
    SELECT f.id,rtrim(c.path,'/')||'/'||f.name,c.depth+1 FROM folders f JOIN chain c ON f.parent_id IS c.id
    WHERE f.deleted_at IS NULL AND f.name=json_extract(?,'$['||c.depth||']') COLLATE NOCASE AND c.depth<? LIMIT 66
  ) SELECT 'folder' AS kind,c.path,c.depth,json_object('id',f.id,'name',f.name,'parent_id',f.parent_id,'created_at',f.created_at,'updated_at',f.updated_at,'deleted_at',f.deleted_at) AS data
    FROM chain c JOIN folders f ON f.id=c.id
    UNION ALL SELECT 'file',rtrim(c.path,'/')||'/'||f.name,c.depth+1,json_object('id',f.id,'name',f.name,'folder_id',f.folder_id,'object_key',f.object_key,'size',f.size,'mime',f.mime,'etag',f.etag,'version',f.version,'status',f.status,'created_at',f.created_at,'updated_at',f.updated_at,'deleted_at',f.deleted_at)
    FROM chain c JOIN files f ON f.folder_id IS c.id WHERE f.deleted_at IS NULL AND f.name=json_extract(?,'$['||c.depth||']') COLLATE NOCASE AND c.depth<?`,
  )
    .bind(JSON.stringify(parts), parts.length, JSON.stringify(parts), parts.length)
    .all<{ kind: 'file' | 'folder'; path: string; depth: number; data: string }>();
  for (let depth = 1; depth <= parts.length; depth++) {
    const found = rows.results.filter((r) => r.depth === depth);
    if (found.length > 1) fail(409, '路径存在同名文件，请在网页中重命名');
    if (!found.length) return null;
    if (found[0].kind === 'file' && JSON.parse(found[0].data).status !== 'ready')
      fail(423, '该路径正在上传');
    if (depth < parts.length && found[0].kind === 'file') return null;
    if (depth === parts.length)
      return {
        kind: found[0].kind,
        path: found[0].path,
        row: JSON.parse(found[0].data),
      } as DavNode;
  }
  return null;
}
export async function parent(env: Env, path: string) {
  const node = await resolve(env, parentPath(path));
  if (!node || node.kind !== 'folder') fail(409, '父目录不存在');
  return node.row.id === 'root' ? null : node.row.id;
}
export async function tree(env: Env, node: DavNode): Promise<DavNode[]> {
  if (node.kind === 'file') return [node];
  const folders = await env.DB.prepare(
    `WITH RECURSIVE t(id,path) AS (
    SELECT ?,? UNION ALL SELECT f.id,t.path||'/'||f.name FROM folders f JOIN t ON f.parent_id=t.id WHERE f.deleted_at IS NULL LIMIT 1001
  ) SELECT f.*,t.path FROM folders f JOIN t ON f.id=t.id`,
  )
    .bind(node.row.id, node.path)
    .all<FolderRecord & { path: string }>();
  if (folders.results.length > 1000) fail(507, '单次目录操作超过1000项，请分批操作');
  const byId = new Map(folders.results.map((f) => [f.id, f.path]));
  const files = await env.DB.prepare(
    'SELECT * FROM files WHERE folder_id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL LIMIT 1001',
  )
    .bind(JSON.stringify([...byId.keys()]))
    .all<FileRecord>();
  if (files.results.some((f) => f.status !== 'ready')) fail(423, '目录中有进行中的上传');
  const nodes: DavNode[] = [
    ...folders.results.map((f) => ({ kind: 'folder' as const, row: f, path: f.path })),
    ...files.results.map((f) => ({
      kind: 'file' as const,
      row: f,
      path: childPath(byId.get(f.folder_id!)!, f.name),
    })),
  ];
  if (nodes.length > 1000) fail(507, '单次目录操作超过1000项，请分批操作');
  if (new Set(nodes.map((n) => n.path.toLowerCase())).size !== nodes.length)
    fail(409, '目录存在同名文件，请在网页中重命名');
  return nodes;
}
export function trashStatements(env: Env, nodes: DavNode[]) {
  const statements: D1PreparedStatement[] = [];
  if (!nodes.length) return statements;
  const fileIds = JSON.stringify(nodes.filter((n) => n.kind === 'file').map((n) => n.row.id));
  statements.push(
    env.DB.prepare(
      'UPDATE files SET deleted_at=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?))',
    ).bind(now(), now(), fileIds),
  );
  for (const [table, flag] of [
    ['file_shares', 'enabled'],
    ['markdown_pages', 'published'],
    ['image_hosts', 'enabled'],
  ])
    statements.push(
      env.DB.prepare(
        `UPDATE ${table} SET ${flag}=0 WHERE file_id IN(SELECT value FROM json_each(?))`,
      ).bind(fileIds),
    );
  const folders = nodes.filter((n) => n.kind === 'folder');
  const depths = [...new Set(folders.map((n) => n.path.split('/').length))].sort((a, b) => b - a);
  for (const depth of depths) {
    const ids = JSON.stringify(
      folders.filter((n) => n.path.split('/').length === depth).map((n) => n.row.id),
    );
    statements.push(
      env.DB.prepare(
        'UPDATE folders SET deleted_at=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?))',
      ).bind(now(), now(), ids),
    );
  }
  statements.push(
    env.DB.prepare('DELETE FROM webdav_locks WHERE path IN(SELECT value FROM json_each(?))').bind(
      JSON.stringify(nodes.map((n) => n.path)),
    ),
  );
  return statements;
}
export async function putObject(
  c: AppContext,
  name: string,
  source?: { key: string; size: number; mime: string },
) {
  const rawSize = c.req.header('Content-Length');
  const size = source?.size ?? Number(rawSize);
  if (!source && (rawSize === undefined || !/^\d+$/.test(rawSize)))
    fail(411, 'WebDAV上传需要Content-Length');
  if (!Number.isSafeInteger(size) || size < 0) fail(400, '文件大小无效');
  if (!source && size > DAV_MAX_UPLOAD)
    fail(413, 'WebDAV单次上传最多100MB；大文件请使用网页分片上传');
  const key = await reserve(c.env, size);
  let stream: ReadableStream | null = c.req.raw.body;
  if (source) {
    const object = await c.env.BUCKET.get(source.key);
    if (!object) fail(404, '源文件对象不存在');
    stream = object.body;
  }
  const fixed = new FixedLengthStream(size);
  const controller = new AbortController();
  let inputFailed = false,
    storageFailed = false;
  const pump = (
    stream
      ? stream.pipeTo(fixed.writable, { signal: controller.signal })
      : (async () => {
          const writer = fixed.writable.getWriter();
          await writer.close();
        })()
  ).catch((error) => {
    if (!storageFailed) inputFailed = true;
    throw error;
  });
  const write = c.env.BUCKET.put(key, fixed.readable).catch((error) => {
    storageFailed = !inputFailed;
    controller.abort();
    throw error;
  });
  const [stored, transferred] = await Promise.allSettled([write, pump]);
  if (storageFailed) fail(502, '存储服务暂时无法写入，请重试');
  if (stored.status === 'rejected' || transferred.status === 'rejected')
    fail(400, '上传中断或文件大小不符');
  const object = stored.value;
  if (!object || object.size !== size) fail(400, '文件大小不符');
  let mime = source?.mime || mimeFor(name);
  if (!source && !isText(mime) && mime !== 'application/octet-stream' && size) {
    const head = await c.env.BUCKET.get(key, { range: { offset: 0, length: Math.min(32, size) } });
    if (!head || sniff(new Uint8Array(await head.arrayBuffer())) !== mime)
      mime = 'application/octet-stream';
  }
  await checkWriteLease(c);
  return { key, size, mime, etag: object.etag };
}
export function fileStatements(
  env: Env,
  path: string,
  folder: string | null,
  object: { key: string; size: number; mime: string; etag: string },
  existing: DavNode | null,
) {
  const statements: D1PreparedStatement[] = [];
  const id = existing?.row.id || uuid();
  if (existing?.kind === 'folder') fail(405, '不能覆盖文件夹');
  if (existing?.kind === 'file') {
    // Image-host MD5 URLs must retain their original immutable bytes.
    statements.push(
      env.DB.prepare(
        "UPDATE files SET object_key=?,size=?,mime=?,etag=?,version=version+1,updated_at=? WHERE id=? AND status='ready' AND deleted_at IS NULL",
      ).bind(object.key, object.size, object.mime, object.etag, now(), id),
    );
    statements.push(cleanupStatement(env, existing.row.object_key));
    statements.push(env.DB.prepare('UPDATE image_hosts SET enabled=0 WHERE file_id=?').bind(id));
  } else
    statements.push(
      env.DB.prepare(
        "INSERT INTO files(id,name,folder_id,object_key,size,mime,etag,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'ready',?,?)",
      ).bind(
        id,
        path.slice(path.lastIndexOf('/') + 1),
        folder,
        object.key,
        object.size,
        object.mime,
        object.etag,
        now(),
        now(),
      ),
    );
  statements.push(releaseStatement(env, object.key));
  return { id, statements };
}
