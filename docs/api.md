# RCloud API

上传 API 使用 `/api/v1`，供命令行、备份脚本和自动化工具调用。当前地址为 `https://s.irin.im`，也可直接使用 `https://233334.xyz`；自部署请替换为自己的 HTTPS 站点。

- [上传快速开始](#上传快速开始)
- [图片上传与 ShareX](sharex.md)（MD5 命名、公开直链）
- [WebDAV / RaiDrive](webdav.md)（独立凭据、目录挂载与文件读写）
- [分片上传](#分片上传)
- [Token 管理](#token-管理)
- [管理与公开接口](#管理与公开接口)
- [错误与限制](#错误与限制)
- [OpenAPI 规范](openapi.json)（上传 API 和 Token 管理）
- [Python 上传脚本](../scripts/upload.py)（Python 3.10+，无需第三方库）

## 认证与响应

| 接口           | 认证                                                  | 写请求要求                                                                                     |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/v1/*`    | `Authorization: Bearer rcu_…`                         | 不需要 Cookie、验证码或 X-Drive-Request；脚本可不发送 Origin；若发送，必须是站点或可信反代来源 |
| `/api/admin/*` | 网页管理员会话；Access 模式使用经过验证的 Access JWT  | 必须携带允许的 Origin 和 `X-Drive-Request: 1`                                                  |
| `/api/auth/*`  | 登录/首次绑定流程                                     | 允许的 Origin 和 `X-Drive-Request: 1`                                                          |
| `/dav/*`       | HTTPS Basic，用户名 `rcloud`，密码为独立 `rcd_…` 凭据 | 返回 WebDAV XML 或文件流；不使用网页登录或上传 Token，详见 [WebDAV](webdav.md)                 |
| 公开接口       | 按发布状态、分享权限和密码校验                        | 上传 Token 不作为公开内容授权                                                                  |

Token 分为两类：`files:upload` 用于私有文件上传、查询和取消自己的上传任务、查询自己的文件元数据；`images:upload` 仅用于 `/api/v1/images` 图片上传并生成公开直链。两类权限不可互换，均无列出网盘、下载私有文件、删除已完成文件、创建分享或管理 Token 的权限。网页会话与上传 Token 不可互换，跨站浏览器调用未开放 CORS。不要把 Token 放入 URL、公开网页或 Git 仓库。

成功响应除文件流外统一为 `{"data": ...}`。新建通常返回 201；查询、分片写入和取消返回 200。失败响应：

```json
{
  "error": { "code": 401, "message": "上传 Token 无效、已到期或已撤销", "request_id": "请求 UUID" }
}
```

响应带 X-Request-Id，API 响应禁止共享缓存。ID 为 UUID，时间为 Unix 毫秒，大小为字节。JSON 使用 Content-Type: application/json；文件和分片使用 application/octet-stream 和原始二进制 Body，**不是 multipart/form-data**。图片接口 `/api/v1/images` 使用 multipart/form-data，详见 [图片上传与 ShareX](sharex.md)。

## 上传快速开始

1. 登录网站，打开 **设置 → 上传 API → 创建 Token**。
2. 选择「文件上传（私有）」，填写名称与有效期，保存仅显示一次的 Token。
3. 将 Token 放入环境变量 RCLOUD_TOKEN，上传后在网盘查看文件。

### Python：普通文件、大文件和空文件

Bash（隐藏输入，不把 Token 字面值写入命令历史）：

```bash
read -rsp 'RCloud Token: ' RCLOUD_TOKEN; echo
export RCLOUD_TOKEN
python3 scripts/upload.py ./backup.zip --url https://s.irin.im
unset RCLOUD_TOKEN
```

PowerShell 7：

```powershell
$env:RCLOUD_TOKEN = Read-Host 'RCloud Token' -MaskInput
python scripts/upload.py 'C:\Backups\backup.zip' --url https://s.irin.im
Remove-Item Env:RCLOUD_TOKEN
```

可选 `--folder UUID` 指定已有文件夹，默认根目录。脚本只缓存一个分片，显示进度，对分片网络错误、423、429 和 5xx 最多尝试 3 次；失败或中断时尝试取消任务。上传期间不要修改源文件。脚本不会自动续传上次进程的任务，也不会自动创建公开链接。

### cURL：32MiB 以内的文件

`POST /api/v1/files?name=URL编码文件名&folder_id=可选UUID`

| 字段        | 位置     | 要求                                       |
| ----------- | -------- | ------------------------------------------ |
| name        | query    | 必填，1–180 字符，不含路径分隔符或控制字符 |
| folder_id   | query    | 可选，已有且未删除目录 UUID；省略为根目录  |
| X-File-Size | header   | 必填，精确字节数，允许 0                   |
| body        | 请求正文 | 原始文件字节，必须与声明大小一致           |

Bash 示例，支持中文和空格文件名：

```bash
FILE='./示例文件.txt'
SIZE=$(wc -c < "$FILE" | tr -d '[:space:]')
NAME=$(python3 -c 'import os,sys,urllib.parse; print(urllib.parse.quote(os.path.basename(sys.argv[1]), safe=""))' "$FILE")
curl --fail-with-body --request POST \
  "https://s.irin.im/api/v1/files?name=$NAME" \
  --header "Authorization: Bearer $RCLOUD_TOKEN" \
  --header 'Content-Type: application/octet-stream' \
  --header "X-File-Size: $SIZE" \
  --data-binary "@$FILE"
```

成功响应示意：

```json
{
  "data": {
    "id": "5b691acf-6c30-4c9d-92b0-0d44f34931a1",
    "name": "示例文件.txt",
    "size": 12,
    "mime": "text/plain",
    "folder_id": null,
    "status": "ready",
    "version": 1,
    "created_at": 1791936000000,
    "updated_at": 1791936000000
  }
}
```

文件默认私有，不返回公开 URL 或 R2 对象 Key。需要公开时在网盘创建分享、直链或使用图床。重试整个直接上传会创建另一份文件，接口没有幂等键，响应不明确时先在网盘确认。

32MiB 仅为直接上传这一请求方式的限制；大文件使用分片方式，无应用层单文件上限，但不能超过剩余全站容量。

## 分片上传

### 1. 创建任务

`POST /api/v1/uploads`

```bash
curl --fail-with-body 'https://s.irin.im/api/v1/uploads' \
  -H "Authorization: Bearer $RCLOUD_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"backup.zip","size":20000000,"folder_id":null}'
```

name 与直接上传规则相同；size 为正整数且不超过 JavaScript 安全整数；folder_id 可省略或为 null。空文件使用直接上传。

```json
{
  "data": {
    "id": "89eb107c-b74b-4bb2-bfe1-3b14049a5f87",
    "fileId": "5b691acf-6c30-4c9d-92b0-0d44f34931a1",
    "partSize": 16777216
  }
}
```

id 是任务 ID，fileId 是最终文件 ID，二者不同。初始化预留完整文件容量。任务自创建起有效 24 小时，分片写入不会延长有效期。

### 2. 写入分片

`PUT /api/v1/uploads/{id}/parts/{part}`

编号从 1 开始。按 partSize（目前 16MiB）切分，最后一片为剩余长度。每片都发送精确的 X-File-Size，服务端还会验证实际 Body 长度。建议依次上传；同一片可以重试，同一任务不要并发写同一片或同时执行完成/取消。

```bash
curl --fail-with-body --request PUT \
  "https://s.irin.im/api/v1/uploads/$UPLOAD_ID/parts/1" \
  -H "Authorization: Bearer $RCLOUD_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-File-Size: 16777216' --data-binary @part-001.bin
```

返回 `{"data":{"partNumber":1}}`，无需保存 R2 ETag 或提交分片清单。

### 3. 查询进度与续传

`GET /api/v1/uploads/{id}`

```json
{
  "data": {
    "id": "89eb107c-b74b-4bb2-bfe1-3b14049a5f87",
    "fileId": "5b691acf-6c30-4c9d-92b0-0d44f34931a1",
    "size": 20000000,
    "partSize": 16777216,
    "expires_at": 1792022400000,
    "parts": [{ "partNumber": 1, "size": 16777216 }]
  }
}
```

保留任务 ID 与原文件，可在任务有效期内用**原 Token**查询并上传缺失分片。客户端须保证续传源文件完全相同，接口不校验完整文件内容哈希。另一个 Token 无法接管原任务。

### 4. 完成任务

`POST /api/v1/uploads/{id}/complete`，不需要 Body：

```bash
curl --fail-with-body --request POST \
  "https://s.irin.im/api/v1/uploads/$UPLOAD_ID/complete" \
  -H "Authorization: Bearer $RCLOUD_TOKEN"
```

成功返回 201 与文件元数据，格式同直接上传；缺失分片返回 409。完成后任务被删除，查询任务返回 410。可用 `GET /api/v1/files/{fileId}` 查询自己的已完成文件元数据；尚未就绪、已删除或不属于当前 Token 的文件返回 404。

如果完成响应丢失，先查询 fileId：200 后须核对文件 ID、`status=ready`、预期大小及初始 `version=1`；版本已增加表示文件随后被改写，不能据此确认原始内容。404 也可能代表仍在完成，再查询任务状态后判断，不要盲目重新创建任务。完成操作不保证并发幂等。

新建任务会在 R2 分片对象中保存任务身份标记。如果 R2 已完成合并，但后续数据库提交临时失败，可以重试同一 `complete`：服务端核对对象 Key、大小、任务标记和仍有效的上传会话后恢复提交，不重传分片、不重复占用容量。取消、过期、身份不匹配的任务不会被恢复。升级前没有身份标记的任务不适用这项恢复，无法确认时返回错误并保留清理记录。

网页与 `scripts/upload.py` 对完成阶段的临时故障最多尝试三次；仍可按 `fileId` 确认响应丢失时的完成状态。分片校验等明确拒绝不会无限重试。

### 5. 取消任务

`DELETE /api/v1/uploads/{id}`，返回 `{"data":{"id":"任务UUID"}}`。

只取消未完成任务，不删除已完成文件。重复取消或已完成/过期任务返回 410。Token 失效后管理员仍可取消；过期任务也由定时清理回收，容量释放可能晚于过期时间。

## Token 管理

以下接口仅接受管理员网页登录认证，上传 Token 无权调用。

| Method | 路径                       | 请求/响应                                                                                     |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | /api/admin/api-tokens      | 最近 100 条；名称、前缀、scope、创建/到期/最近使用/撤销时间，不含明文或哈希                   |
| POST   | /api/admin/api-tokens      | `{"name":"备份脚本","scope":"files:upload","expires_in_days":30}`；201 返回记录与一次性 token |
| DELETE | /api/admin/api-tokens/{id} | 撤销；返回 {id}；重复撤销已有记录仍成功                                                       |

scope 为 `files:upload`（默认）或 `images:upload`；已有 Token 保持 files:upload，不自动获得公开图片权限。名称 1–80 字符；有效期 1–365 天，默认 30 天；最多同时 20 个有效 Token。数据库仅存 SHA-256 哈希。prefix 用于识别；last_used_at 最多每分钟更新一次，代表通过认证的调用，不代表上传成功。撤销/到期拒绝后续请求，已在执行的请求可能完成。无续期接口，需要创建新 Token。

## 管理与公开接口

### 文件与目录（前缀 /api/admin）

| Method   | 路径                             | 参数/行为                                                                                                                |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET      | /settings                        | 身份、认证模式、文本限制、存储容量与链接来源（adminOrigin、filesOrigin、markdownOrigin）                                 |
| GET      | /files                           | folder_id、view=files/recent/markdown/trash、search、page、limit（1–100）、sort=name/size/updated_at、direction=asc/desc |
| POST     | /files/upload?name=…&folder_id=… | 原始 Body 与 X-File-Size，最多 32MiB，支持空文件                                                                         |
| POST     | /uploads                         | 创建分片任务，参数同外部上传 API                                                                                         |
| GET      | /uploads/{id}                    | 查询任务与已上传分片                                                                                                     |
| PUT      | /uploads/{id}/parts/{part}       | 上传分片                                                                                                                 |
| POST     | /uploads/{id}/complete           | 完成上传                                                                                                                 |
| DELETE   | /uploads/{id}                    | 取消；管理员可操作所有上传任务                                                                                           |
| GET      | /files/{id}                      | 就绪文件元数据                                                                                                           |
| PATCH    | /files/{id}                      | {name?,folder_id?}；folder_id 可为 null                                                                                  |
| DELETE   | /files/{id}                      | 移入回收站并停止公开访问                                                                                                 |
| POST     | /files/{id}/restore              | 恢复私人文件，分享/发布保持撤销                                                                                          |
| DELETE   | /files/{id}/permanent            | 永久删除回收站文件，清理 R2                                                                                              |
| DELETE   | /trash                           | 清空回收站；前端须确认                                                                                                   |
| GET/HEAD | /files/{id}/download             | 下载；preview=1 安全内联预览；支持 Range                                                                                 |
| GET      | /files/{id}/content              | 有大小限制的文本与版本                                                                                                   |
| GET      | /folders                         | parent_id 查询目录，省略为根目录                                                                                         |
| POST     | /folders                         | {name,parent_id?}，省略或 null 为根目录                                                                                  |
| GET      | /folders/{id}                    | 目录元数据                                                                                                               |
| PATCH    | /folders/{id}                    | {name?,parent_id?}，防循环                                                                                               |
| DELETE   | /folders/{id}                    | 仅空目录，回收站子项也算非空                                                                                             |
| POST     | /folders/{id}/restore            | 父目录必须存活                                                                                                           |
| DELETE   | /folders/{id}/permanent          | 永久删除空回收站目录                                                                                                     |

永久删除与清空回收站会立即尝试删除对应 R2 对象及文档附件、快照；只有对象删除成功才释放容量。存储服务暂时失败时由定时任务重试，容量不会提前归零。

`GET /api/admin/settings` 返回的 `adminOrigin` 和 `filesOrigin` 分别用于网页的全球 CDN、香港反代链接选项，`markdownOrigin` 保留为文章默认链接来源。网页复制时只切换可信链接的域名，保留路径、参数和片段；选择不改变 API 返回的默认 URL 或 ShareX 上传配置。其他部署可使用自己的域名，若两个配置相同则网页仅显示一个选项。

列表响应 `{data:{files,folders,total,folderTotal,page,limit}}`，`total` 为文件总数、`folderTotal` 为目录总数。文件与目录分别按同一 `page`、`limit` 分页，默认每类 40 条、最多每类 100 条；页数取两个总数中的较大值计算。近期、Markdown 视图与文件名搜索是全局文件查询，不返回目录；搜索中的 %、\_ 视为普通字符。上传 Token 无列目录权限，文件夹 ID 可在已登录的目录 API 中查看。

`GET /api/admin/folders` 支持 `parent_id`、`page`、`limit`，默认第 1 页、每页 100 条，上限 100 条。响应保持 `data` 数组，并增加 `{page,limit,total}` 元数据；移动目标选择器按页读取，超过 100 个目录仍可访问。

### 分享与直链

| Method   | 路径                               | 参数/行为                                                                                             |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET      | /api/admin/shares                  | page、limit 分页，默认每页 100 条；包含可重复复制的 url、directUrl，不返回密码或哈希                  |
| POST     | /api/admin/shares                  | {file_id,password?,expires_at?,allow_download?}；到期可为 null，默认允许下载；返回 {id,url,directUrl} |
| PATCH    | /api/admin/shares/{id}             | {enabled?,allow_download?,expires_at?,password?}；password=null 移除密码                              |
| DELETE   | /api/admin/shares/{id}             | 撤销                                                                                                  |
| GET/HEAD | /s/{token}                         | 公开分享页；已授权 HTML 直接返回原网页，支持 Range                                                    |
| GET/HEAD | /d/{token}                         | 直接下载，仍校验密码、下载许可、有效期和撤销                                                          |
| GET      | /api/public/share/{token}          | 授权后元数据，计浏览次数；HTML 的 preview_type 为 html，其他文件为 null                               |
| POST     | /api/public/share/{token}/unlock   | {password}，返回 HttpOnly 分享 Cookie                                                                 |
| GET      | /api/public/share/{token}/text     | 安全文本预览                                                                                          |
| GET/HEAD | /api/public/share/{token}/preview  | 可预览格式                                                                                            |
| GET/HEAD | /api/public/share/{token}/download | 受控下载                                                                                              |

创建分享和管理列表返回同一条分享的稳定 `url`、`directUrl`，可以再次复制；读取列表不会新建分享或重置统计。默认链接来源为 s.irin.im。这些 URL 本身授予分享访问权，管理列表仅向管理员提供，并禁止缓存。密码 Cookie 每个分享独立，最长一小时。无效链接 404，撤销/到期 410，未解锁 API 返回 401，禁止下载返回 403；分享页面可返回不含文件信息的解锁界面。

管理列表响应为 `{data:[…],page,limit,total}`，每页最多 100 条，按创建时间倒序、ID 次序稳定分页。网页每页显示 40 条，可翻页管理和复制更早的分享。

旧版 64 位十六进制 Token 链接继续有效。旧分享再次复制时返回签名地址，与旧地址共用密码、有效期、下载许可、撤销状态和统计，不需要重建分享。客户端应直接使用返回的 URL，不解析或假定 Token 长度。`directUrl` 仍需要下载许可；密码分享须先在同域名的分享页解锁，网页列表仅为无密码且允许下载的分享提供“复制直链”。

#### HTML 分享

上传 `.html` 或 `.htm` 文件后按普通文件创建分享即可，无需额外发布接口。授权通过的 `GET /s/{token}` 直接返回原始文件字节，以 `Content-Type: text/html; charset=utf-8` 和 `Content-Disposition: inline` 显示；不注入导航、容器、脚本或 iframe。文件仍以 `text/plain` 保存，旧 MIME 为 `application/octet-stream` 的 `.htm` 文件也支持。允许关闭下载，密码、有效期、撤销和回收站权限与普通分享一致。

密码未解锁时，`/s/{token}` 返回简短的解锁页（200），不包含文件名或正文。`POST /api/public/share/{token}/unlock` 成功后设置 HttpOnly Cookie，页面重新加载同一 `/s/{token}` 地址并显示原网页。密码修改后旧 Cookie 失效，下次访问重新显示解锁页。

`GET/HEAD /api/public/share/{token}/preview` 同样返回隔离的原始 HTML。两个地址均带 `Content-Security-Policy: sandbox allow-scripts`，不授予 `allow-same-origin`，因此上传的脚本不能访问本站 Cookie、浏览器存储或管理页面；`frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 禁止其他页面嵌套。[CSP sandbox 说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)

支持内联 CSS、内联 JavaScript 和 `data:` / `blob:` 内嵌图片、音视频，适合单文件页面与简单交互。CSP 禁止外部脚本、样式和图片等子资源，以及 fetch/XHR/WebSocket 等连接、嵌套框架、Worker、表单提交与修改 base URL；不授予弹窗、同源或下载权限。网页仍可通过链接、`location` 或 meta refresh 导航自身。依赖 CDN、远程接口、相对路径资源或浏览器持久存储的页面需要改为自包含文件。

完整授权的 200 GET `/s/{token}` 记一次浏览；HEAD、Range、失败或未解锁请求不计浏览，`/preview` 不计浏览。元数据 GET 保留原有浏览计数行为。显示 HTML 不增加下载计数；需要下载时使用创建分享返回的 `directUrl`（`/d/{token}`）或 `/api/public/share/{token}/download`，两者按下载权限返回原始附件，HEAD 和 Range 不增加下载计数。

### 图床

| Method   | 路径                               | 参数/行为                                                                 |
| -------- | ---------------------------------- | ------------------------------------------------------------------------- |
| POST     | /api/admin/images/folder           | 获取或创建 Image-hosting，返回 {id}                                       |
| POST     | /api/admin/images                  | {file_id}，将已有图片按 MD5 命名并公开；返回 {name,file_id,url,duplicate} |
| GET      | /api/admin/images?page=1           | 每页 40 条，响应 {data:[…],page}                                          |
| DELETE   | /api/admin/images/{name}           | 撤销直链                                                                  |
| POST     | /api/admin/images/{name}/restore   | 恢复直链，返回 {data:{name,file_id,url,enabled:1}}                        |
| DELETE   | /api/admin/images/{name}/permanent | 永久删除已撤销的图片及源文件，返回 {data:{name,file_id,deleted:true}}     |
| GET/HEAD | /api/admin/images/{name}/download  | 管理员下载；已撤销图片仍可下载，支持 Range                                |
| GET/HEAD | /i/{name}                          | 公开内联图片，支持 Range                                                  |
| GET/HEAD | /i/{name}?download=1               | 公开附件下载，仍检查直链有效性，支持 Range                                |

获取目录 → 管理员分片上传至目录 → 调用 /images 公开。支持 PNG/JPEG/GIF/WebP，通过文件头识别，另用 SHA-256 检查 MD5 命名冲突。保存到 Image-hosting，名称为 32位md5.ext，链接默认 s.irin.im。重复图片可能复用已有文件，应使用返回的 file_id；单独调用 POST /images 不会自动删除重复源文件，网页共用上传流程会继续清理重复源。

网页图床与 Markdown 编辑器的新图片上传共用上述管理员流程；编辑器支持选取、拖入和粘贴，将返回的 `url` 插入正文。该流程使用网页管理员会话，不要求用户提供上传 Token，也不调用旧文档附件接口。图床图片上传成功后独立公开，与文章的草稿、发布状态和生命周期无关。

图片列表按 `created_at DESC, name ASC` 稳定排序，每页 40 条；客户端读取到不足 40 条时结束。网页默认显示分页列表，画廊则读取全部分页并加载所有图片。画廊使用 `GET /api/admin/files/{id}/download?preview=1` 私有预览，仍需管理员认证且不增加公开引用次数。合法文件 UUID 的该 GET/HEAD 请求（查询参数仅为 `preview=1`）不占后台每分钟 240 次操作预算，避免集中加载图片影响管理操作；其他后台请求仍受原限流约束。

恢复接口要求源文件处于 ready 状态、不在回收站、所在目录及祖先目录有效，且对象 Key 与图床记录一致、R2 对象存在。图片、文件或对象不存在以及文件在回收站时返回 404，对象 Key 已改变或并发状态冲突返回 409。普通文件移入回收站会撤销直链，恢复文件不会自动重新公开；需再调用图床恢复接口。管理员图床下载同样检查文件和目录有效性、对象 Key 一致性，但允许下载已撤销的图片。

永久删除接口要求 `enabled=0`，仍公开或发生并发冲突时返回 409。该操作删除图床记录、源文件及关联分享、文档附件和快照等数据；R2 清理失败保留持久队列重试，仅对象实际删除成功后释放对应容量。

图床列表包含 `views`（引用次数）、`downloads`（下载次数）与 `last_access_at`（最近一次计入统计的时间，Unix 毫秒；尚无记录时为 null）：

- 引用：`GET /i/{name}` 成功开始返回完整 200 图片响应，包括页面嵌入和直接打开。
- 下载：`GET /i/{name}?download=1` 或管理员 `GET /api/admin/images/{name}/download` 成功开始返回完整 200 附件响应。浏览器对普通图片另存为不会自动归为下载。
- HEAD、206 部分响应、失败请求、列表查询和 `/api/admin/files/{id}/download?preview=1` 私有预览不计数。若 Range 请求最终返回完整 200 响应，仍按完整响应计数。

统计从迁移 `0009_image_stats.sql` 上线后累加，既有图片从 0 开始，不补历史数据。撤销、恢复、重复上传去重保留计数；永久删除会移除统计记录。同一访客的重复请求及自动请求可能多次计入，统计不代表唯一访客或传输完成。记录采用尽力写入：统计写入失败不影响图片响应，可能少计；最近访问时间也仅随成功记录更新。

### Markdown

| Method   | 路径                                                | 参数/行为                                                                                  |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET      | /api/admin/markdown                                 | page、limit 分页；published=1 仅查询已发布文章，默认每页 100 条                            |
| POST     | /api/admin/markdown                                 | {name,content?}，.md/.markdown；统一保存 /Markdown，旧 folder_id 参数不改变目的地          |
| GET      | /api/admin/markdown/{id}                            | {file,content,page}，id 为文件 ID                                                          |
| PUT      | /api/admin/markdown/{id}                            | {content,version}，版本冲突 409                                                            |
| POST     | /api/admin/markdown/{id}/attachments?name=…         | 兼容旧受控附件；图片原始 Body 与 X-File-Size，返回 {id,reference}                          |
| GET      | /api/admin/markdown/{id}/attachments/{attachmentId} | 旧格式私人附件，校验归属                                                                   |
| POST     | /api/admin/markdown/{id}/publish                    | {title,slug,version,description?,allow_source?,allow_index?}；创建快照，两项权限默认 false |
| POST     | /api/admin/markdown/{id}/unpublish                  | 取消发布，保留原文；阻断旧受控附件公开访问，不撤销图床直链                                 |
| GET/HEAD | /p/{slug}                                           | 公开阅读页                                                                                 |
| GET/HEAD | /api/public/pages/{slug}/source                     | 开启源文件下载时返回发布快照                                                               |
| GET/HEAD | /api/public/pages/{slug}/attachments/{id}           | 校验发布、引用与归属                                                                       |

文档列表响应 `{data:[…],page,limit,total}`，每页最多 100 条；`published=1` 在分页前过滤，新增私人草稿不会挤走已发布文章。网页已发布管理每页显示 40 条。

编辑器新图片使用 `![图片](https://s.irin.im/i/MD5.ext)`，实际 URL 取图床接口返回值；自部署使用配置的图床域名。旧私有附件格式 `![图片](attachment:UUID)` 继续兼容，仅发布快照实际引用且属于该文档的附件可以公开。HTTPS 图片（包括图床）由浏览器直接请求，取消发布或删除 Markdown 文件不会撤销这些图片；需要在图床中单独撤销直链或删除图片。

Slug 1–100 字符，仅小写字母、数字和连字符，不能是系统保留名。Markdown/在线文本上限 1MiB。单篇发布最多 20 张旧格式受控附件，图床 HTTPS 直链不计入该数量。

### 网页认证

站内模式在 /login 使用密码＋验证器验证码登录；POST /api/auth/login 请求 {password,code}，设置 24 小时 HttpOnly 会话，code 也可使用一次性恢复码。POST /api/auth/logout 撤销会话。首次绑定使用 /api/auth/setup/start 与 /api/auth/setup/finish，详见 [部署文档](deployment.md)。脚本请使用 Token，避免保存账号密码和 TOTP 密钥。

## Google Drive 与 HTML 网站

Google Drive 使用独立的管理员 API 和远端存储，与现有 `/api/v1` 上传 Token 权限分开。Google 的 OAuth 访问凭据不向浏览器返回；配置及接口见 [Google Drive](google-drive.md)。

HTML 文件夹网站使用 `/api/admin/site-shares` 管理、`/site/{token}/` 公开访问，支持相对资源和密码访问；完整请求格式与兼容边界见 [HTML 文件夹分享](html-sites.md)。

## 通用错误与限制

| 状态码  | 含义与处理                                               |
| ------- | -------------------------------------------------------- |
| 400     | 参数、大小或分片编号错误                                 |
| 401     | 未认证或 Token 无效/到期/撤销                            |
| 403     | 来源或权限校验失败                                       |
| 404     | 接口/文件/目录不存在；其他 Token 的文件/任务也返回此状态 |
| 409     | 状态/版本冲突、缺失分片、Token 数量上限                  |
| 410     | 上传任务已完成/取消/过期/不存在，或分享失效              |
| 411     | 图片表单缺少有效 Content-Length                          |
| 413     | 容量不足、直接上传超过 32MiB、文本/JSON 超限             |
| 415     | 不支持的预览或图片格式                                   |
| 416     | Range 无法满足                                           |
| 429     | 限流，退避重试，不保证返回 Retry-After                   |
| 500/503 | 服务或配置错误；记录 request_id，避免无限重试非幂等请求  |

- 全站 50GiB（53,687,091,200 字节），网页/API 共用，包含回收站、附件、快照和上传预留。
- 每 Token 每分钟 240 请求；上传 API 同一来源 IP 每分钟 600 请求，包含失败认证。使用固定分钟窗口；管理和公开接口另有限流。
- 反代、Cloudflare 套餐与客户端可能有单请求大小/超时限制，建议大文件分片。反代需转发 Authorization、Content-Type、X-File-Size，图片表单需保留正确 Content-Length，禁止缓存 API 响应。
- 任务 24 小时后失效，定时任务分批清理，容量到实际删除对象才释放。撤销 Token 不等于取消任务。
- 上传不覆盖同名文件。直接上传和初始化不是幂等操作，不应自动重试整个 POST；分片 PUT 可重试。
- 文件类型判断不代表病毒扫描或完整解码；图床 Token 上传会直接公开图片；普通文件上传仍为私有。
- 部署前先应用所有待执行迁移，包括 0007_api_tokens.sql、0008_image_api_scope.sql 和 0009_image_stats.sql，再发布 Worker（启用 nodejs_compat）；无需新增 Cloudflare Secret。现有网页认证和上传继续可用。
