-- Foraine D1 数据库表结构
-- 本地: npx wrangler d1 execute foraine-db --local --file=schema.sql
-- 线上: npx wrangler d1 execute foraine-db --remote --file=schema.sql

-- 自建的 visit_logs 已删除: 统计改用 Cloudflare 站级分析 (httpRequests1dGroups 的 uniq/uniques),
-- 不再自己写访问日志。存量库清理 (先导出备份):
--   DROP TABLE IF EXISTS visit_logs;

-- 用户 (登录凭证 + 角色)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL, 
  email         TEXT,
  github_id     TEXT,                 -- GitHub 数字 ID (OAuth 登录/绑定时写入, 未绑定为 NULL)
  github_login  TEXT,                 -- GitHub 用户名 (仅展示用)
  role          TEXT NOT NULL DEFAULT 'user',   -- 指向 roles.name ('owner' | 'admin' | 'user')
  last_login_at INTEGER,              -- 最后一次登录 (ms) —— 资料卡片上的「最后登录时间」
  created_at    INTEGER
);

-- last_login_at 是后加的列 (缺列时资料卡片不显示那行, 代码里带降级):
--   ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- email_verified 是后加的列, 存量库要手动补一次 (缺列时代码会降级成「未验证」):
--   ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- 注销申请: 点注销只是打标记, 账号至少再留 7 天 (期间可以取消), 到期由 cron 真删。
-- 存量库要手动补两列:
--   ALTER TABLE users ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE users ADD COLUMN deleted_at INTEGER;   -- 申请时刻 (ms), cron 拿它算 7 天
-- 缺列时代码一律当「没在注销中」(loadPendingDeletion 里 try/catch 降级)。

-- 「取消注销」的时刻 (ms): 取消之后 7 天内不允许再申请注销 (个人页那个按钮变灰), 缺列当没有:
--   ALTER TABLE users ADD COLUMN delete_cancelled_at INTEGER;

-- 用户名一律小写 + 大小写不敏感的唯一。顺序不能反: 先把存量数据转小写、再建表达式唯一索引,
-- 否则 RainCatNya 与 raincatnya 会被当成两个号:
--   UPDATE users SET username = LOWER(username) WHERE username <> LOWER(username);
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(LOWER(username));
-- 原来的 UNIQUE(username) 仍然保留; 代码里按用户名查的地方一律写成 LOWER(username) = LOWER(?).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(LOWER(username));

-- ==================== 资源分组 ====================
-- 「一次上传 = 一个组, 组里可以有多个文件」(用户 2026-09-16 定的形制)。
-- 资源中心的一张卡片 = 一个组; 点进去每个文件各占一个面板 (各自的标题 / 简介 / 校验值 / 下载)。
--
-- 为什么另开一张表而不是给 resource 加几列: 组有自己的标题与简介 (与文件那两个是不同的东西),
-- 还有「防盗」这种组级开关, 塞进 resource 就变成一组 N 行重复记同一件事。
--
-- key 是对象名里的那一截目录名 (res/<用户名>/<key>/<序号>-<slug>.<ext>)。
-- ⚠️ 它必须在「登记行」之前就定下来 —— 我们的规矩是先登记再 PUT, 所以对象名要先生成,
--    不能用自增的 id 当目录名。
CREATE TABLE IF NOT EXISTS resource_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,               -- 对象名里的目录名 (随机串, 不带斜杠)
  title       TEXT,                        -- 组标题 (空则前端退回「第一个文件名」)
  description TEXT,
  uploader_id INTEGER,
  expires_at  INTEGER,                     -- 整组的有效期 ms; NULL = 永久 (文件行上那份是权威, 这里只作展示与批量改)
  guard       INTEGER NOT NULL DEFAULT 0,  -- 1 = 整组防盗（对象设私有 + 下载只认站内 Referer）; 见 resource.guard
  allow_edit  INTEGER NOT NULL DEFAULT 0,  -- 1 = 允许其他人编辑这一组（用户 2026-09-17）; 门槛 = 已登录 + 邮箱已验证, 看自觉
  notify_stage INTEGER NOT NULL DEFAULT 0, -- 大流量上传通知到哪一档了（0 未通知 / 2 已通知 2GB 档 / 5 已通知 5GB 档）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resource_group_uploader ON resource_group (uploader_id, id);

-- 存量库要手动补这张表 (CREATE TABLE IF NOT EXISTS 会在下一次跑本文件时自动建好, 不用手敲);
-- 另外 resource 要补三列:
--   ALTER TABLE resource ADD COLUMN group_id INTEGER;
--   ALTER TABLE resource ADD COLUMN seq INTEGER;
--   ALTER TABLE resource ADD COLUMN guard INTEGER;   -- NULL = 跟组的开关走
-- 还有 resource_group 要补一列（「允许其他人编辑」, 2026-09-17）:
--   ALTER TABLE resource_group ADD COLUMN allow_edit INTEGER NOT NULL DEFAULT 0;
-- 以及 resource 再补一列（SHA-1, 2026-09-17）:
--   ALTER TABLE resource ADD COLUMN sha1 TEXT;
-- resource_group 再补一列（大流量通知的进度, 2026-09-17）:
--   ALTER TABLE resource_group ADD COLUMN notify_stage INTEGER NOT NULL DEFAULT 0;
-- ⚠️ 加列之前上传的资源 group_id 是 NULL: 代码里一律把这种行当成「只有一个文件的组」
--    (列表用 COALESCE(group_id, -id) 当分组键, 详情支持用老的行 id 打开), 所以不用数据迁移。

-- ==================== 资源登记表 ====================
-- 桶 foraine-resource (对外 res.foraine.xyz) 里那些文件的「账本」。
-- 顺序不能反: handleResourceUpload 先 INSERT 这一行、再 PUT 字节, 传挂了就把行删掉
-- (别留「有记录没对象」的空条目)。过期清理走 cron (`purgeExpiredResources`, 跟注销清理
-- 同一趟), 连对象带记录一起删; 想给某个资源续期就自己改 expires_at (NULL = 永不过期)。
--
-- scope 是这张表的分水岭 (2026-09-16 资源中心开工时加的):
--   'chat'    = 私聊附件。默认 7 天, 到期对象与行一起清掉, 永远不进资源中心。
--   'library' = 资源中心的资源。默认永久 (expires_at = NULL), 会出现在 /api/resources 里。
-- ⚠️ 不能让 /api/resources 直接 SELECT 全表: 私聊里发的文件会被摆到公开列表上。
-- ⚠️ 也别拿 expires_at IS NULL 当「这是公开的」用 —— 它是对象寿命, 不是可见性。
--
-- 存量库要手动补五列 (CREATE TABLE IF NOT EXISTS 对已经存在的表不动手):
--   ALTER TABLE resource ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat';
--   ALTER TABLE resource ADD COLUMN title TEXT;
--   ALTER TABLE resource ADD COLUMN description TEXT;
--   ALTER TABLE resource ADD COLUMN sha256 TEXT;
--   ALTER TABLE resource ADD COLUMN md5 TEXT;      -- 服务端校验值 (OSS 的 ETag)
--   CREATE INDEX IF NOT EXISTS idx_resource_scope ON resource (scope, id);
-- 默认 'chat' 是刻意的: 加列之前上传的全是私聊附件, 一个都不该冒到资源中心去。
CREATE TABLE IF NOT EXISTS resource (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,          -- 原始文件名 (展示给用户看的就是它)
  object_key  TEXT NOT NULL,          -- 桶里的对象名 res/<用户名>/<组key>/<序号>-<slug>.<ext> (老对象是 res/<用户名>/<时间戳36>-<随机>.<ext>)
  size        INTEGER,                -- 字节
  mime        TEXT,                   -- 上传时的 Content-Type
  uploader_id INTEGER,                -- 谁传的 (站长手敲 SQL 时可以不填)
  expires_at  INTEGER,                -- 过期时间 ms; NULL = 永不过期
  created_at  INTEGER NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'chat', -- 'chat' 私聊附件 / 'library' 资源中心
  title       TEXT,                   -- 资源中心用的标题 (空则退回 name)
  description TEXT,                   -- 资源中心用的简介
  sha256      TEXT,                   -- 上传端算的校验值 (小写十六进制, 可空)
  sha1        TEXT,                   -- 上传端算的 SHA-1 (用户 2026-09-17 要求补的; 与 sha256 同一次读字节算出)
  md5         TEXT,                   -- 服务端校验值: OSS 单次 PUT 回来的 ETag 就是内容的 MD5
  group_id    INTEGER,                -- 属于哪个组 (resource_group.id); NULL = 老行, 当成只有一个文件的组
  seq         INTEGER,                -- 组内排序 (上传顺序, 从 1 开始)
  guard       INTEGER                 -- 1 = 防盗 / 0 = 强制不防盗 / NULL = 跟组的开关走 (见 handlers/resource.js)
);
CREATE INDEX IF NOT EXISTS idx_resource_expires ON resource (expires_at);
CREATE INDEX IF NOT EXISTS idx_resource_scope ON resource (scope, id);

-- 聊天图的「账本」: 聊天图要登记 + 默认留 7 天, 到期由 cron (`purgeExpiredImages`) 连对象带记录删掉。
--   对象名 img/user/<用户名>/chat/<时间戳36>-<随机> (无扩展名)。
--   头像 / 配图 / 表情 / 背景都不进这张表 (要么永久, 要么由引用关系决定生死)。
CREATE TABLE IF NOT EXISTS stored_image (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL,           -- 桶里的对象名
  url        TEXT NOT NULL,           -- 对外地址 (清引用时按它做前缀匹配)
  user_id    INTEGER,                 -- 谁传的
  kind       TEXT NOT NULL DEFAULT 'chat',
  expires_at INTEGER,                 -- 过期时间 ms; NULL = 永不过期
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stored_image_expires ON stored_image (expires_at);

-- 敏感操作的一次性通行证: 验证身份通过后发一张, 5 分钟有效, 用掉即删。
-- 注销 / 重设密码 / 换绑邮箱都靠它 —— 不然服务端没法确认「刚才真的验过身份」。
-- 存量库要手动补:
--   CREATE TABLE IF NOT EXISTS verify_pass (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, via TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verify_pass (
  token      TEXT PRIMARY KEY,      -- 随机串
  user_id    INTEGER NOT NULL,
  via        TEXT,                 -- 怎么验的: totp / email / password
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 邮箱验证 / 解绑的一次性令牌 (30 分钟过期, 用掉或重新发都会作废旧令牌)
CREATE TABLE IF NOT EXISTS email_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  purpose    TEXT NOT NULL,            -- 'verify'(验证邮箱) | 'unbind'(解绑邮箱)
  email      TEXT,                     -- 发起时那个邮箱, 确认时对一下防止“发完又改了”
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id);

-- 一个 GitHub 账号只能绑一个本地账户
-- (SQLite 里 NULL 不参与唯一约束, 所以未绑定的用户不受影响)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users (github_id);

-- 用户资料 (和 users 一对一)
CREATE TABLE IF NOT EXISTS profiles (
  user_id    INTEGER PRIMARY KEY,
  nickname   TEXT,
  avatar_url TEXT,
  bio        TEXT,
  other      TEXT DEFAULT '{}',
  created_at INTEGER,
  updated_at INTEGER,
  -- 个性化 (2026-09-13): 见下面那段注释; 老库要手动 ALTER
  bg_image   TEXT,                             -- 个人主页背景图 (公开)
  bg_blur    INTEGER NOT NULL DEFAULT 0,       -- 主页背景模糊度 0~100
  chat_bg    TEXT,                             -- 私聊背景图 (只有自己看得到)
  chat_blur  INTEGER NOT NULL DEFAULT 0,       -- 私聊背景模糊度 0~100
  -- 字体 (2026-09-13): NULL / '' = 默认字体, 'hand' = 想念是枫糖海盐味
  -- 三个都是只对自己生效的显示偏好 (别人看你的内容时用他们自己的设置)
  font_chat    TEXT,                           -- 私信 (私信页 + 个人页的私聊弹窗)
  font_forum   TEXT,                           -- 论坛 (文章列表 + 评论区)
  font_article TEXT                            -- 文章 (详情页的标题/简介/正文)
);
-- 个性化: 个人主页背景 (bg_*) 与私聊背景 (chat_*), 存的是桶里的完整 URL, 换图时带 ?t= 破缓存。
--   bg_* 是公开的 (别人看得见你的主页背景), chat_* 只有自己看得到; blur 是模糊度 0~100。
-- 字体: 白名单在 worker.js 的 FONT_VALUES (= ['', 'hand']), 加新字体要改三处
--   (FONT_VALUES / 前端 core.js 的 FONT_CHOICES / main.css 里那条 --font-*)。
-- 老库补列:
--   ALTER TABLE profiles ADD COLUMN bg_image  TEXT;
--   ALTER TABLE profiles ADD COLUMN bg_blur   INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE profiles ADD COLUMN chat_bg   TEXT;
--   ALTER TABLE profiles ADD COLUMN chat_blur INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE profiles ADD COLUMN font_chat    TEXT;
--   ALTER TABLE profiles ADD COLUMN font_forum   TEXT;
--   ALTER TABLE profiles ADD COLUMN font_article TEXT;

-- 文章 (论坛主内容: 游客可读, 登录可发; 草稿仅作者/管理员可见)
CREATE TABLE IF NOT EXISTS articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  title      TEXT,                                    -- 标题可选, 留空时前端截取正文首行
  intro      TEXT,                                    -- 简介 (作者手写的一句话主题; 列表页/个人页卡片显示它, 可为空)
  content    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'published',       -- 'draft' | 'published'
  is_deleted INTEGER NOT NULL DEFAULT 0,              -- 软删除
  narra      INTEGER NOT NULL DEFAULT 0,              -- 1 = 叙述 (不进公开列表, 只在个人页与终端世界出现)
  created_at INTEGER,
  updated_at INTEGER
);
-- 存量库要手动补这一列:
--   ALTER TABLE articles ADD COLUMN narra INTEGER NOT NULL DEFAULT 0;

/* 叙述的「文章引用键名」: 一个键对应一篇叙述, 键全局唯一 (建叙述时就占位)
   存量库要手动建:
   CREATE TABLE IF NOT EXISTS article_quotekey (quotekey TEXT PRIMARY KEY, article_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_article_quotekey_article ON article_quotekey (article_id); */
CREATE TABLE IF NOT EXISTS article_quotekey (
  quotekey   TEXT PRIMARY KEY,          -- 小写化后的键名 [a-z0-9.-], 3~40 位
  article_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_quotekey_article ON article_quotekey (article_id);

/* 终端面板 → 叙述 的对应关系: 一个面板能挂多篇 (复合主键), 点开后左边是文章集、右边是正文
   存量库要手动建:
   CREATE TABLE IF NOT EXISTS terminal_article_redirect (key TEXT NOT NULL, quotekey TEXT NOT NULL, PRIMARY KEY (key, quotekey)); */
CREATE TABLE IF NOT EXISTS terminal_article_redirect (
  key      TEXT NOT NULL,               -- 面板的 key, 如 terminal.iota.left-1
  quotekey TEXT NOT NULL,               -- 指向 article_quotekey.quotekey
  PRIMARY KEY (key, quotekey)
);

-- 登录会话 (Cookie 里存 token, 3 天过期)
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 频率限制计数器 (登录 / 注册防刷; key 形如 "login:1.2.3.4", 过期即可重新计数)
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 站点级开关 (2026-09-17): 站长在个人页「Foraine」页签里切的那些全局方案。
-- 键与默认值写在 src/common.js 的 SITE_FLAG_DEFAULTS 里, 这里只存**被改过**的那些 ——
-- 表里没有这个键 = 用默认值, 所以以后加新开关不用写迁移。
-- 现有两个键:
--   downlink = 1  下行流量方案 (按身份限下载并发 + 记下载日志) 是否执行
--   quota    = 1  资源量限制方案 (存量 / 7 天累计 / 单组文件数 / 大流量通知 / 日配额 20GB) 是否执行
CREATE TABLE IF NOT EXISTS site_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- '1' / '0'
  updated_at INTEGER NOT NULL
);

-- 上传用量 (按「人 + 一天」累加字节, 2026-09-16 资源中心把上传配额从「次数」改成「总量」)。
-- 为什么另开一张表而不是复用 rate_limits: 那张表存的是 count + 过期时刻, 语义是「窗口内几次」,
-- 装不下「一天灌了多少字节」; 硬塞进去要么加列要么把 count 当字节用, 两个都会在别处坑到人。
-- ⚠️ day 是 UTC 的 YYYY-MM-DD, 跨天就是新的一行, 老行不用清 (份量很小, 需要时按 day 删即可)。
CREATE TABLE IF NOT EXISTS upload_usage (
  user_id INTEGER NOT NULL,
  day     TEXT NOT NULL,
  bytes   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ==================== 下载日志与并发槽 (2026-09-17) ====================
-- 用户要「控制下行流量」, 但他认了云猫的方案: 不做字节级限速, 改成「按身份限同时下载数 + 记账」。
-- ① download_log: 谁 / 何时 / 哪个资源 / 多大 / 走哪条路 / IP。
--    ⚠️ via='direct' 那些是**前端上报**的: OSS 直链的字节不过 Worker, 拦不到也看不到,
--       只能靠点下载时补发一条 (脚本直接拿直链就记不到 —— 与用户说清过这个代价)。
CREATE TABLE IF NOT EXISTS download_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,               -- NULL = 游客
  ip          TEXT,
  resource_id INTEGER,
  group_id    INTEGER,
  bytes       INTEGER NOT NULL DEFAULT 0,
  via         TEXT NOT NULL DEFAULT 'worker',   -- worker | direct
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_log_user ON download_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_download_log_resource ON download_log (resource_id);

-- ② dl_active: 「此刻有几个下载在跑」。
--    ⚠️ 不能复用 rate_limits: 那张表是「窗口内几次」的语义, 装不下「现在有几个」。
--    token 是每个下载一个随机串, 收尾时按它精确还槽 (不能按 user_id 删, 那会把同一个人
--    其它还在跑的下载一起放掉)。游客没有 user_id, 就按 ip 配对。
CREATE TABLE IF NOT EXISTS dl_active (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER,
  ip         TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dl_active_user ON dl_active (user_id);
CREATE INDEX IF NOT EXISTS idx_dl_active_ip ON dl_active (ip);

-- 存量库要手动补这三样:
--   ALTER TABLE resource_group ADD COLUMN notify_stage INTEGER NOT NULL DEFAULT 0;
--   (download_log 与 dl_active 两张表跑一次 schema.sql 就建好了, IF NOT EXISTS 可重复跑)

-- ==================== 文章系统: 标签 / 评论 / 权限 ====================

-- 标签
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

-- 文章 ↔ 标签
CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (article_id, tag_id)
);

-- 评论 (两级展示: 顶层评论 + 回复, 形制照 Waline)
-- 早期版本还有 nickname / reply_to_nickname 两个「快照列」, 现在不存了 ——
-- 昵称与头像一律现查 profiles (改个昵称全站一起变, 与文章卡片 / 私信一致)。
CREATE TABLE IF NOT EXISTS comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id          INTEGER NOT NULL,
  user_id             INTEGER NOT NULL,
  content             TEXT NOT NULL,
  reply_to_comment_id INTEGER,                        -- 回复哪条 (NULL = 直接评论文章)
  is_deleted          INTEGER NOT NULL DEFAULT 0,     -- 软删 (留一条「已删除」)
  created_at          INTEGER NOT NULL
);

-- 按文章取评论时最常用的那个顺序
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments (article_id, created_at);

-- ==================== 角色 (RBAC 只有这一张表) ====================
-- 原来是三张 (roles / role_permissions / user_roles), 可角色只有固定的 3 个, 拆三张纯属给自己
-- 找麻烦; 现在合成一张: 角色 + 权限 + 排序都在同一行, 用户那边只用 users.role 指过来。
--   permissions 是逗号分隔的权限串, '*' = 全部权限 (站长); 加一条权限 = 往字符串后面追。
--   rank 越小权限越高 (1 站长 / 2 管理员 / 3 普通用户), 成员花名册按它排。
CREATE TABLE IF NOT EXISTS roles (
  name        TEXT PRIMARY KEY,          -- 'owner' | 'admin' | 'user' (代码里比较的就是它)
  label       TEXT NOT NULL,             -- '站长' | '管理员' | '普通用户' (前端直接显示这个)
  rank        INTEGER NOT NULL,
  permissions TEXT NOT NULL DEFAULT ''
);

-- 初始角色与权限 (INSERT OR IGNORE 保证可重复执行)
-- ⚠️ INSERT OR IGNORE 对已经存在的那一行是空操作: 改这里的 permissions 只对新库生效,
--    存量库要自己敲一句 UPDATE 追上去。资源中心那一轮追的是 resource.delete.any:
--      UPDATE roles SET permissions = permissions || ',resource.delete.any' WHERE name = 'admin'
--        AND permissions NOT LIKE '%resource.delete.any%';
INSERT OR IGNORE INTO roles (name, label, rank, permissions) VALUES
  ('owner', '站长',     1, '*'),
  -- 管理员不能改别人的文章: 改正文等于「无声无息地改人家说的话」, 太危险; 只保留删除
  -- (审核违规内容, 而且是软删除可追溯)。要放开就往上面那行的 permissions 里追 ',article.edit.any'。
  -- resource.delete.any 也一样是「能删别人的, 但删之前必须先给上传者发站内信」(见 handlers/resource.js)
  ('admin', '管理员',   2, 'article.delete.any,comment.delete.any,tag.manage,resource.delete.any'),
  ('user',  '普通用户', 3, '');

-- ==================== 站内信 / 封禁 / 审核留痕 ====================

-- 站内信 (系统通知 + 用户互发 + 评论提醒)
-- 表名故意不叫 messages: 老聊天室时代遗留的 messages 还在存量库里, 同名的 IF NOT EXISTS
-- 会变成空操作, 列全对不上。
CREATE TABLE IF NOT EXISTS notices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user_id   INTEGER NOT NULL,
  from_user_id INTEGER,               -- NULL = 系统
  kind         TEXT,                  -- 'ban' | 'unban' | 'article.delete' | 'system' | 'user'
                                      -- | 'comment.article' | 'comment.reply' (评论提醒: 前端画成一行小卡片)
  title        TEXT,                  -- 评论提醒里 = 文章标题
  body         TEXT,                  -- 评论提醒里 = 评论/回复的正文
  article_id   INTEGER,               -- 评论提醒: 点卡片跳到哪篇文章
  comment_id   INTEGER,               -- 评论提醒: 指向那条评论 (以后要做「跳到这条评论」用得上)
  read_at      INTEGER,               -- NULL = 未读
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notices_to ON notices (to_user_id, id DESC);

-- 关注 (追随者): 一行 = 「follower 关注了 followee」。计数公开, 「谁关注了谁」只有自己看得到。
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,       -- 关注的人
  followee_id INTEGER NOT NULL,       -- 被关注的人
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);

-- 私聊 (保留聊天记录的那个模态框)。表名故意不叫 messages: 老聊天室时代的 messages 还在存量库里。
-- 撤回: 只允许自己的消息 + 5 分钟内, 置 is_deleted = 1, 查询处一律 `AND is_deleted = 0`;
-- 「删除」不走服务端 (只删自己这边的本地记录)。
CREATE TABLE IF NOT EXISTS chats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL,
  to_user_id   INTEGER NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER,                -- NULL = 对方还没看
  is_deleted   INTEGER NOT NULL DEFAULT 0,   -- 1 = 已被发信人撤回
  deleted_at   INTEGER                        -- 撤回时间 (轮询靠它告诉对方「哪几条没了」)
);
CREATE INDEX IF NOT EXISTS idx_chats_pair ON chats (from_user_id, to_user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_chats_inbox ON chats (to_user_id, id DESC);
-- 老库补列:
--   ALTER TABLE chats ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE chats ADD COLUMN deleted_at INTEGER;

-- 表情包: 每人一份, 存在 foraine-image 的 img/<用户名>/emoji/ 下面。
-- 列表走这张登记表而不是列桶: 那个 RAM 账号还没给 `oss:ListObjects`, 列目录会 403。
CREATE TABLE IF NOT EXISTS emoji (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  url        TEXT NOT NULL,      -- 公开地址 (img.foraine.xyz/img/<用户名>/emoji/…)
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emoji_user ON emoji (user_id, id DESC);

-- 封禁 (一个用户同时只有一条; until 为 NULL = 永久)
CREATE TABLE IF NOT EXISTS bans (
  user_id    INTEGER PRIMARY KEY,
  reason     TEXT,
  until      INTEGER,
  by_user_id INTEGER,
  created_at INTEGER NOT NULL
);

-- 管理操作留痕 (审核删文 / 封禁 / 解封 / 删号, 出事了能查是谁干的)
CREATE TABLE IF NOT EXISTS moderation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  target_user INTEGER,
  article_id  INTEGER,
  reason      TEXT,
  by_user_id  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modlog_created ON moderation_log (created_at DESC);

-- 「向站长申请改密」的待办 (一人一条, 后写的覆盖先写的)。
-- 存的是已经加密好的新密码 (PBKDF2 + 随机盐), 任何人 (包括站长) 都看不到明文;
-- 站长同意了就直接把这三列搬进 users 表。
CREATE TABLE IF NOT EXISTS password_requests (
  user_id       INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 动态令牌 (TOTP)。
-- 密钥不存明文: secret_enc 是 AES-GCM 密文, 密钥材料 = 服务端密钥 + 每行自己的盐 (salt)。
-- enabled = 0 表示「二维码已生成但还没点确认」, 点确认才置 1。
CREATE TABLE IF NOT EXISTS totp (
  user_id    INTEGER PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  iv         TEXT NOT NULL,
  salt       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

/* 权限分两套 (用户 2026-09-28 定的, 实现在 src/permission.js):
   ① 权限组 group —— basis / default / user / mod / admin, 有继承; **写在代码里, 不落库**。
      它由 users.role 那个名字指过来 (roles 表只剩 name/label/rank, permissions 那一列不再读)。
   ② 属性 attribute —— 「每人一份」的小开关, 存下面这张表。内容等级 (<secret> 里的串) 与
      terminal.access 都算属性; 登录时按自己的组补齐 (缺哪条补哪条), 站点权限项不进来。
   权限串用点号分级, 判的时候认自己的某一级父级 (拥有 foraine.* 就能看 foraine.iota)。 */
CREATE TABLE IF NOT EXISTS view_permission (
  user_id    INTEGER NOT NULL,
  permission TEXT NOT NULL,         -- 属性名: foraine.iota / terminal.access ...
  created_at INTEGER,
  PRIMARY KEY (user_id, permission)
);

-- 文章 <secret> 里点过名的属性 (名册)。ref_count = 有多少篇没删的文章引用它, 归零就删行。
-- 名册是给「以后那个授予属性的界面」用的: 让人从已存在的属性里挑, 而不是手打。
CREATE TABLE IF NOT EXISTS attribute_registry (
  name       TEXT PRIMARY KEY,
  ref_count  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

-- 文章 → 属性 的引用关系 (算 ref_count 的依据; 也保证同一篇重复保存不会重复计数)
CREATE TABLE IF NOT EXISTS article_attribute (
  article_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (article_id, permission)
);

/* 服务端秘密 (只给后端读, 不下发到前端)。第一行: 终端秘钥; 第二行: Iota 那一关的答案。
   ⚠️ 列名 key / value / case 都是 SQL 关键字, 引用时必须加双引号 ("key" / "value" / "case").
   "case" = 1 表示比对时**大小写必须完全相同**, 0 = 忽略大小写.
   "value" 可为 NULL —— NULL / 空串都表示「还没设值」, 比对一律不通过 (Iota 那行现在就是 NULL)。
   线上 / 本地建表 (幂等, 可重复跑):
     CREATE TABLE IF NOT EXISTS secret ("key" TEXT PRIMARY KEY, "value" TEXT, "case" INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
     INSERT OR IGNORE INTO secret ("key", "value", "case", updated_at) VALUES ('terminal.accessKey', 'narralethe', 1, 0);
     INSERT OR IGNORE INTO secret ("key", "value", "case", updated_at) VALUES ('terminal.iota', NULL, 1, 0);
   改秘钥: UPDATE secret SET "value" = '新秘钥', updated_at = ... WHERE "key" = 'terminal.accessKey';
   老库的 value 原来是 NOT NULL —— 要能存 NULL 得重建一次表 (内容不多, 直接搬):
     CREATE TABLE secret_new ("key" TEXT PRIMARY KEY, "value" TEXT, "case" INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
     INSERT INTO secret_new ("key","value","case",updated_at) SELECT "key","value","case",updated_at FROM secret;
     DROP TABLE secret;
     ALTER TABLE secret_new RENAME TO secret; */
CREATE TABLE IF NOT EXISTS secret (
  "key"      TEXT PRIMARY KEY,
  "value"    TEXT,
  "case"     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);

INSERT OR IGNORE INTO secret ("key", "value", "case", updated_at)
  VALUES ('terminal.accessKey', 'narralethe', 1, 0);

INSERT OR IGNORE INTO secret ("key", "value", "case", updated_at)
  VALUES ('terminal.iota', NULL, 1, 0);

-- 改名前的旧表名 (2026-09-28 由 secret_permission / article_permission 改过来)。线上清一遍:
--     DELETE FROM article_attribute WHERE article_id IN (SELECT id FROM article_permission);
--     DROP TABLE IF EXISTS article_permission;
--     DROP TABLE IF EXISTS secret_permission;

-- 翻译台 (/lang.html) 已整块删除。线上 / 本地清理旧表 (先导出备份, 再执行):
--     DROP TABLE IF EXISTS lang_overrides;
--     DROP TABLE IF EXISTS lang_pending;
--     DROP TABLE IF EXISTS lang_history;
--     DELETE FROM site_flags WHERE key IN ('lang', 'langedit', 'langsig');

-- 索引
CREATE INDEX IF NOT EXISTS idx_articles_status_created ON articles (status, is_deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag        ON article_tags (tag_id);

-- ---------------------------------------------------------------------
-- 论坛 (讨论区) 已整块删除。线上 / 本地清理旧表 (先导出备份, 再执行):
--     DROP TABLE IF EXISTS forum_posts;
--     DROP TABLE IF EXISTS forum_topics;


-- ---------------------------------------------------------------------
-- 存量库迁移 (新建数据库无需执行; 两段都幂等, 重复跑只会报"duplicate column"无害)
--
-- 1) articles 旧结构缺两列 (会影响文章列表/详情):
--   ALTER TABLE articles ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
--   ALTER TABLE articles ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE articles ADD COLUMN intro TEXT;   -- 「简介」列 (2026-09-12 新增)
--
-- 2) users 旧结构缺 OAuth 绑定字段 (缺少时 OAuth 登录不可用,
--    但 /api/me 已做降级, 不会像当初那样拖垮整个登录):
--   ALTER TABLE users ADD COLUMN github_id TEXT;
--   ALTER TABLE users ADD COLUMN github_login TEXT;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users (github_id);
--
-- 3) RBAC 三表合并 (把 roles/role_permissions/user_roles 收成 roles 一张):
--    顺序不能反 —— 先把「谁是什么角色」搬进 users.role, 才能删旧表 (数据在那里面):
--   ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
--   UPDATE users SET role = COALESCE((SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
--                                     WHERE ur.user_id = users.id ORDER BY r.id LIMIT 1), 'user');
--   DROP TABLE IF EXISTS user_roles;
--   DROP TABLE IF EXISTS role_permissions;
--   DROP TABLE IF EXISTS roles;
--   然后再跑一遍本文件 (它会把新的 roles 建出来并塞进那 3 行)。
--   最后确认一下: SELECT username, role FROM users WHERE role <> 'user';
--
--   一个用户只能有一个角色: 旧库里「user + admin 两条」的会被上面那句按 role_id 最小
--   (权限最高) 的那条定性, 本来也没人指望「两个角色叠加」。
--   代码侧全部 try/catch 降级, 忘了迁移的库只会「所有人都是普通用户」, 不会崩。
--
-- 4) 两小改 (各跑一次):
--   ALTER TABLE visit_logs DROP COLUMN visit_time_str;   -- 时间交给前端格式化
--   ALTER TABLE users ADD COLUMN last_login_at INTEGER;  -- 资料卡片上的「最后登录时间」
--
-- 2.5) notices 旧结构缺评论提醒的两列 (缺了也不报错 —— sendNotice 会吞掉异常,
--      只是评论提醒发不出去):
--   ALTER TABLE notices ADD COLUMN article_id INTEGER;
--   ALTER TABLE notices ADD COLUMN comment_id INTEGER;
--
-- 3) 清理已废弃的表 (老聊天室功能以移除):
--   DROP TABLE IF EXISTS messages;   -- 老的聊天室表; 新的站内信表叫 notices, 别搞混
--   注: comments 表 2026-09-12 又回来了 (见文件上半部分的建表语句)
--
-- 4) QQ 登录已移除 (QQ 互联要求网站备案)。已迁移过的库可以顺手清掉那两列,
--    不清也没影响 (空列不占空间, 只是看着碍眼):
--   DROP INDEX IF EXISTS idx_users_qq_openid;
--   ALTER TABLE users DROP COLUMN qq_openid;
--   ALTER TABLE users DROP COLUMN qq_nickname;
-- ---------------------------------------------------------------------
