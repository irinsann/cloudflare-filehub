import type { AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import { initializeQuota, STORAGE_LIMIT } from './quota';
import { nodeId, parentPath, type DavNode } from './webdav-store';

// Bound both R2 work and D1 statements within a Free Worker request.
export const DAV_COPY_LIMIT = 12;

/** Prepare new independent objects; the caller commits these statements with any target replacement. */
export async function prepareCopy(
  c: AppContext,
  nodes: DavNode[],
  sourcePath: string,
  targetPath: string,
  targetParent: string | null,
): Promise<D1PreparedStatement[]> {
  if (!nodes.length || nodes.length > DAV_COPY_LIMIT)
    fail(507, `单次COPY最多${DAV_COPY_LIMIT}项，请分批复制`);
  if (
    !nodes.some((node) => node.path === sourcePath) ||
    nodes.some((node) => node.path !== sourcePath && !node.path.startsWith(sourcePath + '/'))
  )
    fail(409, '复制目录结构无效');
  const timestamp = now();
  const mapped = nodes.map((node) => ({
    node,
    id: uuid(),
    path: targetPath + node.path.slice(sourcePath.length),
  }));
  const folderIds = new Map(
    mapped
      .filter((entry) => entry.node.kind === 'folder')
      .map((entry) => [entry.node.path, entry.id]),
  );
  const parentId = (node: DavNode) => {
    if (node.path === sourcePath) return targetParent;
    const id = folderIds.get(parentPath(node.path));
    if (!id) fail(409, '复制目录结构无效');
    return id;
  };
  const folders = mapped
    .filter((entry) => entry.node.kind === 'folder')
    .map((entry) => ({
      id: entry.id,
      name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
      parent_id: parentId(entry.node),
      depth: entry.path.split('/').length,
    }));
  const files = mapped
    .filter((entry) => entry.node.kind === 'file')
    .map((entry) => {
      if (entry.node.kind !== 'file') throw new Error('Invalid copy node');
      return {
        id: entry.id,
        name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
        folder_id: parentId(entry.node),
        object_key: `objects/${uuid()}`,
        source_key: entry.node.row.object_key,
        size: entry.node.row.size,
        mime: entry.node.row.mime,
        etag: '',
      };
    });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (
    !Number.isSafeInteger(total) ||
    files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0)
  )
    fail(409, '源文件大小无效');

  if (files.length) {
    await initializeQuota(c.env);
    const reservations = JSON.stringify(
      files.map((file) => ({ key: file.object_key, size: file.size })),
    );
    // Materialize capacity once so the entire copy is reserved, or no destination bytes are written.
    const reserved = await c.env.DB.batch([
      c.env.DB.prepare(
        `WITH capacity AS MATERIALIZED (
        SELECT COALESCE(SUM(size),0) AS used FROM storage_allocations
      ) INSERT INTO storage_allocations(object_key,size)
        SELECT json_extract(value,'$.key'),json_extract(value,'$.size') FROM json_each(?),capacity
        WHERE used+?<=?`,
      ).bind(reservations, total, STORAGE_LIMIT),
      c.env.DB.prepare(
        `INSERT INTO cleanup_tasks(object_key,created_at)
        SELECT object_key,? FROM storage_allocations
        WHERE object_key IN (SELECT json_extract(value,'$.key') FROM json_each(?))`,
      ).bind(timestamp, reservations),
    ]);
    if (reserved[0].meta.changes !== files.length) fail(507, '存储容量不足（总容量50GB）');
    // On failure, the durable queue and allocations remain until cleanup confirms R2 deletion.
    for (const file of files) {
      let source: R2ObjectBody | null;
      try {
        source = await c.env.BUCKET.get(file.source_key);
      } catch {
        return fail(502, '存储服务暂时无法读取，请重试');
      }
      if (!source) fail(404, '源文件对象不存在');
      if (source.size !== file.size) {
        await source.body.cancel().catch(() => undefined);
        fail(502, '源文件大小不符');
      }
      let copied: R2Object | null;
      try {
        copied = await c.env.BUCKET.put(file.object_key, source.body);
      } catch {
        if (!source.body.locked) await source.body.cancel().catch(() => undefined);
        return fail(502, '存储服务暂时无法写入，请重试');
      }
      if (!copied || copied.size !== file.size) fail(502, '复制文件完整性校验失败');
      file.etag = copied.etag;
    }
  }

  const statements: D1PreparedStatement[] = [];
  // Parent triggers require ancestors to be inserted before descendants, within the final transaction.
  for (const depth of [...new Set(folders.map((folder) => folder.depth))].sort((a, b) => a - b)) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO folders(id,name,parent_id,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.parent_id'),?,?
      FROM json_each(?)`,
      ).bind(
        timestamp,
        timestamp,
        JSON.stringify(folders.filter((folder) => folder.depth === depth)),
      ),
    );
  }
  if (files.length) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO files(id,name,folder_id,object_key,size,mime,etag,status,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.folder_id'),
        json_extract(value,'$.object_key'),json_extract(value,'$.size'),json_extract(value,'$.mime'),
        json_extract(value,'$.etag'),'ready',?,? FROM json_each(?)`,
      ).bind(timestamp, timestamp, JSON.stringify(files)),
    );
    statements.push(
      c.env.DB.prepare(
        'DELETE FROM cleanup_tasks WHERE object_key IN (SELECT value FROM json_each(?))',
      ).bind(JSON.stringify(files.map((file) => file.object_key))),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO webdav_properties(resource_id,namespace,name,value)
    SELECT json_extract(m.value,'$.new'),p.namespace,p.name,p.value FROM json_each(?) m
    JOIN webdav_properties p ON p.resource_id=json_extract(m.value,'$.old')`,
    ).bind(
      JSON.stringify(
        mapped.map((entry) => ({ old: nodeId(entry.node), new: `${entry.node.kind}:${entry.id}` })),
      ),
    ),
  );
  // The route checks its write lease and credential once after streaming, immediately before DB.batch.
  return statements;
}
