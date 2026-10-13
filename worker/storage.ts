import type { Env } from './env';
import { limit, now, uuid } from './env';
import { fail } from './errors';
export const mimeFor = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const m: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/plain',
    ts: 'text/plain',
    tsx: 'text/plain',
    jsx: 'text/plain',
    py: 'text/plain',
    css: 'text/plain',
    html: 'text/plain',
    svg: 'text/plain',
    yaml: 'text/plain',
    yml: 'text/plain',
    sql: 'text/plain',
    rs: 'text/plain',
    go: 'text/plain',
    java: 'text/plain',
    cpp: 'text/plain',
    c: 'text/plain',
    sh: 'text/plain',
    toml: 'text/plain',
    csv: 'text/plain',
    log: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return m[ext] ?? 'application/octet-stream';
};
export const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
export const isText = (mime: string) => mime.startsWith('text/') || mime === 'application/json';
export function sniff(bytes: Uint8Array): string | null {
  const prefix = (...v: number[]) => v.every((b, i) => bytes[i] === b);
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (prefix(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (prefix(255, 216, 255)) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (prefix(26, 69, 223, 163)) return 'video/webm';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  return null;
}
export async function reserve(env: Env) {
  const key = `objects/${uuid()}`;
  await env.DB.prepare('INSERT INTO cleanup_tasks(object_key,created_at) VALUES(?,?)')
    .bind(key, now())
    .run();
  return key;
}
export const releaseStatement = (env: Env, key: string) =>
  env.DB.prepare('DELETE FROM cleanup_tasks WHERE object_key=?').bind(key);
export const cleanupStatement = (env: Env, key: string) =>
  env.DB.prepare('INSERT OR IGNORE INTO cleanup_tasks(object_key,created_at) VALUES(?,?)').bind(
    key,
    now(),
  );
export async function uploadStream(env: Env, request: Request, key: string, name: string) {
  const rawSize = request.headers.get('X-File-Size');
  const size = Number(rawSize);
  if (rawSize === null || !Number.isSafeInteger(size) || size < 0)
    fail(400, '必须提供有效文件大小');
  if (size > limit(env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024)) fail(413, '超过单文件上传限制');
  if (!request.body && size > 0) fail(400, '上传内容为空');
  const fixed = new FixedLengthStream(size);
  const pump = request.body
    ? request.body.pipeTo(fixed.writable)
    : (async () => {
        const w = fixed.writable.getWriter();
        await w.close();
      })();
  let object: R2Object | null;
  try {
    const results = await Promise.all([env.BUCKET.put(key, fixed.readable), pump]);
    object = results[0];
  } catch {
    fail(400, '上传中断或实际文件大小不匹配');
  }
  if (!object || object.size !== size) fail(400, '上传完整性校验失败');
  let mime = mimeFor(name);
  if (!isText(mime) && mime !== 'application/octet-stream' && size > 0) {
    const head = await env.BUCKET.get(key, { range: { offset: 0, length: Math.min(size, 32) } });
    const detected = head ? sniff(new Uint8Array(await head.arrayBuffer())) : null;
    if (detected !== mime) mime = 'application/octet-stream';
  }
  return { size: object.size, etag: object.etag, mime };
}
export async function textObject(env: Env, key: string) {
  const head = await env.BUCKET.head(key);
  if (!head) fail(404, '文件对象不存在');
  if (head.size > limit(env.MAX_TEXT_BYTES, 1024 * 1024))
    fail(413, '文本超过在线编辑和预览大小限制');
  const object = await env.BUCKET.get(key);
  if (!object) fail(404, '文件对象不存在');
  return object.text();
}
export async function writeText(env: Env, text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limit(env.MAX_TEXT_BYTES, 1024 * 1024)) fail(413, 'Markdown 超过大小限制');
  const key = await reserve(env);
  const object = await env.BUCKET.put(key, bytes);
  if (!object) fail(500, '保存失败');
  return { key, size: object.size, etag: object.etag };
}
export function disposition(name: string, inline: boolean) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function parseRange(
  header: string,
  size: number,
): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size === 0) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const offset = Number(m[1]),
    end = m[2] ? Number(m[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset)
    return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}
export async function serveObject(
  env: Env,
  request: Request,
  key: string,
  name: string,
  mime: string,
  inline: boolean,
) {
  const head = await env.BUCKET.head(key);
  if (!head) fail(404, '文件对象不存在');
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': disposition(name, inline),
    'Content-Length': String(head.size),
    'Accept-Ranges': 'bytes',
    ETag: head.httpEtag,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
  });
  let range;
  const rangeHeader = request.headers.get('Range');
  if (
    rangeHeader &&
    (!request.headers.get('If-Range') || request.headers.get('If-Range') === head.httpEtag)
  ) {
    range = parseRange(rangeHeader, head.size);
    if (!range) {
      headers.set('Content-Range', `bytes */${head.size}`);
      headers.delete('Content-Length');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Length', String(range.length));
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
  }
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const object = await env.BUCKET.get(key, range ? { range } : undefined);
  if (!object) fail(404, '文件对象不存在');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
export async function cleanup(env: Env) {
  const cutoff = now() - 3600000;
  const tasks = await env.DB.prepare(
    'SELECT object_key FROM cleanup_tasks WHERE created_at<? ORDER BY created_at LIMIT 10',
  )
    .bind(cutoff)
    .all<{ object_key: string }>();
  for (const task of tasks.results) {
    const used = await env.DB.prepare(
      "SELECT id FROM files WHERE object_key=? AND status='ready' UNION ALL SELECT id FROM markdown_pages WHERE snapshot_key=? UNION ALL SELECT id FROM markdown_attachments WHERE object_key=? LIMIT 1",
    )
      .bind(task.object_key, task.object_key, task.object_key)
      .first();
    if (used) {
      await releaseStatement(env, task.object_key).run();
      continue;
    }
    try {
      await env.BUCKET.delete(task.object_key);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM files WHERE object_key=? AND status='pending'").bind(
          task.object_key,
        ),
        releaseStatement(env, task.object_key),
      ]);
    } catch {
      await env.DB.prepare('UPDATE cleanup_tasks SET attempts=attempts+1 WHERE object_key=?')
        .bind(task.object_key)
        .run();
    }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now()),
    env.DB.prepare('DELETE FROM operations WHERE created_at<?').bind(now() - 90 * 86400000),
  ]);
}
