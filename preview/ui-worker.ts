import { htmlPage, readerScript } from '../worker/html';
import { loginBody, loginCss, loginUiScript } from '../worker/login-view';
import { files, folders, images, pages, markdown, documentText, imageSvg } from './fixtures';

interface PreviewEnv {
  ASSETS: Fetcher;
}
const json = (data: unknown) => Response.json({ data });
const error = (message: string, status = 404) =>
  Response.json({ error: { code: status, message } }, { status });
const notice = '<p class="description">界面演示 · 虚构数据 · 写入已禁用</p>';
const page = (title: string, body: string, script = readerScript, css = '') => {
  const result = htmlPage(
    title,
    body,
    script,
    '<meta name="robots" content="noindex,nofollow">',
    css,
  );
  return new Response(result.html, { headers: result.headers });
};
function image(index: number) {
  return new Response(imageSvg(index), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
}

async function route(request: Request, env: PreviewEnv) {
  const url = new URL(request.url),
    path = url.pathname;
  if (!['GET', 'HEAD'].includes(request.method))
    return error('演示模式：不会保存、上传或删除文件。', 403);
  if (path === '/login')
    return page(
      '登录预览',
      loginBody(true),
      loginUiScript +
        `
document.getElementById('auth').addEventListener('submit',e=>{e.preventDefault();document.getElementById('error').textContent='演示模式，不会提交登录信息。';e.target.reset();});`,
      loginCss,
    );
  if (path === '/') return Response.redirect(url.origin + '/drive/', 302);
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
  if (path === '/api/admin/settings')
    return json({
      authMode: 'preview',
      environment: 'preview',
      email: 'preview@example.invalid',
      maxUploadBytes: null,
      maxTextBytes: 1048576,
      storageUsedBytes: 13743895347,
      storageLimitBytes: 53687091200,
      storageAvailableBytes: 39943195853,
      adminOrigin: url.origin,
      filesOrigin: url.origin,
      markdownOrigin: url.origin,
    });
  if (path === '/api/admin/files') {
    const view = url.searchParams.get('view') || 'files';
    const folder = url.searchParams.get('folder_id');
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const current = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const sort = url.searchParams.get('sort');
    const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
    const rows = files
      .filter(
        (entry) =>
          (view === 'trash' ? entry.deleted_at !== null : entry.deleted_at === null) &&
          (view !== 'files' || search || entry.folder_id === folder) &&
          (view !== 'markdown' || entry.mime === 'text/markdown') &&
          entry.name.toLowerCase().includes(search),
      )
      .sort(
        (a, b) =>
          direction *
          (sort === 'name'
            ? a.name.localeCompare(b.name)
            : sort === 'size'
              ? a.size - b.size
              : a.updated_at - b.updated_at),
      );
    return json({
      files: rows.slice((current - 1) * 40, current * 40),
      folders:
        view === 'files' && !search ? folders.filter((entry) => entry.parent_id === folder) : [],
      total: rows.length,
      page: current,
      limit: 40,
    });
  }
  if (path === '/api/admin/folders')
    return json(folders.filter((entry) => entry.parent_id === url.searchParams.get('parent_id')));
  if (path === '/api/admin/api-tokens') return json([]);
  if (path === '/api/admin/webdav')
    return json({ credentials: [], username: 'rcloud', path: '/dav/', maxUploadBytes: 100000000 });
  if (path === '/api/admin/images')
    return json(
      Number(url.searchParams.get('page') || 1) === 1
        ? images.map((entry, index) => ({
            name: entry.name,
            file_id: entry.id,
            size: entry.size,
            mime: entry.mime,
            enabled: index === 7 ? 0 : 1,
            created_at: entry.created_at,
            views: 24 + index * 37,
            downloads: index * 3,
            last_access_at: entry.updated_at,
            url: `${url.origin}/i/${entry.name}`,
          }))
        : [],
    );
  if (path === '/api/admin/markdown')
    return json(
      pages.map((entry) => ({
        ...entry,
        id: entry.file_id,
        name: files.find((file) => file.id === entry.file_id)!.name,
        version: 1,
      })),
    );
  if (path === '/api/admin/shares')
    return json(
      files.slice(4, 6).map((entry, index) => ({
        id: `demo-share-${index}`,
        file_id: entry.id,
        name: entry.name,
        enabled: 1,
        created_at: entry.created_at,
        expires_at: null,
        password_protected: index,
        allow_download: 1,
        views: 43 + index * 12,
        downloads: 8 + index * 3,
        last_access_at: entry.updated_at,
      })),
    );
  const document = /^\/api\/admin\/markdown\/([^/]+)$/.exec(path);
  if (document) {
    const entry = files.find((entry) => entry.id === document[1] && entry.mime === 'text/markdown');
    return entry
      ? json({
          file: entry,
          content: markdown,
          page: pages.find((page) => page.file_id === entry.id) ?? null,
        })
      : error('示例文档不存在');
  }
  const download = /^\/api\/admin\/files\/([^/]+)(?:\/(content|download))?$/.exec(path);
  if (download) {
    const entry = files.find((entry) => entry.id === download[1]);
    if (!entry) return error('示例文件不存在');
    if (!download[2]) return json(entry);
    if (download[2] === 'content')
      return json({ content: documentText(entry), version: entry.version });
    const response = entry.mime.startsWith('image/')
      ? image(
          Math.max(
            0,
            images.findIndex((file) => file.id === entry.id),
          ),
        )
      : new Response(documentText(entry), {
          headers: { 'Content-Type': entry.mime + '; charset=utf-8' },
        });
    response.headers.set(
      'Content-Disposition',
      `${url.searchParams.get('preview') === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    );
    return response;
  }
  const hostedImage = /^\/(?:i\/|api\/admin\/images\/)([^/]+)(?:\/download)?$/.exec(path);
  if (hostedImage) {
    const index = images.findIndex((entry) => entry.name === hostedImage[1]);
    if (index < 0) return error('示例图片不存在');
    if (path.startsWith('/i/') && index === 7) return error('示例图片直链已撤销');
    const response = image(index);
    if (path.endsWith('/download'))
      response.headers.set('Content-Disposition', `attachment; filename="${images[index].name}"`);
    return response;
  }
  const artwork = /^\/preview\/images\/(\d)\.svg$/.exec(path);
  if (artwork) return image(Number(artwork[1]));
  if (path.startsWith('/p/'))
    return page(
      '项目手记',
      `<main class="reader"><h1 class="title">项目手记</h1>${notice}<div class="prose"><p>留下一点空白，让重要的内容更容易被找到。</p><h2>一个安静的工作空间</h2><p>在这里整理文件，记录想法，分享值得留下的内容。</p><img src="/preview/images/0.svg" alt="示例几何构成"><blockquote>这里的文字与图片仅用于界面预览。</blockquote></div></main>`,
    );
  if (path.startsWith('/s/') || path.startsWith('/d/'))
    return page(
      '分享预览',
      `<main class="card"><h1>示例文件</h1>${notice}<p>公开分享页面预览。</p><a class="button" href="/drive/">返回网盘</a></main>`,
    );
  if (path.startsWith('/api/')) return error('演示模式：此接口不可用。', 404);
  if (path.startsWith('/drive/')) url.pathname = path.slice(6) || '/';
  return env.ASSETS.fetch(new Request(url, request));
}

export default {
  async fetch(request: Request, env: PreviewEnv) {
    const result = await route(request, env);
    const response = new Response(request.method === 'HEAD' ? null : result.body, result);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-RCloud-Preview', 'true');
    return response;
  },
} satisfies ExportedHandler<PreviewEnv>;
