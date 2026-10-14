import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { now, uuid } from './env';
import { digest, rateLimit } from './auth-crypto';
import { identifier } from '../shared/validation';
import { fail } from './errors';
import { writeOriginAllowed } from './origins';

export const tokenRoutes = new Hono<AppEnv>();
const fields = 'id,name,prefix,created_at,expires_at,last_used_at,revoked_at';
tokenRoutes.get('/api-tokens', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT ${fields} FROM api_tokens ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return c.json({ data: rows.results });
});
tokenRoutes.post('/api-tokens', async (c) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(80),
      expires_in_days: z.number().int().min(1).max(365).default(30),
    })
    .parse(await c.req.json().catch(() => fail(400, 'JSON 格式无效')));
  const token =
    'rcu_' +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  const id = uuid(),
    created = now(),
    expires = created + input.expires_in_days * 86400000;
  const row = await c.env.DB.prepare(
    `INSERT INTO api_tokens(id,name,token_hash,prefix,created_at,expires_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL AND expires_at>?)<20 RETURNING ${fields}`,
  )
    .bind(id, input.name, await digest(token), token.slice(0, 12), created, expires, created)
    .first();
  if (!row) fail(409, '有效 Token 已达 20 个，请先撤销旧 Token');
  return c.json({ data: { ...row, token } }, 201);
});
tokenRoutes.delete('/api-tokens/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  const result = await c.env.DB.prepare(
    'UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',
  )
    .bind(now(), id)
    .run();
  if (!result.meta.changes) fail(404, 'Token 不存在');
  return c.json({ data: { id } });
});

export const uploadTokenAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Cookies and local development bypasses never authenticate the external API.
  await rateLimit(c.env, 'upload-api-ip', c.req.header('CF-Connecting-IP') || 'local', 600);
  const match = /^Bearer (rcu_[a-f0-9]{64})$/i.exec(c.req.header('Authorization') || '');
  if (!match) fail(401, '请提供有效的上传 Token');
  const token = await c.env.DB.prepare(
    'SELECT id FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
  )
    .bind(await digest(match[1]), now())
    .first<{ id: string }>();
  if (!token) fail(401, '上传 Token 无效、已到期或已撤销');
  // Scripts omit Origin; browser callers must still originate from an allowed site.
  if (c.req.header('Origin') && !writeOriginAllowed(c.env, c.req.raw))
    fail(403, '请求来源校验失败');
  await rateLimit(c.env, 'upload-api-token', token.id, 240);
  c.set('apiTokenId', token.id);
  await c.env.DB.prepare(
    'UPDATE api_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)',
  )
    .bind(now(), token.id, now() - 60000)
    .run();
  await next();
};
