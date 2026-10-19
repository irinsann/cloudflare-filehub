# RCloud Cloudflare 部署

站点统一使用 https://233334.xyz。首页自动进入 /drive/ 私人网盘，公开文章 /p/:slug、文件分享 /s/:token、文件直链 /d/:token。Worker 只绑定 233334.xyz；图床、分享和直链默认使用已有 VPS 反代域名 https://s.irin.im。

## 准备资源

安装依赖并登录 Wrangler。创建专用私有 R2 Bucket 和 D1 数据库，保持 r2.dev 关闭。复制根目录 wrangler.jsonc 到被 Git 忽略的 wrangler.production.jsonc，删除 env 段，填入真实账号 ID、D1 ID 和 Bucket 名。不要提交真实密钥。

使用 docs/wrangler.production.example.jsonc 的单域名 routes 和变量模板。ADMIN_ORIGIN、MARKDOWN_ORIGIN 为 https://233334.xyz；FILES_ORIGIN 为 https://s.irin.im，TRUSTED_PROXY_ORIGINS 包含 https://s.irin.im，ENVIRONMENT=production，LOCAL_AUTH=false。全站存储配额固定为 50GB，无单文件大小上限。上传分片为 16MiB，每片通过鉴权 Worker 流式写入 R2，不需要公开 Bucket 或浏览器持有存储密钥。

## Access 路径策略

1. 创建 Self-hosted 管理应用，目标 233334.xyz 的 drive/_ 与 api/admin/_ 两个路径，Allow 仅管理员邮箱，登录方式为 One-time PIN。
2. 文章、分享、直链及公开 API 路径不添加 Access 应用。前端资源统一位于 /drive/assets/，随私人后台一起保护。
3. 后台与管理 API 由路径应用保护。Worker 另行验证管理员 JWT 与邮箱白名单。公开文章必须已发布，文件必须由管理员主动创建有效链接；回收站、过期和撤销立即阻断访问。
4. 将管理应用 AUD、团队域名和管理员邮箱填入本地生产配置。验证路径匹配后再上线。

## 发布

在根目录执行：

```sh
pnpm db:production
pnpm exec wrangler secret put SHARE_SESSION_SECRET --config wrangler.production.jsonc
pnpm check
pnpm run deploy:production
```

分享密钥使用随机 32 字节字符串，创建分享、读取可复制链接和密码解锁都需要它。它同时签名可重复获取的分享地址和解锁会话；升级时保留现有密钥，轮换会使已复制的签名地址失效。此次分享列表升级不需要数据库迁移。Custom Domain 自动配置 DNS 和 HTTPS 证书；先核对目标 DNS 无需保留的冲突服务。已有部署迁移域名时，从 Worker Domains 中移除旧绑定并确认旧域名不再提供服务。

## 验证

首页会跳转 /drive/；/drive/ 和 /api/admin/files 未登录应进入 Access 登录；登录后检查上传与列表。匿名 /p/:slug、/s/:token、/d/:token 和 /api/public/\* 无需管理员登录，但仍受发布、令牌、有效期和密码约束。未创建内容时公开路径返回 404。测试直链 Range/HEAD，撤销链接后不可下载。清空回收站必须由用户在界面确认，正常文件不受影响。

全站存储上限 50GB，无单文件上限；分片失败自动重试，24 小时未完成任务自动清理。文本在线编辑上限仍为 1MiB。发布后可在 Cloudflare 查看用量，实际消耗取决于文件与访问量。

## 站内密码与验证器登录

设置 AUTH_MODE=password_totp 后，/login 提供站内登录与首次绑定，认证接口位于 /api/auth/\*。准备独立 AUTH_ENCRYPTION_KEY 随机密钥作为 Worker Secret，用于 AES-GCM 加密验证器密钥。不要旋转此密钥，否则已有验证器将无法解密。AUTH_SETUP_SECRET 是独立随机一次性邀请令牌；AUTH_SETUP_EXPIRES 是邀请有效期的毫秒时间戳。首次设置链接格式为 /login#setup=令牌，页面读入后立即移除 URL 片段。令牌不提交公开仓库，不对外分享。

用户亲自设置至少 12 字符密码，并扫描站内二维码输入验证码完成绑定，保存显示一次的 8 个恢复码。密码用独立随机盐 PBKDF2 保存；TOTP 为 SHA1 / 6 位 / 30 秒，接受前后一个窗口且原子拒绝已用验证码。恢复码只存哈希并只能使用一次，仍须提供密码。登录 Cookie 为 Secure、HttpOnly、SameSite=Strict 的随机会话，服务端存哈希，24 小时过期，退出立即撤销。

迁移时先部署并完成账户绑定，再移除 RCloud Access 应用；不要在账户未建立时移除现有保护。绑定成功后 /setup/start 会永久拒绝初始化，随后删除 AUTH_SETUP_SECRET。密码或验证器凭据更新必须由用户本人操作；遗失密码时由 Cloudflare 账户所有者进行受控离线重置，平台无公开绕过或重置接口。

## Google Drive 与 HTML 文件夹升级

先运行 `pnpm db:production` 应用 `0011_google_drive.sql` 和 `0012_site_shares.sql`，再部署新代码。迁移新增独立表和目录删除时撤销网站分享的触发器，不搬移或重命名现有 R2 文件。

HTML 网站使用现有 R2、D1 和 `SHARE_SESSION_SECRET`。将 `/site/*` 留给应用验证分享权限，反代不要缓存该路径，也不要覆盖 CORS、CSP 或重定向响应。

Google Drive 是可选连接，缺少配置时页面显示未配置，R2 功能仍可使用。它还需要 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 和已有的 `AUTH_ENCRYPTION_KEY`，配置及两个域名回调见 [Google Drive 接入](google-drive.md)。`/api/oauth/google/callback` 必须能直接到达 Worker，不能放进 Cloudflare Access 保护范围；它通过一次性 state 和浏览器 nonce 验证授权，不能自行调用以绕过登录。

## VPS 反代要求

WebDAV 升级需要先应用 `0010_webdav.sql`（`pnpm db:production`），再部署代码。它复用现有 D1/R2，不需要新的 Secret 或付费服务。登录设置后创建专用凭据，连接 `https://233334.xyz/dav/` 或 `https://s.irin.im/dav/`。Access 如仍保护整个域名，需要让 `/dav/*` 通过，由应用自行验证专用凭据。反代须透传 WebDAV 方法及条件/锁定请求头，并禁止缓存 `/dav/*`；详见 [RaiDrive 连接与协议说明](webdav.md)。

上传 API 使用独立 Bearer Token。升级时先应用 `0007_api_tokens.sql` 和 `0008_image_api_scope.sql`，在 Worker 配置中保留 `"compatibility_flags": ["nodejs_compat"]`，再部署 Worker，登录「设置 → 上传 API」手动创建 Token。无需配置全局上传密钥。反代须转发 Authorization、Content-Type 和 X-File-Size，并禁止缓存 `/api/*`。详情和脚本见 [API 文档](api.md)；图床上传与可导入配置见 [ShareX 文档](sharex.md)，反代表单请求需保留正确的 Content-Length。

反代使用其他域名时，将外部 HTTPS Origin 加入 TRUSTED_PROXY_ORIGINS，例如 https://s.irin.im（无尾随斜线）。反代上游仍为 233334.xyz，保留浏览器 Origin、Cookie 与 Set-Cookie，不改写 Origin，不缓存登录和管理接口。应用只接受配置的精确可信 Origin，保留写接口的自定义头（包括 X-Drive-Request、X-Google-Connection）与会话验证，不信任任意 X-Forwarded-Host。
