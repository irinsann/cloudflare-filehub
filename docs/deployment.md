# RCloud Cloudflare 部署

站点统一使用 https://233334.xyz。首页自动进入 /drive/ 私人网盘，公开文章 /p/:slug、文件分享 /s/:token、文件直链 /d/:token。只绑定一个域名，旧域名绑定需移除。

## 准备资源

安装依赖并登录 Wrangler。创建专用私有 R2 Bucket 和 D1 数据库，保持 r2.dev 关闭。复制根目录 wrangler.jsonc 到被 Git 忽略的 wrangler.production.jsonc，删除 env 段，填入真实账号 ID、D1 ID 和 Bucket 名。不要提交真实密钥。

使用 docs/wrangler.production.example.jsonc 的单域名 routes 和变量模板。ADMIN_ORIGIN、MARKDOWN_ORIGIN、FILES_ORIGIN 均为 https://233334.xyz，ENVIRONMENT=production，LOCAL_AUTH=false。MAX_UPLOAD_BYTES=1073741824。上传分片为 16MiB，每片通过鉴权 Worker 流式写入 R2，不需要公开 Bucket 或浏览器持有存储密钥。

## Access 路径策略

1. 创建 Self-hosted 管理应用，目标 233334.xyz 的 drive/* 与 api/admin/* 两个路径，Allow 仅管理员邮箱，登录方式为 One-time PIN。
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

分享会话密钥使用随机 32 字节字符串，不重复旋转现有密钥。Custom Domain 自动配置 DNS 和 HTTPS 证书；先核对目标 DNS 无需保留的冲突服务。已有部署迁移域名时，从 Worker Domains 中移除旧绑定并确认旧域名不再提供服务。

## 验证

首页会跳转 /drive/；/drive/ 和 /api/admin/files 未登录应进入 Access 登录；登录后检查上传与列表。匿名 /p/:slug、/s/:token、/d/:token 和 /api/public/* 无需管理员登录，但仍受发布、令牌、有效期和密码约束。未创建内容时公开路径返回 404。测试直链 Range/HEAD，撤销链接后不可下载。清空回收站必须由用户在界面确认，正常文件不受影响。

默认上限 1GB；分片失败自动重试，24 小时未完成任务自动清理。文本在线编辑上限仍为 1MiB。发布后可在 Cloudflare 查看用量，实际消耗取决于文件与访问量。

## 站内密码与验证器登录

设置 AUTH_MODE=password_totp 后，/login 提供站内登录与首次绑定，认证接口位于 /api/auth/*。准备独立 AUTH_ENCRYPTION_KEY 随机密钥作为 Worker Secret，用于 AES-GCM 加密验证器密钥。不要旋转此密钥，否则已有验证器将无法解密。AUTH_SETUP_SECRET 是独立随机一次性邀请令牌；AUTH_SETUP_EXPIRES 是邀请有效期的毫秒时间戳。首次设置链接格式为 /login#setup=令牌，页面读入后立即移除 URL 片段。令牌不提交公开仓库，不对外分享。

用户亲自设置至少 12 字符密码，并扫描站内二维码输入验证码完成绑定，保存显示一次的 8 个恢复码。密码用独立随机盐 PBKDF2 保存；TOTP 为 SHA1 / 6 位 / 30 秒，接受前后一个窗口且原子拒绝已用验证码。恢复码只存哈希并只能使用一次，仍须提供密码。登录 Cookie 为 Secure、HttpOnly、SameSite=Strict 的随机会话，服务端存哈希，24 小时过期，退出立即撤销。

迁移时先部署并完成账户绑定，再移除 RCloud Access 应用；不要在账户未建立时移除现有保护。绑定成功后 /setup/start 会永久拒绝初始化，随后删除 AUTH_SETUP_SECRET。密码或验证器凭据更新必须由用户本人操作；遗失密码时由 Cloudflare 账户所有者进行受控离线重置，平台无公开绕过或重置接口。
