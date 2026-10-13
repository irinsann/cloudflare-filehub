# Cloudflare 部署指南

本地验证不等于云端部署。真实生产必须自行提供 Cloudflare 账号、D1 ID、私有 Bucket、Access 应用、管理员邮箱和 DNS 权限。所有示例 ID 均为占位符。

## 1. 创建资源

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler r2 bucket create irin-drive-private
pnpm exec wrangler d1 create irin-drive
```

只创建新的专用资源；如果名字已有生产用途，改用新名字。不要删除已有资源。R2 保持私有，禁用 r2.dev 公共访问，不给 Bucket 绑定公开域名。此实现使用 Worker Binding，浏览器没有 R2 密钥，不需要 Bucket CORS 或 R2 S3 Token。

将创建返回的真实 `database_id` 填入 `wrangler.jsonc` 顶层 D1 配置；Bucket 名填写到 `r2_buckets`，Binding 名保持 `DB` 与 `BUCKET`。无需编造 UUID。

## 2. Cloudflare Access

Cloudflare Zero Trust 控制台：建立 Self-hosted 应用，保护管理域名 `ps.irin.im` 的所有路径。登录方式可使用邮箱 OTP 或现有身份提供商。建立 Allow Policy，仅允许你自己的邮箱，不使用 Everyone 或宽泛的 Bypass。

记录团队域名（例如 `your-team.cloudflareaccess.com`，无 `https://` 和末尾 `/`）与应用 AUD，填写：

```json
{
  "ACCESS_TEAM_DOMAIN": "YOUR_TEAM.cloudflareaccess.com",
  "ACCESS_AUD": "YOUR_APPLICATION_AUD",
  "ADMIN_EMAILS": "YOUR_EMAIL",
  "ENVIRONMENT": "production",
  "LOCAL_AUTH": "false"
}
```

多个管理员允许邮箱用逗号分隔（第一版无注册和用户管理）。Worker 验证 RS256 签名、issuer、audience、exp、iat、sub、email，并检查邮箱白名单；不能只依赖 Access 的前置拦截。`md.irin.im` 和 `s.irin.im` 不应被同一个管理 Access 应用拦截，否则访客无法匿名阅读。

默认 workers.dev 开发：保持三个 Origin 为空；在 Zero Trust 中另外为完整 Worker 默认主机配置 Access，并保护后台与 `/api/admin/*`，给 `/p/*`、`/s/*`、`/api/public/*` 建立明确的 Bypass 应用/路径例外。Worker 自身仍验证私人路由。建议生产使用三个自定义域名，更容易隔离策略。Origin 为空不会跳过鉴权。

## 3. 三个自定义域名

确保 `irin.im` 所在 zone 已加入当前 Cloudflare 账号，确认没有要保留的冲突 DNS。把 `docs/wrangler.production.example.jsonc` 中的 `routes` 和三个 Origin 复制到顶层 `wrangler.jsonc`（其中 main/assets/migrations 路径以根配置为准，不复制示例的 `../` 路径）：

```json
{
  "routes": [
    { "pattern": "ps.irin.im", "custom_domain": true },
    { "pattern": "md.irin.im", "custom_domain": true },
    { "pattern": "s.irin.im", "custom_domain": true }
  ],
  "vars": {
    "ADMIN_ORIGIN": "https://ps.irin.im",
    "MARKDOWN_ORIGIN": "https://md.irin.im",
    "FILES_ORIGIN": "https://s.irin.im"
  }
}
```

保留其他 vars，不要整体覆盖。填写 Origin 时不加尾随斜线。Worker 拒绝公共主机上的管理员 API；后台仅在 ADMIN_ORIGIN 服务。文章主机根路径 `/my-note` 直接返回文章，分享地址为 `https://s.irin.im/s/<token>`。三个域名可以改成你自己的域名。部署时 Custom Domains 会由 Cloudflare 配置 Worker 路由和证书。

## 4. 分享密钥

```sh
# 生成后保存在自己的密码管理器，不提交到源码
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
pnpm exec wrangler secret put SHARE_SESSION_SECRET
```

粘贴随机值到交互提示。密钥至少 32 个字符，推荐上面的 256 位值。轮换会使现有密码分享 Cookie 失效，用户重新输入密码即可。Access 团队域名/AUD/邮箱为配置，不是签名私钥；无需自己创建 Access 私钥。

## 5. 迁移、检查和部署

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm db:remote
pnpm run deploy
```

`db:remote` 只执行版本化迁移，不重建数据库。`deploy` 会先拒绝缺失配置，然后构建与上传 Worker/Assets。首次部署缺失密钥可先运行 `wrangler secret put`，按提示创建专用 Worker；不要覆盖同名现有项目。自动化部署使用外部环境变量 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；使用所需 Workers/D1/R2 权限，涉及 Custom Domains 还需对应 Zone 权限，遵循官方 API Token 最小权限流程。

上线验证：从无登录浏览器访问后台/API 应被拒绝；登录指定邮箱；完整走上传与分享撤销流程；发布文章后保存一段敏感草稿，确认公开正文没有变化；更新发布保持 URL；取消发布确认正文与图片都 404。实际云端 Access JWT 注入、证书、CPU 配额和 DNS 需在线验证，离线测试不替代它们。

不要创建会强制缓存 `/api/*`、`/p/*`、`/s/*` 或 md 主机正文的 Cache Rules。此项目使用 no-store 确保撤销生效，但不能阻止接收者在撤销前保存内容。

## 6. 环境与备份

- `--env local`：只用于 `wrangler dev` 与本地迁移；代码同时检查 ENVIRONMENT、LOCAL_AUTH 与 loopback hostname。
- 生产：顶层配置，默认关闭 LOCAL_AUTH；部署脚本会再次拒绝启用它。
- 如需预发布，单独创建 Worker、Bucket、D1 和 Access 应用，复制配置成另一份文件，所有资源 ID 与主机独立。不要绑定生产 Bucket 做开发测试。
- D1 使用平台提供的 Time Travel/导出能力；R2 数据需制定单独备份策略。此 MVP 不提供文件版本历史或自动 R2 备份。
- Cron 每小时处理持久化清理任务。当前 Wrangler 本地可请求 `/cdn-cgi/local/scheduled` 验证触发，以启动终端提示为准；生产可检查 Workers 日志/触发记录。

## 配置清单

| 参数                     | 作用                                   |
| ------------------------ | -------------------------------------- |
| R2 bucket_name / BUCKET  | 私有文件对象                           |
| D1 database_id / DB      | 真实数据库 ID                          |
| ADMIN_ORIGIN             | 私人后台来源，空值支持 Worker 默认主机 |
| FILES_ORIGIN             | 分享链接主机，空值用当前主机           |
| MARKDOWN_ORIGIN          | 阅读主机，空值用当前主机 `/p`          |
| ACCESS_TEAM_DOMAIN       | Access JWKS / issuer 域名              |
| ACCESS_AUD               | 管理 Access 应用 AUD                   |
| ADMIN_EMAILS             | 经 JWT 验证的允许邮箱                  |
| SHARE_SESSION_SECRET     | 密码分享短期 Cookie 签名，Secret 注入  |
| MAX_UPLOAD_BYTES         | 默认 20 MiB，必须低于账号请求体限制    |
| MAX_TEXT_BYTES           | 默认 1 MiB，限制正文读取和编辑         |
| ENVIRONMENT / LOCAL_AUTH | 生产必须 production / false            |

官方参考：[Static Assets 路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)、[R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
