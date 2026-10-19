# RCloud Cloudflare 部署

示例源站为 `https://cloud.example.com`，可选反代为 `https://files.example.com`。请替换为自己控制的域名。首页进入 `/drive/`；文章、文件分享、图片和目录网站分别位于 `/p/`、`/s/`、`/i/` 和 `/site/`。

## 配置与资源

1. 安装依赖并登录 Wrangler，创建私有 R2 Bucket 和 D1 数据库，保持 R2 的公开访问关闭。
2. 复制根目录 `wrangler.jsonc` 为被 Git 忽略的 `wrangler.production.jsonc`，删除 `env` 段，填入真实资源 ID、名称和 Custom Domain。
3. 对照 [配置模板](wrangler.production.example.jsonc) 设置变量。模板位于 docs，路径带 `../`；复制到项目根目录时改为 `worker/index.ts`、`./dist` 和 `db/migrations`。
4. 保留 `nodejs_compat`、私有 BUCKET/DB 绑定、静态资源绑定和 Cron。生产必须使用 `ENVIRONMENT=production`、`LOCAL_AUTH=false`。

| 变量                  | 示例或用途                                           |
| --------------------- | ---------------------------------------------------- |
| ADMIN_ORIGIN          | `https://cloud.example.com`                          |
| MARKDOWN_ORIGIN       | `https://cloud.example.com`                          |
| FILES_ORIGIN          | 单域名使用源站；反代可设 `https://files.example.com` |
| TRUSTED_PROXY_ORIGINS | 可选精确 HTTPS Origin 列表，不含路径或尾随斜线       |
| ADMIN_EMAILS          | `owner@example.com`                                  |
| AUTH_MODE             | `password_totp` 或 `access`                          |
| MAX_TEXT_BYTES        | `1048576`，在线文本上限                              |

应用总容量为 50 GiB。网页通过 16 MiB 分片写入私有 R2，不需要公开 Bucket 或把存储凭据交给浏览器。

## 站内密码与验证器登录

设置 `AUTH_MODE=password_totp`。准备独立随机 Worker Secret：

- `SHARE_SESSION_SECRET`：至少 32 字符，签名分享地址与解锁会话。
- `AUTH_ENCRYPTION_KEY`：用于加密 TOTP 密钥。
- `AUTH_SETUP_SECRET`：一次性初始化邀请令牌；同时设置有效期毫秒时间戳 `AUTH_SETUP_EXPIRES`。

通过 `wrangler secret put` 交互输入，不提交到 Git。首次链接为 `https://cloud.example.com/login#setup=令牌`；页面读取后移除片段。用户设置至少 12 字符密码、扫描验证器二维码、输入验证码，并保存仅显示一次的恢复码。绑定后删除初始化 Secret。

TOTP 为 SHA1 / 6 位 / 30 秒，拒绝重复使用验证码。恢复码单次有效且仍须提供密码。登录会话有效 24 小时，Cookie 为 Secure、HttpOnly、SameSite=Strict，退出立即撤销。语言偏好 Cookie 与认证无关。

从 Access 切换时先完成账户绑定，再移除原 Access 应用，不能在账户建立前撤掉现有保护。保留 `AUTH_ENCRYPTION_KEY`；盲目轮换会令已有验证器密钥无法解密。遗失密码需由部署者受控恢复，平台没有公开绕过入口。

## Cloudflare Access 登录

选择 `AUTH_MODE=access`，创建 Self-hosted 应用保护 `cloud.example.com/drive/*` 与 `cloud.example.com/api/admin/*`，Allow 仅允许管理员邮箱，例如 `owner@example.com`。填入 `ACCESS_TEAM_DOMAIN`、应用 `ACCESS_AUD` 和 `ADMIN_EMAILS`。

公开文章、图片、文件分享、`/site/*`、上传 API `/api/v1/*` 和 `/dav/*` 必须能到达 Worker，由各自的分享权限、Token 或 WebDAV 凭据验证。不要用整个域名的 Access 登录截住公开资源。Worker 仍独立验证管理员 JWT 签名、issuer、audience、有效期和邮箱。

## 迁移与发布

已有站点先备份 D1，应用所有待执行迁移后再部署新 Worker：

```sh
pnpm check
pnpm db:production
# 首次部署设置 Secret；升级时保留已有值
pnpm exec wrangler secret put SHARE_SESSION_SECRET --config wrangler.production.jsonc
pnpm run deploy:production
```

站内认证还需按上节设置相应 Secrets。不要在每次更新时重建分享密钥；轮换 `SHARE_SESSION_SECRET` 会使已复制的签名地址和解锁会话失效。

本版迁移：

- `0012_site_shares.sql`：目录网站与删除时撤销网站分享的触发器。
- `0013_remove_google_drive.sql`：移除旧 Google 连接、授权、上传元数据；不请求 Google 删除远端文件。
- `0014_html_hosting.sql`：HTML 上传分享映射与版本触发器，不搬移或改名现有文件，不修改旧分享。
- `0015_resource_accounting.sql`：回填容量计数，添加事务触发器与引用索引，必须先于新代码部署。

新部署也按顺序执行全部迁移。不要跳过历史迁移或编辑已应用的 SQL。Google Drive 已退出当前功能集；备份并确认不再使用后，可从 Worker 设置移除旧 OAuth Secrets。HTML hosting 和容量优化不新增 Secrets 或 Cloudflare 产品。

## 反代、上传 API 与 WebDAV

反代上游使用源站域名，外部浏览器地址必须列在 `TRUSTED_PROXY_ORIGINS`。保留浏览器 Origin，不将其重写为上游；透传 Cookie、Set-Cookie、Authorization、Content-Type、X-File-Size 和 X-Drive-Request。应用不信任任意 X-Forwarded-Host。

禁止缓存登录、`/api/*`、`/dav/*`、图片与文件分享、`/site/*` 等受控内容。保留 CSP、CORS、Range、Content-Disposition 和重定向头；目录网站 CSP 同时覆盖配置的源站和可信反代下的同一分享路径。

`/drive/assets/`下带构建哈希的JavaScript、CSS及字体属于公开程序资源，使用长期immutable缓存，减少重复下载与会话查询。管理HTML外壳仍要求认证并使用`private, no-store`；不要将静态资源的缓存规则扩展到文件或分享接口。

上传 API 使用独立 Token，图床 Token 可导出 ShareX 配置，表单请求需保留正确 Content-Length。WebDAV 使用独立用户名/密码，透传其方法及条件/锁头，连接 `https://cloud.example.com/dav/` 或反代下的 `/dav/`。详见 [API](api.md)、[ShareX](sharex.md) 和 [WebDAV](webdav.md)。

## 上线检查

- 未登录后台/API 被拒绝；站内模式在当前域名登录，Access 模式按 Access 流程登录。
- 上传、下载、删除与恢复正常；撤销后链接拒绝后续请求。
- HTML 上传保存到 `/Html-hosting`，重复发布返回同一链接，撤销后旧重试不重新公开。
- 目录网站的 CSS、模块、JSON 和子页面在各配置域名下正确加载。
- 分别检查语言切换、手机/桌面布局、Range/HEAD、图床 API 和目标 WebDAV 客户端。
- 查看 Cloudflare 实际用量。50 GiB 是应用上限，不是免费额度；套餐与反代也可能限制单请求大小或超时。

自动化和人工验收边界见 [验证指南](verification.md)。本地测试或 dry-run 不代表生产已经部署。
