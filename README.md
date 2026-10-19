# RCloud · Cloudflare Filehub

**中文** · [English](#english)

基于 Cloudflare Workers、私有 R2 和 D1 的个人云盘、图片托管与 Markdown 发布平台。支持 HTML 上传分享和文件夹静态网站，采用 MIT 协议。

## 功能

- 文件管理：多级目录、搜索、排序、列表/网格、分片上传、预览、回收站、恢复和永久删除。
- Image 托管：支持拖拽或选择多张图片，保存到 `/Image-hosting`，按内容 MD5 命名；直链、Markdown 链接、引用/下载统计，默认列表与全量画廊切换。
- HTML 上传：拖入或选择 HTML/HTM，保存到 `/Html-hosting` 后自动生成稳定分享地址；可再次复制、撤销、恢复，上传和发布分别重试。
- HTML 网站：发布含 `index.html` 的文件夹，直接加载相对 CSS、JavaScript 模块、JSON、字体、图片和子页面，没有 iframe。
- Markdown：保存在 `/Markdown`；CodeMirror 编辑、预览、草稿恢复和版本冲突检测；编辑器图片自动上传到 Image 托管；发布快照与私人草稿独立。
- 公开链接：密码、有效期、撤销、下载权限和统计；可选择源站或已配置的反代域名。
- 自动化：独立上传 API、ShareX 图床配置和 WebDAV 凭据。
- 界面：中文/英文、明暗主题、桌面侧栏与手机导航、统一的蓝绿马卡龙配色与独立卡片。
- 认证：站内密码＋TOTP 验证器，或 Cloudflare Access 管理员白名单。

R2 是唯一文件存储后端；当前版本不包含 Google Drive 挂载。

## 本地运行

需要 Node.js 22.12+ 和 pnpm 11。以下命令只操作本地开发环境：

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars.local
# PowerShell: Copy-Item .dev.vars.example .dev.vars.local
# 将示例密钥替换为独立随机值
pnpm db:local
pnpm dev
```

打开 `http://127.0.0.1:8787`。本地数据保存在 `.wrangler/state`。开发认证模拟仅在显式 local 环境与 loopback 地址同时满足时启用，不能用于生产。创建/读取分享链接需要配置 `SHARE_SESSION_SECRET`。

前端热更新可另开终端运行 `pnpm dev:ui`，API 由开发服务器转发给本地 Worker。

## 部署与文档

部署一个 Worker、一个私有 R2 Bucket 和一个 D1 数据库。使用自己的域名，例如 `https://cloud.example.com`，可选反代地址 `https://files.example.com`。真实账号、资源 ID 和密钥保存在被忽略的本地生产配置及 Cloudflare Secrets 中。

- [部署与升级](docs/deployment.md)
- [上传 API 与管理接口](docs/api.md) · [OpenAPI](docs/openapi.json)
- [ShareX](docs/sharex.md) · [WebDAV / RaiDrive](docs/webdav.md)
- [HTML 网站兼容范围](docs/html-sites.md)
- [数据与安全架构](docs/architecture.md) · [UI 维护](docs/ui-architecture.md)
- [验证与发布检查](docs/verification.md)

升级前备份 D1，先应用全部待执行迁移，再部署新 Worker。迁移 `0013` 移除已退出功能的 Google 连接元数据，`0014` 新增 HTML 上传分享记录，`0015` 建立事务内维护的容量计数；`0016–0018` 增强上传清理与图片撤销保护，并优化 WebDAV 路径查询。它们不搬移或改名现有 R2 文件。保留现有分享签名密钥和认证加密密钥。

## 容量与边界

应用总容量为 **50 GiB**（53,687,091,200 字节），包括回收站、发布快照、附件和上传预留。网页/API 分片上传没有额外单文件上限，但不能超过剩余容量。每片 16 MiB；直接上传上限 32 MiB，WebDAV 单次 PUT 上限 100,000,000 字节，在线文本/Markdown 上限 1 MiB。

50 GiB 是应用限制，**不是 Cloudflare 免费存储额度**。实际成本取决于 Workers、D1、R2 用量和账号套餐。容量检查读取单行计数，完整文件读取减少一次 R2 HEAD，清理引用查询使用索引；权限检查与访问统计仍保留。

单 HTML 分享适用于内联脚本、样式和内嵌图片的自包含页面。目录网站支持分享目录内的相对资源，但沙箱不开放浏览器持久存储、Service Worker、外部 CDN/API 或后端应用。详见 [HTML 网站说明](docs/html-sites.md)。上传内容不会获得管理后台的同源权限。

回收站恢复不会自动恢复公开分享；撤销无法收回接收者已保存的内容。图床图片独立公开，删除或取消发布文章不会自动撤销所引用的图片。文件没有历史版本或病毒扫描。协议测试不等于每个 WebDAV 客户端版本都已完成实机验收。

## 开发检查

```sh
pnpm check
```

依次运行类型检查、Lint、workerd 本地 D1/R2 测试、前端构建和 Worker dry-run。测试不访问生产存储；浏览器交互与真实 WebDAV 客户端需要单独验证。

```text
src/             React 后台、编辑器、上传队列、主题与语言
worker/          Hono API、鉴权、存储、公开 HTML 和 WebDAV
shared/          类型、校验、渲染与语言工具
db/migrations/   顺序 SQL 迁移
tests/           本地 D1/R2、安全和协议测试
docs/            部署、接口、架构与验收
```

## English

RCloud is a self-hosted personal drive, image host, and Markdown publishing platform built on **Cloudflare Workers + private R2 + D1**, licensed under MIT.

### Features

- File browsing, folders, search, multipart uploads, previews, trash and recovery.
- Drag-and-drop or multi-file image hosting in `/Image-hosting`, MD5 names, direct and Markdown links, view/download counters, a default list and a full gallery.
- Drag-and-drop HTML/HTM hosting in `/Html-hosting`, automatic stable share links, revocation and explicit restoration. Publication retries reuse the uploaded file and share.
- Folder websites with an `index.html` entry point and relative CSS, JavaScript modules, JSON, fonts, images and subpages, displayed directly without an iframe.
- Markdown files in `/Markdown`, editing and preview, automatic image uploads, conflict detection, and separate published snapshots.
- Password-protected and expiring shares, selectable configured public origins, upload API, ShareX and WebDAV.
- Chinese/English UI, light/dark themes, responsive layouts, and consistent blue/mint macaron cards.
- Password plus TOTP authentication, or Cloudflare Access with an administrator allowlist.

R2 is the only file storage backend. Google Drive mounting is not included in this version.

### Run locally

Use Node.js 22.12+ and pnpm 11. Install dependencies with `pnpm install --frozen-lockfile`, copy `.dev.vars.example` to `.dev.vars.local`, replace placeholder secrets, then run `pnpm db:local` and `pnpm dev`. Open `http://127.0.0.1:8787`. Local authentication bypass is restricted to the explicit local environment on loopback hosts; never deploy it.

### Deploy and upgrade

Provision a Worker, a private R2 bucket and a D1 database. Configure your own HTTPS origin, for example `cloud.example.com`, and an optional reverse proxy at `files.example.com`. Keep production resource IDs and secrets out of Git. Follow the [deployment guide](docs/deployment.md).

Back up D1, apply all migrations, then deploy. Migration 0013 removes retired Google connection metadata, 0014 adds HTML hosting records, and 0015 maintains storage usage with transactional triggers. Migrations 0016–0018 strengthen upload cleanup and image revocation handling, and optimize WebDAV path queries. Existing R2 files are not moved or renamed. Preserve existing signing and encryption keys.

### Limits and safety

The application enforces **50 GiB total capacity**, including trash, snapshots, attachments and upload reservations. This is not a promise of 50 GiB of free Cloudflare storage. Multipart uploads use 16 MiB parts without an additional per-file cap. Direct uploads are capped at 32 MiB, WebDAV PUT at 100,000,000 bytes, and online text editing at 1 MiB.

Single HTML shares support self-contained pages. Folder websites support resources inside their own share, but sandboxing excludes persistent browser storage, service workers, external APIs/CDNs and server-side applications. See [HTML compatibility](docs/html-sites.md).

Revocation affects subsequent requests; it cannot erase downloaded copies. Restoring a trashed file does not automatically republish it. Image hosting has its own lifecycle, independent of Markdown publishing. Version history, virus scanning and multi-user collaboration are not included.

`pnpm check` runs type checking, lint, local workerd/D1/R2 tests, the frontend build and a Worker dry-run. Browser and real WebDAV client acceptance are tracked separately in the [verification guide](docs/verification.md).

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
