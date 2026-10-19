// Translate only application error messages, never file names, document bodies, or HTML.
// Unknown messages remain intact so new errors do not lose their diagnostic meaning.
const english: ReadonlyMap<string, string> = new Map(
  Object.entries({
    'JSON 格式无效': 'Invalid JSON',
    '有效 Token 已达 20 个，请先撤销旧 Token':
      'The limit of 20 active tokens has been reached. Revoke an existing token first.',
    'Token 不存在': 'Token not found',
    '请提供有效的上传 Token': 'Provide a valid upload token',
    '上传 Token 无效、已到期或已撤销': 'The upload token is invalid, expired, or revoked',
    请求来源校验失败: 'Request origin verification failed',
    'Token 类型不允许调用此接口': 'This token type cannot access this endpoint',
    分享会话密钥未配置: 'The share session secret is not configured',
    '请求过于频繁，请稍后重试': 'Too many requests. Try again later.',
    文件夹不存在或已删除: 'The folder does not exist or has been deleted',
    文件不存在: 'File not found',
    不能移动到自身或子文件夹: 'A folder cannot be moved into itself or one of its descendants',
    '请先移出或永久删除文件夹中的内容（含回收站内容）':
      'Move or permanently delete the contents of this folder first, including items in the trash.',
    文件夹不存在: 'Folder not found',
    '请先将文件夹移入回收站，并清空其中的内容':
      'Move this folder to the trash and empty its contents first.',
    必须提供有效文件大小: 'A valid file size is required',
    请使用分片上传: 'Use multipart upload for this file',
    此文件不支持文本预览: 'This file does not support text preview',
    文件未删除: 'The file has not been deleted',
    必须先将文件移入回收站: 'Move the file to the trash first',
    '文件状态已改变，请刷新后重试': 'The file state has changed. Refresh and try again.',
    '根目录中已有名为 Html-hosting 的文件':
      'A file named Html-hosting already exists in the root folder',
    'Html-hosting 目录不可用': 'The Html-hosting folder is unavailable',
    'HTML 分享不存在': 'HTML share not found',
    '仅支持 HTML、HTM 文件': 'Only HTML and HTM files are supported',
    '请先上传到 Html-hosting 文件夹': 'Upload the file to the Html-hosting folder first',
    '分享已过期，请在文件分享中修改有效期':
      'This share has expired. Update its expiration in file sharing.',
    '分享状态已变化，请刷新后重试': 'The share state has changed. Refresh and try again.',
    '请使用 multipart/form-data 上传图片': 'Upload images using multipart/form-data',
    '请提供 Content-Length': 'A Content-Length header is required',
    上传内容为空: 'The upload body is empty',
    '表单 boundary 无效': 'Invalid multipart form boundary',
    '表单只允许一个名为 file 的图片文件':
      'The form must contain exactly one image file in the file field',
    文件超过声明的请求长度: 'The file exceeds the declared request length',
    图片为空: 'The image is empty',
    图片接收失败: 'Failed to receive the image',
    请求长度不匹配: 'The request length does not match the declared length',
    '缺少 file 图片字段': 'The file image field is missing',
    图片表单不完整或上传中断: 'The image form is incomplete or the upload was interrupted',
    '仅支持 PNG、JPEG、GIF 和 WebP 图片': 'Only PNG, JPEG, GIF, and WebP images are supported',
    'Image-hosting 目录不可用': 'The Image-hosting folder is unavailable',
    图片不存在: 'Image not found',
    '图片状态已改变，请刷新后重试': 'The image state has changed. Refresh and try again.',
    'MD5 命名冲突，图片未覆盖':
      'An MD5 name conflict occurred. The existing image was not overwritten.',
    '图片已修改，请重新上传': 'The image has changed. Upload it again.',
    图片保存失败: 'Failed to save the image',
    '图片状态已改变，请重试': 'The image state has changed. Try again.',
    '图片已修改，无法恢复原直链':
      'The image has changed. Its original direct link cannot be restored.',
    '图片对象不存在，无法恢复': 'The image object no longer exists and cannot be restored',
    请先撤销图片直链: 'Revoke the image direct link first',
    图片文件不存在: 'Image file not found',
    '图片已修改，原直链失效':
      'The image has changed and its original direct link is no longer valid',
    图片不存在或直链已撤销: 'The image does not exist or its direct link has been revoked',
    站点已迁移: 'This site has moved',
    接口不存在: 'Endpoint not found',
    请登录: 'Please sign in',
    '名称、Slug 或目录状态冲突，请刷新后重试':
      'The name, slug, or folder state conflicts with another item. Refresh and try again.',
    服务暂时无法完成请求: 'The service cannot complete this request right now',
    '请选择 Markdown 文件': 'Select a Markdown file',
    '文件名应以 .md 结尾': 'The file name must end in .md',
    'Markdown 文件夹不可用': 'The Markdown folder is unavailable',
    '文档已被另一窗口修改，请先另存草稿再重新载入':
      'The document was changed in another window. Save a separate copy of your draft before reloading.',
    '保存冲突，请保留本地草稿后重新载入':
      'A save conflict occurred. Keep your local draft before reloading.',
    '附件仅支持通过签名检查的 PNG、JPEG、GIF、WebP 图片':
      'Attachments must be PNG, JPEG, GIF, or WebP images with valid file signatures',
    附件不存在: 'Attachment not found',
    '文档已在另一窗口更新，请重新载入并确认要发布的正文':
      'The document was updated in another window. Reload it and confirm the content before publishing.',
    '单篇文章最多 20 张受控附件': 'Each article supports up to 20 managed attachments',
    文章引用了不属于它的私人附件:
      'The article references private attachments that do not belong to it',
    '文档状态已变化，请重新载入后再发布':
      'The document state has changed. Reload it before publishing.',
    文章不存在或已取消发布: 'The article does not exist or has been unpublished',
    作者未开启原文下载: 'The author has not enabled source downloads',
    附件未授权: 'Access to this attachment is not authorized',
    请求正文过大: 'The request body is too large',
    '正在统计存储容量，请稍后重试': 'Storage usage is being calculated. Try again shortly.',
    文件大小无效: 'Invalid file size',
    '存储容量不足（总容量 50GB）': 'Insufficient storage space. The total capacity is 50 GB.',
    认证加密密钥未配置: 'The authentication encryption key is not configured',
    '请配置 Cloudflare Access': 'Configure Cloudflare Access first',
    认证无效或已过期: 'Authentication is invalid or has expired',
    认证声明无效: 'Invalid authentication claims',
    此身份没有管理员权限: 'This identity does not have administrator access',
    管理员接口只能通过管理域名访问:
      'Administrator endpoints are only available through the management domain',
    '请登录 RCloud': 'Sign in to RCloud',
    '请通过 Cloudflare Access 登录': 'Sign in through Cloudflare Access',
    过期时间必须在将来: 'The expiration time must be in the future',
    '此文件不支持预览，必须允许下载':
      'This file does not support preview. Downloads must be enabled.',
    分享不存在: 'Share not found',
    分享已过期或已撤销: 'The share has expired or has been revoked',
    请输入分享密码: 'Enter the share password',
    密码错误: 'Incorrect password',
    不支持文本预览: 'Text preview is not supported',
    路由不存在: 'Route not found',
    该分享已关闭下载: 'Downloads are disabled for this share',
    不支持预览: 'Preview is not supported',
    '密码至少 12 个字符': 'The password must contain at least 12 characters',
    '请输入 6 位验证码或恢复码': 'Enter a 6-digit authenticator code or a recovery code',
    未启用站内登录: 'Local sign-in is not enabled',
    登录请求过大: 'The sign-in request is too large',
    '设置链接已过期，请联系管理员生成新链接':
      'The setup link has expired. Ask the administrator for a new link.',
    账户已经设置: 'The account has already been set up',
    设置链接无效: 'Invalid setup link',
    '设置已过期，请重新打开设置链接': 'Setup has expired. Open the setup link again.',
    验证码不正确: 'Incorrect verification code',
    密码或验证码不正确: 'Incorrect password or verification code',
    '密码或验证码不正确，已用验证码不可重复使用':
      'Incorrect password or verification code. A code that has already been used cannot be reused.',
    网站路径过长: 'The website path is too long',
    网站目录层级过深: 'The website folder hierarchy is too deep',
    网站路径编码无效: 'Invalid website path encoding',
    网站路径无效: 'Invalid website path',
    网站目录内存在重名文件: 'The website folder contains files with duplicate names',
    '文件夹中没有 index.html': 'The folder does not contain index.html',
    网站资源不存在: 'Website resource not found',
    网站目录内存在重名文件和文件夹:
      'The website folder contains a file and folder with the same name',
    网站目录内存在重名文件或文件夹: 'The website folder contains duplicate file or folder names',
    网站分享域名未配置: 'The website sharing domain is not configured',
    请求内容为空: 'The request body is empty',
    请求内容过大: 'The request body is too large',
    请求内容无效: 'Invalid request body',
    '文件夹状态已变化，请刷新后重试': 'The folder state has changed. Refresh and try again.',
    网站分享不存在: 'Website share not found',
    网站分享已过期或已撤销: 'The website share has expired or has been revoked',
    请输入网站分享密码: 'Enter the website share password',
    上传中断或实际文件大小不匹配:
      'The upload was interrupted or the actual file size does not match',
    上传完整性校验失败: 'Upload integrity verification failed',
    文件对象不存在: 'File object not found',
    文本超过在线编辑和预览大小限制:
      'The text exceeds the size limit for online editing and preview',
    'Markdown 超过大小限制': 'The Markdown document exceeds the size limit',
    保存失败: 'Failed to save',
    上传文件不存在: 'Uploaded file not found',
    'API 接口不存在': 'API endpoint not found',
    '上传对象不存在，请重新上传': 'The upload object no longer exists. Upload the file again.',
    '无法确认上传对象所属任务，请取消任务后重新上传':
      'The upload object could not be matched to this task. Cancel the task and upload the file again.',
    '上传任务已过期，请重新上传': 'The upload task has expired. Upload the file again.',
    分片编号无效: 'Invalid upload part number',
    分片大小无效: 'Invalid upload part size',
    分片上传中断或实际大小不匹配:
      'The part upload was interrupted or its actual size does not match',
    上传文件已移除: 'The uploaded file has been removed',
    分片未上传完整: 'Not all upload parts have been received',
    文件大小校验失败: 'File size verification failed',
    '上传文件状态已改变，请刷新后重试': 'The upload file state has changed. Refresh and try again.',
    '存储服务暂时无法取消上传，请重试':
      'The storage service cannot cancel the upload right now. Try again.',
    最多保留20个有效WebDAV凭据: 'Up to 20 active WebDAV credentials are allowed',
    WebDAV需要HTTPS: 'WebDAV requires HTTPS',
    复制目录结构无效: 'Invalid folder structure for copying',
    源文件大小无效: 'Invalid source file size',
    '存储容量不足（总容量50GB）': 'Insufficient storage space. The total capacity is 50 GB.',
    '存储服务暂时无法读取，请重试':
      'The storage service cannot read the file right now. Try again.',
    源文件对象不存在: 'Source file object not found',
    源文件大小不符: 'The source file size does not match',
    '存储服务暂时无法写入，请重试':
      'The storage service cannot write the file right now. Try again.',
    复制文件完整性校验失败: 'Copied file integrity verification failed',
    文件已改变: 'The file has changed',
    If过长: 'The If header is too long',
    If条件为空: 'The If condition is empty',
    If条件过多: 'Too many If conditions',
    If不能混合带标签和无标签条件: 'The If header cannot mix tagged and untagged conditions',
    If格式无效: 'Invalid If header format',
    If资源地址无效: 'Invalid resource URI in the If header',
    If条件格式无效: 'Invalid If condition format',
    If资源条件过多: 'Too many resource conditions in the If header',
    WebDAV条件不满足: 'WebDAV conditions were not satisfied',
    文件被WebDAV客户端锁定: 'The file is locked by a WebDAV client',
    Destination必须位于WebDAV目录: 'Destination must be within the WebDAV directory',
    路径过长: 'The path is too long',
    路径编码无效: 'Invalid path encoding',
    文件名无效: 'Invalid file name',
    目录层级过深: 'The folder hierarchy is too deep',
    父目录不是文件夹: 'The parent path is not a folder',
    '单目录超过2000项，请在网页中分目录整理':
      'This folder contains more than 2,000 items. Organize them into separate folders using the website.',
    '目录存在同名文件，请在网页中重命名后重试':
      'The folder contains files with duplicate names. Rename them using the website and try again.',
    '路径存在同名文件，请在网页中重命名':
      'This path contains files with duplicate names. Rename them using the website.',
    该路径正在上传: 'An upload to this path is in progress',
    父目录不存在: 'Parent folder not found',
    目标路径过长: 'The destination path is too long',
    目标目录层级过深或路径过长:
      'The destination folder hierarchy is too deep or its path is too long',
    '单次目录操作超过1000项，请分批操作':
      'This folder operation exceeds 1,000 items. Process them in smaller batches.',
    目录中有进行中的上传: 'The folder contains uploads that are still in progress',
    '目录存在同名文件，请在网页中重命名':
      'The folder contains files with duplicate names. Rename them using the website.',
    'WebDAV上传需要Content-Length': 'WebDAV uploads require a Content-Length header',
    'WebDAV单次上传最多100MB；大文件请使用网页分片上传':
      'WebDAV uploads are limited to 100 MB per request. Use multipart upload on the website for larger files.',
    上传中断或文件大小不符: 'The upload was interrupted or the file size does not match',
    文件大小不符: 'The file size does not match',
    不能覆盖文件夹: 'A folder cannot be overwritten',
    'XML 格式无效': 'Invalid XML format',
    'XML 请求不能超过 64 KiB': 'XML requests cannot exceed 64 KiB',
    'XML 节点数不能超过 1000': 'XML cannot contain more than 1,000 nodes',
    '不允许 XML DOCTYPE 或自定义实体':
      'XML DOCTYPE declarations and custom entities are not allowed',
    '仅支持 XML 1.0': 'Only XML 1.0 is supported',
    'XML 嵌套不能超过 32 层': 'XML nesting cannot exceed 32 levels',
    'WebDAV XML 元素无效': 'Invalid WebDAV XML element',
    'WebDAV XML 结构不能包含文本': 'The WebDAV XML structure cannot contain text',
    '此 XML 元素必须为空': 'This XML element must be empty',
    属性值仅支持纯文本: 'Property values support plain text only',
    '缺少 PROPFIND 查询类型': 'The PROPFIND query type is missing',
    'PROPFIND 查询类型重复或无效': 'The PROPFIND query type is duplicated or invalid',
    'PROPPATCH 操作无效': 'Invalid PROPPATCH operation',
    '每个属性操作必须包含一个 prop':
      'Each property operation must contain exactly one prop element',
    未指定要修改的属性: 'No properties were specified for modification',
    'LOCK XML 元素无效': 'Invalid LOCK XML element',
    'LOCK 类型缺失或重复': 'The LOCK type is missing or duplicated',
    仅支持独占写锁: 'Only exclusive write locks are supported',
    '锁所有者仅支持文本或 DAV:href': 'The lock owner supports only text or DAV:href',
    XML请求过大: 'The XML request is too large',
    XML编码无效: 'Invalid XML encoding',
    属性数量过多: 'Too many properties',
    文件已存在或已改变: 'The file already exists or has changed',
    不支持此方法: 'This method is not supported',
    不能修改WebDAV根目录: 'The WebDAV root directory cannot be modified',
    路径已存在: 'The path already exists',
    MKCOL不接受请求体: 'MKCOL does not accept a request body',
    不支持分段PUT: 'Partial PUT requests are not supported',
    '图床文件不可覆盖，请使用新文件名': 'Hosted images cannot be overwritten. Use a new file name.',
    'DELETE文件夹需要Depth infinity': 'Deleting a folder requires Depth: infinity',
    '目录层级过深，请分批删除':
      'The folder hierarchy is too deep. Delete items in smaller batches.',
    源文件不存在: 'Source file not found',
    缺少Destination: 'The Destination header is missing',
    Destination无效: 'Invalid Destination header',
    仅支持同一站点内复制或移动: 'Copying and moving are supported only within the same site',
    目标路径冲突: 'The destination path conflicts with the source',
    Overwrite无效: 'Invalid Overwrite header',
    目标已存在: 'The destination already exists',
    'MOVE需要Depth infinity': 'MOVE requires Depth: infinity',
    'COPY Depth无效': 'Invalid Depth header for COPY',
    '复制目标目录过深或内容过多，请分批复制':
      'The destination folder is too deep or contains too many items. Copy them in smaller batches.',
    '目标目录层级过深，请分批操作':
      'The destination folder hierarchy is too deep. Process items in smaller batches.',
    锁不存在或不属于此凭据: 'The lock does not exist or does not belong to these credentials',
    'LOCK Depth无效': 'Invalid Depth header for LOCK',
    路径已锁定: 'The path is locked',
    有效锁数量过多: 'Too many active locks',
    创建文件失败: 'Failed to create the file',
    '缺少Lock-Token': 'The Lock-Token header is missing',
    WebDAV操作失败: 'The WebDAV operation failed',
    路径无效: 'Invalid path',
    '目录状态无法确认，请刷新后重试':
      'The folder state could not be confirmed. Refresh and try again.',
    'WebDAV客户端正在编辑，请关闭文件后重试':
      'A WebDAV client is editing the file. Close it and try again.',
    '另一个文件操作正在进行，请重试': 'Another file operation is in progress. Try again.',
    '文件操作已超时，请重试': 'The file operation timed out. Try again.',
    WebDAV凭据已失效: 'The WebDAV credentials are no longer valid',
    文件名不能包含路径或控制字符: 'File names cannot contain paths or control characters',
    此路径是系统保留路径: 'This path is reserved by the system',
  }),
);

function knownError(message: string) {
  const translated = english.get(message);
  if (translated !== undefined) return translated;
  const copyLimit = /^单次COPY最多(\d+)项，请分批复制$/.exec(message);
  return copyLimit
    ? `A single COPY request supports up to ${copyLimit[1]} items. Copy them in smaller batches.`
    : message;
}

export function translateError(message: string, locale: 'zh' | 'en'): string {
  if (locale === 'zh') return message;
  const exact = knownError(message);
  if (exact !== message) return exact;
  // Zod issues are joined with semicolons. Preserve separators and any unknown issue text.
  return message
    .split(/([;；]\s*)/u)
    .map((part, index) => (index % 2 ? part : knownError(part)))
    .join('');
}
