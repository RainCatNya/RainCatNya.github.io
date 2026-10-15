# AGENTS.md —— Foraine 交接手册

> **给下一个接手这个仓库的 Agent**：先读这份，再按需查 `docs/style-guide.md`（组件与视觉规范，按「第几轮」编号，改样式前几乎一定用得上）。
> 这里只写**不知道就会踩坑 / 会做错决定**的东西，不重复代码里已经写清楚的事。
> 逐轮改动日志在 `/memories/repo/foraine-project.md`（仓库级记忆，每轮一条「续 N」，很长但很全）。

---

## 0. 这是个什么项目

**RainCat 的个人站 foraine.xyz**：Cloudflare Workers + D1 + 阿里云 OSS 的全栈站。
**前端零构建**：HTML/CSS/JS 直接写在 `public/` 下改完就是线上（靠 `_headers` no-store + ETag 304）。
**后端有一道 esbuild**：源码在 `src/`，`node build.mjs` 打包成 `worker.js`（一个文件既是后端 API 又是页面渲染器）。
没有框架、没有运行时依赖（`node_modules` 里只有 wrangler 与 esbuild 两个 devDependencies）。

干的事：文章与评论、标签、个人主页、关注、站内信、私信（QQ 形制，含附件/表情/引用/撤回）、论坛（半成品）、
角色权限（站长/管理员/成员）、审核与封禁、D1 控制台（站长）、邮箱验证、GitHub OAuth、OSS 上传、
终端页（`/terminal`，占位）。

---

## 1. 先跑起来

```powershell
npm install
npm test                       # 48 项回归测试（markdown + 星历历法），改任何东西前后都跑
npx wrangler dev --port 8788   # 本地（assets 实时读盘, 改了刷新就有）
npx wrangler deploy            # 部署, 输出里的 Current Version ID 要记下来回给用户
```

* **线上 = `main` 分支的 `public/` + 打包产物 `worker.js`**。本地 dev 与线上共用同一个 `worker.js`，但**数据不共用**。
  ⚠️ **改后端改的是 `src/`**：`wrangler dev/deploy` 会自动跑 `build.command`（`node build.mjs`）重新打包；
  `wrangler dev` 开着 `build.watch_dir=./src`，改 `src/` 刷新即重打包。`worker.js` 是生成物，**别手改**。
* 本地 D1 在 `.wrangler/state/v3/d1/`（Miniflare SQLite）；本地库的迁移要**自己**跑（`--local`）。
* ⚠️ **线上库（`--remote`）用户已授权我直接操作，不用问**，但**做完必须自己收拾干净**（测试账号/会话/行）。
  ```powershell
  npx wrangler d1 execute foraine-db --remote --file=schema.sql          # schema.sql 全是 IF NOT EXISTS, 可重复跑
  npx wrangler d1 execute foraine-db --remote --command "SELECT ..."
  ```
* **本地没有 `.dev.vars`** → 本地 `OSS_ACCESS_KEY_ID` 是空的、邮件也没配。
  所以**上传类功能（图片/头像/资源/表情）在本地只能验到失败分支**（503），真链路只能在线上验。
* 兜底工具（我加的，值得留着）：
  * `.wrangler/tools/check-inline-js.mjs` —— 把 HTML 里的内联 `<script>` 抽出来用 V8 解析一遍
    （前端内联脚本没有编译期检查），**顺便挑「字符串 +块注释+ 字符串」那种写法**（见 §9 的 NaN 那行）。
    用法 `node .wrangler/tools/check-inline-js.mjs public/chat/index.html`。
  * `.wrangler/tools/check-copy.mjs` —— **文案规则自检**：扫「会给用户看的串」，挑出语气词结尾 / 口语动词 /
    催促口吻 / 半角标点 / 人称「您」。改完文案跑一遍，它退出码非 0 就是还有漏的（规则与白名单见 §13）。
  * `.wrangler/tools/i18n-scan.mjs` —— **文案体检表**：把全站还没挂语言 key 的「给用户看的字」扫出来，
    写成 `docs/文案清单.md`（文件:行号 + 文案）。雨猫要亲自翻译时拿它当工作台：搜原文 → 改那一行，或者按它分批挂 key。
  * `.wrangler/tools/check-lang.mjs` —— **语言包体检**：自动扫 `public/lang/*.jsonc`（加一门语言不用改脚本），
    照 `i18n.js` 那套状态机剔注释再 parse（行尾 `//` 与字符串里的 `/*` 都对），并按 zh 基准列各包「还没翻 / 多出来」的 key。
    可以 `--missing` 把没翻的 key 逐条列出来；退出码非 0 = 有包解析不了。
  * `.wrangler/tools/check-globals.mjs` —— **裸全局守门员**：扫打包产物里「被调用但全文找不到声明」的名字
    （漏 import 时 esbuild 不报错，运行时才 ReferenceError → Cloudflare 回 1101 HTML 页）。
    **改完后端必跑**；它当场抓到过 3 个（`groupLabel` / `consumeVerifyPass` / `suggestLang`）。
  * `.wrangler/tools/lang-sync.mjs` —— **语言包键名同步**（`npm run lang:sync`，`--dry` 只报不写）：
    以 `zh-CN.jsonc` 的原文当骨架，把其它语言的值填进去 —— 没的键补 `""`、多余的键删掉、改过名的按脚本里的 `RENAMES` 搬值。
    ⚠️ **在 zh-CN 里改键名之后要跑它**（否则页面里那些键在别的语言里就显示 null；下载也靠 zh-CN 的骨架）。
  * `.wrangler/tools/check-compat.mjs`（`npm run check:compat`）—— **老内核兼容守门员**：扫 `public/style/*.css` 里
    `translate:` 属性 / `dvh` / `backdrop-filter` / `:has()` 这类写法，看有没有 `@supports` 兜底。
    退出码非 0 = 有**会让布局直接错位**的写法没兜底。**改完 CSS 跑一遍**（§14.86）。
* ⚠️⚠️ **绝对不要用 PowerShell 的 `-replace` / `Set-Content` 或 `node -e` 去批量改含中文的源文件** ——
  会把整个文件的 UTF-8 写坏（中文全变 `未登�?`）。**改源码只准用编辑工具**，一个文件一个文件地改。
  （已经翻过一次车：9 个 handler 全毁，靠 `.wrangler/annot-backup/` 才恢复回来。）
* ⚠️ **线上库改角色时别链式滚 UPDATE**：`UPDATE … WHERE role='owner'` 再 `UPDATE … WHERE role='admin'`
  第二条会命中第一条刚改过的行，**所有人被压成同一档**（真发生过：线上一个站长都不剩）。
  一次一条 SQL 一个语义，或者写成一条带 CASE 的 UPDATE。
* `node --check public/script/ui.js` —— 普通 JS 文件的语法检查；`node --check worker.js` —— 打包产物的语法检查。
* cron：`0 4 * * *`（UTC）跑 `scheduled()` —— 清理注销满 7 天的账号 + 过期的 `resource` 行与对象
  + 过期的 `stored_image`（聊天图）+ 过期的 `rate_limits` 行（按 IP 的 key 会随访客一直增行）。

### 环境坑（Windows + PowerShell 5.1）

* 不要用 `&&`，用 `;`。`del` / `kill` 是内置别名（不是命令）。
* `Invoke-RestMethod -Headers @{Cookie=…}` **发不出 Cookie** → 用 `curl.exe`。
* 带 JSON 的 `-d` 会被 PowerShell 吃掉引号 → 写进文件 + `--data "@file"`。
* 终端里中文会乱码（`鈩?`），那是编码问题，**不是接口问题**，别去修无关的代码。
* ⚠️ **线上校验中文串别用 PowerShell 抓**：`Invoke-WebRequest` / `Select-String` 会把没声明 charset 的
  JS/CSS 按非 UTF-8 解，中文一律匹配不到（本轮差点把「已上线」误判成「没上线」）。
  判中文用 `node`：`node -e "fetch(u).then(r=>r.text()).then(t=>console.log(t.includes('中文')))"`
  （或写个临时 `.mjs` 跑完就删）；`curl.exe -s` 则常常拿到压缩后的字节，同样搜不到。
* JS 块注释里出现 `**` 会让 `node --check` 报 SyntaxError（踩过一次）。

### 内置浏览器的坑（我的验证手段只有它）

* 视口被强制夹到 **≤853px** → **测不了 >900px 的桌面样式**（所以桌面改完只能推理 + 让用户线上看）。
* dpr 是 1.5，`getComputedStyle().borderTopWidth` 会吸附到整数设备像素（1px→0.6667px），**别当 CSS bug**。
* 截图经常是半帧/过渡中的假象 —— **只信「goto 之后停一会儿再拍」的那张**。
* 不能 `context.cookies()/addCookies()`（没实现 Storage 域）→ 设身份要先在站内页
  `page.evaluate(() => { document.cookie='foraine_session=<token>; path=/; SameSite=Lax' })` 再 goto。
  本地调试会话这样造：`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ('devlocal-x',4,…)`，
  用完 `DELETE FROM sessions WHERE token LIKE 'devlocal-%'`。
* 窄屏下私信页只显示一栏（列表栏是 `display:none`）→ **隐藏子树里的 CSS 动画不会跑、没有 animationend**，
  元素不可见时也不能 `click`（要用 `page.evaluate(el => el.click())`）。

---

## 2. 地图

```
src/               后端源码（2026-09-14 起）：index.js(入口 fetch/scheduled) + common.js(基础层) + handlers.js(只做路由)
  handlers/        按域拆的接口实现（2026-09-14 由 handlers.js 拆出，2026-09-16 新增 resource，共 18 个）:
                   auth email password oauth profile article comment chat notice upload resource
                   oss oss-admin admin d1 pages totp site   ← 改接口先看这张表，别又翻那个 4000 行的巨无霸
                   ⚠️ resource.js 是资源桶那条线（上传/直传/下载/列表/详情/删除）；upload.js 只剩头像与配图
                   ⚠️ site.js 是「站点级总闸」（站长个人页「Foraine」页签那两个 Toggle，2026-09-17）
                   ⚠️ forum.js 已删（论坛那一轮整个拿掉），lang.js 已删（翻译台那一轮整个拿掉），别再照着老清单找它们
  permission.js      权限组 + 属性两套东西都在这儿（2026-09-29 建，取代原来的 view-permission.js）
  ⚠️ **权限组**（group）basis/default/user/mod/admin，有继承（下级拥有上级全部）—— **写在代码里、不落库**，
     由 `users.role` 那个名字指过来（roles 表只剩 name/label/rank，permissions 那一列不再读）
  ⚠️ **属性**（attribute）= 每人一份的小开关，存 `view_permission` 表，如 `foraine.iota` / `terminal.access`；
     登录时 `syncGroupAttributes()` 按组补齐（缺哪条补哪条，已有的不动也不删）
  ⚠️ <secret> 只认属性：`filterSecrets()` 是看文章时那一道过滤（作者也不豁免，只有 `&raw=1` 才给原文）
  ⚠️ 名册：`extractAttributes` / `syncArticleAttributes` / `releaseArticleAttributes` / `reconcileAttributes`
     （存草稿/发布时同步引用计数，删文章/下架时还回去，cron 每天兜底对账）
  ⚠️ 前端的 secretExprLooksValid（markdown.js）与这里的 evalAttributeExpr 是**同一套语法**，改一边要改两边
build.mjs          esbuild 把 src/ 打成 worker.js；wrangler.jsonc 的 build.command 在 dev/deploy 前自动跑
worker.js          打包产物（生成物，别手改）：路由 + 所有 API + OG/sitemap 渲染 + OSS 签名 + 定时任务
schema.sql          364 行：全部建表/加列（IF NOT EXISTS） + 线上迁移命令写在注释里
wrangler.jsonc      assets 绑定 / run_worker_first 白名单 / D1 绑定 / cron / 自定义域 / build
public/
  index.html  login.html  profile.html  stats.html  access-denied.html
  aceris/     星历（Aceris）: 一个月一张网格 + 翻月, 历法内核在 script/aceris-calendar.js（有测试）
              ⚠️ 旧的 aceris.html 占位页已删（2026-09-17）; 路由白名单与 OG 表里都是 /aceris 与 /aceris/
  articles/   文章列表      article/   文章详情 + 编辑器
  chat/       私信页（应用式三栏；**不在 run_worker_first 里** → 不记访问、无 OG）
  terminal/   终端页（**一页到底**：`/terminal` 要登录；启动进度条期间读属性 → 页内出秘钥闸门 → 松开直接是面板世界）
  ⚠️ `/terminal/verify/` 那个页面**已删**（只留 `src/index.js` 里一张 302 的路，`run_worker_first` 那两条得留着）
  ⚠️ 游客一律由 worker 送去拒绝访问页；`terminal.access` 与面板状态现在**页内判**（`/api/view-permissions`），别再往 worker 里搬回来
  script/  core.js(公共工具/令牌/字体/时间/导航)  ui.js(弹窗/Toast/聊天积木/表情/右键菜单/灯箱)
           header.js  layout.js(页脚 + 弹窗宿主 + 站内简介)  transition.js(转场)  markdown.js  highlight.js  latex.js
           d1-console.js(D1 控制台)  oss-console.js(R2 页签: 两个桶)  site-flags.js(「Foraine」页签的总闸)
           rain.js(雨幕 + 首页的点击涟漪/鼠标转向/推泡泡)  aceris-calendar.js(星历内核)
           terminal.js(启动画面: 冻结的背景格 + 进度条 + 秘钥闸门; 面板世界: 1 主 6 环 + 每块各自浮动)
           i18n.js(语言包: data-i18n 替换 / I18N.t 取词 / 设备级偏好), 词表在 public/lang/
  lang/    zh-CN.jsonc(中文基准骨架) en-US.jsonc ja-JP.jsonc lzh-Hans.jsonc foraine-Raincat.jsonc custom.jsonc
  style/   main.css(令牌 + 全站组件 + 共用的 .chat-*)  main-media.css(≤900 覆盖, 按 matchMedia 注入)
           page-*.css(每页一份)  page-storage.css(R2 页签里的「概览」四张卡)  page-site.css(「Foraine」页签的开关卡)
           page-terminal.css(终端页: 黑底 + 居中图标)
  assets/  Icon Image Text Web-Font
  Resource/ 资源页目录（**还没有前端**）
docs/style-guide.md      视觉/组件规范（§14.x 是按轮次记的「为什么这么写」）
tests/  markdown.test.mjs 与 aceris-calendar.test.mjs，共 48 项
.wrangler/tools/         字体子集脚本 + 内联脚本语法检查
```

`run_worker_first`（`wrangler.jsonc`）里列的路径**才会经过 Worker**（要注入 OG、要记访问、
要服务端渲染 `/u/*`）。**不在里面的就是 CDN 直出**，别指望在那里跑后端逻辑。加新页面时记得想一下要不要进这个名单。

---

## 3. 铁律（改之前必须知道）

1. **零构建、无内容哈希文件名** → `public/_headers` 给 `/` 默认 `max-age=0, must-revalidate`，
   只有 `/assets/*`、`/Resource/*` 长缓存 7 天（`/assets/Text/*` 又覆盖回不缓存）。
   ⚠️ 历史上踩过「HTML 新了、CSS 还是旧的 24h 缓存」，所以别再给 `/*` 加长缓存。
2. ⚠️⚠️ **改完 `public/style/*.css` 或 `public/script/*.js` 必须跑 `python .wrangler/tools/bump_asset_version.py`**。
   `_headers` 那套 no-store + ETag 只对**浏览器**有效 —— **Cloudflare 边缘也会缓存 `.css` / `.js`**：
   实测部署完 `curl -D - https://foraine.xyz/style/main.css` 回 `CF-Cache-Status: HIT`，**内容还是上一版**。
   现象：用户说「你改的东西我没看到 / 明明修过的问题还在」，先按这条查。
   ⚠️ **但 `?v=N` 绕不过边缘**：实测 `/main.css`、`?v=1`、`?v=2`、`?v=777` 回的是同一份内容、同一个 ETag
   —— Cloudflare 的缓存键**不含查询串**。边缘会在**部署后不久自己刷新**（实测约一分钟内），
   所以改完资源部署完，若自己/用户马上看还是旧的，**硬刷新或等一会儿**，别以为没改对。
   `?v=N` 的价值是保证**浏览器**那份缓存不复用旧 URL（12 个页面的 `?v=` 由 `add_asset_version.py` 一次性补上的）。
   真想彻底绕开边缘，得在 Cloudflare 侧给 `/style/*` `/script/*` 加 Cache Rule（用户在控制台做的事）。
2. **样式一律用令牌**：颜色 `--c-*`、圆角 `--radius-*`、间距 `--sp-1..12`（4px 基准）、
   字号 `--fs-14/18/20/22/28/36/48`（**没有 `--fs-md`，也别再加中间档**，用户嫌密）、
   按钮尺寸 `--btn-py/px/fs`。
3. ⚠️⚠️ **全局 `p { font-size: var(--fs-20) }` 会压过继承**：任何「容器改字号」的地方都要写成
   `:is(p, li, dt, dd, th, td, blockquote, figcaption)`（评论区、D1 结果网格都栽过）。
   `*` 里只有 `margin/padding/box-sizing`，**别往那儿加 color/font-size**（会把全站压平）。
4. ⚠️ **选择器特异性**：`.chat-msg .chat-bubble.is-media`（0,3,0）这种写法是必须的
   —— 只写 `.chat-bubble.is-media` 压不过 `.chat-msg.is-mine .chat-bubble`。
5. **两个 `@font-face` 家族别合并**：`XNSFengTangHaiYanWei`（243KB 装饰子集，人人会下，`--font-hand`）
   与 `XNSFengTangHaiYanWeiText`（1394KB/4045 字，只有选了手写体的人才请求，`--font-hand-body`）。
   字体子集脚本在 `.wrangler/tools/subset_font*.py`，要用手写体写新字就得重跑。
6. **字体白名单三处必须一致**：`worker.js` 的 `FONT_VALUES` / `core.js` 的 `FONT_CHOICES` / `main.css` 的 `--font-hand*`。
   服务端认不出的值一律存成 `''`。
7. **用户名一律小写入库、比较一律 `LOWER(x) = LOWER(?)`**（`idx_users_username_nocase` 是 `LOWER(username)` 唯一索引）。
   大小写只留在**昵称**里。改这条要**先部署代码再改数据**，反了老代码会把改名的人锁在门外。
8. **加列/建表要本地 + 线上都跑**，并写进 `schema.sql`（`IF NOT EXISTS` + 注释里给线上命令）。
   读新列的地方要能容忍「老库没这列」（历史上 `user_roles` 的缺失拖垮过整个登录、
   `loadPublicUser` 的降级分支静默吞掉列名错误）。
9. ⚠️⚠️ **`handleSendChat` 存的是「原始 body」，不是 `parseChatBody` 洗过的那份**。
   所以往聊天 body 里塞任何键都会**原样进库** —— 客户端专用标记必须在真发送时删掉（`pending` 就是这么处理的）。
10. **删功能要连皮一起删**：用户明确删掉过空气泡尾巴、评论撤回、预览权限(viewAs)、首页「最近更新」、
    列表页搜索栏 —— **别「恢复」它们**（`docs/style-guide.md` 里有 ⛔ 标注）。
11. ⚠️⚠️ **`resource` 表混装着两种东西，一律靠 `resource.scope` 分家**：
    `'chat'` 私聊附件（7 天、要登录、不进资源中心） / `'library'` 资源中心（默认永久、公开可下）。
    查这张表的地方**必须带 scope**，否则会把别人私聊里发的文件摆到公开列表上。
    **也别拿 `expires_at IS NULL` 当「公开」的判据** —— 它是对象寿命，不是可见性。
12. ⚠️ **新写的处理器用到了别的模块的函数，导入清单漏一个 = 只在成功路上炸的 500**：
    esbuild 不报错，只把这个名字留成裸全局（产物里别处都重命名了，只有它还是原名），
    运行时才 ReferenceError、Cloudflare 回 1101（HTML 错误页，不是 JSON）。
    验收手法：`Select-String -Path worker.js -Pattern "函数名\("` 看有没有没被重命名的调用。

---

## 4. 数据层（D1）

绑定 `DB`/`foraine-db`（线上 id `4b212cea-af1a-4663-aba3-54df8bd418c6`）。主要表：

| 表 | 说明 / 坑 |
| --- | --- |
| `users` | `email_verified`、`github_id`（唯一索引，NULL 不参与）、`is_deleted`+`deleted_at`（注销宽限 7 天）、`password_hash` 用 `!oauth!` 前缀标记 OAuth 账号 |
| `profiles` | 昵称/简介/位置/其他、`avatar_url`、`bg_image`/`bg_blur`/`chat_bg`/`chat_blur`、`font_chat/forum/article` |
| `sessions` | `token` 主键、`expires_at` **NOT NULL**（手工插测试会话时别漏） |
| `articles` / `tags` / `article_tags` | 软删除 `is_deleted`；草稿 `status='draft'`；阅读时长服务端算好再丢正文 |
| `comments` | 两级楼中楼，`reply_to_comment_id`；删了会**递归清掉整棵死子树** |
| `chats` | `from_user_id/to_user_id/body/created_at`、`is_deleted`(撤回软删)+`deleted_at`、`cid`+唯一索引（幂等去重） |
| `emoji` | 每人最多 120 张，`url`+`object_key` |
| `resource` | 上传文件登记（`name/object_key/size/mime/uploader_id/expires_at`，默认 7 天） |
| `notices` | 站内信（**故意不叫 `messages`**：老库里有同名死表） |
| `roles` + `users.role` | RBAC **只剩这一张表**（2026-09-14 合并）：角色行 = label + rank + 逗号分隔的 permissions。老库旧三表 `roles`/`role_permissions`/`user_roles` 已删 |
| `totp` | 动态令牌（用户问过「令牌的数据表在哪」）：`user_id` 主键 + `secret_enc`（AES-GCM 密文）/`iv`/`salt` + `enabled`。**`enabled=0` = 「二维码已生成但还没确认」**；密钥材料 = 服务端密钥（`TOTP_KEY` → 退 `OSS_ACCESS_KEY_SECRET`）+ 每行自己的盐 |
| `resource_group` | 资源组：`key`（对象目录名）/`title`/`description`/`uploader_id`/`expires_at`/`guard`（整组防盗）/`allow_edit`（「公开编辑」：1 = 站内已验邮箱的人都能编辑这一组，门槛 = 已登录 + 邮箱已验证）/`notify_stage`（大流量通知到哪一档了：0/2/5）。⚠️ 这个开关**只在详情页右栏那块「公开编辑」卡上改**（`POST /api/resource/allow-edit`，判据与防盗同一个：上传者/站长）。⚠️ 协作者（allow_edit 进来的）**只能动自己传的那些文件**：改别人的文件标题/简介 403、删别人的文件 403、也不能把这一组删空 |
| `download_log` / `dl_active` | 下载日志（谁/何时/哪个资源/多大/`via` worker|direct/IP）与**并发槽**。⚠️ 并发槽不能塞进 `rate_limits`（那是「窗口内几次」的语义）。槽在响应流 `flush` 时才还（§14.50） |
| `upload_usage` | 上传用量（人 + UTC 日 + 字节）。既是**日配额**（20GB/天）也是**7 天累计**（最近 7 个 UTC 日求和）的数据源 |
| `site_flags` | **站点级总闸**（站长个人页「Foraine」页签那两个 Toggle）：键 `downlink`（下行流量方案）/ `quota`（资源量限制方案），**只存被改过的键**（缺键 = 默认开，`common.js` 的 `SITE_FLAG_DEFAULTS`）→ 加新开关不用迁移。`loadSiteFlags()` 有 **30 秒 isolate 缓存**、出错一律当全开；改开关最多 30 秒才全网一致 |
| `bans` / `moderation_log` / `password_requests` / `email_tokens` / `follows` / `visit_logs` / `rate_limits` | 见名知意 |
| `verify_pass` | **敏感操作的一次性通行证**：`token` / `user_id` / `via`(totp\|email\|password) / `expires_at` / `created_at`，5 分钟、消费即删。`issueVerifyPass()` / `consumeVerifyPass()` 在 `common.js`；注销、`/api/password/set`、`/api/email/rebind` 三个写入点都靠它放行 |
| `view_permission` | **属性**（每人一份的小开关）：`user_id` + `permission` 两列主键。内容等级（`foraine.iota`）、终端通行证（`terminal.access`）都是属性。`a.b.*` 覆盖 `a.b.c`。⚠️ 授予还是只能手写 SQL（没有界面） |
| `attribute_registry` | 属性**名册**：`name` 主键 + `ref_count`（多少篇没删的文章点过名）。归零就删行。给以后那个「授予属性」的界面当候选清单用 |
| `article_attribute` | 文章 → 属性 的引用关系（算 `ref_count` 的依据；重复保存不会重复计数）。删文章 / 下架时还计数，cron 每天兜底对账 |
| `forum_topics` / `forum_posts` | 论坛（半成品，见 §9） |

⚠️ `rate_limits` 是限流的落地表（`peekRateLimit` / `hitRateLimit`），存的是 `Date.now() + 窗口` 的**毫秒**值。
删**已过期**的行零影响（代码本来就当它不存在，下次会重置）；删**未过期**的等于把那道闸当场清零。
它只是「窗口内几次」的计数器 —— 不参与鉴权、没有别的表引用，清掉不坏任何东西。cron 每天清过期行（`purgeRateLimits`）。
⚠️ `visit_logs` 只统计**页面请求**（`isPageRequest()` 判 `Accept` 含 `text/html`），否则一个页面几十个子请求会把 D1 写爆。

**站长 D1 控制台**（个人页「D1」页签）：只读白名单 `d1Guard()`（`stripSqlLiterals` 之后才查写关键字，
否则 `WHERE action='article.delete'` 会被误拦）；写操作要求 `write:true` + `confirm:'RUN'` + 审计日志 + 单独限流。

---

## 5. 存储层（阿里云 OSS，两个桶 + 一个待删）

都在 `oss-us-west-1`（美国硅谷，海外 → 免备案），**同一个 RAM 密钥对**（secret：`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`）。

**`foraine-image`（`img.foraine.xyz`）的布局（2026-09-14 用户定的规则）**：

| 前缀 | 内容 | 寿命 |
| --- | --- | --- |
| `avatar/<用户名>` | 头像（**不带扩展名**，换图覆盖同一个对象） | 永久 |
| `img/article/<文章编号>/…` | 文章正文 + **评论区**的图 | 没人引用就删（保存/发布后、或删评论后） |
| `img/user/<用户名>/emoji/…` | 表情 | 用户在表情栏删掉时一并删对象 |
| `img/user/<用户名>/chat/…` | 聊天图（无论和谁） | **登记进 `stored_image` 表 + 7 天过期**（cron 清） |
| `img/user/<用户名>/profile-image` | 主页背景（不带扩展名，覆盖） | 永久 |

* ⚠️ **一律不带扩展名**（头像 / 背景这类可替换的）→ 传 jpg/png/webp 都是同一个对象名，必然覆盖、不冗余；
  图片类型靠 PUT 的 `Content-Type` 记在对象上。带时间戳的图（文章图 / 聊天图 / 表情）本来就不会撞名。
* ⚠️ **聊天背景（`chat-image`）2026-09-14 起暂时下线**：个性化页签那张卡片加了 `hidden`，后端分支保留。
**大文件两条路（2026-09-17 起）**：
* **≤ 24MB 走 Worker 中转**（`POST /api/resource/upload`，multipart，能拿到 ETag = MD5）。
* **> 24MB 走分片直传**：`init → sign → 浏览器 PUT 每片 → complete`，8MB 一片，**支持断点续传**（§14.48）。
  ⚠️ 那张「桶上没给 `oss:ListParts` / `oss:AbortMultipartUpload`」的账还欠着（见速查表）。
  ⚠️ 私聊附件仍是老的那条**单次直传**（`uploadChatAttachDirect`），没有断点续传 —— 用户特意说的「仅资源上传」。
* ⚠️ **一批的总字节超过 5GB → 新组默认开防盗链**（`RES_AUTO_GUARD_BYTES`，2026-09-17）：前端把这一批的大小当 `group_total` 发给三个开组点，`createResourceGroup()` 里判；**只在开新组那一下判**，往老组里加文件不动人家原来的开关。
* `foraine-resource`（`res.foraine.xyz`，单文件 5GB / 每天 40GB，2026-09-16 把「20 个/时」废掉了）：`res/<用户名>/<ts36>-<rand>.<ext>`，登记进 `resource` 表（私聊附件 7 天 / 资源中心默认永久）。
  * 字节配额在 `upload_usage (user_id, day, bytes)` 里累加（`rate_limits` 是计数语义，装不下字节）。
* ⚠️ **这个桶是公共读**（实测：匿名 GetObject 200 / 匿名 ListObjects 403 / 匿名 PUT 403），
  而且 `res.foraine.xyz` **走 Cloudflare 且在缓存**（响应头里 `cf-cache-status: HIT`）—— 所以：
  * 「必须登录才能下」只挡得住「从页面点下载」那一条路，直链谁拿到谁能下；桶上**没有防盗链**（外站 Referer 也 200）。
  * 资源中心的存对象**不能写 `immutable`**（删了对象边缘还会吐旧副本）：永久给 `max-age=86400`、
    会过期给 `max-age=3600`（见 `handlers/resource.js` 的 `resourceCacheControl`）；私聊附件保持 immutable。
  * 想让失效立刻生效得靠更轻的手段：桶级防盗链或 Cloudflare 规则（用户 2026-09-16 拍板走这条）。
  * ⚠️ **桶级的 Referer 防盗链用户已经配好了**（白名单 `foraine.xyz` + `www`、**空 Referer 拦死**）。两个反直觉的点：
    ① **带签名的请求绕过它**（实测 Worker 的列桶/上传照常工作，不用给 Worker 请求补 Referer）；
    ② **Cloudflare 的缓存键不含 Referer**（同一条 URL 被站内请求缓上之后，换外站 Referer 也能命中 200）——
    所以**判「对象是不是私有的」必须用站内 Referer 去探**，空 Referer 探不出来（被桶规则一律 403）。
  * ⚠️ **改对象 ACL 的正门 `PutObjectAcl` 要单独的 `oss:PutObjectAcl` 动作**（现有密钥没有 → 403）。
    代码里退到自拷责 `CopyObject`（已授权的 GetObject+PutObject）。想走正门就往 RAM 策略补 `oss:PutObjectAcl`。
  * 防盗（对象设私有）的实现与语义见 `handlers/resource.js` 的 `setResourceObjectAcl` / `resourceGuarded`。
  ⚠️ 2026-09-17 起防盗又多了一道门：**下载防盗的文件/组必须先登录**（`/api/resource/download` 返 401），
  前端对防盗文件也不再给直链（对象 ACL 是 private，直链本来就 403）。
* ⚠️ `foraine-avatar` 桶（`avatar.foraine.xyz`）**已废弃**：头像已全部迁到 `img.foraine.xyz/avatar/`（线上 7 个全在新址）。
  确认后在 OSS 控制台删桶 + 解绑 CNAME。
* **站长一次性工具**（浏览器里跑，都要站长会话）：`POST /api/admin/oss/purge-images`（删旧 `img/` 对象，先不带 apply 看报告）、
  `POST /api/admin/oss/migrate-avatars`（搬旧头像）、`GET /api/avatar/diag?orphans=1`（扫孤儿）。
* **「这个对象还有没有人引用」只在 `objectStillReferenced()`（`common.js`）一处判定**：文章正文 / 未删评论 / 未撤回聊天 / 表情 / 背景。
  ⚠️ 以后加新图床字段**必须**把它的查询补进去，否则扫桶 GC 会当垃圾删掉。

* ⚠️⚠️ **OSS V4 签名三个易错点**（照 AWS 印象写必错）：① 规范化请求末尾**没有 `SignedHeaders` 段**；
  ② **`host` 不参与签名**；③ **规范化 URI 必须带桶名** `/<bucket>/<object>`。
  救命的诊断：`SignatureDoesNotMatch` 的响应体里会**回显它自己算的 CanonicalRequest**，逐字节对比即可。
* 所有 PUT 都带 `Cache-Control: public, max-age=31536000, immutable`（**不参与签名**，所以随便加）。
  老对象要 `CopyObject` 重写才吃得上这个头。
* **>24MB 的文件走「Worker 签名 + 浏览器直传 PUT」**（Worker 中转有请求体上限 + 128MB 内存，
  大文件必炸）→ `POST /api/resource/presign` 返回 `{url, headers}`，前端 XHR 直传，**一个头都不能漏**。
  这条**依赖桶的 CORS**（阿里云控制台「编辑跨域规则」：来源 `https://foraine.xyz` 与 `https://www.foraine.xyz`、
  只勾 PUT、允许 Headers `*`、暴露 Headers 留空、缓存 600、不勾 Vary）。用户已配好并实测通过。
* RAM 策略要 `GetObject/PutObject/DeleteObject`，**列对象还要 `ListObjects`**（Resource = 桶本身，不带 `/*`）。
* 下载**文件**别直连桶（私有读会 403）：走 `GET /api/resource/download?id=<resource 行主键>`（Worker 代取 +
  强制 `Content-Disposition: attachment`）。聊天里那条 JSON 因此要带 `id`；老消息没 `id` 才退化成直链。
* 桶垃圾回收：`GET /api/avatar/diag?orphans=1[&apply=1]`（引用集 = 未删文章正文 + 头像 + 两张个性化背景；
  ⚠️ 加新图床字段时**必须**把它的查询补进 `objectStillReferenced()`，否则会把人的背景图当垃圾删了）。

---

## 6. 鉴权与权限

* 会话：HttpOnly Cookie `foraine_session`（3 天），`createSessionCookie()` / `redirectTo()`（要 `Headers.append` 才能发多条 Cookie）。
* ⚠️ **现在是「权限组 + 属性」两套，不再是 `roles.permissions` 那串**（2026-09-29 用户定的，实现在 `src/permission.js`）：
  * **权限组**（group，写在代码里、不落库）：`basis`（被封禁）→ `default`（未登录）→ `user`（登录）→ `mod` → `admin`，**下级拥有上级全部权限**。
    `users.role` 存的就是组名；`roles` 表只剩 `name` / `label` / `rank`（**permissions 那一列不再读**，留着是为了别动库结构）。
  * **属性**（attribute）：每人一份的小开关，存 `view_permission`。`<secret>` 的内容等级（如 `foraine.iota`）与 `terminal.access` 都是属性。
    登录时 `syncGroupAttributes()` 按组补齐（缺哪条补哪条，**不删**）；授予目前只能手写 SQL。
  * 判定：`loadUserGroup()` 取组（封禁 → `basis`，游客 → `default`）→ `loadPermissions()` = 组权限 ∪ 属性 → `hasPermission()`（`*` 与 `a.b.*` 都能顶）。
  * ⚠️ 权限串的**唯一权威清单**是 `docs/权限串中央清单.md`（用户自己维护的）+ `permission.js` 的 `GROUP_PERMISSIONS`/`PERMISSION_LABELS`。
    ⚠️ 改串名要**四处一起改**：清单文档 / `GROUP_PERMISSIONS` / 各 handler 里的 `hasPermission()` 实参 /
    **前端自己那份判定**（`profile.html` 的 `amISiteOwner()`、`canManageOthersArticles()`、`applyDevTools()`，
    `article/index.html` 的两处站长判定 —— 漏改的症状是「我是站长但开发者工具不见了」）。
  * ⚠️ 迁移角色时**别链式滚 UPDATE**（见 §1 的坑，线上站长被压平过一次）。
  * 代码侧全带 try/catch —— 表没迁移时只会「所有人都是普通成员」，不会把登录搞挂（历史教训见铁律 8）。
* 预览权限（`viewAs` / `effectiveRole` / `canActAs`）**已被用户要求整体删除**，界面一律按服务端真实权限画。
* 封禁：立即生效，只能浏览不能发文/评论/建话题；封禁期间 `/api/me` 会带 `ban` 信息给前端画横幅。
  权限组会掉到 `basis`（只有 `articles.visit` / `article.visit` / `resources.visit`）。
* 密码：`handleRegister` 入库前小写化用户名；GitHub OAuth 也 `toLowerCase()`；撞名用 `<login>-gh<id>` **新建**账号，绝不合并。

---

## 7. 私信系统（最复杂的一块，改动最频繁）

> 两个宿主共用同一套积木：`/chat/`（`public/chat/index.html`）与个人页的私信弹窗（`public/profile.html`）。
> 积木全在 `ui.js`：`fillChatBubble` / `parseChatAttach` / `chatAttachBody` / `renderChatAttach` /
> `uploadChatAttach` / `toggleStickerPanel` / `loadStickers` / `showContextMenu` / `openImageLightbox`。
> 样式在 `main.css` 的 `.chat-*` 段（**两个宿主共用**，改之前确认别把某一边改坏）。

* **body 就是文字或一坨 JSON**（没加列）：
  * `{t:'image', url, name}`（表情 = `name:'sticker'` → 画成小一点）
  * `{t:'file', url, name, size, id}` —— `id` 是 `resource` 行的主键，下载靠它
  * `{t:'quote', name, text, body}` —— 引用是**快照**，不校验 URL，原消息撤回也不变
  * 客户端专用：`{pending:true}` 表示「还在上传」（⚠️ 见铁律 9）
* **乐观发送**：按下发送 → 立刻上屏一条（`.is-new` 做「边缘→中心」的位移动画）+ 同时就地更新左侧第二栏；
  上传/入库/拿真实 id 全在后台做，回来**只改那一行**（`patchChatRow`），失败加 `.is-failed`。
* **去重靠 `cid`**（客户端随机串，≤40 位）：`chats.cid` + 唯一索引，服务端撞上已存在的 cid 直接返回原消息
  （`dup:true`，重发幂等）。客户端渲染前 `findChatRow`（先按 cid 再按 id）→ 已画着的只补属性，
  这就是「消息出现两次」的解法（根因是「乐观那行 + 轮询又拉回来一行」）。
* **左侧第二栏（会话列表）的两条策略**：
  * **动画只在「切进来」时播**（首屏 / 论坛切回私信 / 窄屏返回列表），数据更新一律不播
    （`.chat-item` 自身没有 animation，动画类是 `replayItems` 临时挂的）。
  * **发出即就地更新**：`touchConversation(username, preview)` 不等接口先改预览与时间、排到最前、抹未读；
    客户端预览文案 `chatPreviewTextClient()` **必须与服务端 `chatPreviewText()` 逐字一致**，否则列表会白重画。
  * 另有一条 **15 秒的独立慢轮询**（`startConvPolling`）给挂机看列表兜底，指纹没变就早退。
* **右键菜单的语义差别（用户拍过板）**：
  * 「删除」= **只删自己这边**（`localStorage['foraine.chat.hidden']`，上限 800）
  * 「撤回」= **服务端软删**（自己发的 + 5 分钟内，`is_deleted/deleted_at`，增量轮询回带 `recalled:[ids]`）
  * 「引用 / 另存为 / 复制图片 / 添加到表情」见 `ui.js`
  * 在消息区右键 = `preventDefault` 吞掉原生菜单；**输入框/头部要留原生菜单**（要能粘贴）。
* **文件卡片有两张脸**：上传中 = 灰边 3px（悬浮转紫）+「上传中」+ 水位波浪（`--chat-file-fill` 进度，
  水面是一条长波长无缝 SVG 波浪在漂）；上传完成 = 紫边 2px 亚克力卡片（`<a>` 可下载）。
  进度只有 XHR 的 `upload.onprogress` 能给（所以 `ui.js` 有 `xhrUpload()`）。
* 缓存与增量：`msgCache['c:<用户名>'|'f:<话题id>'] = {list,lastId}`，轮询只拉 `?after=<最后一条 id>`，
  没新东西一行 DOM 都不碰；列表用指纹去重（`convoSig`/`topicSig`）。
* ⚠️ `dropChatRows()` 要调全局钩子 `window.foraineChatDropped(ids)` 去抹 `msgCache`，
  否则切走再切回来会把删掉/撤回的消息画回去。

---

## 8. 工作方式（这位用户的习惯）

* 需求是**一次给一批编号的中文条目**（常常 4~10 条），夹着截图；**逐条实现 + 部署 + 逐条简短汇报**。
* 他会说「**你有什么更好的建议的话就可以做呐喵**」= 授权我自己拿主意（有更优解就直接做，别问）。
* 他也会说「**我允许你直接操作远程数据库，别再问我了**」= 线上增删改直接干，但**必须自己收拾干净**。
* 汇报要**短、按条目**、附部署版本号；不要贴大段代码。
* 他常常先描述一个「感觉」（比如「波浪应该是水慢慢往上溢的感觉」）而不是给规格 ——
  这时**先按最合理的读法做出来**，再把自己怎么理解的、哪些旋钮可以调写清楚，让他一句话纠正。
* 不明确时就**先动手做最合理的那个**（他更讨厌来回问）；但涉及「要不要保留/删除某个功能」这种不可逆的取向，值得问一句。
* 密钥、AK/SK、密码**永远不要经过聊天**：让用户自己在终端 `npx wrangler secret put XXX` 粘贴，或告诉他去控制台点哪里。

---

## 9. 已知的坑速查（症状 → 真因）

| 症状 | 真因 |
| --- | --- |
| 页面样式莫名其妙错位/旧 | `_headers` 缓存（`?v=` 或 no-store 兜底） |
| 改了 CSS 没生效 | `main-media.css` 是**按 `matchMedia` 在加载时注入**的 → 测试要先设视口再 goto/reload |
| 容器改字号无效、段落还是 20px | 全局 `p { font-size }`（见铁律 3） |
| 图片气泡变成紫色块 | 特异性（见铁律 4） |
| 长截图被压成一条 34px 的缝 | `max-height` 等比缩 → 用 `.is-tall` + `object-fit: cover` |
| 图裂/过期不显示兜底 | 监听要**先挂再设 `src`**，并用 `pic.complete` 补判（缓存命中不触发 load） |
| 悬浮时间戳闪现/不稳 | 用 CSS `transition-delay`，别上 JS |
| 聊天消息出现两条 | cid 去重（§7） |
| 大文件上传 502/炸 | Worker 中转上限 → 直传 OSS（§5） |
| 下载文件 403 | 私有桶直链 → 走 `/api/resource/download` |
| 头像悬浮出现椭圆框 | 装 `<img>` 的容器是 `display: block`（基线撑高）→ 用 `flex` + `img{display:block}` |
| 手机端整页横向滚 | grid/flex 项的 `min-content` 被 `nowrap` 撑开 → `min-width: 0` |
| `blob:` 下载跳到 404 | `transition.js` 的链接拦截器把 blob 当内部链接 → 判 `download` 属性与 `protocol` |
| 列表条目动画「播一次就没了/压住 hover」 | `animation-fill-mode: both` 的收尾帧 → `animationend` 摘类 |
| 抽屉/面板关不掉 | 先看 `getComputedStyle(el).transform` 与 `getBoundingClientRect()`，别只看 class（入场动画的 `transform: none` 会压死自己的位移） |
| 放 `data-anim` 的元素上自己的 `transform` 失效 | 入场动画用独立的 `translate` 属性（已修），别再用 `transform` |
| 内联元素（一句剧透）换行后，遮罩变成「整段行宽」的一大条 | 绝对定位的 `::after` 对内联多行元素只能取**首末片段的并集矩形** → 面板改写成元素自己的背景 + `box-decoration-break: clone`（§14.70） |
| 剧透旁边那几个普通字跟着变模糊了 | `backdrop-filter` 挂在内联元素上按**并集矩形**取背景 → 内联元素上不要用背景滤镜；原文用 `color: transparent` 藏就够了 |
| 剧透里塞了张图，面板只有一行字那么矮（盖不住图） | 内联盒只画「字盒」那么高，且 `.md-img` 是 `display: block` 会把内联元素撕开 → 图改回 `inline-block`，整块用 `:has(img)` 切 `inline-box` |
| 本地插了带权限的测试会话，接口还是 401 | 先看 `sessions.expires_at` 是不是**过去了**（毫秒时间戳，写小了就是过期） |
| 本地插入会话报 NOT NULL | `sessions.expires_at` 必填 |
| API 回 1101 HTML 错误页、DB 行没回滚 | 新处理器漏了某个 import（esbuild 不报错）→ **`node .wrangler/tools/check-globals.mjs`**（一句话定位到名字）|
| `ReferenceError: xxx is not defined` 只在某个页面炸 | 同上；**恢复文件后尤其要跑**（旧备份的 import 清单跟不上新代码，一次踩到过 3 个）|
| 同上，但回滚的是「登记行 / 删除行」 | ⚠️ D1 的 `.bind()` 返回的是**语句对象不是 Promise**：`prepare(...).bind(x).catch(...)` 会 `TypeError` → `.catch()` 只能接在 `.run()/.first()/.all()` 后面 |
| 全站下拉框滑一下就消失 | `ui.js` 里那句捕获阶段的 scroll 监听把**菜单自己内部**的滚动也当成了页面滚动 → 已排掉 target 在菜单内的那种 |
| 自造控件和旁边的下拉框「看着是一对」但总高一头（56 / 49 vs 45） | 按钮行继承 36px 行高、手写体字体族的 `normal` 行高又偏高 → 直接抄 `.ui-select-btn` 的 `line-height: 1.28`（§14.46） |
| 用户说「还是把这按钮删了吧」 | 是真的要删，别只藏起来 —— 连它的 HTML / CSS / 变量 / 请求字段一起清（§14.47 的 `.rw-allow` 就是这么整块没的） |
| 新加的上传字段只有一条路生效 | 前端「预填 / 上传循环的补算分支 / 编辑保存循环」三处都要写（`sha1` 就是这么漏过一处的） |
| 分片上传发起来就 403 SignatureDoesNotMatch | 规范查询串和我们拼的不一样 → 照 OSS 回显的 CanonicalRequest 重签一次（`ossStartMultipart` 已内置这道兜底，别再猜） |
| CompleteMultipartUpload 回 InvalidPart | ① 分片 ETag **是大写十六进制 MD5**，比对时**认大小写**（转小写就错）；② ETag 要**连着引号**原样回填进 XML |
| 分片合并出来的对象没有 Content-Disposition | 分片的对象元信息**只能在 initiate 那一刻定**，而且要给 `ossSignedRequest` 的 `extraHeaders` 真转过去（当时忘了转发） |
| 分片那条路上列分片 403 AccessDenied | RAM 里没有 `oss:ListParts`（abort 需要 `oss:AbortMultipartUpload`）→ 客户端自己记 `{片号: ETag}` 顶上 |
| 「取消上传」在分片循环里报 `xxx is not defined` | 那个循环在**工作台闭包外面**，看不到 `uploadCancelled` → 模块级再镜像一个标志（`uploadStopRequested`） |
| 接口只在成功路上 500（错误却写成「资源表还没建」） | 新写的处理器用了 `common.js` 的常量/函数但**没加进 import**（`RES_QUOTA_TIERS`、`RES_WEEKLY_DAYS` 各栽过一次）—— esbuild 不报错，运行时才 ReferenceError |
| 拿几 KB 的文件测「下载并发上限」测不出来 | 小响应体会被平台一次收完、流当场结束、槽立刻还掉 → 要用**大文件**（且客户端只读一块不读完）才能占住槽 |
| 游客的并发上限把登录用户也算进去了 | `dl_active` 里登录用户的槽也记着同一个 IP → 数游客时必须 `user_id IS NULL AND ip = ?` |
| 站内信写不进 / 查不到 | 收件人列叫 **`to_user_id`**，不是 `user_id`（`notices` 那张表） |
| 删整组不带密码、或在测试里「清了行但对象还在」 | 删整组的密码是**服务端**验的（`res-del-group:<uid>` 限流），前端那个「验证身份」弹窗只是体验；整组删除现在只有一条入口 = 编辑组里清空列表再保存（§14.49） |
| 协作者连文件的标题都改不了 | `handleResourceGroup` 那道「只有上传者能改组信息」的 403 只能拦**组那一层**（`file_id` 没给时），两条路的字段名都是 `title`/`description` |
| 想查线上异常但 `wrangler tail` 连不上 | 临时把 `handleApi` 包一层 try/catch 返回 `err.message`，打完一次接口再拆掉（比对着 1101 HTML 猜快） |
| 资源中心列表里冒出私聊附件 | 查询漏了 `scope = 'library'` |
| 弹窗里再弹一个确认框，关掉之后底层弹窗没了 | `confirmAction` / `showMessage` 共用 `#modal-content` → **用 `armTwoStep`（按钮点两次）代替**，它才是现在的规矩（§14.36） |
| 输入框/卡片被压成一条缝（autoGrow 算对了但渲染很小） | 父级是 flex 列且高度受限 → 孩子要 `flex: none`（§14.36） |
| 同一个按钮类，锚点那个比 `<button>` 高一头、字也更大 | `<a>` 是 inline 且继承正文行高 → `a.btn*` 要显式 `display: inline-flex; line-height: normal`（§14.36） |
| 两个并排的输入框（一个 `<input>` 一个 `<textarea>`）高度差 3~4px | 高度 = **行盒** + 内边距 + 边框：`input` 走字体自己的 `normal` 行盒，而 `textarea.confirm-input` 被定了 `line-height: 1.6`。⚠️ 改成 `normal` 会让 `autoGrowLines()`（`parseFloat(computed lineHeight)`）拿到 NaN 退到 `fontSize×1.5`、行数算不准 → **给两张都钉一个数值行高**（§14.53） |
| 写了个 `document` 上的 keydown 想拦住弹窗的 Esc，结果弹窗还是关了 | `ui.js` 的关闭监听也在 `document` 上，**同一节点上的其他监听不会被 `preventDefault()` / `stopPropagation()` 拦住** → 用 `capture: true` + `stopImmediatePropagation()`（§14.53） |
| 转圈弹窗在某个页面上是一片空白 | `.modal-busy` / `.busy-spinner` 已挑到 main.css（原来只在 page-article.css，资源页不加载它） |
| 上传中还能点背景 / 按 Esc 把弹窗关掉 | 只有 `showBusyModal` 锁了弹窗；跑的活要用计数式的 `lockModal()`（§14.38） |
| 弹窗里出现两个滚动条 + 一块空白 | 面板被定了高、列里又有一层 `overflow-y: auto` → 高度交给内容，让 `.modal-panel` 统一滚（§14.38） |
| 「服务端校验值」补不上，接口回 502（HTTP 403） | 用的是签名 HEAD 取 ETag —— OSS 在部分对象上对 HEAD 回 403（同对象签名 GET 正常）→ 改成 GET + `Range: bytes=0-0`（§14.38） |
| 个人页资源卡片写「0 B / 文件」 | `/api/resources` 返回的是组卡片字段（`total_size`/`file_count`/`kinds`），不是 `size`/`ext`（§14.38） |
| 配好桶的 Referer 防盗链后，服务端取对象开始 403 | Worker 里直接 `fetch` 公共域名 = 匿名请求、没 Referer → 一律改走 `ossSignedRequest`（签名请求不受白名单管） |
| 明明是个 .zip，上传回「不支持这种文件」 | 中转那条只看 `mime`（拖进来的文件常是 `application/octet-stream`）→ 已改成 `mime \|\| 扩展名`，与直传一致 |
| 删掉的资源直链还能下 | 对象上写了 `immutable`，被 Cloudflare 缓存着 |
| 某个「同页两种形态」的页面上页脚不见了 | `layout.js` 注页脚挑的是**第一个** `.page-layout`（`/resource/` 上是 `#list-view`），进详情那一棵被 `hidden` → 页脚跟着没。要挪就在**渲染函数末尾**挪（先 `innerHTML=''` 会把它清掉），并补一个 `.spacer-flex`。⚠️ 挪到详情里之后**要留一个元素引用**：下次 `innerHTML=''` 会把它从文档里摘下来，那时 `querySelector` 已经查不到它了（用户第三次报「保存完页脚消失」就是这个）|
| 桌面端整页变成**单列**、侧边栏（目录之类）掉到文章**最下面** | 那个 flex **容器**的规则被整段弄丢了（2026-09-17 的 `.article-layout` 就是这么消失的）：子项上写的 `flex: 1` / `flex: none` / `min-width: 0` **在没有 flex 父级时全是废的**，只剩普通块级堆叠。重建时拿两边的已知尺寸反推（正文 36em=720 + 目录 275 + 间距 40 → 1040，与 `.list-grid` / `.profile-layout` 同宽）|| 新加的 `data-tab` 页签点了没反应、页面停在「资料」 | 新页签**必须追加进 `TAB_ORDER`**（`profile.html`），否则 `switchProfileTab` 第一行就把它改写成 `'profile'` —— 按钮会亮但不切、懒加载也不跑（`site` 页签就是这么翻过一次车） |
| 某个列表/内容区越长、整个模态框（容器）就越高 | 容器是 **auto 高度的 grid 行**（行高取两栏**固有高度**的最大值）→ 给列表写 `height/max-height` 或 `min-height: 0 + overflow: auto` 都压不住；要把它裹进**绝对定位**的一层（`position: absolute; inset: 0`），固有高度那一路才算 0（工作台左栏滑动框就是这么修的，§14.52） || 某行字突然变成 20px 亮色（该小该灰的没小没灰） | 那套样式住在 `page-article.css`（`.article-meta` 等），而这个页面**不加载它** → 自己声明一遍（`.modal-busy` 也是同一类事故） |
| Toast 只显示一半 / 开关关掉了也说「已开启」 | `'名字' + box.checked ? A : B` —— `+` 比 `?:` 优先级高，条件变成了「拼好的那串字」（恒为真）→ 三元先取到局部变量里，或把条件括起来 |
| 页面里某个元素变成了一串文字 `NaN`（或整层 div 不见） | 拼字符串时在两条串中间夹了块注释：`'A' + /* 注 */ + 'B'` 被解析成 `'A' + (+'B')` → `NaN`。注释要写在**下一行行首**；`check-inline-js.mjs` 现在会挑出来。⚠️ 同一轮的另一个版本：块注释里写到 `*/`（比如描述「注释」时）会把注释提前闭合，后面全变语法错 |
| 想在弹窗「确认」的处理函数里转圈 | ⚠️ 不行：`showBusyModal` 是往 `#modal-content` 里塞的，会把当前弹窗内容整个换掉（忙等关掉后原弹窗也没了）→ 那种地方只能靠 `confirmBtn.disabled`。转圈只给「点一下就关掉当前框、然后等着开下一个框」的场合（账号栏那几条「继续」）|
| 弹窗打开时页面内容 / 面板会横移几像素 | 滚动条一消失视口就变宽。`body` 的 padding 补不到 `position: fixed` 的遮罩 → `initScrollLock()` 得给遮罩也补一条 `padding-right` |
| 弹窗打开时页面内容 / 面板会横移几像素 | 滚动条一消失视口就变宽。**首选 `html { scrollbar-gutter: stable }`**（`main.css`，从源头不让它变宽，`body` 与 fixed 遮罩一起受益）；补 `padding-right` 是次选（`body` 的补不到 fixed 的遮罩）|
| 新加了一张 `page-*.css` 但某个页面上样式没生效 | 每页的 `<head>` 里都是手写的 `<link>`，没有自动注入 —— **加样式表要同时改 10 个页面**（index / login / stats / access-denied / profile / aceris / article / articles / chat / resource / terminal）|
| 首页那颗「简介」按钮去哪了 / 简介怎么打开 | 简介已从首页菜单搬进 `layout.js`（`INTRO_HTML` + `showIntro`，也挂在 `window.showIntro`），入口是页脚版权那行（`.site-footer-copy`，带 `role="button"`，回车/空格也认）。**全站每个页面都能点开**（用户 2026-09-28 定的）；字体样式一律不动，只加一条 `cursor: pointer` |
| 终端页的启动画面 / 闸门 / 面板世界 | 全在 `script/terminal.js`：进 `/terminal` 先建世界（背景格停在**最暗**那一帧）→ 启动层（透明空壳：图标 + 系统名 + 进度条）→ 加载期读 `/api/view-permissions` → 没权限就页内出闸门（`terminal.denied` 红字 + 纯白直角输入框）→ 收条后背景从最暗慢慢开始呼吸、面板层淡入。旋钮全在 `window.terminalTune`（`panelFloat` / `floatRange` / `lookEase` / `waveRamp` …）|
| 从终端页返回其它页，停在动画结束的黑屏上 | **bfcache**：上一页被整棵（含盖满屏幕的那层启动画面 `.term-boot-layer`）冻进往返缓存，后退回来原样恢复 → `pageshow` 里 `teardown()` 收掉（**按类名清**，别只删变量）|
| 三角网格看不出六边形 / 交界处全是 T 型接口 | 铺的行**没隔行错开半条边**（`off = (r & 1) ? side / 2 : 0`）。不错开时两行的顶点都落在整数倍边上，交点只有 3 个三角形 → 凑不出六边形（用户一眼就看出来了）|
| 想给弹窗加「背景不许滚」这类全局行为 | 同样盯遮罩的 `.show`：`ui.js` 的 `initScrollLock()` 用 MutationObserver 听它的 class（谁加的 `.show` 都管得着），别去那几十处开关里一处处改 |
| 要给「所有弹窗」一起加动效 / 调动画 | 全站弹窗**只有一个宿主**：`layout.js` 注入的 `#modal-overlay > .modal-panel`（`showMessage` / `confirmAction` / `showBusyModal` 与各页面的工作台、私信框都往里塞，开关统一是遮罩上的 `.show`）→ 写在 `.modal-panel` 这一层就全覆盖，别去每个 `show*()` 里挂 class。⚠️ 面板动画时长**别超过遮罩那条 `0.2s`**：`visibility` 一落回 `hidden`，比它慢的那段就看不见了（§14.54） |
| 某个弹窗要「锁住」（Esc / 点空白关不掉 + 关标签页提示） | 用 `lockModal()`（计数式，返回 `{ release }`）：**先 `release()` 再 `closeModal()`** —— 锁着时 `closeModal()` 是空操作（工作台就是这么处理的：所有关闭路径改走 `closeWorkbench()`）。走流程的弹窗直接 `confirmAction({ lock: true })`。⚠️⚠️ `lockModal()` 必须排在那句 `modalLocked = false`（新弹窗接管）**之后**，顺序反了等于没锁（§14.55） |
| Esc 关掉确认框后，`await confirmAction(...)` 再也没回来 | 已修（2026-09-18）：`closeModal()` 会先跑 `modalCloseHook`（confirmAction 注册的 `finish(false)`）→ 现在能拿到 `false`。自己写的弹窗别指望「关掉就不 resolve」 |
| 「打字确认 / 点两次」的按钮永远亮着（打错字也能点） | `actions` 模式下 `confirmBtn` **根本不进 DOM**，而门槛只写了 `confirmBtn.disabled` → 必须走 `refreshGates()`（同时管 `confirmBtn` 与 `actionButtons`）。⚠️ 默认只锁 `danger` 那一个（`actions[].gated` 可改）：「留下」这类退出动作不能被锁，否则人只能按 Esc 跑（§14.57） |
| 想加一门语言 / 改某句译文 | 词条在 `public/lang/<code>.jsonc`（**空值 = 退回中文**，可以写 `//` 注释）；页面挂 `data-i18n`（**有子元素的元素会被跳过**，头像按钮就靠这条保护），脚本里用 `I18N.t(key, 原文)`（三种写法：`t(key)` / `t(key,'原文')` / `t(key,{ value })` —— 第二个参数是对象就当 vars，那时中文只写在词条里、查不到会把 key 亮出来）；
    ⚠️ **一个完整句子 = 一个 key**：三元与 `x ? 'A' : 'B'` 这种条件拼接，**每一边各给一个 key**（别让译文去理解条件）；只有数据用 `{value}` 插进去，别把判断写进词条。加语言再去 `i18n.js` 的 `LANGS` 补一行。想知道「某句话在哪」，跑 `.wrangler/tools/i18n-scan.mjs` 看 `docs/文案清单.md` |
| 输入框的 placeholder / 按钮的 title 怎么翻 | 属性得用专门的 key：`data-i18n-placeholder`、`data-i18n-title`（这个会顺手把 `aria-label` 也换掉）。**JS 里动态设的分两种**：有元素就 `el.dataset.i18n = 'key'`（中文原文照样写进 `textContent` 当兜底，挂 key 的时机随便）；拼出来的一次性字符串（`confirmAction` 的 `fields[].placeholder`、Toast）用 `I18N.t('key', '原文')`；**句子带着数据**（`'已填入：' + label`）用占位符 `I18N.t('key', '已填入：{value}', { value })`（词条里写 `{value}`，漏传就原样留 `{value}`）。⚠️ **静态元素也能带数据**：`data-i18n-value="50"`（纯数字会转成 Number），词条 `"{value} 行"` 就画成「50 行」——`<option value="50" data-i18n="value.lines" data-i18n-value="50">` 就是这么用的（2026-09-22 加）。⚠️ 挂 key 的时机不用管先后了：`i18n.js` 的 MutationObserver 同时盯 childList 与这四个属性 |
| 在 zh-CN 里加了 / 删了 / 改了键名，别的语言包要跟上 | 跑 `public/lang/sync.py`（以 zh-CN 为骨架重建其它包）或 `npm run lang:sync`（没的补空串、多余的删掉、改名先往脚本的 `RENAMES` 追一行） |
| 部署了新语言包，线上还是旧译文 | 已经不会了：翻译台与 D1 覆盖值整套已删（2026-09-26），全站文案只读 `public/lang/*.jsonc`，文件改完部署即生效 |
| 发布/保存完一跳页就弹原生「确定要离开吗」 | 页面上还挂着「加载中」牌子（`showForaineToast` 不带 duration 就会拦关标签页）→ 跳转前收掉它：`coverAndGo` / `pageGoInstant` 已统一兜底（`window.__dismissForaineToast`），页面自己那条路（如发布成功）也该**先 close 再转场**。⚠️ 上传工作台那种 `lockModal()` 的锁**不能**一起收（那是有活在做，点导航就该拦） |
| `rate_limits` 越攼越多 / 能不能手动清 | 能清**已过期**的（零影响）；未过期的删了 = 那道限流额度立即回满。它不参与鉴权，清空也不会坏任何东西 |
| 「输入框默认 1 行、写多长多高」怎么都不生效（永远两行） | `autoGrowLines` 靠 `scrollHeight` 算高度，而 **textarea 的 `scrollHeight` 不会低于它自己 `rows` 的高度** → 不先 `el.rows = 1`，默认的 `rows=2` 就把结论钉死在 2 行 |
| 自己写的 `min-height: 0` / `margin-top: 0` 压不住弹窗里的输入框 | `main.css` 那条是 **`textarea.confirm-input`（0,1,1）**，`.ln-reason`（0,1,0）比不过 → 自己的类要连标签名一起写（`textarea.ln-reason`）|
| 某句文案在所有语言里都显示中文 | `I18N.t('key', '原文')` 的 key 拼错了（`lopt.review` 就是这么写错的）——**查不到就静默退回中文兜底**，不报错。改词条名时得同步改代码里的 key |
| 给一张卡片加 `hidden` 想「暂时下线」，没生效 | 那个类自带 `display: flex`（`.custom-card` 就是）→ 作者样式压过 UA 的 `[hidden] { display: none }`。得自己补一条 `#card-font[hidden] { display: none }`（先把属性加上，再补规则）|
| 邮箱验证码位数 / 敏感操作的身份验证 | 验证码全站统一 **6 位**。敏感操作（注销 / 重设密码 / 换绑邮箱）现在一律走 **一次性通行证**：`verifyIdentity` 验过后服务端发一张 `verify_pass`（5 分钟、用掉即删），调用方把它交给后端 —— **服务端只认这张票**。⚠️ 以前注销查的是 `purpose='delete'` 的码、而弹窗发的是 `'verify'`，导致邮箱那条路一直走不通（已修） |
| 语言包改名（`zh.jsonc` → `zh-CN.jsonc` 这种 BCP-47 风格）后全站文案退回原样 | `i18n.js` 的 `DEFAULT_LANG` **必须与文件名逐字一致**（它就是兜底包的名字）。改名忘改它 = 兜底包读空、`fallback` 也是空，所有 `t(key)` 返回 null，未挂 key 的字全停在硬编码那层 |
| 弹窗里的「取消 / 确认 / 此操作不可撤销」翻不了、代码里又找不到 | 这三句是**弹窗骨架的默认值**：住在 `ui.js` 的 `confirmAction` 里（`opt.cancel` / `opt.confirm` / `modal.warning.CannotbeUndone`），不在调用方的页面里 |
| 新加了一门语言 / 切了语言但整页还是中文（“没生效”） | ① 先看**线上文件到底在了没**：`/lang/<code>.jsonc` 拿到的可能是 SPA fallback 的 HTML，**状态码照样 200**；② `loadTable` 现在先判内容是不是 `{` 开头、失败还 `console.warn`（以前静默当空表，表现就是「整页中文」）；③ 新语言要同时有 `LANGS` 一行 + 同名 jsonc |
| 拿 `res.ok` 判断「这个静态文件在不在」 | 站点的 `not_found_handling` 是 SPA fallback —— **不存在的路径也回 200**（内容是一页 HTML）。要判在不在得看 `content-type` 或直接试着 `JSON.parse`（`i18n.js` 就是这么干的：解析失败就换下一个后缀） |
| 新插进 DOM 的元素挂 class 做进场动画，动画不播 | 它在加类之前从没被算过样式 → 两次样式被合成一次。读一下 `el.offsetWidth` 强制回流再挂类（灯箱就是这么修的）；`requestAnimationFrame` 在后台标签会被节流，切回前台就「瞬移」到位了（§14.55） |
| 文章里写的 `<censored>` / `<spoiler>` 之类整段没生效 | 这些标记在 `markdown.js` 的转义**之后**识别，源码里要写**真的尖括号**（不是 `&lt;`）；渲染成 `.md-*` 的样式住在 `page-article.css` → 不加载它的页面（首页、列表、评论）只剩无语义的壳 |
| `<secret>` 跨了空行 / 标题（开关标签独占一行），页面把 `<secret='…'>` 标签一起露出来 | 前端 `inlineMarkdown` 是**逐段**跑的，跨块的栅栏匹配不上 → `renderMarkdown` 在**分行之前**有一道 `SECRET_BLOCK_RE` 预扫（只处理内容带换行的那些，§14.73）。⚠️ 服务端 `filterSecrets` 本来就是整篇匹配，别去那边找 |
| 手机上页脚只到屏幕 2/3、下面一大片空白，首页图标上方那截留白也没了 | 浏览器的内核不认 `dvh`（如国产浏览器）：`--vh-full: 100dvh` 解析期合法、用在 `height: var(--vh-full)` 时才非法 → 按规范整条声明**无效即未设** → `height` 变 `auto`，**把上一条 `100vh` fallback 一起吃掉**。修法 = `@supports` 升级 + `core.js` 的 `syncVhFull()` 用 `innerHeight` 兜底（§14.74）|
| 终端页组件全挤到中间偏右下、文字互相压住、白输入框伸出屏幕右边 | 内核**不认 `translate` 这个独立属性**（Chromium < 104），而终端页整套居中全靠 `translate: -50% …`。修法 = `@supports not (translate: none)` 里用 `transform`/`margin` 重写一遍（§14.75 ①）。⚠️ 闸门/进度条要用 margin 不能 transform（敲错那下 `term-gate-shake` 动的就是 transform）|
| 终端页的六边形被「水平压缩」 | 面板宽高各自 `min(…, Nvw)` / `min(…, Nvh)` → 窄屏上宽度先被卡住。改成统一缩放 `--term-scale`（`syncTermScale()` 算，宽高都 `calc(260px * var(--term-scale))`，§14.75 ②）|
| 进 `/terminal` 时背景格又「从中心铺开」重播一遍 | 世界那层先画**一帧冻结的**背景（`draw(0)`），启动层是**透明空壳**，收条时不换 canvas 也不换页，直接接着那一帧呼吸（§14.81 ②）|
| 想改终端页的输入框 / 模态框 | 输入框只有一种形制：`.term-gate-field > .term-gate-input`（白六边形+黑字），别另造一套；模态框是 `.term-modal-back > .term-modal`（通栏亚克力横带，`width: 100%`，两栏/分割线正中），绿按钮 `.term-modal-btn`（§14.75 ④ / §14.76 ② / §14.77 ②）|
| 想给带 `clip-path` 的东西加发光/阴影 | `box-shadow` 会被 `clip-path` 一起剪掉 → 另起一层同形状的元素垫在底下 + `filter: blur()`（面板就是这么拆成 壳 / 光晕 / 里子 三层；`data-state` = 黑（未解锁）/ 白（可点）/ 紫（已完成），§14.77 ①）|| 想给 `clip-path` 的形状加一条**描边** | **别加** —— 试过（面板垫一层大 2px 的同形状色块当边 + 模态框直接 `border`），用户 2026-10-01 看过说「还不如之前好看」，已整块撤回。技术上也不顺：`border` 会被整条剪掉（六边形的边界在盒子内部，盒子的四条边全落在六边形**外面**），只能靠「大一圈的色块垫底」（§14.80 ③）|| 导航栏头像每次进新页面都「先闪一下登录再变头像」 | `/api/me` 是异步的，而会话 cookie 是 HttpOnly（前端读不到）→ `core.js` 的 `USER_CACHE_KEY`（localStorage 存一份精简 user）先把头像画出来，接口回来再校正（§14.78 ④）|
| terminal 的输入框 / 模态框细节 | 输入框的说明一律是左上角那行小灰字（`.term-field > .term-field-label`，`terminal.needKey`），**不要 placeholder**；模态框两栏是 **3:5 用 `width: calc(...)` 而不是 `flex`**（flex 会把内边距先扣掉，比例就不准了），分割线是**右栏的 `::before`**（高度拉伸到较高那一栏 + 两头渐隐 mask），关闭要先摘 `.is-in` 再延时 420ms 摘节点（§14.78 ② / §14.81 ⑨）|
| 想加一个新的终端权限阶段 | 小面板 = `data-slot="几钟方向"` + `term-panel-tier` + 一行 `.term-panel-name`（阶段名是**专有名词，别挂 i18n**）+ `data-attribute="foraine.xxx"`（持有这个属性 = 已完成）；答案走 `secret` 表，解锁靠 `/api/terminal/iota` 那套（GET 问状态 / POST 校验并发属性）。⚠️ 面板状态**全由加载期那次 `/api/view-permissions` 说了算**，别再用 localStorage（§14.81 ④）|
| 终端面板的状态不对（没权限却紫色已解锁 / 有权限却黑的） | 看每块面板的 `data-attribute` 与 `applyPermissions()`（terminal.js）；权威是 `view_permission` 表，前端只读 |
| 文章卡 / 子节点被锁死点不开 | 那是**故意的**：说明书页 2 的两张卡是 Iota 的子节点（`data-parent="0,1"`），**父节点没「完成」就锁**（`applyChildStates()`）。⚠️ 「解锁」(active) 与「完成」(done) 是两回事（§14.82 ⑤） |
| 父子之间那根白线的颜色 / 它飘在形状外面 | 颜色三档：**父没完成 = 灰 / 父完成 = 白 / 父子全完成 = 紫**；端点要**每帧**按两块当前位置重算（`paintLinks()` 挂在 `applyLook()` 里，别只在布局时算一次）|
| 线的一头缩到卡片中心、另一头到卡片外面 | 端点**不能用支撑函数**算（它给的是顶点投影的最大值，只有中心对称的形状才等于边界距离）→ 用 `polyRay()` 射线求交（§14.83 ②）|
| 想给终端页加新的父子连线 | 子元素上写 `data-parent="<父的 data-cell>"`，父/子各有一块 slot（`{el,x,y,radius,w,h,fx,fy}`）；父用 `HEX_PTS`、子用 `CARD_PTS` 交给 `polyRay()` 求边界点 |
| 文章卡/面板的「完成」怎么算 | `nodeDone()`：面板 = 持有自己那条属性；卡片这类没属性的节点 = **子节点全完成，没子节点算默认完成**（`applyChildStates()` 用的就是它，§14.83 ④）|
| 终端页面板像玻璃纸 / 网格线从面板中间穿过去 | 那个内核**没有 backdrop-filter**（亚克力滤不出东西）→ `page-terminal.css` 末尾的降级块会把面板换成接近实心的底色；本地复现手法：注入 `*{backdrop-filter:none!important}` 就能看到一模一样的效果（§14.86）|
| 新加了一块「亚克力」表面，怕旧内核上又透 | 压在**网格 / 图片**这种花哨背景上的才需要兜底：在那个页面的 CSS 末尾加一个 `@supports not ((backdrop-filter:...) or (-webkit-backdrop-filter:...))` 块，把底色换成接近实心；跑 `npm run check:compat` 确认没有没兜底的致命写法 |
| 想知道哪些写法在旧内核上会翻车 | `npm run check:compat`（致命项：`translate:` 属性、`dvh` 没配 `vh` 兜底；警告项：`backdrop-filter` / `:has()` / `color-mix()` 之类）|
| 文章里写 `<view user>` 之类不生效 / 显示 `unknown` | 它是**客户端**渲染的，页面要先 `setViewContext({user,nickname,permissions,time})`（拿到 `/api/me` 之后）；没填就是 unknown / 权限 null。文章页 / 列表页 / 个人页 / 终端页四处都填了（§14.87 ①）|
| 标题或简介里写了 `<secret>` / `<zwsp>` / `<font XNS>` 没生效，标签还露出来了 | **故意的**：标题/简介走 `inlinePlain()`，这三样一律不解析（secret 在标题里会漏给所有人 / 零宽看不见 / font 那支子集 1.4MB）。原样留着是为了让作者看见写错了（§14.87 ②）|
| 新加一种行内标记，正文生效但标题/简介里没样式 | 行内样式的作用域要**同时写上** `.article-body` / `.article-title` / `.article-intro` / `.article-summary`（`page-article.css`）；⚠️ 别用 `:is()` 合并 —— 老内核会整条选择器失效，正文一起丢样式 |
| 草稿 / 叙述别人打不开 | 故意的：`handleGetArticle` 只给作者（连 `article.review` 都不放行），别人拿 404，前端 `loadArticle` 就地把人送到 `access-denied.html?reason=404`。⚠️ 但**作者自己的作品栏要看得见**：`/api/my/articles` 不加 narra 过滤、带 `narra` 标记（打「叙述」徽章），只是**对外**（公开主页 `/api/user?username=` + 用户目录的 `article_count` + `sitemap.xml`）收掉（§14.88 ②③）|
| 想验「公开主页有没有藏叙述」，拿 `/api/user/articles` 去 fetch | **站上没有这个路由**（回 `{"error":"Not Found"}`，看着像「列表是空的」）→ 公开主页其实是 `GET /api/user?username=xxx` 的 `articles` 字段（`profile.html` 的 `loadPublicProfile`）|
| 个人页那排卡片被同一行最高的撑高 / 有空洞 | 作品栏是**瀑布流**：`layoutCardColumns()` 按「当前最矮的那一列」依次放卡片，列宽/列数与旧网格同一档。⚠️ 函数幂等（先拆回再分）；⚠️ 藏着的栏 `clientWidth` 是 0，所以切到「作品」时与窗口 resize（120ms 防抖）都要重跑（§14.88 ④）|
| 叙述的详情页 / 编辑器冒出「已发布」 | 叙述没有发布这个状态：保存提示语是 `narraMode || wasPublished ? '已保存' : '已发布'`（§14.88 ①）|
| 叙述的阅读页背景 / 那一行小灰斜体 | 阅读页与编辑页**共用** `body.page-narra` + `startNarraBackground()`（阅读那条路在 `loadArticle` 里起，**别调 `applyNarraMode()`** —— 它会去动编辑器才有的元素）；`#article-intro` 那一行在叙述上摆的是 `GET /api/article` 回的 `quotekey`（不加引号）（§14.89）|
| 某行字选不中（想让人复制） | 全站默认 `body { user-select: none }`（`main.css`，防左侧出现光标）→ 要显式开回来（`.article-body` 就有，`.article-intro` 当初没写）。叙述那行 QuoteKey 现在是 `body.page-narra .article-view .article-intro { user-select: text; cursor: text }`（§14.89 ③）|
| 想挪启动画面（图标 / 系统名 / 进度条 / 闸门）的纵向位置 | 四块都是绝对定位 + `translate`，位置全挂 `.term-boot` 的 `--boot-*-y` → 只动**一个** `--boot-shift`（当前 18.5px = 让「图标与系统名之间那道缝的中点」落在画面正中）。⚠️ 老内核那条 `@supports not (translate: none)` 降级块共用同一组变量，别只改一边（§14.90）|
| 叙述文章下面怎么没有评论区 | 故意的：详情页整块 `#comment-section` 不出现（`loadComments()` 里 `narra` 直接 hidden），服务端也拦（`POST /api/comments` 对 narra 回 403）—— 改一边不够（§14.84 ②）|
| 终端文章模态框里的正文颜色 | `.term-article-md` = 纯白 + 白色发光（与模态框标题同一套 `text-shadow`，会继承到标题/引用/行内代码）|
| 终端文章模态框窄屏的那颗圆按钮 / 抽屉 | `.term-article-toggle`（灰色亚克力圆钮 + 标签图标）+ `.term-article-drawer` / `.term-article-shade`（带模糊的遮罩）；两份列表（左栏 + 抽屉）都在 DOM 里，`showArticle()` 同步高亮时要**查 `back`**（抽屉挂在 back 上，查 `modal` 会漏，§14.85）|
| 想在个性化里加一张开关卡 / 它 `hidden` 了却还在 | 卡默认加 `hidden`，但 **`.ctx-card` / `.custom-card` 自带 `display: flex` 会压过 `[hidden]`** → 必须自己补一条 `#你的id[hidden] { display: none }`；权限判定读 `/api/me` 的 `permissions` |
| 想给终端页加新的父子连线 | 子元素上写 `data-parent="<父的 data-cell>"`，父/子各有一块 slot（`{el,x,y,radius,w,h,fx,fy}`）；父用 `hexSupport`、子用 `polySupport(w,h,CARD_PTS,…)` 求边界支撑点 |
| 终端页的线 / 卡片端点算不准 | SVG 那层 `.term-links` 是 ±2000 的大方块，坐标统一加 2000 偏移；形状的边界要用终端页自己的 `polyRay()`（`HEX_PTS` / `CARD_PTS` 与 CSS 的 `clip-path` 同一套顶点），别按矩形算 |
| 想调终端面板的浮动（鼠标靠近推开的幅度/距离） | `TUNE.panelFloat`（默认 10px）与 `TUNE.floatRange`（默认 180px，量到**面板边缘**）；方向固定是**背离指针**，超出触发距离一点不动。⚠️ 每块**各自**算（`--fx/--fy`），别改回整层挪（§14.81 ⑦）|
| 首页那颗终端图标原来那趟网格过场去哪了 | **没删, 别删**：用户 2026-10-01 明确要的就是它（「点击终端按钮触发三段式的转场，而不是全站通用的圆形黑色转场」）—— `openingTerminal('/terminal/')`（黑面板铺满 → 变深紫 → 紫涟漪沉黑 → 全黑换页），调参在 `TUNE` 的 `reveal*` / `shift*` / `glow*` / `ring*`（§14.82 ①）|
| 用户说「点击终端还有旧过场动画，请修复」 | ⚠️ **先问清他指的是哪一个** —— 这趟三段式就是他要的（下面那条）；他自己也可能把「全站圆形转场」当成过场（那颗按钮走的是 `pageTransitionTo`/`pageGoInstant` 的话一定是他看错了）|
| 想加一类「不进公开列表」的文章 | 照「叙述」办：`articles.narra = 1` + `article_quotekey`（键名与文章一对一）+ 列表加 `AND narra = 0`；编辑页靠 `GET /api/article` 回的 `narra` 进叙述模式（藏简介/标签/缩进/Md 规则, 只留一个「保存」, 背景换 `grid-bg.js` 的呼吸网格）（§14.82 ③）|
| 叙述的键名规矩与创建时机 | `[a-z0-9.-]{3,40}` 小写化；`POST /api/articles/narra` **创建即占位**（建空叙述 + 写键名行），权限 `article.narra`（站长）；键名撞了回 409, 前端用 `onConfirm` 返回 false 留在弹窗里让人改。⚠️ `confirmAction` 带 `fields` 时 **resolve 出来的是 `true`**，取值要用 `onConfirm(values)` |
| 终端那张平行四边形文章卡 | Iota 面板 11 点 / 1 点方向、边缘净距 30px、大小是 Iota 卡的 1/2（`.term-card`，两张同向斜）；`data-key` = `terminal.iota.left-1` / `right-1`，对应关系在 `terminal_article_redirect(key, quotekey)`（复合主键 = 一个面板挂多篇 = 文章集）。内容**加载期一次拿完**（`GET /api/terminal/articles`），点开左列卡片 / 右列正文，查不到就红字「终端查询错误」（§14.82 ④）|
| `secret` 表想存 NULL | 老库的 `"value"` 是 `NOT NULL`，SQLite 改不了约束 → 重建表再搬（SQL 写在 `schema.sql` 注释里，`.wrangler/tools/secret-nullable.sql` 是现成的一份）（§14.79 ③）|
| 给弹窗做「高度从 0 长出来」的展开动画 | 别用「先量高度再写 `max-height`」：量的时候内边距会被压没、量出来偏小 → 用 `display: grid; grid-template-rows: 0fr → 1fr` + 内层 `min-height: 0; overflow: hidden`，padding 一起过渡（§14.77 ②）|
| 手机上那块「Foraine」牌子（foraine-toast）被吸顶导航栏压住 | 窄屏它挪在右上角，`top` 要**让开导航栏**：`calc(var(--sp-8) + 63px + var(--sp-2))` —— 那 63px 是窄屏的 `--nav-h`（写死的，它定义在 `.site-bar` 上取不到，改导航栏高度要一起改，§14.76 ①）|
| `<gradient>` 的颜色写坏了，整段连标签一起露出来 | 故意的（跟 `<secret>` 语法错一个态度：让作者看见自己写错了）。合法写法 `<gradient=#abc>…</gradient=#def>`，**不加引号**、两端颜色都能省（省了 = `currentColor`） |
| `<secret='…'>` 里藏的正文被读者看见 / 编辑一次就没了 | 服务端过滤（`src/view-permission.js`）：不满足 → 整段空、语法错 → 原样露出、**作者自己永不过滤**（否则编辑保存就把藏的正文真删了）。⚠️ 条件语法前端 `secretExprLooksValid` 与后端 `evalSecretExpr` 必须一致 |
| 想给某人开一条 `<secret>` 权限 | 现在**没法开**：只有 `view_permission` 表 + `GET /api/view-permissions`，没有写入的界面（用户当时选的「先只做表 + 读接口」）。权限名册（`secret_permission`）倒是自动维护了 —— 保存文章时把点名过的权限登记进去 |
| 作者自己也看不见自己藏的那段 | 故意的（用户 2026-09-28 定的）：详情页人人按同一套票判；**只有编辑器那条路带 `&raw=1`** 才给原样正文（不带上它，一保存就把藏着的段落真删了） |

---

## 10. 未来工作

### 用户点名过、还没做的

1. **资源中心** —— 第一版已上线（2026-09-16，列表 / 搜索 / 类型与上传者筛选 / 详情 / 上传弹窗 /
   浏览器端 SHA-256 / 删除三条分支，见 `docs/style-guide.md` §14.31）。**还差**：
   * 细粒度权限（`resource.upload` 之类）—— 等「角色可自定义」那一轮，现在按现有角色硬判；
   * 窄屏右栏只有「类型」抽屉，「上传者 / 存储统计」两块还没搬过去；
   * 「防白嫖」的两层（2026-09-16 已上线）：桶级 Referer 白名单（用户自己配的）+ 每个文件/整组的**防盗开关**
     （对象 ACL 设 `private` + 下载接口校验站内 Referer，空 Referer 拦死）。还没配的是 CF 规则。
   * **多文件上传工作台**（2026-09-16 已上线，见 `docs/style-guide.md` §14.35）：左文件队列（可拖动排序、逐个移除）/ 右拖选框 + 组标题 + 组简介 + 选中文件的标题简介，
     串行上传 + 逐文件进度，`确认上传` 再弹一次确认；失败的留在队列里可重试。
   * 直传那条路的已知窟窿：浏览器 PUT 失败或用户关标签时**登记行没人回滚**（`handlers/resource.js` 里注了）。
2. **论坛** —— 表、接口、三栏 UI 都通了（建话题/回帖/Markdown/防刷），但用户明说「**刚建问题有点多，先不修**」。
   要动手的话先跟他确认哪里最痛（他自己发现的问题都还没说）。
3. **私信「本地当唯一真相 + 对账」** —— 他提过用 IndexedDB 做 outbox（离线也能发、联网后对账）。
   现在的乐观发送只是「先上屏再补」，刷新/断网就丢。**这是消息可靠性的下一步。**
4. **资源/表情/聊天图的老对象治理** —— 老对象没有 immutable 缓存头（要 CopyObject 重写）；
   删文章不删图（桶里会攒孤儿）；`resource` 到期有 cron 清，但引用不到的 `img/` 还没有常规巡检。

### 值得主动提议的

* **性能**：`public/assets/Image` 还有 7.5MB 的大图（`Forest.jpg` 1.87MB 等）没转 WebP；
  装饰字体仍在用（243KB 子集已经很小，但可以把首页那几处换成 SVG 描边）。
* **私信**：已读回执、消息搜索、表情面板分类/最近使用、发「资源中心」的文件（和 1 连着）、
  「对方正在输入」、按会话独立的未读定位。
* **文章**：草稿自动保存（现在离开就丢）、修订历史、列表搜索（`?q=` 接口还在，UI 被删了）。
* **站内信**：用户之间互发（现在是只读通知）。
* **可访问性/移动端**：`≤900` 的适配是逐页补的，可以回头统一一遍。
* **测试**：`tests/` 里只有 markdown 与星历历法回归 48 项；聊天 body 解析、限流、权限判定都值得补纯函数级用例。

### 已经删掉、**别复活**的东西

气泡尾巴、评论撤回、预览权限（viewAs / 角色切换按钮）、首页「最近更新」、文章列表搜索栏、
评论「回复」的第二输入框、`.chat-attach` 的桌面浮层（窄屏改成静态）、
**翻译台（`/lang.html` + `lang-console.js` + `page-lang.css` + `handlers/lang.js` + `src/lang-sig.js`
与 D1 那三张表，2026-09-26 整块移除；i18n 本身保留，词条只读 `public/lang/*.jsonc`）**。

---

## 11. 悬空事项（等用户/线上确认）

* **星历（`/aceris/`）第二轮要做的事**：① 事件 / 纪念日落库（用户已选「登录用户可添加」；
  要新表 + 接口 + 那一天的详情面板）；② 月名是否逐年不同（他给的那张表标了「（2历）」）；
  ③ 一历正月之前的年份怎么显示（现在直接禁用往前的翻月）。
* 论坛的「问题有点多」—— 等他列出来。
* **终端页（`/terminal`）** —— 骨架已升级成「世界」（2026-09-29，§14.71 / §14.72）：常驻三角网格**拖着走**
  （带惯性 + 边界，边界随内容外扩）、上层是面板层（黑色亚克力六边形 + 暗条纹，鼠标视差）。
  0,0 那块放终端图标（点它回首页）；0,1 那块是一半大小的六边形，里面一把钥匙 —— 点开是**六角星亚克力模态框**
  （题干 `terminal.accesskey-verfly.iota` + 输入框，答案走 D1 那张 `secret` 表，答对只变绿合上）。
  ⚠️ **「解密逻辑」用户还没想好**（他自己说的「先写个键」）——等他给；终端里的其它内容、「新增 UI 样式 /
  新增模态框样式」也同样等他说（他每轮只说一点点，做完再问下一步）。
* `resource` 桶的 CORS 已配好、196MB 直传 + 下载已实测通过（这条可以打勾了）。
* `public/assets/Image` 的瘦身他还没拍板（转 WebP 会不会丢他喜欢的质感，要他看过才知道）。

---

## 12. 接到新需求时的建议流程

1. 先 `npm test` 看基线（应当 48 绿）。
2. 需求里凡是涉及**样式**的，先去 `docs/style-guide.md` 搜有没有相关章节（§14 全是「为什么这么写」，能省掉很多返工）。
3. 涉及**数据/存储**的，先确认「本地能不能验」（大概率不能 → 说清楚线上怎么验）。
4. 改完：**后端改 `src/` 后先 `node build.mjs`**；`node --check worker.js`（生成物）/ `check-inline-js.mjs`（HTML 内联）→ `npm test` → 本地浏览器验（能验的都验）→ `npx wrangler deploy` → 记版本号。
5. 线上验证：`curl.exe -s https://foraine.xyz/xxx.js | Select-String 特征串` 确认新文件真的上线了
   （⚠️ 特征串尽量挑 **ASCII** 的；要验中文见 §1 的那条坑，用 node 抓）。
6. **清理**：本地测试数据（`devlocal-%` 会话、测试聊天/表情行）、线上探针账号与临时对象。
7. 更新 `docs/style-guide.md`（新的一条 §14.x）与 `/memories/repo/foraine-project.md`（新的一条「续 N」），
   再简短汇报给用户。

---

## 13. 文案规范（2026-09-17 用户定；改任何「给用户看的字」之前先读这条）

> 用户原话：「网页的文本里不要写口水话！」「凡是给用户看的要专业一点！不能太有AI味」
> 他把这套规矩**只用在功能面**：报错 / Toast / 确认框 / 空状态 / 邮件。氛围面（见白名单）一律不动。

### 13.1 语域分界线（最重要的一条）
这个站有**两副面孔**，改稿前先判断这段文字属于哪一边：

| | 功能面（要专业） | 氛围面（白名单，逐字节不动） |
| --- | --- | --- |
| 出现在 | API 报错、Toast、确认框、空状态、邮件 | 加载语、404 页、雨声开关、站点自我描述 |
| 语气 | 结论先行、动词开头、两句以内 | 星空设定、拖音 `..`、语气词都留着 |
| 例子 | 「上传失败，请稍后再试」 | 「直达星辰..」「你所访问的页面迷失于星海中了..」 |

⚠️ **白名单**（写在 `.wrangler/tools/check-copy.mjs` 的 `WHITELIST` / `KEEP` 里，改它们等于改错）：
`直达星辰..`、`你所访问的页面迷失于星海中了..`、`下雨了..`、`雨要停了呢..`、`没找到东西呐..`、
`都说了是在建了...`、`有待星空来填充此地`、`其实是Raincat懒得做适配（`、`一片虚空`；
以及**用户自己写的两条**：`还没有人评论，来说两句吧。` 与两条删除确认
（`警告：组内的文件会被悉数删除…`、`文件记录与云端对象会被删除…`）——他说了不改。
`写点什么呐..？` 也是他亲自定的。

### 13.2 硬约束（功能面）
1. **不许有语气词结尾**：吧 / 嘛 / 呢 / 呐 / 啦。
2. **不许有口语动词**：「先删几张」「先写点什么」「试试点这里」「找个人聊两句」→ 改成「发生什么 + 怎么办」。
3. **不许有催促/恫吓口吻**：「请注意！」「警告：」→ 直接陈述事实（「保存后不可修改」）。
4. **人称统一「你」**（邮件也一样）。存量里混过「您」，别再让它回来。
5. **标点**：中文串里不许用半角逗号 / 问号 / 感叹号（`X失败, 请稍后再试` → `X失败，请稍后再试`）。
   ⚠️ 但 `..` / `~` / 少量 `！` 是**用户特意定的符号风格**，功能面里也别擅自统一成「……」
   （他 2026-09-17 明确选了「保留这套符号风格」）。
6. **频率类文案统一成**「XX 过于频繁，请 X 后再试」（不要「说得有点快」这种）。
7. 只改**措辞**：不动语义、不动 DOM/CSS/接口字段、不动 localStorage key 与枚举值。
   与文案耦合的逻辑要一起改（如 `requireText: 'RaincatNya'`）。

### 13.3 自检
```powershell
node .wrangler/tools/check-copy.mjs     # 退出码非 0 = 还有违规，逐条改掉
```
它只看功能面那几个槽位（`error:` / `showToast(` / `showMessage(` / `emptyState(` / `title:` / `text:` /
`message:` / `tip:` / `warning:`），白名单与「用户自己写的」会跳过 —— 要加规则就同时改脚本与本节。

---

## 14. 注释规范（2026-09-18 用户定；范本 = `public/script/header.js`）

> 用户原话：「我刚刚修改了一个文件的注释，请你照着我注释的样子，修改全站文件的注释」。
> **范本就是他自己改过的那份 `header.js`** —— 拿不准就去看它，别凭印象写。

一条注释 = **一行** = 「这是什么 / 干什么」。**不写**：日期、「用户 2026-09-xx 第 N 条」、
⚠️ 警告、多段成因分析、历史故事、复述代码。理由可以留，但要压成括号里一句：
`// 首页不显示; 移动端不显示 (按钮会把导航栏撑爆)`。

写法（照抄范本）：

* **文件头**：`/* Header.js 导航栏 */`，紧跟一个区块：
  ```
  /*
    内容: 图标 站名 / 资源 / 文章 / 聊天 / [用户头像/登录]
    依赖: core.js(getCurrentUser) / transition.js(pageTransitionTo)
  */
  ```
* **分区标题**用名词短语：`/* 资源按钮 */`、`/* 外框 */`、`/* 返回按钮 */`。
* **函数**：`// 设定文字按钮`、`/* func设定头像 */`；异步函数标 `asyfunc`
  （`/* asyfunc 跳转页面 */` 或 `// asyfunc: go验证 - 如果钩子返回false则拦截redirect`）。
* **标点**：中文注释里用半角逗号 `,`、半角冒号 `: `，句末不加句号；不复述代码；不要 Emoji。
* **深坑与历史教训不写在代码里** —— 它们归 `docs/style-guide.md` 的 §14.x 与本文件的速查表（§9）。

⚠️ 改注释时**别顺手改代码**。守门员：`node .wrangler/tools/annot-drift.mjs` ——
它把 `.wrangler/annot-backup/` 里那份基线与当前文件都「抹掉注释」再逐行比，
退出码非 0 就是注释之外也被动了（`--verbose` 会指出第几行）。
改之前先备份要动的文件：

```powershell
# 全量备份（60 个 js/css/html，只留最近一次的基线，别提交它）
foreach ($f in (Get-ChildItem -Recurse public,src -Include *.js,*.css,*.html -File)) {
  $rel = $f.FullName.Substring((Get-Location).Path.Length + 1)
  New-Item -ItemType Directory -Force -Path (Split-Path (Join-Path ".wrangler/annot-backup" $rel)) | Out-Null
  Copy-Item $f.FullName (Join-Path ".wrangler/annot-backup" $rel)
}
node .wrangler/tools/annot-drift.mjs     # 改完跑，应为 0
```

配合 `node --check <file>`（js）与 `check-inline-js.mjs`（HTML 内联脚本）一起验收。
