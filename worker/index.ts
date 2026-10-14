import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { AppEnv, Env } from './env';
import { adminAuth, isLocalAuth, rateLimit } from './security';
import { fileRoutes } from './files';
import { imageRoutes, imagePage } from './images';
import { siteAuthRoutes, loginPage, siteIdentity } from './site-auth';
import { uploadRoutes } from './uploads';
import { tokenRoutes, uploadTokenAuth } from './api-tokens';
import { uploadApi } from './upload-api';
import { markdownRoutes, publicPageRoutes, readPage, enforceJsonLimit } from './markdown';
import { shareRoutes, publicShareRoutes, sharePage, directRoutes } from './shares';
import { cleanup } from './storage';
import { fail } from './errors';
import { siteOriginAllowed } from './origins';
import { htmlPage } from './html';
import { escapeHtml } from '../shared/markdown';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  if (
    c.env.ADMIN_ORIGIN &&
    !isLocalAuth(c.env, new URL(c.req.url)) &&
    !siteOriginAllowed(c.env, new URL(c.req.url).origin)
  )
    fail(404, '站点已迁移');
  await next();
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (new URL(c.req.url).protocol === 'https:')
    c.header('Strict-Transport-Security', 'max-age=31536000');
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'private, no-store');
    c.header(
      'Content-Security-Policy',
      c.res.headers.get('Content-Security-Policy') || "default-src 'none'; frame-ancestors 'self'",
    );
  }
});
app.use('/api/admin/*', adminAuth);
app.use('/api/v1/*', uploadTokenAuth);
app.use('/api/admin/*', async (c, next) => {
  await rateLimit(c.env, 'admin', c.get('email'), 240);
  await next();
});
app.use('/api/*', enforceJsonLimit);
app.use('/api/public/*', async (c, next) => {
  await rateLimit(c.env, 'public', c.req.header('CF-Connecting-IP') || 'local', 240);
  await next();
});
app.route('/api/auth', siteAuthRoutes);
app.get('/login', (c) =>
  c.env.AUTH_MODE === 'password_totp' ? loginPage(c) : c.redirect('/drive/'),
);
app.route('/api/admin', fileRoutes);
app.route('/api/admin', tokenRoutes);
app.route('/api/v1', uploadApi);
app.route('/api/admin', imageRoutes);
app.use('/i/*', async (c, next) => {
  await rateLimit(c.env, 'image', c.req.header('CF-Connecting-IP') || 'local', 240);
  await next();
});
app.on(['GET', 'HEAD'], '/i/:name', imagePage);
app.route('/api/admin', uploadRoutes);
app.route('/api/admin', shareRoutes);
app.route('/api/admin', markdownRoutes);
app.route('/api/public/share', publicShareRoutes);
app.use('/d/*', async (c, next) => {
  await rateLimit(c.env, 'sharing', c.req.header('CF-Connecting-IP') || 'local', 120);
  await next();
});
app.route('/d', directRoutes);
app.route('/api/public/pages', publicPageRoutes);
app.use('/p/*', async (c, next) => {
  await rateLimit(c.env, 'reading', c.req.header('CF-Connecting-IP') || 'local', 120);
  await next();
});
app.use('/s/*', async (c, next) => {
  await rateLimit(c.env, 'sharing', c.req.header('CF-Connecting-IP') || 'local', 120);
  await next();
});
app.on(['GET', 'HEAD'], '/p/:slug', (c) => readPage(c));
app.on(['GET', 'HEAD'], '/s/:token', sharePage);
app.get('/favicon.svg', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/robots.txt', (c) =>
  c.text('User-agent: *\nAllow: /p/\nDisallow: /api/\nDisallow: /s/\nDisallow: /d/\nDisallow: /\n'),
);
app.get('*', async (c) => {
  if (c.req.path === '/' && !isLocalAuth(c.env, new URL(c.req.url)))
    return c.redirect('/drive/', 302);
  if (
    c.env.AUTH_MODE === 'password_totp' &&
    !isLocalAuth(c.env, new URL(c.req.url)) &&
    !(await siteIdentity(c))
  )
    return c.redirect('/login', 302);
  // Frontend shell is harmless, but on production protect it with the same JWT verification as API.
  if (!isLocalAuth(c.env, new URL(c.req.url))) {
    let allowed = false;
    await adminAuth(c, async () => {
      allowed = true;
    });
    if (!allowed) fail(401, '请登录');
  }
  const assetUrl = new URL(c.req.url);
  if (assetUrl.pathname.startsWith('/drive/'))
    assetUrl.pathname = assetUrl.pathname.slice(6) || '/';
  const asset = await c.env.ASSETS.fetch(new Request(assetUrl, c.req.raw));
  const response = new Response(asset.body, asset);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: https:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  return response;
});
app.onError((error, c) => {
  const status =
    error instanceof HTTPException
      ? error.status
      : error instanceof ZodError
        ? 400
        : /UNIQUE constraint|folder cycle|folder not empty|parent folder unavailable/.test(
              error.message,
            )
          ? 409
          : 500;
  const message =
    error instanceof HTTPException
      ? error.message
      : error instanceof ZodError
        ? error.issues.map((i) => i.message).join('；')
        : status === 409
          ? '名称、Slug 或目录状态冲突，请刷新后重试'
          : '服务暂时无法完成请求';
  if (status === 500)
    console.error(JSON.stringify({ requestId: c.get('requestId'), type: error.name }));
  if (!c.req.path.startsWith('/api/')) {
    const page = htmlPage(
      `${status}`,
      `<main class="card"><h1>${status}</h1><p>${escapeHtml(message)}</p></main>`,
    );
    return new Response(page.html, { status, headers: page.headers });
  }
  return c.json({ error: { code: status, message, request_id: c.get('requestId') } }, status);
});
export { app };
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
