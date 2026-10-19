import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { webdavAuth } from './webdav-auth';
import { storageWriteLease, checkWriteLease } from './write-lease';
import {
  parsePropfind,
  parseProppatch,
  parseLock,
  XmlParseError,
  type DavPropertyName,
} from './webdav-xml';
import {
  davPath,
  href,
  checkDavPathLength,
  destinationMime,
  childPath,
  parentPath,
  resolve,
  children,
  parent,
  checkTreeDestinationPaths,
  tree,
  nodeId,
  etag,
  putObject,
  fileStatements,
  trashStatements,
  type DavNode,
} from './webdav-store';
import { locks, covers, conditions, ifTokens, checkLocks, type DavLock } from './webdav-locks';
import { serveObject, reserve } from './storage';
import { siteOriginAllowed } from './origins';
import { DAV_COPY_LIMIT, prepareCopy } from './webdav-copy';
import { STORAGE_LIMIT } from './quota';

const ALLOW =
  'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, DELETE, COPY, MOVE, LOCK, UNLOCK';
const xml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[s]!,
  );
const responseXml = (body: string, status = 207) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>${body}`, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
const propertyKey = (p: DavPropertyName) => JSON.stringify([p.namespace, p.name]);
function propTag(p: DavPropertyName, content = '') {
  if (!p.namespace) return `<${p.name} xmlns="">${content}</${p.name}>`;
  if (p.namespace === 'http://www.w3.org/XML/1998/namespace')
    return `<xml:${p.name}>${content}</xml:${p.name}>`;
  return `<P:${p.name} xmlns:P="${xml(p.namespace)}">${content}</P:${p.name}>`;
}
async function textBody(c: AppContext) {
  if (Number(c.req.header('Content-Length') || 0) > 65536) fail(413, 'XML请求过大');
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '',
    size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        fail(413, 'XML请求过大');
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return fail(400, 'XML编码无效');
  }
}
function lockXml(lock: DavLock) {
  let owner = `<D:owner>${xml(lock.owner)}</D:owner>`;
  try {
    const stored = JSON.parse(lock.owner) as { format?: string; text?: unknown; href?: boolean };
    if (
      stored?.format === 'rcloud-dav-owner-v1' &&
      (stored.text === null || typeof stored.text === 'string')
    )
      owner =
        stored.text === null
          ? ''
          : `<D:owner>${stored.href ? `<D:href>${xml(stored.text)}</D:href>` : xml(stored.text)}</D:owner>`;
  } catch {
    /* Existing plain-text owners remain readable. */
  }
  return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${lock.depth}</D:depth>${owner}<D:timeout>Second-${Math.max(0, Math.ceil((lock.expires_at - now()) / 1000))}</D:timeout><D:locktoken><D:href>${xml(lock.token)}</D:href></D:locktoken><D:lockroot><D:href>${xml(href(lock.path))}</D:href></D:lockroot></D:activelock>`;
}
function lockStatement(c: AppContext, lock: DavLock) {
  return c.env.DB.prepare(
    'INSERT INTO webdav_locks(path,token,credential_id,depth,owner,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET token=excluded.token,credential_id=excluded.credential_id,depth=excluded.depth,owner=excluded.owner,expires_at=excluded.expires_at',
  ).bind(lock.path, lock.token, lock.credential_id, lock.depth, lock.owner, lock.expires_at);
}
async function canonicalMissingPath(c: AppContext, path: string) {
  const parentNode = await resolve(c.env, parentPath(path));
  return parentNode?.kind === 'folder'
    ? childPath(parentNode.path, path.slice(path.lastIndexOf('/') + 1))
    : path;
}
const supportedLock =
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';
async function propfind(c: AppContext, node: DavNode) {
  const depth = c.req.header('Depth') ?? 'infinity';
  if (!['0', '1'].includes(depth))
    return responseXml('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403);
  const query = parsePropfind(await textBody(c));
  const nodes =
    depth === '1' && node.kind === 'folder' ? [node, ...(await children(c.env, node))] : [node];
  const active = await locks(c);
  // The whole DAV tree shares the same allocation budget, including trash and in-flight writes.
  const used =
    (await c.env.DB.prepare(
      'SELECT COALESCE(SUM(size),0) AS used FROM storage_allocations',
    ).first<number>('used')) ?? 0;
  // One property query for the whole response avoids a database query per listed item.
  const dead = (
    await c.env.DB.prepare(
      'SELECT * FROM webdav_properties WHERE resource_id IN(SELECT value FROM json_each(?)) LIMIT 10001',
    )
      .bind(JSON.stringify(nodes.map(nodeId)))
      .all<{ resource_id: string; namespace: string; name: string; value: string }>()
  ).results;
  if (dead.length > 10000) fail(507, '属性数量过多');
  const output = nodes
    .map((n) => {
      const properties = new Map<string, { p: DavPropertyName; value: string }>();
      const add = (name: string, value: string) =>
        properties.set(propertyKey({ namespace: 'DAV:', name }), {
          p: { namespace: 'DAV:', name },
          value,
        });
      add('displayname', xml(n.row.name));
      add('resourcetype', n.kind === 'folder' ? '<D:collection/>' : '');
      add('creationdate', new Date(n.row.created_at).toISOString());
      add('getlastmodified', new Date(n.row.updated_at).toUTCString());
      add('getetag', xml(etag(n)));
      add('getcontentlength', String(n.kind === 'file' ? n.row.size : 0));
      add('getcontenttype', xml(n.kind === 'file' ? n.row.mime : 'httpd/unix-directory'));
      add('quota-used-bytes', String(used));
      add('quota-available-bytes', String(Math.max(0, STORAGE_LIMIT - used)));
      add('supportedlock', supportedLock);
      add(
        'lockdiscovery',
        active
          .filter((l) => covers(l, n.path))
          .map(lockXml)
          .join(''),
      );
      for (const p of dead.filter((p) => p.resource_id === nodeId(n)))
        properties.set(propertyKey(p), { p, value: xml(p.value) });
      const requested =
        query.mode === 'prop'
          ? query.properties
          : [...properties.values()].map((v) => v.p).concat(query.properties);
      const seen = new Set<string>(),
        ok: string[] = [],
        missing: string[] = [];
      for (const p of requested) {
        const key = propertyKey(p);
        if (seen.has(key)) continue;
        seen.add(key);
        const value = properties.get(key);
        if (value) ok.push(propTag(p, query.mode === 'propname' ? '' : value.value));
        else missing.push(propTag(p));
      }
      return `<D:response><D:href>${xml(href(n.path, n.kind === 'folder'))}</D:href>${ok.length ? `<D:propstat><D:prop>${ok.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` : ''}${missing.length ? `<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>` : ''}</D:response>`;
    })
    .join('');
  return responseXml(`<D:multistatus xmlns:D="DAV:">${output}</D:multistatus>`);
}
export const webdavRoutes = new Hono<AppEnv>();
webdavRoutes.use('*', async (c, next) => {
  await next();
  c.header('DAV', '1, 2');
  c.header('MS-Author-Via', 'DAV');
  c.header('Allow', ALLOW);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
});
webdavRoutes.use('*', webdavAuth);
webdavRoutes.use('*', storageWriteLease);
webdavRoutes.all('*', async (c) => {
  const method = c.req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204 });
  let path = davPath(new URL(c.req.url).pathname);
  const node = await resolve(c.env, path);
  path = node?.path ?? (await canonicalMissingPath(c, path));
  if (!conditions(c, node)) {
    if (['GET', 'HEAD'].includes(method))
      return new Response(null, { status: 304, headers: node ? { ETag: etag(node) } : {} });
    fail(412, '文件已存在或已改变');
  }
  if (['GET', 'HEAD', 'PROPFIND'].includes(method) && c.req.header('If'))
    await ifTokens(c, path, await locks(c));
  if (method === 'PROPFIND') {
    if (!node) fail(404, '文件不存在');
    return propfind(c, node);
  }
  if (method === 'GET' || method === 'HEAD') {
    if (!node) fail(404, '文件不存在');
    if (node.kind === 'folder')
      return new Response(method === 'HEAD' ? null : 'RCloud WebDAV', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    return serveObject(c.env, c.req.raw, node.row.object_key, node.row.name, node.row.mime, false);
  }
  if (!ALLOW.split(', ').includes(method)) fail(405, '不支持此方法');
  if (path === '/dav/' && ['PUT', 'DELETE', 'MOVE', 'COPY', 'MKCOL'].includes(method))
    fail(403, '不能修改WebDAV根目录');
  const active = await locks(c);
  const lockState = { active, submitted: await ifTokens(c, path, active) };
  if (method === 'MKCOL') {
    if (node) fail(405, '路径已存在');
    checkDavPathLength(path, true);
    if (await textBody(c)) fail(415, 'MKCOL不接受请求体');
    const folder = await parent(c.env, path);
    await checkLocks(c, path, { membership: true }, lockState);
    await checkWriteLease(c);
    await c.env.DB.prepare(
      'INSERT INTO folders(id,name,parent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
      .bind(uuid(), path.slice(path.lastIndexOf('/') + 1), folder, now(), now())
      .run();
    return new Response(null, { status: 201 });
  }
  if (method === 'PUT') {
    if (node?.kind === 'folder') fail(405, '不能覆盖文件夹');
    if (c.req.header('Content-Range')) fail(400, '不支持分段PUT');
    const folder = await parent(c.env, path);
    await checkLocks(c, path, { membership: !node }, lockState);
    if (
      node &&
      (await c.env.DB.prepare('SELECT 1 FROM image_hosts WHERE file_id=?')
        .bind(node.row.id)
        .first())
    )
      fail(409, '图床文件不可覆盖，请使用新文件名');
    const object = await putObject(c, path.slice(path.lastIndexOf('/') + 1));
    await c.env.DB.batch(fileStatements(c.env, path, folder, object, node).statements);
    return new Response(null, { status: node ? 204 : 201, headers: { ETag: `"${object.etag}"` } });
  }
  if (method === 'DELETE') {
    if (!node) fail(404, '文件不存在');
    if (node.kind === 'folder' && c.req.header('Depth') && c.req.header('Depth') !== 'infinity')
      fail(400, 'DELETE文件夹需要Depth infinity');
    await checkLocks(c, path, { membership: true, descendants: true }, lockState);
    const nodes = await tree(c.env, node);
    const statements = trashStatements(c.env, nodes);
    if (statements.length + 20 > 50) fail(507, '目录层级过深，请分批删除');
    await checkWriteLease(c);
    await c.env.DB.batch(statements);
    return new Response(null, { status: 204 });
  }
  if (method === 'MOVE' || method === 'COPY') {
    if (!node) fail(404, '源文件不存在');
    const raw = c.req.header('Destination');
    if (!raw) fail(400, '缺少Destination');
    let destination: URL;
    try {
      destination = new URL(raw, c.req.url);
    } catch {
      return fail(400, 'Destination无效');
    }
    if (
      (destination.origin !== new URL(c.req.url).origin &&
        !siteOriginAllowed(c.env, destination.origin)) ||
      destination.search ||
      destination.hash ||
      destination.username ||
      destination.password
    )
      fail(502, '仅支持同一站点内复制或移动');
    let target = davPath(destination.pathname);
    const existing = await resolve(c.env, target);
    target = existing?.path ?? (await canonicalMissingPath(c, target));
    if (
      target === '/dav/' ||
      target === path ||
      target.startsWith(path + '/') ||
      path.startsWith(target + '/')
    )
      fail(403, '目标路径冲突');
    if (c.req.header('Overwrite') && !['T', 'F'].includes(c.req.header('Overwrite')!))
      fail(400, 'Overwrite无效');
    if (existing && c.req.header('Overwrite') === 'F') fail(412, '目标已存在');
    if (method === 'MOVE' && c.req.header('Depth') && c.req.header('Depth') !== 'infinity')
      fail(400, 'MOVE需要Depth infinity');
    const copyDepth = c.req.header('Depth') || 'infinity';
    if (method === 'COPY' && !['0', 'infinity'].includes(copyDepth)) fail(400, 'COPY Depth无效');
    await checkTreeDestinationPaths(c.env, node, target, method === 'MOVE' || copyDepth !== '0');
    const folder = await parent(c.env, target);
    if (method === 'MOVE')
      await checkLocks(c, path, { membership: true, descendants: true }, lockState);
    await checkLocks(c, target, { membership: !existing, descendants: true }, lockState);
    const targetName = target.slice(target.lastIndexOf('/') + 1);
    const targetMime =
      node.kind === 'file' ? await destinationMime(c.env, node.row, targetName) : undefined;
    const replaced = existing ? await tree(c.env, existing) : [];
    const statements = trashStatements(c.env, replaced);
    // Replacing a resource keeps the destination root's existing lock scope.
    for (const lock of active.filter((l) => l.path === target))
      statements.push(lockStatement(c, lock));
    if (method === 'MOVE') {
      statements.push(
        node.kind === 'file'
          ? c.env.DB.prepare(
              'UPDATE files SET name=?,folder_id=?,mime=?,updated_at=? WHERE id=?',
            ).bind(targetName, folder, targetMime!, now(), node.row.id)
          : c.env.DB.prepare('UPDATE folders SET name=?,parent_id=?,updated_at=? WHERE id=?').bind(
              targetName,
              folder,
              now(),
              node.row.id,
            ),
      );
      // RFC4918 removes locks rooted in the moved subtree; parent locks remain.
      statements.push(
        c.env.DB.prepare('DELETE FROM webdav_locks WHERE path=? OR substr(path,1,?)=?').bind(
          path,
          path.length + 1,
          path + '/',
        ),
      );
    } else {
      const nodes = copyDepth === '0' ? [node] : await tree(c.env, node);
      if (nodes.length > DAV_COPY_LIMIT) fail(507, `单次COPY最多${DAV_COPY_LIMIT}项，请分批复制`);
      const files = nodes.filter((n) => n.kind === 'file').length;
      const folderLevels = new Set(
        nodes.filter((n) => n.kind === 'folder').map((n) => n.path.split('/').length),
      ).size;
      const copyStatements = folderLevels + (files ? 2 : 0) + 1;
      // Keep headroom for authentication, path/If resolution, quota reservation and lease checks.
      const preparation = 21 + (c.req.header('If')?.match(/>\s*\(/g)?.length || 0);
      if (statements.length + copyStatements + files * 2 + preparation > 50)
        fail(507, '复制目标目录过深或内容过多，请分批复制');
      statements.push(...(await prepareCopy(c, nodes, path, target, folder, targetMime)));
    }
    if (statements.length + 21 > 50) fail(507, '目标目录层级过深，请分批操作');
    await checkWriteLease(c);
    await c.env.DB.batch(statements);
    return new Response(null, { status: existing ? 204 : 201 });
  }
  if (method === 'LOCK') {
    const body = await textBody(c);
    const seconds = Math.min(
      3600,
      Math.max(60, Number(/Second-(\d+)/i.exec(c.req.header('Timeout') || '')?.[1]) || 600),
    );
    if (!body.trim()) {
      const lock = active.find(
        (l) =>
          covers(l, path) &&
          lockState.submitted.has(l.token) &&
          l.credential_id === c.get('davCredentialId'),
      );
      if (!lock) fail(412, '锁不存在或不属于此凭据');
      lock.expires_at = now() + seconds * 1000;
      await checkWriteLease(c);
      await c.env.DB.prepare('UPDATE webdav_locks SET expires_at=? WHERE token=?')
        .bind(lock.expires_at, lock.token)
        .run();
      return responseXml(
        `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${lockXml(lock)}</D:lockdiscovery></D:prop>`,
        200,
      );
    }
    const info = parseLock(body),
      depth = c.req.header('Depth') || 'infinity';
    if (!['0', 'infinity'].includes(depth)) fail(400, 'LOCK Depth无效');
    if (
      active.some(
        (l) =>
          covers(l, path) ||
          (depth === 'infinity' && l.path.startsWith(path.replace(/\/$/, '') + '/')),
      )
    )
      fail(423, '路径已锁定');
    if (active.length >= 100) fail(507, '有效锁数量过多');
    const statements: D1PreparedStatement[] = [];
    if (!node) {
      const folder = await parent(c.env, path);
      await checkLocks(c, path, { membership: true }, lockState);
      const key = await reserve(c.env, 0);
      const object = await c.env.BUCKET.put(key, new Uint8Array());
      if (!object) fail(500, '创建文件失败');
      statements.push(
        ...fileStatements(
          c.env,
          path,
          folder,
          { key, size: 0, mime: 'application/octet-stream', etag: object.etag },
          null,
        ).statements,
      );
    }
    const lock: DavLock = {
      path,
      token: `urn:uuid:${uuid()}`,
      credential_id: c.get('davCredentialId')!,
      depth,
      owner: JSON.stringify({
        format: 'rcloud-dav-owner-v1',
        text: info.owner,
        href: info.ownerHref,
      }),
      expires_at: now() + seconds * 1000,
    };
    statements.push(lockStatement(c, lock));
    await checkWriteLease(c);
    await c.env.DB.batch(statements);
    const response = responseXml(
      `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${lockXml(lock)}</D:lockdiscovery></D:prop>`,
      node ? 200 : 201,
    );
    response.headers.set('Lock-Token', `<${lock.token}>`);
    return response;
  }
  if (method === 'UNLOCK') {
    const token = /^<([^>]+)>$/.exec(c.req.header('Lock-Token') || '')?.[1];
    if (!token) fail(400, '缺少Lock-Token');
    const lock = active.find(
      (l) => l.token === token && covers(l, path) && l.credential_id === c.get('davCredentialId'),
    );
    if (!lock) fail(409, '锁不存在或不属于此凭据');
    await checkWriteLease(c);
    const result = await c.env.DB.prepare(
      'DELETE FROM webdav_locks WHERE token=? AND credential_id=? AND expires_at>?',
    )
      .bind(token, c.get('davCredentialId')!, now())
      .run();
    if (!result.meta.changes) fail(409, '锁不存在或不属于此凭据');
    return new Response(null, { status: 204 });
  }
  if (method === 'PROPPATCH') {
    if (!node) fail(404, '文件不存在');
    await checkLocks(c, path, {}, lockState);
    const changes = parseProppatch(await textBody(c));
    const protectedChange = changes.some((p) => p.property.namespace === 'DAV:');
    if (!protectedChange) {
      // Dead properties have no side effects: the last ordered operation determines each final value.
      // Batch them so a valid XML request cannot exhaust D1's per-request query budget.
      const final = [...new Map(changes.map((p) => [propertyKey(p.property), p])).values()];
      const removed = final.filter((p) => p.action === 'remove').map((p) => p.property);
      const written = final
        .filter((p) => p.action === 'set')
        .map((p) => ({ ...p.property, value: p.value }));
      const statements: D1PreparedStatement[] = [];
      if (removed.length)
        statements.push(
          c.env.DB.prepare(
            `DELETE FROM webdav_properties WHERE resource_id=? AND (namespace,name) IN
        (SELECT json_extract(value,'$.namespace'),json_extract(value,'$.name') FROM json_each(?))`,
          ).bind(nodeId(node), JSON.stringify(removed)),
        );
      if (written.length)
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO webdav_properties(resource_id,namespace,name,value)
        SELECT ?,json_extract(value,'$.namespace'),json_extract(value,'$.name'),json_extract(value,'$.value') FROM json_each(?) WHERE 1
        ON CONFLICT(resource_id,namespace,name) DO UPDATE SET value=excluded.value`,
          ).bind(nodeId(node), JSON.stringify(written)),
        );
      await checkWriteLease(c);
      await c.env.DB.batch(statements);
    }
    return responseXml(
      `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xml(href(path, node.kind === 'folder'))}</D:href>${changes.map((p) => `<D:propstat><D:prop>${propTag(p.property)}</D:prop><D:status>HTTP/1.1 ${protectedChange ? (p.property.namespace === 'DAV:' ? '403 Forbidden' : '424 Failed Dependency') : '200 OK'}</D:status></D:propstat>`).join('')}</D:response></D:multistatus>`,
    );
  }
  return fail(405, '不支持此方法');
});
webdavRoutes.onError((error, c) => {
  const status =
    error instanceof HTTPException
      ? error.status
      : error instanceof XmlParseError
        ? 400
        : /constraint|folder cycle|folder not empty|parent folder unavailable/.test(error.message)
          ? 409
          : 500;
  if (status === 500)
    console.error(JSON.stringify({ requestId: c.get('requestId'), type: error.name }));
  const response = responseXml(
    `<D:error xmlns:D="DAV:"><D:responsedescription>${xml(status === 500 ? 'WebDAV操作失败' : error.message)}</D:responsedescription></D:error>`,
    status,
  );
  if (status === 401)
    response.headers.set('WWW-Authenticate', 'Basic realm="RCloud WebDAV", charset="UTF-8"');
  return response;
});
