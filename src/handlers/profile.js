/* handlers/profile.js 资料与用户目录 */
/*
  内容: 资料更新 / 公开个人主页 / 用户目录 / 用户名与 @提及查询 / 逆地理编码
  依赖: ../common.js(资料读写 权限 限流 逆地理缓存)
*/

import { EMAIL_MAX, PROFILE_BIO_MAX, PROFILE_NICKNAME_MAX, PROFILE_OTHER_MAX, attachTags, checkRateLimit, checkUsername, geoCache, getSessionUser, hasPermission, isValidEmail, loadEmailState, loadPermissions, loadPublicUser, loadUserGroup, makeSummary, parseCookies, readBlur, readFont, readImageUrl, retryText, reverseGeocode } from '../common.js';
import { attributeCovers, groupLabel, groupPermissions, loadAttributes } from '../permission.js';


/* asyfunc 我的属性与权限: GET /api/view-permissions
   属性 = 每人一份的小开关 (<secret> 的内容等级、终端通行证这类); 权限 = 权限组给的那些项 */
async function handleViewPermissions(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ ok: true, permissions: [], attributes: [], group: 'default' });
  const group = await loadUserGroup(env, user);
  return Response.json({
    ok: true,
    group,
    // permissions 保留原名: 前端与文档里已经这么叫了, 内容不变 (只是判定改成按组 + 属性)
    permissions: await loadAttributes(env, user.id),
    attributes: await loadAttributes(env, user.id),
    group_permissions: groupPermissions(group)
  });
}


/* asyfunc 校验终端秘钥: POST /api/terminal/access { key }
   秘钥读 D1 的 secret 表 (key = 'terminal.accessKey'), "case" = 1 表示大小写必须完全相同; 对了才发 terminal.access 属性。
   ⚠️ 秘钥只在服务端出现, 前端拿不到它 —— 以前是前端比对, 等于把秘钥公开了。
   ⚠️ 只发给登录用户 —— 游客进不去终端页 (worker 那边会把人送去「拒绝访问」) */
const TERMINAL_KEY_NAME = 'terminal.accessKey';
/* Iota 那一关: 秘钥与解锁后要发的属性 (用户 2026-10-01)
   ⚠️ secret 表里那一行的值现在是 NULL (= 还没定), 比对自然不通过 —— 定了值就能答 */
const IOTA_KEY_NAME = 'terminal.iota';
const IOTA_PERMISSION = 'foraine.iota';

// asyfunc 拿 secret 表里某一行跟用户敲的比 (行不存在 / 值为空 → 一律不通过)
async function secretMatches(env, name, key) {
  const row = await env.DB.prepare(
    `SELECT "value", "case" FROM secret WHERE "key" = ?`
  ).bind(name).first();
  const expect = row && typeof row.value === 'string' ? row.value : '';
  const exact = !!(row && Number(row.case) === 1);
  return !!expect && (exact ? key === expect : key.toLowerCase() === expect.toLowerCase());
}

async function handleTerminalAccess(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  let key = '';
  try {
    const body = await request.json();
    if (body && typeof body.key === 'string') key = body.key.trim();
  } catch (err) {
    key = '';
  }
  if (!key) return Response.json({ error: '请输入终端秘钥' }, { status: 400 });

  // 防爆破: 每人 10 分钟 20 次
  const gate = await checkRateLimit(env, 'terminal-key:' + user.id, 20, 10 * 60 * 1000);
  if (!gate.ok) return Response.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });

  try {
    if (!(await secretMatches(env, TERMINAL_KEY_NAME, key))) {
      return Response.json({ ok: false, error: '秘钥不正确' }, { status: 403 });
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO view_permission (user_id, permission, created_at) VALUES (?, 'terminal.access', ?)`
    ).bind(user.id, Date.now()).run();
    return Response.json({ ok: true, permission: 'terminal.access' });
  } catch (err) {
    console.error('终端秘钥校验失败:', err);
    return Response.json({ error: '操作失败，请稍后再试' }, { status: 500 });
  }
}

/* asyfunc Iota 权限的那道门: GET = 问「解开了没」 / POST { key } = 校验 terminal.iota, 对了发 foraine.iota */
async function handleTerminalIota(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const held = await loadAttributes(env, user.id);
    const unlocked = held.some((one) => attributeCovers(one, IOTA_PERMISSION));
    if (request.method === 'GET') return Response.json({ ok: true, unlocked });

    let key = '';
    try {
      const body = await request.json();
      if (body && typeof body.key === 'string') key = body.key.trim();
    } catch (err) {
      key = '';
    }
    if (!key) return Response.json({ error: '请输入答案' }, { status: 400 });

    // 防爆破: 每人 10 分钟 20 次
    const gate = await checkRateLimit(env, 'terminal-iota:' + user.id, 20, 10 * 60 * 1000);
    if (!gate.ok) return Response.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });

    if (!(await secretMatches(env, IOTA_KEY_NAME, key))) {
      return Response.json({ ok: false, error: '答案不正确' }, { status: 403 });
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO view_permission (user_id, permission, created_at) VALUES (?, ?, ?)`
    ).bind(user.id, IOTA_PERMISSION, Date.now()).run();
    return Response.json({ ok: true, unlocked: true, permission: IOTA_PERMISSION });
  } catch (err) {
    console.error('Iota 校验失败:', err);
    return Response.json({ error: '操作失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 更新资料: POST /api/profile
async function handleUpdateProfile(request, env) {
  // 昵称 / 简介 / 自定义信息 / 邮箱, 需要登录
  const cookies = parseCookies(request);
  const token = cookies.foraine_session;
  if (!token) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const session = await env.DB.prepare(
      `SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?`
    ).bind(token, Date.now()).first();

    if (!session) return Response.json({ error: '登录已过期' }, { status: 401 });

    const body = await request.json().catch(() => null);
    if (!body) return Response.json({ error: '无效的请求' }, { status: 400 });

    // 昵称留空 = 不改; 简介 / 自定义信息 / 邮箱 传空串 = 清空, 所以判「没传」要用 === undefined
    const nickname = body.nickname ? String(body.nickname).trim().slice(0, PROFILE_NICKNAME_MAX) : null;
    const bio = body.bio === undefined ? null : String(body.bio).trim().slice(0, PROFILE_BIO_MAX);
    const other = body.other === undefined
      ? null
      : String(body.other).replace(/\r\n/g, '\n').slice(0, PROFILE_OTHER_MAX);

    // 主页背景 / 聊天背景 + 各自的模糊度 (图已由 /api/image?kind= 传进桶, 这里只落地址)
    const bgImage = readImageUrl(body.bg_image);
    const chatBg = readImageUrl(body.chat_bg);
    if (bgImage === false || chatBg === false) {
      return Response.json({ error: '背景图地址不合法' }, { status: 400 });
    }
    const bgBlur = readBlur(body.bg_blur);
    const chatBlur = readBlur(body.chat_blur);

    // 字体: 只对自己生效的显示偏好 (别人浏览时用他们自己选的那套)
    const fontChat = readFont(body.font_chat);
    const fontForum = readFont(body.font_forum);
    const fontArticle = readFont(body.font_article);

    // 邮箱在 users 表 (不是 profiles.other), 这里不给改: 能随手换就等于盗号 -> 绑自己的邮箱 -> 注销
    // 换绑走 /api/email/unbind (验密码 + 旧邮箱确认信) -> /api/email/rebind, 中间不出现「没有邮箱」
    // 例外: 从没绑过的账号 (OAuth / 老账号) 允许一次性绑定, 绑上之后回到上面的规矩
    let boundEmail = '';
    if (body.email !== undefined) {
      const state = await loadEmailState(env, session.user_id);
      const wanted = String(body.email).trim().toLowerCase().slice(0, EMAIL_MAX);
      if (wanted && wanted !== state.email) {
        if (state.email) {
          return Response.json({
            error: state.verified
              ? '已验证的邮箱不能直接改，请用「换绑邮箱」（会先给旧邮箱发确认信）'
              : '邮箱在验证前不能修改，请先点验证邮件里的链接'
          }, { status: 403 });
        }
        if (!isValidEmail(wanted)) {
          return Response.json({ error: '邮箱格式不对' }, { status: 400 });
        }
        // 撞上别人的邮箱不给绑: 两个账号共用一个只会互相注销
        try {
          const taken = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?')
            .bind(wanted, session.user_id).first();
          if (taken) return Response.json({ error: '这个邮箱已经绑在别的账号上了' }, { status: 409 });
        } catch (err) { /* 读不出来就放行, 交给写入那一步兜底 */ }
        await env.DB.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?')
          .bind(wanted, session.user_id).run();
        boundEmail = wanted;
      }
    }

    const updates = [];
    const values = [];
    if (nickname !== null) {
      updates.push('nickname = ?');
      values.push(nickname);
    }
    if (bio !== null) {
      updates.push('bio = ?');
      values.push(bio);
    }
    if (other !== null) {
      updates.push('other = ?');
      values.push(other);
    }
    // 个性化那四列 (undefined = 没传, 不动)
    if (bgImage !== undefined) {
      updates.push('bg_image = ?');
      values.push(bgImage);
    }
    if (bgBlur !== undefined) {
      updates.push('bg_blur = ?');
      values.push(bgBlur);
    }
    if (chatBg !== undefined) {
      updates.push('chat_bg = ?');
      values.push(chatBg);
    }
    if (chatBlur !== undefined) {
      updates.push('chat_blur = ?');
      values.push(chatBlur);
    }
    // 字体那三列 (同上: undefined = 没传, 不动)
    if (fontChat !== undefined) {
      updates.push('font_chat = ?');
      values.push(fontChat);
    }
    if (fontForum !== undefined) {
      updates.push('font_forum = ?');
      values.push(fontForum);
    }
    if (fontArticle !== undefined) {
      updates.push('font_article = ?');
      values.push(fontArticle);
    }
    if (updates.length === 0) {
      // 只绑了邮箱、没动资料也算一次成功的保存, 不要把 400 甩回去
      if (boundEmail) return Response.json({ ok: true, email: boundEmail, email_bound: true });
      return Response.json({ error: '没有要更新的内容' }, { status: 400 });
    }

    await env.DB.prepare(
      `UPDATE profiles SET ${updates.join(', ')}, updated_at = ? WHERE user_id = ?`
    ).bind(...values, Date.now(), session.user_id).run();

    return Response.json({ ok: true });
  } catch (err) {
    console.error('更新资料失败:', err);
    return Response.json({ error: '更新失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 公开资料: GET /api/user?username=
async function handlePublicUser(request, env, url) {
  // 个人主页的数据源: 资料 + 已发布文章
  const username = (url.searchParams.get('username') || '').trim();
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });

  try {
    const user = await loadPublicUser(env, username);
    if (!user) return Response.json({ error: '用户不存在' }, { status: 404 });

    const { results } = await env.DB.prepare(
      `SELECT a.id, a.title, a.intro, substr(a.content, 1, 240) AS excerpt, a.created_at, a.updated_at
       FROM articles a
       WHERE a.user_id = ? AND a.status = 'published' AND a.is_deleted = 0 AND a.narra = 0
       ORDER BY a.created_at DESC LIMIT 50`
    ).bind(user.id).all();

    const articles = (results || []).map(a => ({
      id: a.id,
      title: a.title,
      intro: a.intro || null,
      summary: makeSummary(a.excerpt),
      created_at: a.created_at,
      updated_at: a.updated_at
    }));
    await attachTags(env, articles);

    // 站点权限组是公开信息 (站长 / 管理员), 老库拿不到就算了
    let roles = [];
    try {
      roles = [groupLabel(await loadUserGroup(env, user))];
    } catch (err) { /* 忽略 */ }

    // 邮箱: 双方互相关注才给 (未登录 / 单方面关注 / follows 表缺失都不返回, 前端那行不画)
    let email = null;
    try {
      const viewer = await getSessionUser(request, env);
      if (viewer && viewer.id !== user.id) {
        const link = await env.DB.prepare(
          `SELECT (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?) AS mine,
                  (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?) AS theirs`
        ).bind(viewer.id, user.id, user.id, viewer.id).first();
        if (link && link.mine && link.theirs) {
          // 真要给了才读这一列 (别的分支连查都不查)
          const contact = await env.DB.prepare(
            `SELECT email, email_verified FROM users WHERE id = ?`
          ).bind(user.id).first();
          if (contact && contact.email && contact.email_verified) email = contact.email;
        }
      }
    } catch (err) {
      console.warn('互关邮箱检查失败 (当成不可见):', err);
    }

    // 「最后登录时间」单独查且带降级: 老库缺这一列时不能把整张卡片拖坏
    let lastLoginAt = null;
    try {
      const row = await env.DB.prepare(`SELECT last_login_at FROM users WHERE id = ?`)
        .bind(user.id).first();
      if (row) lastLoginAt = row.last_login_at || null;
    } catch (err) { /* 老库没这一列, 当作未知 */ }

    return Response.json({
      user: {
        username: user.username,
        // id / 使用年限 / 最后登录: 别人的资料卡片上也要摆
        id: user.id,
        created_at: user.created_at,
        last_login_at: lastLoginAt,
        nickname: user.nickname || user.username,
        avatar_url: user.avatar_url || null,
        bio: user.bio || null,
        other: user.other || null,
        // 主页背景是公开的 (别人也看得到); 聊天背景是私密的, 不在这里返回
        bg_image: user.bg_image || null,
        bg_blur: user.bg_blur || 0,
        github_login: user.github_login || null,
        // 邮箱只在互关时才有值; 没有值就别给 email_verified, 否则前端那行会画出个空链接
        email,
        email_verified: !!email,
        roles
      },
      articles
    });
  } catch (err) {
    console.error('加载公开用户失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 用户目录: GET /api/users
async function handleListUsers(request, env, url) {
  // 卡片墙「连携星点」: 需要登录, 只公开 username / nickname / bio / 头像, 不外露邮箱
  const viewer = await getSessionUser(request, env);
  if (!viewer) return Response.json({ error: '未登录' }, { status: 401 });

  const viewerPerms = await loadPermissions(env, viewer.id);
  const canModerate = hasPermission(viewerPerms, 'article.review');
const canRemove = hasPermission(viewerPerms, 'dev.access');

  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(60, Math.max(1, parseInt(url.searchParams.get('size') || '48', 10) || 48));
  const offset = (page - 1) * size;
  const now = Date.now();

  // 排序: 按名称 (仅正序) / 按编号; 两种都先按 role_rank (1 站长 / 2 管理员 / 3 普通用户, 缺省 99)
  const byName = url.searchParams.get('sort') === 'name';
  const orderBy = byName
    ? `ORDER BY role_rank ASC, LOWER(COALESCE(NULLIF(p.nickname, ''), u.username)) ASC, u.id ASC`
    : `ORDER BY role_rank ASC, u.id ASC`;

  const richQuery = `
    SELECT u.id, u.username, u.created_at,
           p.nickname, p.avatar_url, p.bio,
           (SELECT r.label FROM roles r WHERE r.name = u.role) AS role_label,
           COALESCE((SELECT r.rank FROM roles r WHERE r.name = u.role), 99) AS role_rank,
           (SELECT COUNT(*) FROM articles a
             WHERE a.user_id = u.id AND a.status = 'published' AND a.is_deleted = 0 AND a.narra = 0) AS article_count,
           (SELECT CASE WHEN b.until IS NULL OR b.until > ? THEN 1 ELSE 0 END
              FROM bans b WHERE b.user_id = u.id) AS banned,
           (SELECT 1 FROM password_requests pr WHERE pr.user_id = u.id) AS reset_pending,
           (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id) AS is_following
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    ${orderBy}
    LIMIT ? OFFSET ?`;

  // 老库可能还没建 roles/bans 表 -> 退回不含角色与封禁状态的版本
  const plainQuery = `
    SELECT u.id, u.username, u.created_at,
           p.nickname, p.avatar_url, p.bio,
           99 AS role_rank, NULL AS role_label,
           (SELECT COUNT(*) FROM articles a
             WHERE a.user_id = u.id AND a.status = 'published' AND a.is_deleted = 0 AND a.narra = 0) AS article_count,
           NULL AS banned, NULL AS reset_pending
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    ${orderBy}
    LIMIT ? OFFSET ?`;

  try {
    let rows;
    try {
      rows = await env.DB.prepare(richQuery).bind(now, viewer.id, size, offset).all();
    } catch (err) {
      console.warn('用户目录查询降级:', err && (err.message || err.cause) || err);
      rows = await env.DB.prepare(plainQuery).bind(size, offset).all();
    }

    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users`).first();
    const total = totalRow ? totalRow.count : 0;

    const list = (rows.results || []).map(u => ({
      id: u.id,
      username: u.username,
      nickname: u.nickname || u.username,
      avatar_url: u.avatar_url || null,
      bio: u.bio || null,
      roles: u.role_label ? [u.role_label] : [],
      articles: u.article_count || 0,
      // 谁被封禁了不往外说: 只有能管理的人才看得到这个标记
      banned: canModerate ? !!u.banned : false,
      // 有没有待处理的改密请求 (只有站长需要知道)
      reset_pending: canRemove ? !!u.reset_pending : false,
      // 我关注过他没有 (右键菜单的「关注 / 取消关注」靠它)
      is_following: !!u.is_following,
      joined_at: u.created_at
    }));

    return Response.json({
      users: list,
      page, size, total,
      hasMore: offset + list.length < total,
      // 前端据此决定右键菜单里出现哪些动作 (服务端仍会再校验一遍)
      can: { moderate: canModerate, remove: canRemove }
    });
  } catch (err) {
    console.error('用户目录失败:', err);
    return Response.json({ error: '加载用户失败' }, { status: 500 });
  }
}


// asyfunc 用户名存在性: GET /api/users/exists
async function handleUsersExist(env, url) {
  // 正文里的 @提及: 前端把一篇文章里出现的用户名拼成 ?names=a,b,c 一次问过来
  // 精确匹配 (正文必须写用户名, 写成昵称就当普通链接); 昵称只用于展示, 空昵称用用户名兜底
  // 不能要求登录: 游客也要能看文章, 提及的上色不能因此失效
  const names = (url.searchParams.get('names') || '')
    .split(',')
    .map(s => s.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 50);
  const unique = [...new Set(names)];
  if (!unique.length) return Response.json({ users: [] });

  const placeholders = unique.map(() => '?').join(',');
  try {
    const { results } = await env.DB.prepare(
      `SELECT u.username, COALESCE(NULLIF(p.nickname, ''), u.username) AS nickname
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.username IN (${placeholders})`
    ).bind(...unique).all();
    return Response.json(
      { users: (results || []).map(r => ({ username: r.username, nickname: r.nickname || r.username })) },
      { headers: { 'Cache-Control': 'public, max-age=60' } } // 一分钟内不用再问
    );
  } catch (err) {
    console.error('查询用户名失败:', err);
    return Response.json({ users: [] }); // 查不到就都当普通链接, 不阻断正文
  }
}


// asyfunc 用户名可用性: GET /api/username/check
async function handleUsernameCheck(env, url) {
  const check = checkUsername(url.searchParams.get('username') || '');
  if (!check.ok) {
    return Response.json({ available: false, username: null, reason: check.error });
  }
  try {
    const taken = await env.DB.prepare(
      `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(check.value).first();
    return Response.json({
      available: !taken,
      username: check.value,
      reason: taken ? '用户名已被占用' : ''
    });
  } catch (err) {
    // 查不动就放行: 前端提交时还会再拦一次, 不能因为查询失败就骗人说「能用」
    console.error('查用户名占用失败:', err);
    return Response.json({ available: true, username: check.value, reason: '', uncertain: true });
  }
}


// asyfunc 逆地理编码: GET /api/geo/reverse
async function handleGeoReverse(request, env, url) {
  // 位置栏的「定位」: 经纬度换英文地址; 必须服务端代问 (浏览器直连被 CORS 挡, 且要自定义 UA)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lon = parseFloat(url.searchParams.get('lon') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: '坐标不合法' }, { status: 400 });
  }

  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = geoCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return Response.json({ label: cached.label, cached: true });
  }

  const limited = await checkRateLimit(env, `geo:${user.id}`, 20, 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `定位过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  try {
    const label = await reverseGeocode(lat, lon);
    if (!label) return Response.json({ error: '未能解析该地点，请手动填写' }, { status: 404 });
    geoCache.set(cacheKey, { label, exp: Date.now() + 60 * 60 * 1000 });
    return Response.json({ label });
  } catch (err) {
    console.error('反查位置失败:', err);
    return Response.json({ error: '查询失败，请稍后再试' }, { status: 500 });
  }
}


export { handleTerminalAccess, handleTerminalIota, handleUpdateProfile, handleViewPermissions, handlePublicUser, handleListUsers, handleUsersExist, handleUsernameCheck, handleGeoReverse };
