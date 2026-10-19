# Google Drive

RCloud 的「Google Drive」是独立文件管理页面。主网盘、图床、Markdown、公开分享和 WebDAV 继续使用 R2；Google 文件保存在 Google，自身容量单独显示，不占 R2 的 50GiB 配额，也不会全盘同步元数据到 D1。

## 配置自己的 Google 项目

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/)创建专用项目，例如 `RCloud`，启用 **Google Drive API**。
2. 在 **Google Auth Platform** 配置应用名称、支持邮箱和开发者联系邮箱。个人 Gmail 使用 **External** audience；测试阶段添加自己的 Google 账号作为测试用户。
3. 在 **Data Access** 中添加 `https://www.googleapis.com/auth/drive`。这是完整文件管理权限；`drive.file` 仅覆盖应用创建或用户选择的文件，不能管理已有整个网盘。[权限说明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
4. 在 **Clients** 创建 **Web application** 客户端，登记下列两个精确的 Authorized redirect URIs：

   ```text
   https://233334.xyz/api/oauth/google/callback
   https://s.irin.im/api/oauth/google/callback
   ```

   自部署应使用设置页面列出的回调地址，路径必须完全一致，不使用通配符。RCloud 使用服务端授权码流程，不需要浏览器 JavaScript 客户端密钥。[Web 应用 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)

5. 保存 Client ID 与 Client secret 到 Worker Secrets，密钥不要提交仓库或粘贴到公开聊天：

   ```sh
   pnpm exec wrangler secret put GOOGLE_CLIENT_ID --config wrangler.production.jsonc
   pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.jsonc
   ```

   同时需要至少 32 字符的 `AUTH_ENCRYPTION_KEY`。已经启用密码与验证器登录的部署应复用现有密钥，**不要覆盖或轮换**。Access 登录模式若尚未配置该密钥，单独创建随机密钥并保存为 Worker Secret。

6. 应用所有数据库迁移并部署，登录 RCloud，在 Google Drive 页面点击连接，再由账号所有者在 Google 页面确认授权。
7. 长期使用前将 OAuth audience 的发布状态调整为 **In Production**。External + Testing 模式下，申请 Drive 权限的刷新令牌通常七天过期；生产状态也需要处理授权撤销或令牌失效。[令牌有效期](https://developers.google.com/identity/protocols/oauth2#expiration)

完整 Drive 权限属于 restricted scope。个人自用与向公众提供 OAuth 服务的审核要求不同；使用自己的项目并核对 Google 当前显示的验证要求。部署开源 RCloud 不等于获得 Google 审核。[OAuth 验证要求](https://support.google.com/cloud/answer/13464323?hl=en)

## 文件管理

页面提供目录浏览、名称搜索、分页、新建目录、上传、下载、重命名、移动、回收站、恢复和彻底删除。Google 文件按 ID 区分，允许同目录同名文件；操作仍受 Google 返回的文件权限约束。

Google Docs、Sheets、Slides 是原生文档，提供在 Google 打开和按支持格式导出；RCloud 不编辑这些文档内部内容。导出受 Google 的格式与大小限制，失败时可在 Google 中打开处理。

上传使用 Google resumable 协议，顺序发送 16MiB 分片；重试前查询已确认偏移，避免直接重建导致重复文件。文件字节经过 Worker 流式转发，不写入 R2。浏览器刷新后当前队列不保留，未完成的上传记录会过期清理。

断开连接只移除 RCloud 中的连接和上传状态，不删除 Google 文件。若要撤销 Google 端对应用的授权，可在 Google 账号的第三方连接中操作。

此版本不把 Google 文件接入 RCloud 公开直链、图床、Markdown 发布、HTML 网站源或 WebDAV，也不实现跨 R2/Google Drive 搬运。

## 安全与验证

OAuth 只能从已登录的管理页面发起。回调绑定发起域名、短时一次性 state 和独立浏览器 Cookie；主登录 Cookie 仍为 SameSite=Strict。客户端密钥、访问令牌、刷新令牌及上传会话地址不返回前端；持久凭据加密存储。

两个域名必须分别测试授权与返回流程。接入真实账号后，用专门测试目录验证小文件、大文件分片、中断恢复、重命名、移动、删除、恢复及下载内容一致性。自动化测试中的 Google 响应由测试替身提供，不能代替真实账号授权验收。

挂载消耗 Google API 额度及 Worker 请求；文件不占 R2 并不意味着完全没有资源消耗。以新项目控制台和 [Google Drive 当前额度](https://developers.google.com/workspace/drive/api/guides/limits)为准。

## 管理 API

所有 `/api/admin/google-drive` 接口使用 RCloud 管理员会话；写请求要求可信 Origin 和 `X-Drive-Request: 1`。不接受普通上传 API Token。除文件下载外，成功响应为 `{data:...}`。

创建目录、修改或删除文件、断开连接，以及已连接状态下重新授权，必须携带 `X-Google-Connection`，值为状态接口返回的 `connectionId`。上传初始化将同一值放在请求体内；后续上传操作使用绑定该连接的会话 ID。账号切换后旧操作返回冲突，不会写入新账号。首次连接不需要该头。

状态接口可能返回 `needsReconnect` 和 `error`；Google 授权失效时文件接口返回 424，前端提示重新连接，RCloud 登录会话保持有效。普通文件支持单一 Range；同时提供 `If-Range` 时保守返回完整文件（200），避免拼接不同版本。Google 原生文档普通导出受 10MB 限制，超限返回 413。

| 方法     | 路径（前缀 `/api/admin/google-drive`） | 参数与行为                                                                   |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| GET      | `/`（实际路径无尾斜杠）                | 配置、连接、账户、容量和回调地址                                             |
| POST     | `/connect`                             | 返回 Google 授权 URL                                                         |
| DELETE   | `/connection`                          | 移除本地连接，保留远端文件                                                   |
| GET      | `/files`                               | `parent=root`、`q`、`page_token`、`trashed=1`；返回 `{files,nextPageToken?}` |
| POST     | `/folders`                             | `{name,parentId}`，创建文件夹                                                |
| PATCH    | `/files/{id}`                          | `{name?,parentId?,trashed?}`，重命名、移动、回收或恢复                       |
| DELETE   | `/files/{id}`                          | 彻底删除已经位于回收站的条目                                                 |
| GET/HEAD | `/files/{id}/download`                 | 普通文件下载，支持单一 Range；原生文档须提供返回列表中的 `format`            |
| POST     | `/uploads`                             | `{name,parentId,size,mime,fileId?,connectionId}`，新建上传或覆盖指定普通文件 |
| GET      | `/uploads/{id}`                        | 查询 Google 已确认的偏移和完成结果                                           |
| PUT      | `/uploads/{id}?offset=N`               | 原始分片内容，提供 `X-File-Size`，最长 16MiB                                 |
| DELETE   | `/uploads/{id}`                        | 停止会话；若已完成，不删除远端文件                                           |

上传状态包括 `id`、`chunkSize`、`offset`、`complete`，完成时另含 `file`。初始化使用页面读取的 `connectionId`，避免排队文件在账号切换后传给另一个账号。分片必须顺序发送，非末片大小为 256KiB 的整数倍。

遇到传输失败先 GET 查询偏移，不能直接重新初始化。会话失效时可能需要检查 Google 中的文件再重新选择上传，避免完成响应丢失后重复上传。取消与最后分片完成可能相遇，客户端应显示服务端确认的结果；未确认的取消不能视为成功。

`GET /api/oauth/google/callback` 是 OAuth 专用回调，不接受用户指定的任意回跳地址。正常使用应始终从管理端 `/connect` 开始。
