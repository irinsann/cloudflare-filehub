# API

统一成功 `{ "data": ... }`；错误 `{ "error": { "code": 400, "message": "...", "request_id": "..." } }`。JSON 请求使用 Content-Type。管理员写操作必须同时携带同 Origin 和 `X-Drive-Request: 1`。生产由 Cloudflare 注入 `Cf-Access-Jwt-Assertion`，不能自行信任邮箱头。标识符均为 UUID，日期是 Unix 毫秒。

## 文件与目录

| Method   | 路径（前缀 `/api/admin`）                  | 内容                                                                                                                                   |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| GET      | `/settings`                                | 身份、大小限制、公开域名                                                                                                               |
| GET      | `/files`                                   | `folder_id`, `view=files/recent/markdown/trash`, `search`, `page`, `limit`（1–100）, `sort=name/size/updated_at`, `direction=asc/desc` |
| POST     | `/files/upload?name=文件名&folder_id=UUID` | 原始二进制 Body，`X-File-Size` 是必需整数；绑定有限长度流，实际大小必须匹配                                                            |
| GET      | `/files/:id`                               | 元数据                                                                                                                                 |
| PATCH    | `/files/:id`                               | `{name?,folder_id?:UUID                                                                                                                | null}`         |
| DELETE   | `/files/:id`                               | 软删除并撤销所有公开访问                                                                                                               |
| POST     | `/files/:id/restore`                       | 恢复私人文件                                                                                                                           |
| DELETE   | `/files/:id/permanent`                     | 仅已软删除文件；永久删除元数据及重试清理 R2                                                                                            |
| GET/HEAD | `/files/:id/download`                      | 文件流，`preview=1` 使用安全内联；支持 Range                                                                                           |
| GET      | `/files/:id/content`                       | 有大小上限的文本与版本                                                                                                                 |
| GET/POST | `/folders`                                 | 查询当前父目录，或创建 `{name,parent_id:UUID                                                                                           | null}`         |
| GET      | `/folders/:id`                             | 目录元数据                                                                                                                             |
| PATCH    | `/folders/:id`                             | `{name?,parent_id?:UUID                                                                                                                | null}`，防循环 |
| DELETE   | `/folders/:id`                             | 仅空目录（含回收站内容检查）                                                                                                           |
| POST     | `/folders/:id/restore`                     | 父目录存活且名称无冲突才能恢复                                                                                                         |
| DELETE   | `/folders/:id/permanent`                   | 永久删除空回收站目录                                                                                                                   |

文件列表数据 `{ files, folders, total, page, limit }`，按文件总数分页。近期与 Markdown 视图为全局索引查询；名称搜索对 `%`/`_` 做转义。目录选择器和管理列表默认最多 100 条。

## 分享

| Method   | 路径                                | 内容                                                     |
| -------- | ----------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| GET      | `/api/admin/shares`                 | 最近 100 条，含状态、保护标志、计数，无密码哈希/明文令牌 |
| POST     | `/api/admin/shares`                 | `{file_id,password?,expires_at:number                    | null,allow_download:boolean}`，创建后一次性返回 `id,url` |
| PATCH    | `/api/admin/shares/:id`             | `{enabled?,allow_download?,expires_at?,password?:string  | null}`；null 移除密码                                    |
| DELETE   | `/api/admin/shares/:id`             | 撤销                                                     |
| GET      | `/s/:token`                         | 访客页面；密码验证前不嵌入文件元数据                     |
| GET      | `/api/public/share/:token`          | 已授权元数据，计页面查看次数                             |
| POST     | `/api/public/share/:token/unlock`   | `{password}`；受频率限制，HttpOnly 会话 Cookie           |
| GET      | `/api/public/share/:token/text`     | 安全文本预览                                             |
| GET/HEAD | `/api/public/share/:token/preview`  | 可预览类型的受控响应                                     |
| GET/HEAD | `/api/public/share/:token/download` | 服务端重新校验链接、密码、状态、有效期和下载权限         |

无效 token 404，失效/撤销 410，密码未验证 401，禁止下载 403；不返回私有对象 Key。密码 Cookie 每个分享独立，签名绑定分享 ID 与当前密码哈希，最长 1 小时，生产 Secure。

## Markdown

| Method   | 路径                                                | 内容                                                                                          |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET      | `/api/admin/markdown`                               | 最近 100 个文档及发布状态                                                                     |
| POST     | `/api/admin/markdown`                               | `{name,folder_id?,content?}`，文件名 .md/.markdown                                            |
| GET      | `/api/admin/markdown/:id`                           | `{file,content,page}`，id 是文件 ID                                                           |
| PUT      | `/api/admin/markdown/:id`                           | `{content,version}`；乐观并发冲突 409                                                         |
| POST     | `/api/admin/markdown/:id/attachments?name=...`      | 图片原始 Body，`X-File-Size`；返回 `{id,reference:attachment:UUID}`                           |
| GET      | `/api/admin/markdown/:id/attachments/:attachmentId` | 私人图片预览，验证归属                                                                        |
| POST     | `/api/admin/markdown/:id/publish`                   | `{title,slug,description,allow_source,allow_index,version}`；创建独立快照；版本不匹配返回 409 |
| POST     | `/api/admin/markdown/:id/unpublish`                 | 取消发布，原始文件保留                                                                        |
| GET/HEAD | `/p/:slug` 或 md 主机 `/:slug`                      | Worker 安全 SSR 正文                                                                          |
| GET/HEAD | `/api/public/pages/:slug/source`                    | 只返回已发布快照，需开启允许源文件下载                                                        |
| GET/HEAD | `/api/public/pages/:slug/attachments/:id`           | 验证发布状态、文件存活、实际引用和附件归属                                                    |

正文图片示例 `![示例](attachment:UUID)`。远程图片仅接受 HTTPS，直接由读者浏览器请求。其他本地路径、私人 API URL、data URL 不会作为图片渲染；不提供任意 URL 代理。

响应常用状态：201 新建，400 无效参数，401 未登录/密码，403 权限或来源失败，404 不存在，409 名称/Slug/版本冲突，410 分享失效，413 超限，415 不支持预览，416 Range 不可满足，429 请求限流，503 缺少必要认证或会话配置。

RCloud 新接口：POST `/api/admin/uploads` 初始化 1GB 内分片上传；PUT `/api/admin/uploads/:id/parts/:part` 上传固定 16MiB 分片（最后一片按剩余长度）；POST `.../:id/complete` 由服务端保存的分片列表完成上传；DELETE `.../:id` 取消任务。DELETE `/api/admin/trash` 清空全部回收站。分享创建响应包含 directUrl，GET/HEAD `/d/:token` 直接下载并遵守分享有效期、密码、下载许可及撤销。
