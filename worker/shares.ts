import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv, AppContext } from './env';
import { now, uuid } from './env';
import { fail } from './errors';
import {
  checkPassword,
  digest,
  hashPassword,
  rateLimit,
  signShareSession,
  validShareSession,
} from './security';
import { getFile, logStatement } from './files';
import { serveObject, isText, isHtml, textObject } from './storage';
import { shareInput, sharePatch, identifier } from '../shared/validation';
import type { FileRecord, ShareRecord } from '../shared/types';
import { htmlPage, readerScript } from './html';

// Uploaded HTML never receives the site's origin, even when the preview is opened directly.
const htmlPreviewCsp = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function unlocked(c: AppContext, share: ShareRecord) {
  return (
    !share.password_hash ||
    (await validShareSession(
      getCookie(c, `share_${share.id}`),
      share.id + ':' + (await digest(share.password_hash)),
      c.env,
    ))
  );
}

async function htmlDocument(c: AppContext, file: FileRecord) {
  const response = await serveObject(
    c.env,
    c.req.raw,
    file.object_key,
    file.name,
    'text/html; charset=utf-8',
    true,
  );
  response.headers.set('Content-Security-Policy', htmlPreviewCsp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const shareRoutes = new Hono<AppEnv>();
shareRoutes.get('/shares', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT s.id,s.file_id,s.created_at,s.expires_at,s.enabled,s.allow_download,s.views,s.downloads,s.last_access_at,(s.password_hash IS NOT NULL) AS password_protected,f.name FROM file_shares s JOIN files f ON f.id=s.file_id ORDER BY s.created_at DESC LIMIT 100',
  ).all();
  return c.json({ data: rows.results });
});
shareRoutes.post('/shares', async (c) => {
  const input = shareInput.parse(await c.req.json());
  const file = await getFile(c.env, input.file_id);
  if (input.expires_at && input.expires_at <= now()) fail(400, '过期时间必须在将来');
  if (
    !input.allow_download &&
    !isHtml(file.name) &&
    !/^(image\/|audio\/|video\/|text\/|application\/(pdf|json))/.test(file.mime)
  )
    fail(400, '此文件不支持预览，必须允许下载');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO file_shares(id,file_id,token_hash,password_hash,created_at,expires_at,allow_download) VALUES(?,?,?,?,?,?,?)',
    ).bind(
      id,
      file.id,
      await digest(token),
      input.password ? await hashPassword(input.password) : null,
      now(),
      input.expires_at,
      Number(input.allow_download),
    ),
    logStatement(c.env, 'share.create', id),
  ]);
  return c.json(
    {
      data: {
        id,
        url: `${c.env.FILES_ORIGIN || new URL(c.req.url).origin}/s/${token}`,
        directUrl: `${c.env.FILES_ORIGIN || new URL(c.req.url).origin}/d/${token}`,
      },
    },
    201,
  );
});
shareRoutes.patch('/shares/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const input = sharePatch.parse(await c.req.json());
  const row = await c.env.DB.prepare('SELECT * FROM file_shares WHERE id=?')
    .bind(id)
    .first<ShareRecord>();
  if (!row) fail(404, '分享不存在');
  if (input.expires_at && input.expires_at <= now()) fail(400, '过期时间必须在将来');
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE file_shares SET enabled=?,allow_download=?,expires_at=?,password_hash=? WHERE id=?',
    ).bind(
      input.enabled === undefined ? row.enabled : Number(input.enabled),
      input.allow_download === undefined ? row.allow_download : Number(input.allow_download),
      input.expires_at === undefined ? row.expires_at : input.expires_at,
      input.password === undefined
        ? row.password_hash
        : input.password
          ? await hashPassword(input.password)
          : null,
      id,
    ),
    logStatement(c.env, 'share.update', id),
  ]);
  return c.json({ data: { id } });
});
shareRoutes.delete('/shares/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const result = await c.env.DB.prepare('UPDATE file_shares SET enabled=0 WHERE id=?')
    .bind(id)
    .run();
  if (!result.meta.changes) fail(404, '分享不存在');
  await logStatement(c.env, 'share.revoke', id).run();
  return c.json({ data: { id } });
});
async function lookup(c: AppContext, requirePassword = true) {
  const token = c.req.param('token') ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) fail(404, '分享不存在');
  const share = await c.env.DB.prepare('SELECT * FROM file_shares WHERE token_hash=?')
    .bind(await digest(token))
    .first<ShareRecord>();
  if (!share) fail(404, '分享不存在');
  if (!share.enabled || (share.expires_at && share.expires_at <= now()))
    fail(410, '分享已过期或已撤销');
  await getFile(c.env, share.file_id);
  if (requirePassword && !(await unlocked(c, share))) fail(401, '请输入分享密码');
  return share;
}
export const publicShareRoutes = new Hono<AppEnv>();
publicShareRoutes.post('/:token/unlock', async (c) => {
  const token = c.req.param('token');
  await rateLimit(c.env, 'unlock', c.req.header('CF-Connecting-IP') || 'local', 10, 300);
  const input = z.object({ password: z.string().max(128) }).parse(await c.req.json());
  const share = await lookup(c, false);
  if (!share.password_hash || !(await checkPassword(input.password, share.password_hash)))
    fail(401, '密码错误');
  const signed = await signShareSession(
    share.id + ':' + (await digest(share.password_hash)),
    c.env,
  );
  setCookie(c, `share_${share.id}`, signed, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: 3600,
  });
  return c.json({ data: { unlocked: true, token } });
});
publicShareRoutes.get('/:token', async (c) => {
  const share = await lookup(c);
  const file = await getFile(c.env, share.file_id);
  await c.env.DB.prepare('UPDATE file_shares SET views=views+1,last_access_at=? WHERE id=?')
    .bind(now(), share.id)
    .run();
  return c.json({
    data: {
      name: file.name,
      mime: file.mime,
      preview_type: isHtml(file.name) ? 'html' : null,
      size: file.size,
      allow_download: !!share.allow_download,
      expires_at: share.expires_at,
    },
  });
});
publicShareRoutes.get('/:token/text', async (c) => {
  const share = await lookup(c);
  const file = await getFile(c.env, share.file_id);
  if (!isText(file.mime)) fail(415, '不支持文本预览');
  return c.json({ data: { content: await textObject(c.env, file.object_key) } });
});
publicShareRoutes.on(['GET', 'HEAD'], '/:token/:action', async (c) => {
  const share = await lookup(c),
    action = c.req.param('action');
  if (action !== 'download' && action !== 'preview') fail(404, '路由不存在');
  if (action === 'download' && !share.allow_download) fail(403, '该分享已关闭下载');
  const file = await getFile(c.env, share.file_id);
  const htmlPreview = action === 'preview' && isHtml(file.name);
  if (
    action === 'preview' &&
    !htmlPreview &&
    !/^(image\/|audio\/|video\/|text\/|application\/(pdf|json))/.test(file.mime)
  )
    fail(415, '不支持预览');
  const response = htmlPreview
    ? await htmlDocument(c, file)
    : await serveObject(
        c.env,
        c.req.raw,
        file.object_key,
        file.name,
        file.mime,
        action === 'preview',
      );
  if (action === 'download' && c.req.method === 'GET' && response.status === 200)
    await c.env.DB.prepare(
      'UPDATE file_shares SET downloads=downloads+1,last_access_at=? WHERE id=?',
    )
      .bind(now(), share.id)
      .run();
  return response;
});
export async function sharePage(c: AppContext) {
  const token = c.req.param('token') ?? '';
  const share = await lookup(c, false);
  const file = await getFile(c.env, share.file_id);
  const html = isHtml(file.name);
  if (html && (await unlocked(c, share))) {
    const response = await htmlDocument(c, file);
    if (c.req.method === 'GET' && response.status === 200)
      await c.env.DB.prepare('UPDATE file_shares SET views=views+1,last_access_at=? WHERE id=?')
        .bind(now(), share.id)
        .run();
    return response;
  }
  // Do not expose file metadata in HTML until password verification completes.
  const script = String.raw`
const token=${JSON.stringify(token)};
const api='/api/public/share/'+token;
const view=document.getElementById('view');
const message=document.getElementById('message');
async function load(){
  const r=await fetch(api);
  const j=await r.json();
  if(r.status===401){document.getElementById('unlock').hidden=false;message.textContent='请输入分享密码';return}
  if(!r.ok){message.textContent=j.error.message;return}
  document.getElementById('unlock').hidden=true;
  const f=j.data;
  if(f.preview_type==='html'){location.reload();return}
  document.getElementById('name').textContent=f.name;
  message.textContent=(f.size/1024).toFixed(1)+' KB · '+f.mime;
  const url=api+'/preview';
  let e;
  if(f.mime.startsWith('image/')){
    e=document.createElement('img');e.src=url;e.alt=f.name;
  }else if(f.mime==='application/pdf'){
    e=document.createElement('iframe');e.src=url;e.title=f.name;
  }else if(f.mime.startsWith('video/')||f.mime.startsWith('audio/')){
    e=document.createElement(f.mime.startsWith('video/')?'video':'audio');e.src=url;e.controls=true;
  }else if(f.mime.startsWith('text/')||f.mime==='application/json'){
    const t=await fetch(api+'/text');const tj=await t.json();
    e=document.createElement('pre');e.textContent=t.ok?tj.data.content:tj.error.message;
  }
  if(e)view.replaceChildren(e);
  if(f.allow_download){const a=document.getElementById('download');a.hidden=false;a.href=api+'/download'}
}
document.getElementById('unlock').onsubmit=async(e)=>{
  e.preventDefault();
  const r=await fetch(api+'/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});
  document.getElementById('password').value='';
  if(r.ok)${html ? 'location.reload()' : 'load()'};else message.textContent=(await r.json()).error.message;
};
load();`;
  const page = htmlPage(
    '文件分享',
    `<main class="card"><div class="share-heading"><span class="share-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg></span><div><h1 id="name">文件分享</h1><p id="message" aria-live="polite">正在验证分享…</p></div></div><form id="unlock" hidden><input id="password" type="password" aria-label="分享密码" placeholder="输入访问密码" autocomplete="current-password" required maxlength="128"><button>解锁</button></form><div id="view"></div><div class="share-actions"><a id="download" class="button" hidden>下载文件</a></div></main>`,
    readerScript + script,
    '<meta name="robots" content="noindex,nofollow">',
  );
  return new Response(c.req.method === 'HEAD' ? null : page.html, { headers: page.headers });
}

export const directRoutes = new Hono<AppEnv>();
directRoutes.on(['GET', 'HEAD'], '/:token', async (c) => {
  const share = await lookup(c);
  if (!share.allow_download) fail(403, '该分享已关闭下载');
  const file = await getFile(c.env, share.file_id);
  const response = await serveObject(
    c.env,
    c.req.raw,
    file.object_key,
    file.name,
    file.mime,
    false,
  );
  if (c.req.method === 'GET' && response.status === 200)
    await c.env.DB.prepare(
      'UPDATE file_shares SET downloads=downloads+1,last_access_at=? WHERE id=?',
    )
      .bind(now(), share.id)
      .run();
  return response;
});
