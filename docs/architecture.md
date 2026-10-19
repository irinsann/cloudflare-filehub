# 数据与安全架构

## 数据表

| 表                       | 职责与约束                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| files                    | UUID、随机 object_key（唯一）、文件名/目录/MIME/大小/etag、version、pending/ready/deleting、毫秒时间、deleted_at |
| folders                  | UUID、父目录外键、名称、软删除；活跃兄弟名称唯一，根目录通过 COALESCE 索引统一                                   |
| file_shares              | 文件外键、唯一 token_hash、带盐 password_hash、有效期/启用/下载权限、查看与下载计数                              |
| markdown_pages           | 文件一对一、唯一 Slug、标题简介、发布标志、snapshot_key、published_version、下载/索引权限、阅读计数              |
| markdown_attachments     | 归属文档的文件外键、独立随机图片对象 Key、MIME/大小                                                              |
| page_attachments         | 页面和已引用附件复合主键；限制快照可公开的附件集合                                                               |
| operations               | 操作类型、目标 ID、时间；无密码、令牌或正文                                                                      |
| cleanup_tasks            | 对象 Key 主键、创建时间、尝试次数；跨存储补偿                                                                    |
| rate_limits              | scope + 哈希 IP/身份 + 时间窗；原子计数和到期时间                                                                |
| site_shares              | R2 文件夹外键、签名种子、密码哈希、授权版本、有效期/撤销状态与 HTML 浏览计数                                     |
| google_drive_connections | 单账号连接 ID、账户摘要、加密访问/刷新令牌、有效期与刷新互斥租约                                                 |
| google_drive_generation  | 连接代次；阻止断开或换号后迟到的 OAuth 回调覆盖新状态                                                            |
| google_drive_oauth       | 一次性 state/nonce 摘要、加密 PKCE verifier、发起域名、管理员会话与到期时间                                      |
| google_drive_uploads     | 连接外键、加密上传会话地址、远端文件 ID、预期大小、确认偏移、完成结果与互斥租约                                  |

完整 Schema 见 `db/migrations/` 中的顺序迁移；Google Drive 与目录网站分享分别由 `0011_google_drive.sql`、`0012_site_shares.sql` 新增。Drizzle 定义从 `db/schema.ts` 汇总。启用外键和文件大小非负约束；常用目录、删除状态、最近更新时间、附件归属、操作时间和限流到期字段均有索引。目录触发器在 SQLite 内部再次阻断循环、非空删除和移入已删除目录，防止竞争更新绕过服务层检查。Drizzle 用于文件元数据更新，复杂条件/CAS/递归 CTE 使用参数化 D1 SQL，避免引入不适配边缘事务的封装。

## 对象生命周期

1. 先在 D1 记录待清理随机对象 Key，上传时另插 pending 文件。
2. 写入 R2，读取返回大小/ETag；流通过 FixedLengthStream 验证预告大小，超限在写入前拒绝。MIME 根据扩展名和有限文件头共同判断，不接受浏览器自行声明的可执行 MIME。
3. D1 batch 原子更新 ready 元数据、移除新对象清理任务并记录操作。如果 R2 成功后 SQL 失败，任务仍在，Cron 可恢复。
4. Markdown 保存用新 Key，D1 UPDATE 的版本条件必须匹配；只有切换成功才释放新对象并排队旧对象。冲突留下的新对象随后清理，不覆盖其他窗口内容。
5. 发布必须提交编辑窗口看到的文件版本；复制正文到新快照，并在 D1 batch 中用版本/存活条件切换发布元数据与附件授权。过期窗口不能意外发布另一窗口的新草稿，冲突也不会移除旧快照的附件授权。未发布草稿永不用于访客响应；已发布快照只在再次发布时切换。
6. 删除先软删除并关闭分享/文章。永久删除将所有相关 Key 排队并删除 D1 元数据，外键级联移除授权；R2 删除失败可重试，无法通过业务接口读取剩余对象。
7. Cron 仅处理排队超过一小时且没有 files/pages/attachments/image_hosts/upload_sessions 引用的对象，每次 8 个对象及 2 个过期超过一小时的上传任务。回收站、未发布快照、未被文章引用的附件和所有文件状态都受保护；pending 保留清理任务。过期分片必须成功终止或明确返回 NoSuchUpload（10024）后才删除会话和 pending 索引，临时失败保留会话与容量，按尝试次数轮换重试。普通直传明确失败时仅移除本次 pending 索引；进程崩溃等无法确认终止的 pending 需人工对账。限制批量数以适配免费档子请求预算；永久删除与清空回收站在同一 D1 batch 中先收集文件、附件和快照 Key，再删除记录；提交后按 100 个对象一批立即尝试 R2 删除。再次检查活跃引用，只在 R2 删除成功后释放容量和队列；失败保留原有容量与持久任务，由 Cron 重试。

D1 和 R2 没有共享事务。上传和 SQL 异常只能保证可补偿的一致性，不能宣称跨存储强事务。极端后台存储故障需检查任务与平台日志，系统不向访客泄露内部错误详情。

## 认证与 Origin

私人后台与 `/api/admin/*` 在 `password_totp` 模式下验证站内密码与验证器登录产生的会话；兼容 Access 模式时验证 JWKS RS256 JWT、issuer/AUD、有效期与必要声明，并检查明确邮箱白名单。公开路由独立，不调用后台身份当作授权；未配置为管理域名或可信反代的来源不能使用后台接口。开发模拟必须 ENVIRONMENT=local、LOCAL_AUTH=true、loopback 主机三者同时成立。

管理员写操作要求同源 Origin 和 X-Drive-Request；没有全局开放 CORS。Markdown 公开正文禁止原始 HTML，链接经过 sanitizer，图片仅 HTTPS 或受控附件。正文和附件响应 no-store；文件响应 CSP sandbox、nosniff、保守 Content-Disposition；HTML/SVG 私有预览仍作文本。

HTML/HTM 的 `/s/:token` 在授权后直接流式返回原始文件字节，不添加站点外壳、iframe 或脚本；密码未解锁时仅返回无文件信息的解锁页，成功后重新加载原分享地址。原始 HTML 的响应头设置 `sandbox allow-scripts`，不授予 `allow-same-origin`，从而隔离本站 Cookie、存储和页面权限；`frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 禁止被嵌套。仅允许内联脚本/样式与内嵌资源，禁止外部子资源、fetch/XHR 等连接、表单、嵌套框架、Worker 和弹窗；原网页可以通过链接、location 或 meta refresh 导航自身。此规则同样用于独立预览接口。

分享页、预览、HEAD、Range 和下载每次检查分享权限；下载保持原始附件。完整授权的 HTML 分享 GET 记浏览，HEAD/Range 不计浏览；下载计数仍仅统计完整成功的 GET 下载。普通分享页、解锁页和 Markdown 发布页 CSP 使用每次随机 nonce；不依赖任意远程抓取或公开 R2 地址。

分享密码使用 PBKDF2 100,000 迭代（WebCrypto Workers 兼容范围），应用级原子限流限制猜测；强密码仍很重要。数据库仅保存随机令牌的 SHA-256，旧版随机链接继续通过摘要匹配。管理员创建或列出分享时，返回由 `SHARE_SESSION_SECRET` 以 HMAC-SHA256 签名的稳定地址；签名使用独立用途标识并绑定分享 ID 和令牌摘要，不在数据库中保存可直接访问的明文地址。签名地址先验签，再执行相同的文件状态、密码、有效期和下载权限检查；旧链接与签名地址共用同一授权记录和统计。列表响应不含令牌摘要或密码哈希，且只允许管理员访问并禁用缓存。

部署时保留 `SHARE_SESSION_SECRET`。轮换该密钥会使已复制的签名地址与分享解锁会话失效；重新从管理列表复制可取得新签名地址。旧版随机链接不因密钥轮换失效，但仍受分享权限约束。

受控资源撤销在后续请求时生效，正在传输的文件和接收者已保存内容无法追回。读取后又在另一请求撤销的极短竞态不能回收已经取得的流，no-store 保证不会形成长期未受控缓存。

## R2 目录网站分享

独立的 `/site/:token/` 路由以 R2 文件夹内的 `index.html` 为入口，子目录同样解析 `index.html`。`worker/site-shares-files.ts` 限制目录边界、拒绝歧义重名和危险路径，并为 CSS、JS、字体等资源提供正确 MIME；不更改普通文件预览规则。每次资源请求检查目录存活、分享启用、有效期和密码授权。目录移入回收站时由数据库触发器撤销本目录及后代的网站分享，恢复目录不会自动重新公开。

HTML 直接展示，不使用 iframe。响应保持 `sandbox allow-scripts` 且不授予 `allow-same-origin`；CSP 仅开放该分享路径下的脚本、模块、样式、图片、字体和 fetch。资源路由提供无凭据 CORS，后台 API 不开放 CORS。密码解锁生成最长一小时、绑定分享和授权版本的路径凭证，供模块与子资源使用；该地址在有效期内属于访问凭据。撤销与到期对后续资源请求生效，所有受控响应保持 no-store。

网站应使用相对路径；不自动重写域名根绝对路径或网页字节。浏览器本地存储、Service Worker/PWA、跨站 API、表单及外部登录不属于此隔离模式。单文件 `/s/:token` 继续使用其原有、更严格的资源策略。

## 独立 Google Drive 挂载

R2 继续作为主网盘，维持现有 50GiB 容量、图床、Markdown、分享和 WebDAV。Google Drive 使用独立页面、`shared/google-drive.ts` 类型和 `/api/admin/google-drive/*` 接口；远端文件不进入 R2 的文件、容量分配或清理任务，不建立全盘 D1 镜像。浏览使用 Google 文件 ID 与游标分页，写操作依据远端 capabilities；普通文件流式下载，原生文档按支持的格式导出，普通导出的 10 MB 限制仍由 Google 决定。

`worker/google-drive-oauth.ts` 负责授权，`google-drive-client.ts` 负责加密凭据、Google 请求和刷新，`google-drive-uploads.ts` 负责上传会话，`google-drive.ts` 编排文件接口。OAuth 发起要求管理员身份与可信 Origin；独立回调使用一次性 state、PKCE 和短期 Lax nonce Cookie，不放宽主登录的 Strict Cookie。香港反代即使保留上游 Host，也使用白名单内的浏览器 Origin 生成回调；回调核对保存的域名及 nonce，不信任任意转发主机头。

普通写入、重连和断开操作绑定当前连接 ID；上传队列与会话同样绑定原账号，避免旧窗口操作另一个账号。令牌刷新和上传分别使用 D1 条件租约，迟到响应不得恢复已断开的连接。上传以 16 MiB 分片顺序转发，失联先查询 Google 确认的偏移；已经消费的请求流不能直接重放。取消先确认远端是否已完成，查询失败保留待确认状态。断开与定时清理只移除本地连接或过期会话，均不删除 Google 文件。

OAuth 客户端由部署者配置，真实账号仍需在 Google 页面授权。当前 Google 自动化验证使用模拟 API，不能代替真实账号授权及跨代理浏览器联调；最新验收状态见 [验证指南](verification.md)。

## 前端

初始后台独立加载，CodeMirror 与 Markdown renderer 在打开编辑/预览时加载。代码语言按需加载；统一小组件、CSS 变量主题、Radix 对话框焦点管理，移动端导航与编辑/预览单面板切换。上传采用串行队列，限制同时占用网络资源。错误时内容仍在编辑器，保存失败允许下载本地草稿；localStorage 草稿只是辅助恢复。

WebDAV 位于 `/dav/`，使用独立凭据（仅保存 SHA-256 摘要），共享文件/目录表、私有 R2 与容量配额。路径查询使用递归 SQL；重名返回冲突。覆盖先写新对象，再切换元数据并排队清理旧对象。持久锁及全局短期写入租约协调网页和 WebDAV 的命名空间修改；目录删除从叶到根软删除并撤销公开授权。XML 使用受限的 namespace-aware 解析器，拒绝 DOCTYPE 与自定义实体。详细协议限制见 [WebDAV](webdav.md)。

全文搜索、历史版本、多用户可新增服务接口，当前不引入微服务或新的付费产品依赖。
