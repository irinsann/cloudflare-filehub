import { readFileSync } from 'node:fs';
import { parse, printParseErrorCode } from 'jsonc-parser';
const configPath = process.argv[2] ?? 'wrangler.jsonc';
const parseErrors = [];
const config = parse(readFileSync(configPath, 'utf8'), parseErrors, { allowTrailingComma: true });
if (parseErrors.length) {
  console.error(
    configPath +
      ' 格式错误：' +
      parseErrors.map((e) => printParseErrorCode(e.error) + ' at ' + e.offset).join(', '),
  );
  process.exit(1);
}
const vars = config.vars ?? {};
const missing = [];
if (vars.ENVIRONMENT !== 'production' || vars.LOCAL_AUTH !== 'false')
  missing.push('生产必须 ENVIRONMENT=production、LOCAL_AUTH=false');
if (
  !config.d1_databases?.[0]?.database_id ||
  /REPLACE|local-only/.test(config.d1_databases[0].database_id)
)
  missing.push('真实 D1 database_id');
for (const key of vars.AUTH_MODE === 'password_totp'
  ? ['ADMIN_EMAILS']
  : ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS'])
  if (!vars[key] || /YOUR_|REPLACE/.test(vars[key])) missing.push(key);
for (const key of ['ADMIN_ORIGIN', 'FILES_ORIGIN', 'MARKDOWN_ORIGIN'])
  if (vars[key]) {
    try {
      const u = new URL(vars[key]);
      if (u.protocol !== 'https:' || u.origin !== vars[key])
        missing.push(`${key} 必须是无尾随斜线的 HTTPS Origin`);
    } catch {
      missing.push(`${key} 格式不正确`);
    }
  }
if (vars.ADMIN_ORIGIN && vars.MARKDOWN_ORIGIN !== vars.ADMIN_ORIGIN)
  missing.push('文章 Origin 必须与后台站点一致');
const trustedOrigins = (vars.TRUSTED_PROXY_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (vars.FILES_ORIGIN !== vars.ADMIN_ORIGIN && !trustedOrigins.includes(vars.FILES_ORIGIN))
  missing.push('文件链接 Origin 必须使用后台域名或已配置的可信反代域名');
if (
  config.routes?.length !== 1 ||
  config.routes[0].pattern !== new URL(vars.ADMIN_ORIGIN || 'https://invalid.local').host
)
  missing.push('生产必须只绑定一个与 ADMIN_ORIGIN 对应的自定义域名');
for (const origin of (vars.TRUSTED_PROXY_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' || u.origin !== origin)
      missing.push('反代来源必须是精确 HTTPS Origin');
  } catch {
    missing.push('反代来源格式无效');
  }
}
if (missing.length) {
  console.error(
    '部署配置尚未完成：\n' +
      missing.map((v) => '- ' + v).join('\n') +
      '\n请参阅 docs/deployment.md。',
  );
  process.exit(1);
}
console.log('生产配置预检查通过。确认 Cloudflare 中已配置 SHARE_SESSION_SECRET。');
