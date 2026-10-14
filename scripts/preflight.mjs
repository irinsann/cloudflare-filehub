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
if (
  vars.ADMIN_ORIGIN &&
  (vars.FILES_ORIGIN !== vars.ADMIN_ORIGIN || vars.MARKDOWN_ORIGIN !== vars.ADMIN_ORIGIN)
)
  missing.push('三个 Origin 必须统一为同一站点');
if (
  config.routes?.length !== 1 ||
  config.routes[0].pattern !== new URL(vars.ADMIN_ORIGIN || 'https://invalid.local').host
)
  missing.push('生产必须只绑定一个与 ADMIN_ORIGIN 对应的自定义域名');
if (missing.length) {
  console.error(
    '部署配置尚未完成：\n' +
      missing.map((v) => '- ' + v).join('\n') +
      '\n请参阅 docs/deployment.md。',
  );
  process.exit(1);
}
console.log('生产配置预检查通过。确认 Cloudflare 中已配置 SHARE_SESSION_SECRET。');
