# 本地验证与验收记录

验证环境：Windows / Node.js 24，pnpm 11；所有存储测试在 Cloudflare workerd 中运行，用本地 D1/R2，不访问生产资源。

## 自动化范围

目前四个测试文件、23 个业务测试，覆盖：

- 文件夹创建、重名、循环移动、数据库触发器的竞争更新保护、非空删除、恢复。
- R2 流式上传、实际大小、大小不匹配时的拒绝与 pending 清理、类型校验、名称校验、列表、搜索/分页、重命名、移动、下载、删除、回收站恢复、永久删除。
- 单区间 Range、suffix Range、HEAD、206 Content-Range、416、多区间拒绝、中文 Content-Disposition。
- 孤立对象清理、已引用对象保护、R2 删除失败时持久任务保留与重试。
- 分享令牌哈希、匿名授权访问、无效/过期/撤销、关闭下载、密码错误/正确、HttpOnly 会话、密码轮换、尝试限流、统计口径、删除后恢复不重开公开链接。
- Markdown 新建/保存/发布、未发布 404、独立快照、原 URL 更新、源文权限、取消发布、Slug 重复/非法/改名失效、保存和发布版本冲突。
- Markdown HTML/JavaScript/data SVG/私人图片路径安全过滤、GFM 表格/任务列表/代码高亮。
- 图片附件归属、未发布图片与草稿新附件私有、取消发布同时关闭图片。
- md 域名根路径与 ps 后台 API 隔离。
- 无 JWT、无效 JWT、生产不允许本地模拟、issuer/AUD/到期时间/签名/邮箱白名单校验，完整 middleware 对真实签名 JWT 的接受与拒绝。
- 管理写 API Origin 与自定义请求头检查；公共接口无需管理员身份。

鉴权测试使用即时生成的真实 RSA 签名；完整 middleware 测试仅替换 JWKS 网络响应为该测试公钥，不替换 JWT 验证。存储流程使用真实本地 D1/R2。故障恢复测试仅让 R2 delete 临时失败，验证真实 D1 中的持久清理状态与后续真实删除。

## 执行方式

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker:check
pnpm db:local
```

本轮 `pnpm check` 已实际完整执行：23 个测试通过（四个文件，约 18 秒）；TypeScript 与 ESLint 通过；React 生产构建通过；Worker dry-run 打包通过（约 389 KiB gzip）；两份本地 SQL 迁移通过。`pnpm peers check` 无依赖兼容问题。生产预检查对占位 D1 ID 和空 Access 参数返回非零，符合预期。

受此电脑沙箱对依赖目录访问限制影响，执行时使用过等价的本地 CLI 入口（例如 `node node_modules/vitest/vitest.mjs run`），实际运行的是 package scripts 指定的同一套工具。Vite 提示编辑器延迟加载块较大；首屏不加载编辑器，后续可继续缩减语言与 CodeMirror 功能集。

## 浏览器验收

已启动本地 Worker，浏览器实际创建 `本地验收.md`、输入正文、保存、配置 Slug `local-acceptance` 并发布。示例是明确的验收数据，不是代替生产 API 的 mock；它保存在本地 R2 和 D1。

本地后台：`http://127.0.0.1:8787`。示例阅读页：`http://127.0.0.1:8787/p/local-acceptance`。关闭启动进程后，按 README 的 `pnpm dev` 可重新启动。

桌面/手机布局、主题、阅读页和编辑器经浏览器检查；截图保存于 `docs/screenshots/`。自动化测试侧重点是安全与业务流程，未构建持续运行的浏览器 E2E 套件。

## 生产尚未验证

`wrangler whoami` 确认未登录 Cloudflare。未创建云端 Bucket/D1、未配置 Access、DNS 或发布生产 Worker。因此不宣称云端验收成功。

上线后按部署指南验证真实 Access 注入、公开域名、证书、匿名读取、撤销、附件、请求体上限与 CPU 配额。生产价格/免费额度、跨区域延迟与真实流量成本只能在实际账号与云端测试后确认。
