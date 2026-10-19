import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { now, uuid } from './env';
import { digest, isLocalAuth, rateLimit } from './security';
import { writeOriginAllowed } from './origins';
import { fail } from './errors';
import { identifier } from '../shared/validation';

export const DAV_MAX_UPLOAD = 100000000;
const fields = 'id,name,prefix,created_at,expires_at,last_used_at,revoked_at';
export const webdavCredentials = new Hono<AppEnv>();
webdavCredentials.get('/webdav', async (c) => {
  const timestamp = now();
  return c.json({
    data: {
      credentials: (
        await c.env.DB.prepare(
          `WITH history AS (
            SELECT ${fields} FROM webdav_credentials
            WHERE revoked_at IS NOT NULL OR expires_at<=? ORDER BY created_at DESC LIMIT 100
          ) SELECT ${fields} FROM (
            SELECT ${fields},0 AS inactive FROM webdav_credentials
            WHERE revoked_at IS NULL AND expires_at>?
            UNION ALL SELECT ${fields},1 AS inactive FROM history
          ) ORDER BY inactive,created_at DESC`,
        )
          .bind(timestamp, timestamp)
          .all()
      ).results,
      username: 'rcloud',
      path: '/dav/',
      maxUploadBytes: DAV_MAX_UPLOAD,
    },
  });
});
webdavCredentials.post('/webdav', async (c) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(80),
      expires_in_days: z.number().int().min(1).max(365).default(90),
    })
    .parse(await c.req.json());
  const password =
    'rcd_' +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  const credential = await c.env.DB.prepare(
    `INSERT INTO webdav_credentials(id,name,prefix,password_hash,created_at,expires_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM webdav_credentials WHERE revoked_at IS NULL AND expires_at>?)<20 RETURNING ${fields}`,
  )
    .bind(
      uuid(),
      input.name,
      password.slice(0, 12),
      await digest(password),
      now(),
      now() + input.expires_in_days * 86400000,
      now(),
    )
    .first();
  if (!credential) fail(409, '最多保留20个有效WebDAV凭据');
  return c.json({ data: { credential, password } }, 201);
});
webdavCredentials.delete('/webdav/:id', async (c) => {
  const id = identifier.parse(c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE webdav_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',
    ).bind(now(), id),
    c.env.DB.prepare('DELETE FROM webdav_locks WHERE credential_id=?').bind(id),
  ]);
  return c.json({ data: { id } });
});

export const webdavAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (new URL(c.req.url).protocol !== 'https:' && !isLocalAuth(c.env, new URL(c.req.url)))
    fail(403, 'WebDAV需要HTTPS');
  // OPTIONS has no private content and some Windows clients probe before authenticating.
  if (c.req.method === 'OPTIONS') return next();
  let password = '';
  try {
    const auth = c.req.header('Authorization') || '';
    if (/^Basic /i.test(auth)) {
      const pair = atob(auth.slice(6));
      if (pair.startsWith('rcloud:')) password = pair.slice(7);
    }
  } catch {
    /* Invalid Basic encoding is an authentication failure. */
  }
  const credential = /^rcd_[a-f0-9]{64}$/.test(password)
    ? await c.env.DB.prepare(
        'SELECT id,last_used_at FROM webdav_credentials WHERE password_hash=? AND revoked_at IS NULL AND expires_at>?',
      )
        .bind(await digest(password), now())
        .first<{ id: string; last_used_at: number | null }>()
    : null;
  if (!credential) {
    await rateLimit(c.env, 'dav-auth', c.req.header('CF-Connecting-IP') || 'local', 30);
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="RCloud WebDAV", charset="UTF-8"',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (c.req.header('Origin') && !writeOriginAllowed(c.env, c.req.raw))
    fail(403, '请求来源校验失败');
  c.set('davCredentialId', credential.id);
  if ((credential.last_used_at || 0) < now() - 60000)
    await c.env.DB.prepare(
      'UPDATE webdav_credentials SET last_used_at=? WHERE id=? AND COALESCE(last_used_at,0)<?',
    )
      .bind(now(), credential.id, now() - 60000)
      .run();
  await next();
};
