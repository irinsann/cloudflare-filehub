# HTML 文件夹分享

在「我的文件」中准备一个包含 `index.html` 的文件夹，从文件夹菜单选择「发布网站」。可以设置访问密码和有效期；发布后在「文件分享 → HTML 网站」再次复制或撤销链接。

网站在 `/site/<token>/` 直接显示原始 HTML，没有 iframe 或 RCloud 页面外壳。复制链接时可选择全球 CDN 或香港反代，二者访问同一份文件。

## 目录示例

```text
my-site/
  index.html
  assets/
    style.css
    main.js
    photo.webp
    data.json
  about/
    index.html
```

首页使用 `./assets/style.css`、`./assets/main.js`、`./assets/photo.webp` 和 `./about/`。进入 `about/` 时读取 `about/index.html`；子页引用上一级图片可使用 `../assets/photo.webp`。目录地址自动补尾部斜杠，并保留查询参数。

支持站点内部的 CSS、普通与模块 JavaScript、动态 import、图片、字体、音视频和 `fetch('./assets/data.json')`。公开资源返回正确类型和无凭据 CORS 响应；普通网盘预览仍按原有规则处理。

## 发布与撤销

- 只能分享明确的文件夹，不能将整个网盘根目录发布为网站。
- 根目录必须有唯一的 `index.html`；目录内有同名文件或文件/文件夹重名时拒绝发布。发布后产生的路径歧义也会被拒绝，不会随机选择文件。
- 分享读取当前文件夹内容。修改、添加或移入的文件会通过网站地址提供；从中删除或移出的文件不再可访问。不要把私有资料放进已发布目录。
- 分享仅能解析根文件夹内的路径，不能访问相邻文件夹、回收站文件或管理接口。
- 撤销、过期或删除分享根目录及其祖先会阻断访问。恢复目录不会自动重新发布网站。
- 使用 `private, no-store`，每次资源请求重新检查权限。浏览器已经收到的内容无法远程收回。
- 浏览统计按成功返回完整 HTML 的 GET 累计；CSS、脚本、图片、HEAD、Range 和未解锁页面不计数。它不是独立访客数。

## 密码访问

访客输入密码后，跳转到带有短期访问凭证的网站地址。凭证最长有效一小时，并且不能超过分享有效期；撤销分享立即使全部资源失效。该地址在有效期内相当于已解锁链接，请使用管理列表中的原始分享地址对外分享。

使用路径凭证是为了让隔离后的模块脚本、字体和 JSON 请求也能通过密码校验，公开网页不会得到管理员 Cookie。服务端只向分享资源开放无凭据 CORS，管理 API 不开放跨来源访问。

## 兼容范围

网站与管理后台使用相同域名，响应通过 `Content-Security-Policy: sandbox allow-scripts` 隔离，没有 `allow-same-origin`。网页能运行脚本，但不能读取管理站的 Cookie 或浏览器存储。[浏览器 sandbox 规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)

以下内容需要调整或使用独立内容域名托管：

- `/assets/main.js` 之类从域名根开始的路径。应改为相对路径，或把构建工具的 base 设置为当前分享前缀。
- localStorage、sessionStorage、IndexedDB、Service Worker 和 PWA 离线功能。
- 外部 CDN 脚本、远程 API、第三方登录、嵌入框架、弹窗、表单提交，以及需要后端服务的 PHP、Node 应用。
- 依赖服务器统一返回首页的 SPA history 路由。此处按真实文件和目录查找，缺失路径返回 404；可使用 hash 路由。
- 依赖 `eval` 或 `new Function` 动态编译代码的脚本。应使用无需动态求值的生产构建。

不会改写上传的 HTML/CSS/JS，也不会伪装成可以运行任意网站的通用托管。既有单文件 HTML 分享继续使用更严格的自包含页面规则。

## API

以下管理接口需要已登录的 RCloud 会话；写入还需要可信 Origin 和 `X-Drive-Request: 1`。

| 方法     | 路径                                     | 行为                                                             |
| -------- | ---------------------------------------- | ---------------------------------------------------------------- |
| GET      | `/api/admin/site-shares?page=1&limit=40` | 分页列表，返回稳定可复制的 URL                                   |
| POST     | `/api/admin/site-shares`                 | `{folder_id,password?,expires_in_days?}`；不填或 null 为长期有效 |
| DELETE   | `/api/admin/site-shares/{id}`            | 撤销网站分享                                                     |
| GET/HEAD | `/site/{token}/{path}`                   | 原始静态资源、目录首页或密码解锁页                               |
| OPTIONS  | `/site/{token}/{path}`                   | 仅授权资源的 GET/HEAD CORS 预检                                  |
| POST     | `/site/{token}`                          | `{password,path?,query?}`，返回同站点的短期已解锁 URL            |

管理列表返回 `{data:[…],page,limit,total}`；创建返回 `{data:{id,folder_id,name,url,enabled,password_protected,created_at,expires_at,views,last_access_at}}`。客户端应直接使用 URL，不解析令牌格式。密码请求有独立大小与尝试次数限制。
