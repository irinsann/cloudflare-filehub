import { requestLocale } from './locale';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import qrcode from 'qrcode-generator';
import type { Env, AppEnv, AppContext } from './env';
import { now } from './env';
import { fail } from './errors';
import { writeOriginAllowed } from './origins';
import { hashPassword, checkPassword, digest, rateLimit } from './auth-crypto';
import { htmlPage } from './html';
import { loginBody, loginCss, loginUiScript } from './login-view';
import { encryptSecret, decryptSecret } from './secret-store';
export { encryptSecret } from './secret-store';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export function base32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(s: string) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export async function totp(secret: string, counter: number, digits = 6) {
  const key = await crypto.subtle.importKey(
    'raw',
    decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, b));
  const off = mac[mac.length - 1] & 15;
  const v = new DataView(mac.buffer).getUint32(off) & 0x7fffffff;
  return String(v % 10 ** digits).padStart(digits, '0');
}
async function matchCode(secret: string, code: string) {
  const counter = Math.floor(now() / 30000);
  for (const n of [counter, counter - 1, counter + 1])
    if ((await totp(secret, n)) === code) return n;
  return -1;
}
const cookieName = (env: Env) =>
  env.ENVIRONMENT === 'local' ? 'rcloud-session' : '__Host-rcloud-session';
export async function siteIdentity(c: AppContext) {
  const existing = c.get('siteIdentity');
  if (existing !== undefined) return existing;
  const token = getCookie(c, cookieName(c.env));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    c.set('siteIdentity', null);
    return null;
  }
  const s = await c.env.DB.prepare(
    'SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?',
  )
    .bind(await digest(token), now())
    .first();
  const identity = s ? c.env.ADMIN_EMAILS.split(',')[0] || 'owner' : null;
  c.set('siteIdentity', identity);
  return identity;
}
async function prepareSession(c: AppContext, requireConsumedCode = false) {
  const token = randomToken();
  // Keep credential consumption and session creation in the same database transaction.
  const statement = c.env.DB.prepare(
    'INSERT INTO admin_sessions(token_hash,expires_at) SELECT ?,?' +
      (requireConsumedCode ? ' WHERE changes()=1' : ''),
  ).bind(await digest(token), now() + 86400000);
  return { token, statement };
}
function setSessionCookie(c: AppContext, token: string) {
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'local',
    sameSite: 'Strict',
    path: '/',
    maxAge: 86400,
  });
}
const password = z.string().min(12, '密码至少 12 个字符').max(128);
const code = z.string().regex(/^([0-9]{6}|[a-f0-9]{16})$/, '请输入 6 位验证码或恢复码');
export const siteAuthRoutes = new Hono<AppEnv>();
siteAuthRoutes.use('*', async (c, next) => {
  if (c.env.AUTH_MODE !== 'password_totp') fail(404, '未启用站内登录');
  if (c.req.method !== 'GET') {
    if (!writeOriginAllowed(c.env, c.req.raw) || c.req.header('X-Drive-Request') !== '1')
      fail(403, '请求来源校验失败');
    await rateLimit(c.env, 'auth-ip', c.req.header('CF-Connecting-IP') || 'local', 20, 300);
  }
  if (c.req.method === 'POST' && c.req.raw.body) {
    const reader = c.req.raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        fail(413, '登录请求过大');
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
  await next();
});
siteAuthRoutes.post('/setup/start', async (c) => {
  const input = z.object({ token: z.string().max(128) }).parse(await c.req.json());
  if (!c.env.AUTH_SETUP_EXPIRES || Number(c.env.AUTH_SETUP_EXPIRES) <= now())
    fail(403, '设置链接已过期，请联系管理员生成新链接');
  if (await c.env.DB.prepare('SELECT id FROM admin_account WHERE id=1').first())
    fail(409, '账户已经设置');
  if (
    !c.env.AUTH_SETUP_SECRET ||
    c.env.AUTH_SETUP_SECRET.length < 32 ||
    (await digest(input.token)) !== (await digest(c.env.AUTH_SETUP_SECRET))
  )
    fail(403, '设置链接无效');
  const secret = base32(crypto.getRandomValues(new Uint8Array(20))),
    token = randomToken();
  await c.env.DB.prepare('INSERT INTO admin_setup(token_hash,totp_cipher,expires_at) VALUES(?,?,?)')
    .bind(await digest(token), await encryptSecret(secret, c.env), now() + 900000)
    .run();
  const uri =
    'otpauth://totp/RCloud:Owner?secret=' +
    secret +
    '&issuer=RCloud&algorithm=SHA1&digits=6&period=30';
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return c.json({
    data: { token, secret, qr: qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }) },
  });
});
siteAuthRoutes.post('/setup/finish', async (c) => {
  const input = z
    .object({ token: z.string().regex(/^[0-9a-f]{64}$/), password, code })
    .parse(await c.req.json());
  const setup = await c.env.DB.prepare(
    'SELECT totp_cipher FROM admin_setup WHERE token_hash=? AND expires_at>?',
  )
    .bind(await digest(input.token), now())
    .first<{ totp_cipher: string }>();
  if (!setup) fail(403, '设置已过期，请重新打开设置链接');
  const counter = await matchCode(await decryptSecret(setup.totp_cipher, c.env), input.code);
  if (counter < 0) fail(401, '验证码不正确');
  const recovery = Array.from({ length: 8 }, () => randomToken().slice(0, 16));
  const session = await prepareSession(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO admin_account(id,password_hash,totp_cipher,last_counter,created_at) VALUES(1,?,?,?,?)',
    ).bind(await hashPassword(input.password), setup.totp_cipher, counter, now()),
    c.env.DB.prepare('DELETE FROM admin_setup'),
    ...(await Promise.all(
      recovery.map(async (r) =>
        c.env.DB.prepare('INSERT INTO admin_recovery(code_hash) VALUES(?)').bind(await digest(r)),
      ),
    )),
    session.statement,
  ]);
  setSessionCookie(c, session.token);
  return c.json({ data: { recovery } });
});
siteAuthRoutes.post('/login', async (c) => {
  const input = z.object({ password: z.string().min(1).max(128), code }).parse(await c.req.json());
  await rateLimit(c.env, 'auth-owner', 'owner', 10, 300);
  const account = await c.env.DB.prepare(
    'SELECT password_hash,totp_cipher,last_counter FROM admin_account WHERE id=1',
  ).first<{ password_hash: string; totp_cipher: string; last_counter: number }>();
  if (!account || !(await checkPassword(input.password, account.password_hash)))
    fail(401, '密码或验证码不正确');
  let consumeCode: D1PreparedStatement | undefined;
  if (input.code.length === 16) {
    consumeCode = c.env.DB.prepare('DELETE FROM admin_recovery WHERE code_hash=?').bind(
      await digest(input.code),
    );
  } else {
    const counter = await matchCode(await decryptSecret(account.totp_cipher, c.env), input.code);
    if (counter >= 0) {
      consumeCode = c.env.DB.prepare(
        'UPDATE admin_account SET last_counter=? WHERE id=1 AND last_counter<?',
      ).bind(counter, counter);
    }
  }
  if (!consumeCode) fail(401, '密码或验证码不正确，已用验证码不可重复使用');
  const session = await prepareSession(c, true);
  const [consumed] = await c.env.DB.batch([consumeCode, session.statement]);
  if (!consumed.meta.changes) fail(401, '密码或验证码不正确，已用验证码不可重复使用');
  setSessionCookie(c, session.token);
  return c.json({ data: { ok: true } });
});
siteAuthRoutes.post('/logout', async (c) => {
  const token = getCookie(c, cookieName(c.env));
  if (token)
    await c.env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?')
      .bind(await digest(token))
      .run();
  deleteCookie(c, cookieName(c.env), { path: '/', secure: c.env.ENVIRONMENT !== 'local' });
  return c.json({ data: { ok: true } });
});
export async function loginPage(c: AppContext) {
  const ready = !!(await c.env.DB.prepare('SELECT id FROM admin_account WHERE id=1').first());
  const script = String.raw`const ready=${ready};const form=document.getElementById('auth');const error=document.getElementById('error');let token='';async function post(path,data){const r=await fetch('/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Drive-Request':'1','Accept-Language':window.RCloudI18n.locale},body:JSON.stringify(data)});const j=await r.json();if(!r.ok)throw Error(j.error.message);return j.data;}if(!ready){const invite=new URLSearchParams(location.hash.slice(1)).get('setup');history.replaceState(null,'','/login');if(invite)post('setup/start',{token:invite}).then(d=>{token=d.token;document.getElementById('qr').innerHTML=d.qr;document.getElementById('secret').textContent=d.secret;form.hidden=false;document.getElementById('loading').hidden=true;}).catch(e=>error.textContent=e.message);else {error.dataset.i18n='请使用管理员提供的一次性设置链接。';error.textContent=window.RCloudI18n.t('请使用管理员提供的一次性设置链接。');}}form.onsubmit=async e=>{e.preventDefault();const button=document.getElementById('submit');button.disabled=true;delete error.dataset.i18n;error.textContent='';try{const p=document.getElementById('password').value;const confirm=document.getElementById('confirm');if(!ready&&p!==confirm.value)throw Error(window.RCloudI18n.t('两次密码不一致'));const d=await post(ready?'login':'setup/finish',{token,password:p,code:document.getElementById('code').value.trim().toLowerCase()});document.getElementById('password').value='';if(ready)location.replace('/drive/');else{form.hidden=true;document.getElementById('qr').replaceChildren();document.getElementById('secret').textContent='';document.getElementById('recovery').hidden=false;document.getElementById('codes').textContent=d.recovery.join('\n');}}catch(e){error.textContent=e.message;}finally{button.disabled=false;}};`;
  const locale = requestLocale(c.req.raw);
  const page = htmlPage(
    '登录',
    loginBody(ready, locale),
    script + loginUiScript,
    '',
    loginCss,
    locale,
    true,
  );
  return new Response(page.html, { headers: page.headers });
}
