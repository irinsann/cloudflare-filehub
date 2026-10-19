# ShareX 图片上传

## 配置 ShareX

1. 登录 RCloud，打开 **设置 → 上传 API → 创建 Token**。
2. 类型选择 **图床上传（公开直链 / ShareX）**，填写名称与有效期。
3. 创建后点击 **下载 ShareX 配置**，保存 `RCloud.sxcu`。配置已包含站点地址和本次 Token，仅显示一次，请勿公开。
4. 在 ShareX 的 **Destinations（目标）→ Custom uploader settings（自定义上传设置）** 中选择 **Import → From file**，导入此文件。
5. 将图片上传目标设为 **Custom image uploader**，选择 **RCloud 图床**。启用截图后的 **Upload image to host** 即可自动上传并取得直链。

也可以下载仓库中的 [配置模板](RCloud.sxcu)，将 Headers.Authorization 中的 `REPLACE_WITH_IMAGE_UPLOAD_TOKEN` 换成图床 Token，再导入。Token 到期或撤销后，创建新 Token 并重新导入配置。普通文件上传 Token 无法调用图床接口。

配置采用 [ShareX 官方自定义上传器格式](https://getsharex.com/docs/custom-uploader.html)：POST、MultipartFormData、文件字段 `file`，从 `{json:data.url}` 提取直链，从 `{json:error.message}` 提取错误。

## 图片上传接口

`POST https://files.example.com/api/v1/images`

| 项目           | 值                                                  |
| -------------- | --------------------------------------------------- |
| Authorization  | `Bearer rcu_…`，需要 `images:upload` 类型           |
| Body           | `multipart/form-data`，仅一个名为 `file` 的文件字段 |
| Content-Length | 必需，整个表单的字节数；ShareX 和 cURL 自动计算     |
| 格式           | PNG、JPEG、GIF、WebP，按文件内容识别                |

不需要 Cookie、验证码、X-File-Size 或 X-Drive-Request。不要手动设置 Content-Type，交给客户端生成带 boundary 的表单头。不要发送额外表单字段。

```bash
# RCLOUD_IMAGE_TOKEN 为已保存的图床 Token 环境变量
curl --fail-with-body 'https://files.example.com/api/v1/images' \
  -H "Authorization: Bearer $RCLOUD_IMAGE_TOKEN" \
  -F 'file=@./screenshot.png'
```

新图片返回 201；已有相同图片返回 200：

```json
{
  "data": {
    "name": "39dd1aed58e76c360216335fda25d0cf.png",
    "file_id": "5b691acf-6c30-4c9d-92b0-0d44f34931a1",
    "url": "https://files.example.com/i/39dd1aed58e76c360216335fda25d0cf.png",
    "duplicate": false
  }
}
```

保存逻辑与网页图床共用：文件以内容 MD5 和识别出的扩展名命名，归入根目录 `Image-hosting`，公开直链默认使用 `files.example.com`。相同内容复用已有图片和链接；同时比较 SHA-256，拒绝 MD5 冲突。重新上传已停用的同一图片会重新启用直链，与网页行为一致。Token 撤销不会撤销已上传图片；管理图片请使用网站。

没有额外的应用层单图片大小上限；图床与网盘共用 50GiB 配额，接收时预留表单大小，发布复制时还需要一份图片的临时空间。服务端按 16MiB 写入 R2；ShareX 仍发送一个 HTTP 请求，因此还受 Cloudflare 和 VPS 的请求大小、超时限制。大图片无法通过时可使用网页分片上传。类型识别不等同于完整图片解码或病毒扫描。

常见错误：400 表单不完整/多文件/字段错误；401 Token 无效、过期或撤销；403 Token 类型或 Origin 不允许；409 命名或状态冲突；411 缺少 Content-Length；413 配额或上游请求大小限制；415 不支持的图片格式（包括 SVG）；429 请求过于频繁。应用错误正文使用 `{ "error": { "code": 401, "message": "…", "request_id": "…" } }`；上游错误可能返回 HTML。

反代应转发 Authorization、完整 multipart Content-Type 和正确的 Content-Length，禁止缓存 `/api/*`。完整认证规则与限流见 [API 文档](api.md)。
