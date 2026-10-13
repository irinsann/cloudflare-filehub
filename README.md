# Cloudflare Filehub · RCloud

MIT 开源的 Serverless 个人云盘与 Markdown 发布平台。

运行在 Cloudflare Workers + 私有 R2 + D1 上的个人云盘和 Markdown 发布平台。React / TypeScript / Vite / Tailwind 4，shadcn 风格 Radix 组件，Lucide 图标；Hono API；Drizzle Schema 与参数化 D1 查询；CodeMirror 6 编辑器；unified / remark GFM / rehype-sanitize 安全渲染。

统一站点 `https://233334.xyz`：首页自动进入 `/drive/` 私人后台，`/p/:slug` 为公开文章，`/s/:token` 为分享页，`/d/:token` 为文件直链。生产只绑定一个域名，其他主机停止服务。

## 本地开始

需要 Node.js 22.12+（本次验证使用 24）、pnpm 11；Windows、macOS、Linux 均可。首次安装会下载 workerd / esbuild 平台运行时，受限网络需要允许访问 npm。

```sh
pnpm install --frozen-lockfile
pnpm db:local
# 为本地密码分享创建密钥配置（PowerShell 复制命令如下）
# Copy-Item .dev.vars.example .dev.vars.local
# 将示例值替换为自己生成的 32 字节随机字符串
pnpm dev
```

打开 `http://127.0.0.1:8787`。`pnpm dev` 先构建前端，再启动本地 Worker，本地 D1/R2 数据保存在 `.wrangler/state`。`--env local` 显式启用仅限 loopback 主机的认证模拟；顶层生产配置默认关闭。**本地配置绝不可用于生产部署。** 不配置分享会话密钥仍可管理文件和发布文章，但密码分享解锁会返回配置错误。

前端热更新：保留 Worker，另一个终端运行 `pnpm dev:ui`，打开 `http://127.0.0.1:5173`。Vite 转发 API 到 8787；为严格来源校验，代理会把 Origin 改为 Worker 地址，仅用于本地开发。

## 已实现

- 多级目录、目录重命名/移动、循环检测、空目录删除/恢复/永久删除。
- 选取与拖放上传、批量队列、进度与失败重试、大小预检；服务端有大小约束的流式 R2 写入与实际对象大小校验。
- 文件分页、排序、名称搜索、最近文件、列表/网格、类型图标、图片缩略图、右键操作、多选批量删除。
- 文件重命名/移动/下载、软删除、回收站恢复、永久删除与全部清空；删除自动撤销公开访问，恢复不会自动重新开放。
- 图片、PDF、纯文本/JSON/代码、Markdown、音视频预览；音视频/下载支持单个字节区间与 206 / 416 / HEAD。
- 256 位随机分享令牌（D1 只保存 SHA-256）、有效期、可选密码、预览与下载权限、访问与下载统计、管理列表、撤销；生成可直接下载的 `/d/:token` 链接。
- 密码使用 PBKDF2-SHA256 随机盐、100,000 次派生（适配 Workers WebCrypto 上限），10 次/5 分钟的 D1 原子尝试限制，短期 HttpOnly / SameSite Cookie；修改密码会使旧会话失效。
- 上传/新建真实 Markdown 文件、CodeMirror 语法高亮、双栏实时预览、工具栏、Ctrl/Cmd+S、未保存提示、浏览器草稿恢复、保存冲突检测。
- 标题、Slug、简介、自定义地址、是否允许源文件下载和索引、一键发布/更新/取消发布、复制链接、阅读计数。
- 独立 R2 发布快照：保存草稿不会更新公开文章；再次发布保持原 Slug。修改 Slug 会使旧地址失效，无隐式重定向。
- 拖入/选取图片附件；只公开属于该文档且已发布快照实际引用的图片；草稿新图片保持私有；取消发布立即阻断附件。
- Worker 直接返回安全 HTML 正文、目录、标题锚点、代码高亮/复制、SEO 与 Open Graph。禁止原始 HTML；HTTPS 远程图片由浏览器直连，不代理外部 URL。
- 中文响应式后台、手机导航与编辑/预览切换、浅色/深色主题、加载/空状态和错误反馈。
- 生产 Access JWT 签名、issuer、audience、过期/必要声明、管理员邮箱白名单；写 API Origin 与自定义请求头校验；安全响应头、保守 no-store 缓存与请求限流。
- D1/R2 跨存储恢复机制：预先登记待清理对象，D1 提交成功才释放；永久删除原子移除元数据并持久化清理任务，R2 失败由每小时 Cron 重试。

## 项目布局

```text
src/                 React 后台、编辑器、预览、组件与上传队列
worker/              鉴权、文件、分享、发布、存储、公共 HTML
shared/              公共类型、Zod 校验与 Markdown 渲染
db/schema.ts         Drizzle 表定义
db/migrations/       D1 SQL 迁移、外键、索引与约束
tests/               workerd 中运行的真实 D1/R2 与鉴权测试
docs/                部署、接口、架构及验收指南
wrangler.jsonc       默认生产配置与显式 local 环境
```

## 检查与部署

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker:check
# 完整顺序检查
pnpm check
```

测试使用当前 Cloudflare 官方 `@cloudflare/vitest-plugin`，在 workerd 中执行 SQL 迁移和真实本地 R2 操作，不会访问生产 Bucket 或 D1。详见 [验收与验证](docs/verification.md)。

生产资源、Access 与域名步骤见 [部署指南](docs/deployment.md)，主要路由见 [API 文档](docs/api.md)，数据与安全边界见 [架构说明](docs/architecture.md)。没有真实资源 ID / Access 配置时，不应运行生产部署命令。

## MVP 的明确边界

- 单文件上限 1GB（1,073,741,824 字节），按 16MiB 分片流式上传 R2，分片自动重试最多 3 次。上传任务有效期 24 小时；刷新页面后需重新选择上传，尚不支持跨页面断点续传。在线文本/Markdown 仍为 1MiB。
- 文件夹采用清空后删除，避免递归删除与恢复冲突。子文件/目录包括回收站项，先恢复移出或永久删除它们。
- 名称搜索不是内容全文搜索；文件列表分页。分享管理/Markdown 管理和单次目录选择最多返回 100 条，适合个人 MVP；高数据量时应扩展这些列表分页。
- 多选实现批量删除；重命名、移动、分享按单个文件操作。未实现批量下载打包、复杂多选移动。
- 预览密码分享关闭下载不能防止接收者另存内容或截图。下载计数口径是成功开始返回完整 200 GET 下载响应；HEAD、预览、Range 与未授权不计数，不代表传输完成或独立访客。
- 图片格式用文件头验证，不能保证图像完整解码；PDF/媒体只做签名识别。未知/伪装格式强制下载，HTML/SVG 作为文本并附带 sandbox CSP。未实现病毒扫描、缩略图处理或转码。
- 不保留文件内容历史；旧草稿对象和发布快照会清理。源文件改名不修改已经发布的标题或 Slug。
- 普通文件分享授予当前文件的访问权，Markdown 文件分享展示当前原文。若需让未发布修改保持私有，应使用 Markdown 编辑器的发布快照功能，而不是原文分享。
- 已取消发布的快照保留到再次发布或永久删除文件；不会通过公开接口返回。附件当前随文档永久删除一起清理，未引用附件不会自动删。
- D1 限流是正确性优先的基础防护，会产生写操作；大量攻击应叠加 Cloudflare WAF / Bot 防护，避免免费额度耗尽。单 Worker 没有完整网络级 DDoS 配额隔离。
- 清理任务仅处理超过 1 小时的对象，最多 8 个对象及 2 个过期分片任务/次；单篇发布最多 20 张受控附件，归属验证合并查询，以控制免费档子请求预算。操作日志保留 90 天。崩溃留下的 pending 上传会在清理时移除。
- 保留现有操作日志不含文件内容、密码或令牌；这里未配置外部遥测服务。
- WebDAV、多用户、版本管理、Office、同步客户端、全文索引、大文件直传属于后续扩展。

## 成本

上传/更新/发布调用 R2 A 类操作并增加存储；读取、下载、预览、附件和清理检查调用 R2 B 类操作。公开阅读运行 Worker 并查询/更新 D1；请求限流和计数也产生 D1 写入。Worker CPU、请求数、D1 读写与存储和 R2 存储/操作按账号实际套餐计费。这里不缓存可撤销私人内容，`run_worker_first: true` 也会让静态请求先运行 Worker，选择它是为统一鉴权与多域名隔离。以后可针对不可变公共静态资源优化。

价格和限制可能变化，请以 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[R2 定价](https://developers.cloudflare.com/r2/pricing/)、[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/) 与 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 为准。

## 开源协议

本项目采用 [MIT License](LICENSE)。第三方依赖保留各自的开源协议。
