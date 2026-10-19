import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import {
  filename,
  filePatch,
  folderInput,
  folderPatch,
  identifier,
  markdownInput,
} from '../shared/validation';

interface Lock {
  path: string;
  depth: string;
}
interface Target {
  path: string;
  membership?: boolean;
  descendants?: boolean;
}
interface FileLocation {
  name: string;
  folder_id: string | null;
}
const childPath = (parent: string, name: string) => `${parent.replace(/\/$/, '')}/${name}`;
const pathKey = (path: string) => path.replace(/\/$/, '').toLowerCase();
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/dav';
function affects(lock: Lock, target: Target) {
  const locked = pathKey(lock.path),
    path = pathKey(target.path);
  const covers = (candidate: string) =>
    locked === candidate || (lock.depth === 'infinity' && candidate.startsWith(locked + '/'));
  return (
    covers(path) ||
    (target.membership && covers(parentPath(path))) ||
    (target.descendants && locked.startsWith(path + '/'))
  );
}

// Resolve database IDs to the same decoded namespace that DAV locks protect.
// Unknown or batch mutations fail closed; bodies for raw uploads are never read here.
async function webTargets(c: AppContext): Promise<Target[] | null> {
  const match = /^\/api\/(admin|v1)\/(.*)$/.exec(c.req.path)!;
  const api = match[1],
    method = c.req.method;
  let parts: string[];
  try {
    parts = match[2].split('/').map(decodeURIComponent);
  } catch {
    fail(400, '路径无效');
  }
  const [kind, id, action] = parts;
  const targets: Target[] = [];
  const folderPaths = new Map<string, string>();
  const folderPath = async (folderId: string | null): Promise<string> => {
    if (!folderId) return '/dav/';
    const cached = folderPaths.get(folderId);
    if (cached) return cached;
    const rows = await c.env.DB.prepare(
      `WITH RECURSIVE chain(id,name,parent_id,depth) AS (
        SELECT id,name,parent_id,0 FROM folders WHERE id=?
        UNION ALL SELECT f.id,f.name,f.parent_id,c.depth+1 FROM folders f
        JOIN chain c ON f.id=c.parent_id WHERE c.depth<255
      ) SELECT name,parent_id FROM chain ORDER BY depth DESC`,
    )
      .bind(folderId)
      .all<{ name: string; parent_id: string | null }>();
    // Broken/deeper-than-supported ancestry cannot safely be matched against a DAV path.
    if (!rows.results.length || rows.results[0].parent_id !== null)
      fail(423, '目录状态无法确认，请刷新后重试');
    const path = '/dav/' + rows.results.map((row) => row.name).join('/');
    folderPaths.set(folderId, path);
    return path;
  };
  const fileTarget = async (fileId: string, membership = false) => {
    const row = await c.env.DB.prepare('SELECT name,folder_id FROM files WHERE id=?')
      .bind(fileId)
      .first<FileLocation>();
    if (row)
      targets.push({ path: childPath(await folderPath(row.folder_id), row.name), membership });
    return row;
  };
  const json = async () => {
    // Hono caches this result for the handler; enforceJsonLimit runs before this middleware.
    const body: unknown = await c.req.json().catch(() => fail(400, 'JSON 格式无效'));
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  };
  const newFile = async (name: unknown, folderId: unknown) => {
    const folder = folderId == null ? null : identifier.parse(folderId);
    targets.push({
      path: childPath(await folderPath(folder), filename.parse(name)),
      membership: true,
    });
  };
  const namedFolder = async (name: string) => {
    const row = await c.env.DB.prepare(
      'SELECT id FROM folders WHERE name=? AND parent_id IS NULL AND deleted_at IS NULL',
    )
      .bind(name)
      .first<{ id: string }>();
    if (!row) targets.push({ path: '/dav/' + name, membership: true });
    return row;
  };
  const imageDestination = async () => {
    const folder = await namedFolder('Image-hosting');
    // MD5 is not known until the image stream is hashed, so protect this destination subtree.
    targets.push({ path: '/dav/Image-hosting', descendants: true });
    // Deduplication may re-enable a hosted image that was moved out of that directory.
    const existing = await c.env.DB.prepare(
      'SELECT f.name,f.folder_id FROM files f JOIN image_hosts i ON i.file_id=f.id WHERE f.folder_id IS NOT ? OR ? IS NULL',
    )
      .bind(folder?.id ?? null, folder?.id ?? null)
      .all<FileLocation>();
    for (const row of existing.results)
      targets.push({ path: childPath(await folderPath(row.folder_id), row.name) });
  };

  if (kind === 'files') {
    if (method === 'POST' && ((api === 'admin' && id === 'upload') || (api === 'v1' && !id))) {
      await newFile(c.req.query('name'), c.req.query('folder_id') || null);
    } else if (id && method === 'PATCH' && !action) {
      const input = filePatch.parse(await json());
      const row = await fileTarget(id, true);
      if (row)
        await newFile(
          input.name ?? row.name,
          input.folder_id === undefined ? row.folder_id : input.folder_id,
        );
    } else if (id && (method === 'DELETE' || (method === 'POST' && action === 'restore'))) {
      await fileTarget(id, true);
    } else return null;
  } else if (kind === 'folders') {
    if (method === 'POST' && !id) {
      const input = folderInput.parse(await json());
      targets.push({
        path: childPath(await folderPath(input.parent_id), input.name),
        membership: true,
      });
    } else if (id) {
      const row = await c.env.DB.prepare('SELECT name,parent_id FROM folders WHERE id=?')
        .bind(id)
        .first<{ name: string; parent_id: string | null }>();
      if (row) {
        targets.push({ path: await folderPath(id), membership: true, descendants: true });
        if (method === 'PATCH') {
          const input = folderPatch.parse(await json());
          targets.push({
            path: childPath(
              await folderPath(input.parent_id === undefined ? row.parent_id : input.parent_id),
              input.name ?? row.name,
            ),
            membership: true,
            descendants: true,
          });
        }
      }
    } else return null;
  } else if (kind === 'uploads') {
    if (method === 'POST' && !id) {
      const input = await json();
      await newFile(input.name, input.folder_id);
    } else if (id) {
      const session = await c.env.DB.prepare('SELECT file_id FROM upload_sessions WHERE id=?')
        .bind(id)
        .first<{ file_id: string }>();
      if (session) await fileTarget(session.file_id, true);
    } else return null;
  } else if (kind === 'markdown') {
    if (method === 'POST' && !id) {
      const input = markdownInput.parse(await json());
      await namedFolder('Markdown');
      targets.push({ path: childPath('/dav/Markdown', input.name), membership: true });
    } else if (id) await fileTarget(id);
    else return null;
  } else if (kind === 'html-hosting' && method === 'POST' && id === 'folder' && !action) {
    await namedFolder('Html-hosting');
  } else if (kind === 'images') {
    if (method === 'POST' && !id) {
      if (api === 'admin') await fileTarget(identifier.parse((await json()).file_id), true);
      await imageDestination();
    } else if (method === 'POST' && id === 'folder') {
      await namedFolder('Image-hosting');
    } else if (id) {
      const image = await c.env.DB.prepare('SELECT file_id FROM image_hosts WHERE name=?')
        .bind(id)
        .first<{ file_id: string }>();
      if (image) await fileTarget(image.file_id, action === 'permanent');
    } else return null;
  } else return null;
  return targets;
}

async function checkWebLocks(c: AppContext) {
  const locks = await c.env.DB.prepare('SELECT path,depth FROM webdav_locks WHERE expires_at>?')
    .bind(now())
    .all<Lock>();
  if (!locks.results.length) return;
  const targets = await webTargets(c);
  if (!targets || locks.results.some((lock) => targets.some((target) => affects(lock, target))))
    fail(423, 'WebDAV客户端正在编辑，请关闭文件后重试');
}

const isDav = (c: AppContext) => c.req.path === '/dav' || c.req.path.startsWith('/dav/');

// Web writes retain their existing concurrent/CAS behavior. DAV namespace mutations are
// exclusive against both other DAV requests and registered web writes. Each acquisition
// is a single conditional SQL write, so neither side can enter during the other's lease.
// Upload bodies stay streamed; reads are never blocked. Crashed registrations expire.
export const storageWriteLease: MiddlewareHandler<AppEnv> = async (c, next) => {
  const dav = isDav(c);
  if (
    ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(c.req.method) ||
    (!dav &&
      !/^\/api\/(?:admin|v1)\/(?:files|folders|uploads|markdown|images|trash)(?:\/|$)/.test(
        c.req.path,
      ) &&
      !(c.req.method === 'POST' && c.req.path === '/api/admin/html-hosting/folder'))
  )
    return next();
  const owner = uuid(),
    timestamp = now();
  await c.env.DB.prepare('DELETE FROM storage_web_writes WHERE expires_at<=?')
    .bind(timestamp)
    .run();
  const acquired = dav
    ? await c.env.DB.prepare(
        `UPDATE storage_write_lease SET owner=?,expires_at=? WHERE id=1 AND expires_at<=?
      AND NOT EXISTS(SELECT 1 FROM storage_web_writes WHERE expires_at>?)`,
      )
        .bind(owner, timestamp + 30 * 60000, timestamp, timestamp)
        .run()
    : await c.env.DB.prepare(
        `INSERT INTO storage_web_writes(owner,expires_at) SELECT ?,?
      WHERE NOT EXISTS(SELECT 1 FROM storage_write_lease WHERE id=1 AND expires_at>?)`,
      )
        .bind(owner, timestamp + 30 * 60000, timestamp)
        .run();
  if (!acquired.meta.changes) {
    c.header('Retry-After', '2');
    fail(423, '另一个文件操作正在进行，请重试');
  }
  c.set('writeLease', owner);
  try {
    // Web clients do not submit DAV lock tokens. Do not let them bypass a DAV editing lock.
    if (!dav) await checkWebLocks(c);
    await next();
  } finally {
    await c.env.DB.prepare(
      dav
        ? 'UPDATE storage_write_lease SET owner=NULL,expires_at=0 WHERE id=1 AND owner=?'
        : 'DELETE FROM storage_web_writes WHERE owner=?',
    )
      .bind(owner)
      .run();
  }
};
export async function checkWriteLease(c: AppContext) {
  const active = await c.env.DB.prepare(
    isDav(c)
      ? 'SELECT 1 FROM storage_write_lease WHERE id=1 AND owner=? AND expires_at>?'
      : 'SELECT 1 FROM storage_web_writes WHERE owner=? AND expires_at>?',
  )
    .bind(c.get('writeLease') || '', now())
    .first();
  if (!active) fail(423, '文件操作已超时，请重试');
  if (
    c.get('davCredentialId') &&
    !(await c.env.DB.prepare(
      'SELECT 1 FROM webdav_credentials WHERE id=? AND revoked_at IS NULL AND expires_at>?',
    )
      .bind(c.get('davCredentialId')!, now())
      .first())
  )
    fail(401, 'WebDAV凭据已失效');
}
