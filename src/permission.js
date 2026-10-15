/* permission.js 属性 (attribute) 与权限组 */
/*
  内容: 权限组定义 / 登录时把该组该有的属性补齐 / 读一个人的属性 / 属性覆盖判定 / 权限名册的引用计数
  依赖: 无

  两套东西分开看 (用户 2026-09-28 定的):
    ① **权限组** group —— basis / default / user / mod / admin, 有继承 (下级拥有上级的全部权限)。
       写在代码里 (GROUPS), 不落库; 判定靠「这个人的组名能不能够到要的那一项」。
    ② **属性** attribute —— 「每人一份」的小开关, 存 view_permission 表, 比如 foraine.iota。
       登录时按自己的组补齐 (缺哪条补哪条, 已有的不动、不删); 内容等级就是拿它判的。

  ⚠️ 它是**属性**不是权限: 谁身上有 `foraine.iota` 谁就能看 `<secret='foraine.iota'>` 那段。
     站点自己的权限项 (article.delete.self 这类) 走权限组, 不该往这张表里塞。
*/

/* 五个组, 从下到上。inherit 只写直接上级, 判定时顺着链爬 */
const GROUPS = {
  basis: { rank: 1, inherit: null, label: '基础' },
  default: { rank: 2, inherit: 'basis', label: '默认' },
  user: { rank: 3, inherit: 'default', label: '成员' },
  mod: { rank: 4, inherit: 'user', label: '管理员' },
  admin: { rank: 5, inherit: 'mod', label: '站长' }
};

/* 每一组自己额外拿到的权限项 (不含继承来的) */
const GROUP_PERMISSIONS = {
  basis: ['articles.visit', 'article.visit', 'resources.visit'],
  default: [],
  user: [
    'article.create', 'article.delete.self',
    'article.comment.publish', 'article.comment.delete.self',
    'resources.edit', 'terminal.visit'
  ],
  mod: [
    'article.review', 'article.comment.delete.any', 'resource.delete.any',
    'user.ban', 'user.pardon'
  ],
  admin: [
    'dev.access', 'dev.d1', 'dev.r2', 'dev.site', 'dev.renumberUserId',
    'user.delete', 'user.setAsMod', 'user.setAsMember',
    'article.narra', 'terminal.keyviewer'
  ]
};

/* 登录时按组自动补的属性 (内容等级这类; 站点自己的权限项不进来) */
const GROUP_ATTRIBUTES = {
  basis: [],
  default: [],
  user: [],
  mod: [],
  admin: []
};

/* 老的 RBAC 串 → 新的组 (改名前线上库里的值) */
const LEGACY_GROUPS = { owner: 'admin', admin: 'mod', user: 'user' };

// 归一到组名 (认不出的一律当 default)
function normalizeGroup(name) {
  const key = String(name || '').toLowerCase();
  if (GROUPS[key]) return key;
  return LEGACY_GROUPS[key] || 'default';
}

// 这个组顺着继承链能拿到的全部权限项
function groupPermissions(group) {
  const out = [];
  let cur = normalizeGroup(group);
  const seen = new Set();
  while (cur && GROUPS[cur] && !seen.has(cur)) {
    seen.add(cur);
    for (const one of GROUP_PERMISSIONS[cur] || []) if (out.indexOf(one) < 0) out.push(one);
    cur = GROUPS[cur].inherit;
  }
  return out;
}

/* 这个组能不能够到要的那一项。'*' 只给 admin (站长就是全都能) */
function groupCovers(group, required) {
  const want = String(required || '');
  if (!want) return false;
  const name = normalizeGroup(group);
  if (want === '*' || name === 'admin') return true;
  const mine = groupPermissions(name);
  if (mine.indexOf(want) >= 0) return true;
  // 跟属性一样的父级覆盖: dev.* 能顶 dev.d1
  const parts = want.split('.');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (mine.indexOf(parts.slice(0, i).join('.') + '.*') >= 0) return true;
  }
  return false;
}

/* 权限项的中央清单 (给界面 / 清单文档用; 键 = 权限串, 值 = 中文描述) */
const PERMISSION_LABELS = {
  'articles.visit': '访问文章列表页',
  'article.visit': '访问单篇文章',
  'resources.visit': '访问资源列表页',
  'article.create': '发文与存草稿',
  'article.delete.self': '删除自己的文章',
  'article.narra': '创建与编辑叙述',
  'article.comment.publish': '发表评论',
  'article.comment.delete.self': '删除自己的评论',
  'resources.edit': '访问资源编辑页',
  'terminal.visit': '访问终端验证页',
  'terminal.keyviewer': '查看终端文章面板的 key',
  'article.review': '审核文章',
  'article.comment.delete.any': '删除任意人的评论',
  'resource.delete.any': '删除任意人的资源',
  'user.ban': '封禁用户',
  'user.pardon': '解除封禁',
  'dev.access': '访问开发者工具',
  'dev.d1': '访问 D1 控制台',
  'dev.r2': '访问存储浏览器',
  'dev.site': '改站点总闸',
  'dev.renumberUserId': '重编用户 ID',
  'user.delete': '删除用户',
  'user.setAsMod': '设为管理员',
  'user.setAsMember': '设为普通成员'
};

// 组名 → 展示用的中文
function groupLabel(group) {
  const g = GROUPS[normalizeGroup(group)];
  return g ? g.label : '默认';
}

/* asyfunc 读一个人身上的属性 (读不出来就当空; 表没建也不炸) */
async function loadAttributes(env, userId) {
  if (!userId) return [];
  try {
    const rows = await env.DB.prepare(
      'SELECT permission FROM view_permission WHERE user_id = ?'
    ).bind(userId).all();
    return (rows.results || []).map((row) => String(row.permission || '')).filter(Boolean);
  } catch (err) {
    console.warn('读属性跳过:', (err && (err.message || err.cause)) || err);
    return [];
  }
}

/* asyfunc 登录时把该组该有的属性补齐 (缺哪条补哪条, 已有的不动也不删) */
async function syncGroupAttributes(env, userId, group) {
  const want = GROUP_ATTRIBUTES[normalizeGroup(group)] || [];
  if (!want.length || !userId) return 0;
  let have = new Set();
  try {
    const rows = await env.DB.prepare(
      'SELECT permission FROM view_permission WHERE user_id = ?'
    ).bind(userId).all();
    have = new Set((rows.results || []).map((row) => String(row.permission || '')));
  } catch (err) {
    console.warn('补属性前读表跳过:', (err && (err.message || err.cause)) || err);
    return 0;
  }
  const miss = want.filter((one) => !have.has(one));
  if (!miss.length) return 0;
  const now = Date.now();
  try {
    await env.DB.batch(miss.map((one) => env.DB.prepare(
      'INSERT OR IGNORE INTO view_permission (user_id, permission, created_at) VALUES (?, ?, ?)'
    ).bind(userId, one, now)));
  } catch (err) {
    console.warn('补属性跳过:', (err && (err.message || err.cause)) || err);
    return 0;
  }
  return miss.length;
}

/* 属性覆盖判定: 手里这一项能不能顶住要的那一项 (自己 / '*' / 某一级父级 a.b.*) */
function attributeCovers(held, required) {
  const has = String(held || '').toLowerCase();
  const want = String(required || '').toLowerCase();
  if (!has || !want) return false;
  if (has === want || has === '*') return true;
  const parts = want.split('.');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (has === parts.slice(0, i).join('.') + '.*') return true;
  }
  return false;
}

/* ==================== 权限名册 (引用计数) ==================== */
/* <secret='…'> 里点过名的属性跟文章是多对多, 用两张表记:
   article_attribute 记「哪篇引用了哪个」, attribute_registry 记「被引用几次」。
   ⚠️ 只有 HAS/HASNOT + EXACTLY/GLOBALLY 后面那串算属性名 (DATE / USER 后面不是), 单独的 * 不算 */

const SECRET_RE = /<secret='([^']*)'>([\s\S]*?)<\/secret>/gi;

// 一条条件里点名的属性
function exprAttributes(expr) {
  const tokens = String(expr == null ? '' : expr).trim().split(/\s+/).filter(Boolean);
  const head = (tokens[0] || '').toUpperCase();
  const i = (head === 'HAS' || head === 'HASNOT') ? 1 : 0;
  const kind = (tokens[i] || '').toUpperCase();
  if (kind !== 'EXACTLY' && kind !== 'GLOBALLY') return [];
  return tokens.slice(i + 1).filter((one) => one && one !== '*');
}

// 正文里点名过的全部属性 (去重)
function extractAttributes(text) {
  const src = String(text == null ? '' : text);
  const names = new Set();
  if (src.indexOf('<secret') < 0) return names;
  const re = new RegExp(SECRET_RE.source, 'gi');
  let m;
  while ((m = re.exec(src))) {
    for (const name of exprAttributes(m[1])) names.add(name);
  }
  return names;
}

/* asyfunc 把「这篇正文引用了哪些属性」同步进库 (存草稿与发布都跑)。
   没的建、已有的 +1、不再引用的 -1、减到 0 就把名册那行删掉 */
async function syncArticleAttributes(env, articleId, content) {
  const next = extractAttributes(content);
  let old = new Set();
  try {
    const rows = await env.DB.prepare(
      'SELECT permission FROM article_attribute WHERE article_id = ?'
    ).bind(articleId).all();
    old = new Set((rows.results || []).map((row) => String(row.permission || '')));
  } catch (err) {
    console.warn('读文章属性跳过:', (err && (err.message || err.cause)) || err);
  }
  const added = [...next].filter((name) => !old.has(name));
  const removed = [...old].filter((name) => !next.has(name));
  if (!added.length && !removed.length) return { added, removed };
  const now = Date.now();
  const stmts = [];
  for (const name of added) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO attribute_registry (name, ref_count, created_at) VALUES (?, 0, ?)').bind(name, now));
    stmts.push(env.DB.prepare('UPDATE attribute_registry SET ref_count = ref_count + 1 WHERE name = ?').bind(name));
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO article_attribute (article_id, permission) VALUES (?, ?)').bind(articleId, name));
  }
  for (const name of removed) {
    stmts.push(env.DB.prepare('DELETE FROM article_attribute WHERE article_id = ? AND permission = ?').bind(articleId, name));
    stmts.push(env.DB.prepare('UPDATE attribute_registry SET ref_count = ref_count - 1 WHERE name = ?').bind(name));
    stmts.push(env.DB.prepare('DELETE FROM attribute_registry WHERE name = ? AND ref_count <= 0').bind(name));
  }
  await env.DB.batch(stmts);
  return { added, removed };
}

// asyfunc 一篇文章被删掉时, 把它引用的那几个属性的计数还回去
async function releaseArticleAttributes(env, articleId) {
  try {
    const rows = await env.DB.prepare(
      'SELECT permission FROM article_attribute WHERE article_id = ?'
    ).bind(articleId).all();
    const list = (rows.results || []).map((row) => String(row.permission || '')).filter(Boolean);
    const stmts = [env.DB.prepare('DELETE FROM article_attribute WHERE article_id = ?').bind(articleId)];
    for (const name of list) {
      stmts.push(env.DB.prepare('UPDATE attribute_registry SET ref_count = ref_count - 1 WHERE name = ?').bind(name));
      stmts.push(env.DB.prepare('DELETE FROM attribute_registry WHERE name = ? AND ref_count <= 0').bind(name));
    }
    await env.DB.batch(stmts);
    return list;
  } catch (err) {
    console.warn('释放文章属性跳过:', (err && (err.message || err.cause)) || err);
    return [];
  }
}

/* asyfunc 计数的兜底对账 (cron 每天跑): 引用了已删文章的引用行清掉, 再按引用行重算一遍计数 */
async function reconcileAttributes(env) {
  try {
    await env.DB.prepare(
      `DELETE FROM article_attribute WHERE article_id NOT IN (SELECT id FROM articles WHERE is_deleted = 0)`
    ).run();
    await env.DB.prepare(
      `UPDATE attribute_registry SET ref_count = (
         SELECT COUNT(*) FROM article_attribute aa WHERE aa.permission = attribute_registry.name
       )`
    ).run();
    await env.DB.prepare('DELETE FROM attribute_registry WHERE ref_count <= 0').run();
  } catch (err) {
    console.warn('属性计数对账跳过:', (err && (err.message || err.cause)) || err);
  }
}

// asyfunc 名册 (给以后那个「授予属性」的界面当候选清单)
async function listAttributes(env) {
  try {
    const rows = await env.DB.prepare(
      'SELECT name, ref_count FROM attribute_registry ORDER BY name ASC'
    ).all();
    return (rows.results || []).map((row) => ({
      name: String(row.name || ''),
      ref_count: row.ref_count || 0
    }));
  } catch (err) {
    return [];
  }
}

/* ==================== <secret> 的可见性 ==================== */
/* 语法 (不分大小写; public/script/markdown.js 里那份「像不像合法条件」的判断要跟这里保持一致):
     [HAS|HASNOT] [EXACTLY|GLOBALLY] <属性...>     属性命中自己或其父级 (foraine.* / *)
     [HAS|HASNOT] DATE [AFTER|BEFORE] <unix 毫秒>
     [HAS|HASNOT] USER [WITH|WITHOUT] <用户名...>
   取反规则 (HAS / HASNOT 给整条条件取反):
     HAS   EXACTLY  = 列出来的全都要有      HASNOT EXACTLY  = 不是全都有 (差一项就算通过)
     HAS   GLOBALLY = 有一项就行            HASNOT GLOBALLY = 一项都不能有
   语法错 → 返回 null, 调用方原样留着 (让作者看见自己写错了) */

// 判一条 secret 条件: true = 给他看, false = 不给, null = 语法不对
function evalAttributeExpr(expr, ctx) {
  const tokens = String(expr == null ? '' : expr).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  let i = 0;
  let negate = false;
  const head = tokens[0].toUpperCase();
  if (head === 'HAS' || head === 'HASNOT') {
    negate = head === 'HASNOT';
    i = 1;
  }

  const kind = (tokens[i] || '').toUpperCase();
  const held = (ctx && ctx.attributes) || [];
  let ok = false;

  if (kind === 'EXACTLY' || kind === 'GLOBALLY') {
    const need = tokens.slice(i + 1).filter(Boolean);
    if (!need.length) return null;
    const hit = need.map((one) => held.some((h) => attributeCovers(h, one)));
    ok = kind === 'EXACTLY' ? hit.every(Boolean) : hit.some(Boolean);
  } else if (kind === 'DATE') {
    const op = (tokens[i + 1] || '').toUpperCase();
    const stamp = tokens[i + 2] || '';
    if ((op !== 'AFTER' && op !== 'BEFORE') || !/^\d{1,16}$/.test(stamp)) return null;
    const now = Date.now();
    const at = Number(stamp);
    ok = op === 'AFTER' ? now > at : now < at;
  } else if (kind === 'USER') {
    const op = (tokens[i + 1] || '').toUpperCase();
    const names = tokens.slice(i + 2).filter(Boolean).map((one) => one.toLowerCase());
    if ((op !== 'WITH' && op !== 'WITHOUT') || !names.length) return null;
    const me = String((ctx && ctx.username) || '').toLowerCase();
    const hit = !!me && names.indexOf(me) >= 0;
    ok = op === 'WITH' ? hit : !hit;
  } else {
    return null;
  }

  return negate ? !ok : ok;
}

// asyfunc 攒一份「这个人的属性上下文」: 同一趟请求里要过滤好几段正文时, 只查一次表
async function loadAttributeContext(env, user) {
  return {
    attributes: await loadAttributes(env, user && user.id),
    username: (user && user.username) || ''
  };
}

// asyfunc 按属性过一遍正文: 满足 → 脱掉标签; 不满足 → 整段删掉; 语法错 → 原样留着
async function filterSecrets(env, text, user, ctx) {
  const src = String(text == null ? '' : text);
  if (src.indexOf('<secret') < 0) return src;
  const scope = ctx || await loadAttributeContext(env, user);
  return src.replace(SECRET_RE, (whole, expr, body) => {
    const ok = evalAttributeExpr(expr, scope);
    if (ok === null) return whole;
    return ok ? body : '';
  });
}

export {
  GROUPS, GROUP_PERMISSIONS, GROUP_ATTRIBUTES, PERMISSION_LABELS, SECRET_RE,
  attributeCovers, evalAttributeExpr, extractAttributes, filterSecrets,
  groupCovers, groupLabel, groupPermissions, listAttributes,
  loadAttributeContext, loadAttributes, normalizeGroup, reconcileAttributes,
  releaseArticleAttributes, syncArticleAttributes, syncGroupAttributes
};
