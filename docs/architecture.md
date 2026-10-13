# 数据与安全架构

## 数据表

| 表                   | 职责与约束                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| files                | UUID、随机 object_key（唯一）、文件名/目录/MIME/大小/etag、version、pending/ready/deleting、毫秒时间、deleted_at |
| folders              | UUID、父目录外键、名称、软删除；活跃兄弟名称唯一，根目录通过 COALESCE 索引统一                                   |
| file_shares          | 文件外键、唯一 token_hash、带盐 password_hash、有效期/启用/下载权限、查看与下载计数                              |
| markdown_pages       | 文件一对一、唯一 Slug、标题简介、发布标志、snapshot_key、published_version、下载/索引权限、阅读计数              |
| markdown_attachments | 归属文档的文件外键、独立随机图片对象 Key、MIME/大小                                                              |
| page_attachments     | 页面和已引用附件复合主键；限制快照可公开的附件集合                                                               |
| operations           | 操作类型、目标 ID、时间；无密码、令牌或正文                                                                      |
| cleanup_tasks        | 对象 Key 主键、创建时间、尝试次数；跨存储补偿                                                                    |
| rate_limits          | scope + 哈希 IP/身份 + 时间窗；原子计数和到期时间                                                                |

完整 Schema 见 `db/migrations/0001_initial.sql` 与 `0002_tree_guards.sql`；Drizzle 定义见 `db/schema.ts`。启用外键和文件大小非负约束；常用目录、删除状态、最近更新时间、附件归属、操作时间和限流到期字段均有索引。目录触发器在 SQLite 内部再次阻断循环、非空删除和移入已删除目录，防止竞争更新绕过服务层检查。Drizzle 用于文件元数据更新，复杂条件/CAS/递归 CTE 使用参数化 D1 SQL，避免引入不适配边缘事务的封装。

## 对象生命周期

1. 先在 D1 记录待清理随机对象 Key，上传时另插 pending 文件。
2. 写入 R2，读取返回大小/ETag；流通过 FixedLengthStream 验证预告大小，超限在写入前拒绝。MIME 根据扩展名和有限文件头共同判断，不接受浏览器自行声明的可执行 MIME。
3. D1 batch 原子更新 ready 元数据、移除新对象清理任务并记录操作。如果 R2 成功后 SQL 失败，任务仍在，Cron 可恢复。
4. Markdown 保存用新 Key，D1 UPDATE 的版本条件必须匹配；只有切换成功才释放新对象并排队旧对象。冲突留下的新对象随后清理，不覆盖其他窗口内容。
5. 发布必须提交编辑窗口看到的文件版本；复制正文到新快照，并在 D1 batch 中用版本/存活条件切换发布元数据与附件授权。过期窗口不能意外发布另一窗口的新草稿，冲突也不会移除旧快照的附件授权。未发布草稿永不用于访客响应；已发布快照只在再次发布时切换。
6. 删除先软删除并关闭分享/文章。永久删除将所有相关 Key 排队并删除 D1 元数据，外键级联移除授权；R2 删除失败可重试，无法通过业务接口读取剩余对象。
7. Cron 仅处理超过一小时任务，每次 10 个，删除前检查 files/pages/attachments 是否仍引用 Key，防误删。超过一小时的 pending 上传一并清理。限制批量数以适配免费档子请求预算；正文永久删除立即尝试，附件和快照通过持久任务清理。

D1 和 R2 没有共享事务。上传和 SQL 异常只能保证可补偿的一致性，不能宣称跨存储强事务。极端后台存储故障需检查任务与平台日志，系统不向访客泄露内部错误详情。

## 认证与 Origin

私人后台与 `/api/admin/*` 验证 Access JWKS RS256 JWT、issuer/AUD、有效期与必要声明，并检查明确邮箱白名单。公开路由独立，不调用后台身份当作授权；公开主机上的后台接口直接拒绝。开发模拟必须 ENVIRONMENT=local、LOCAL_AUTH=true、loopback 主机三者同时成立。

管理员写操作要求同源 Origin 和 X-Drive-Request；没有全局开放 CORS。公开内容禁止未处理 HTML，链接经过 mature sanitizer，图片仅 HTTPS 或受控附件。正文和附件响应 no-store；文件响应 CSP sandbox、nosniff、保守 Content-Disposition；HTML/SVG 扩展名只作文本预览。发布页 CSP 使用每次随机 nonce，禁止任意脚本/iframe/对象；没有第三方脚本、任意远程抓取或公开 R2 地址。

分享密码使用 PBKDF2 100,000 迭代（WebCrypto Workers 兼容范围），应用级原子限流限制猜测；强密码仍很重要。token 256 位随机，数据库只保存 SHA-256，无重新构造原始链接的能力。若遗失链接，可撤销并新建。

受控资源撤销在后续请求时生效，正在传输的文件和接收者已保存内容无法追回。读取后又在另一请求撤销的极短竞态不能回收已经取得的流，no-store 保证不会形成长期未受控缓存。

## 前端

初始后台独立加载，CodeMirror 与 Markdown renderer 在打开编辑/预览时加载。代码语言按需加载；统一小组件、CSS 变量主题、Radix 对话框焦点管理，移动端导航与编辑/预览单面板切换。上传采用串行队列，限制同时占用网络资源。错误时内容仍在编辑器，保存失败允许下载本地草稿；localStorage 草稿只是辅助恢复。

全文搜索、历史版本、多用户、WebDAV 可新增服务接口复用 getFile/activeFolder/storage 权限与元数据操作，当前不引入微服务或新的付费产品依赖。
