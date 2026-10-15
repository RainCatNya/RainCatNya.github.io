/* handlers/auth.js 注册登录 */
/*
  内容: 注册 / 登录 / 退出 / 当前用户 / 验证密码 / 注销与撤销
  依赖: ../common.js(会话 权限 限流) / ./totp.js(动态令牌)
*/

import { groupLabel, syncGroupAttributes } from '../permission.js';
import { DELETE_GRACE_MS, EMAIL_MAX, checkRateLimit, checkUsername, clientIp, consumeVerifyPass, countUnreadChats, countUnreadNotices, createSession, emailTakenByOther, getSessionUser, hasPassword, hashPassword, isBanned, isValidEmail, issueVerifyPass, loadDeleteCooldown, loadEmailState, loadPendingDeletion, loadPermissions, loadSessionUser, loadUserGroup, mailConfigured, ownerUserIdList, parseCookies, randomHex, retryText, sendNotice, verifyUserPassword } from '../common.js';
import { totpEnabled, verifyTotpForUser } from './totp.js';


// asyfunc 注册: POST /api/register
async function handleRegister(request, env, url) {
  // 防脚本批量注册: 每 IP 每小时 5 个
  const limited = await checkRateLimit(env, `register:${clientIp(request)}`, 5, 60 * 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `注册过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.username || !body.password) {
    return Response.json({ error: '用户名和密码不能为空' }, { status: 400 });
  }

  const rawName = String(body.username).trim();
  const password = String(body.password);
  // 邮箱必填: 它就是身份凭证 (注销要验证码, 改密要邮件链接), 注册后只能换绑; 顺手统一小写
  const email = body.email ? String(body.email).trim().toLowerCase().slice(0, EMAIL_MAX) : '';
  const nickname = body.nickname ? String(body.nickname).trim() : rawName;
  const avatar = body.avatar ? String(body.avatar).trim() : null;
  const bio = body.bio ? String(body.bio).trim() : null;

  // 用户名合规: 半角字母 / 数字 / _ / -, 3–20 位, 首尾必须是字母或数字
  // 收紧是因为它会进 URL (/u/<用户名>); 中文显示名请用「昵称」(profiles.nickname, 不限字符)
  const nameCheck = checkUsername(rawName);
  if (!nameCheck.ok) return Response.json({ error: nameCheck.error }, { status: 400 });
  // 入库用小写版: 全站查询都按小写走, 大小写只保留在昵称里
  const username = nameCheck.value;
  if (password.length < 6) {
    return Response.json({ error: '密码至少 6 个字符' }, { status: 400 });
  }
  if (!email) {
    return Response.json({ error: '请填写邮箱（注册后不能随便改，它用来验证身份）' }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return Response.json({ error: '邮箱格式不正确' }, { status: 400 });
  }

  try {
    // 一个邮箱只能被一个账号验证 (未验证的不占位), 注册时先拦一道
    if (await emailTakenByOther(env, email, 0)) {
      return Response.json({ error: '这个邮箱已被其他账号验证' }, { status: 409 });
    }
    // 查重必须走 LOWER(...), 否则 RainCatNya 与 raincatnya 会变成两个账号
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).bind(username).first();
    if (existing) {
      return Response.json({ error: '用户名已被占用' }, { status: 409 });
    }

    const salt = randomHex(16);
    const passwordHash = await hashPassword(password, salt);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO users (username, password_hash, salt, email, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(username, passwordHash, salt, email, now).run();

    const user = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first();

    // 顺便建一份默认资料 (other 留给「自定义信息」, 默认空)
    await env.DB.prepare(
      `INSERT INTO profiles (user_id, nickname, avatar_url, bio, other, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`
    ).bind(user.id, nickname, avatar, bio, now, now).run();

    // 角色不用管: users.role 默认就是 'user' (普通用户)

    // 注册即登录
    return await createSession(env, user.id, url);
  } catch (err) {
    // 查重与写入之间被人抢先: 唯一索引会拦住, 按 409 报「用户名被占用」而不是 500
    if (/UNIQUE|constraint/i.test(String(err && err.message))) {
      return Response.json({ error: '用户名已被占用' }, { status: 409 });
    }
    console.error('注册失败:', err);
    return Response.json({ error: '注册失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 登录: POST /api/login
async function handleLogin(request, env, url) {
  // 防密码爆破: 每 IP 每 15 分钟 20 次
  const limited = await checkRateLimit(env, `login:${clientIp(request)}`, 20, 15 * 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `尝试次数过多，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.username || !body.password) {
    return Response.json({ error: '请输入用户名和密码' }, { status: 400 });
  }

  const username = String(body.username).trim();
  const password = String(body.password);

  try {
    // 登录也不分大小写 (与注册那侧的查重对齐)
    const user = await env.DB.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`).bind(username).first();
    if (!user) {
      return Response.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const hash = await hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      return Response.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    return await createSession(env, user.id, url);
  } catch (err) {
    console.error('登录失败:', err);
    return Response.json({ error: '登录失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 退出登录: POST /api/logout
async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.foraine_session;
  if (token) {
    try {
      await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    } catch (err) {
      console.error('退出登录失败:', err);
    }
  }
  const cookie = `foraine_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}


// asyfunc 当前用户: GET /api/me
async function handleMe(request, env) {
  // 未登录返回 null
  const cookies = parseCookies(request);
  const token = cookies.foraine_session;
  if (!token) return Response.json({ user: null });

  try {
    const user = await loadSessionUser(env, token);
    if (!user) return Response.json({ user: null });

  /* 每次登录 (带上会话请求) 重新检查一遍属性: 缺哪条补哪条 —— 用户 2026-09-28 定的,
       「foraine.iota 在用户登录时自动创建, 每次登录重新检查一次, 若不存在则重新创建」。
       失败不影响下面任何一步 */
    try {
      await syncGroupAttributes(env, user.id, await loadUserGroup(env, user));
    } catch (err) {
      console.warn('登录补属性跳过:', (err && (err.message || err.cause)) || err);
    }

    // 权限组与权限给前端决定是否显示管理入口; 表缺失时降级, 不能拖垮登录
    let roles = [];
    let perms = new Set();
    try {
      const group = await loadUserGroup(env, user);
      roles = [groupLabel(group)];
      perms = await loadPermissions(env, user.id);
    } catch (err) {
      console.error('加载权限组失败 (已降级为空):', (err && (err.message || err.cause)) || err);
    }

    // 未读站内信 + 未读私信 + 封禁状态 (都在 try 里降级, 表没建时当 0 / 未封禁)
    let unread = 0;
    let ban = null;
    let chatUnread = 0;
    try {
      unread = await countUnreadNotices(env, user.id);
      ban = await isBanned(env, user.id);
      chatUnread = await countUnreadChats(env, user.id);
    } catch (err) {
      console.error('读取站内信/封禁状态失败 (已降级):', err && (err.message || err) || err);
    }

    return Response.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        bio: user.bio,
        other: user.other,
        // 个性化: 主页背景公开 / 聊天背景只有自己看得到; 都是桶里的完整 URL, 带 ?t= 破图缓存
        bg_image: user.bg_image || null,
        bg_blur: user.bg_blur || 0,
        chat_bg: user.chat_bg || null,
        chat_blur: user.chat_blur || 0,
        // 字体: '' = 默认字体, 'hand' = 想念是枫糖海盐味
        font_chat: user.font_chat || '',
        font_forum: user.font_forum || '',
        font_article: user.font_article || '',
        github_login: user.github_login || null,
        // 有没有密码: 决定注销要不要走「输密码」那一步 (OAuth 建号没有密码)
        has_password: hasPassword(user),
        // 邮箱验证状态 + 站点配没配发信 (前端据此显示「验证邮箱」还是「换绑邮箱」); 老库缺列当未验证
        email_verified: Boolean(user.email_verified),
        mail_ready: mailConfigured(env),
        // 动态令牌: 启用过就把「第三方」那颗按钮变灰
        totp_enabled: await totpEnabled(env, user.id),
        // 注销申请: null = 没在注销里; { at, deleteAt, daysLeft } = 还在保留期
        pending_delete: await loadPendingDeletion(env, user.id),
        delete_cooldown: await loadDeleteCooldown(env, user.id),
        // 未读站内信数量 (个人页标签徽章 / 顶部小红点)
        unread,
        // 未读私信数 (顶部「私信」图标的红点 / 会话列表)
        chat_unread: chatUnread,
        // 封禁状态: null = 正常; { reason, until } (until 为 null = 永久)
        ban,
        roles,
        permissions: Array.from(perms)
      }
    });
  } catch (err) {
    console.error('获取登录状态失败:', err && (err.message || err.cause) || err);
    return Response.json({ user: null });
  }
}


// asyfunc 验证密码: POST /api/account/verify
async function handleVerifyPassword(request, env) {
  // 注销前的密码校验 (两步确认第一步), 只回答对 / 不对
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const limited = await checkRateLimit(env, `verify:${user.id}`, 10, 15 * 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `尝试次数过多，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const password = body && body.password ? String(body.password) : '';
  if (!password) return Response.json({ error: '请输入密码' }, { status: 400 });

  // 要完整行 (带 salt): getSessionUser 只取了 id/username/nickname
  const row = await env.DB.prepare(
    `SELECT id, username, password_hash, salt FROM users WHERE id = ?`
  ).bind(user.id).first();
  if (!row || !(await verifyUserPassword(row, password))) {
    return Response.json({ error: '密码不正确' }, { status: 403 });
  }
  // 验过了就发一张通行证: 后面的敏感操作凭它放行, 不再把密码 / 验证码传来传去
  return Response.json({ ok: true, pass: await issueVerifyPass(env, user.id, 'password') });
}


// asyfunc 申请注销: POST /api/account/delete
async function handleDeleteAccount(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const confirm = body && body.confirm ? String(body.confirm).trim() : '';
    const pass = body && body.pass ? String(body.pass).trim() : '';
    /* 身份验证在「验证身份」弹窗里做过, 服务端只认它发的那张一次性通行证 (5 分钟, 用掉即删)
       旧的邮箱码那条查的是 purpose='delete', 而弹窗发的是 'verify' —— 两码事, 那条路一直是坏的 */
    if (!(await consumeVerifyPass(env, me.id, pass))) {
      return Response.json({ error: '请先完成身份验证' }, { status: 403 });
    }

    if (await loadPendingDeletion(env, me.id)) {
      return Response.json({ error: '这个账号已经在注销流程里了（在个人页可以取消）' }, { status: 400 });
    }
    /* 取消注销之后 7 天内不许再申请 (前一次反悔说明这个决定要冷静一下), 个人页那个按钮也是灰的 */
    const cooldown = await loadDeleteCooldown(env, me.id);
    if (cooldown) {
      return Response.json({ error: `取消注销后 ${cooldown.daysLeft} 天内不能再次申请注销` }, { status: 400 });
    }
    if (confirm.toLowerCase() !== String(me.username).toLowerCase()) {
      return Response.json({ error: '请输入你的用户名以确认' }, { status: 400 });
    }
    // 站长保护: 不能把最后一个能管理站点的人注销了
    const perms = await loadPermissions(env, me.id);
    if (perms.has('*')) {
      try {
        const owners = await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM users WHERE role = 'owner'`
        ).first();
        if (owners && owners.count <= 1) {
          return Response.json({ error: '你是唯一的站长，注销后站点将无人可管理' }, { status: 403 });
        }
      } catch (e) { /* RBAC 表缺失时跳过这个检查 */ }
    }

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET is_deleted = 1, deleted_at = ? WHERE id = ?`).bind(now, me.id),
      env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'delete'`).bind(me.id)
    ]);

    // 告诉站长们一声 (反悔要靠他们或用户自己点「取消注销」)
    try {
      const owners = await ownerUserIdList(env);
      for (const ownerId of owners) {
        if (ownerId === me.id) continue;
        await sendNotice(env, ownerId, {
          kind: 'system',
          title: '有用户申请注销账号',
          body: `${me.nickname || me.username}（@${me.username}）申请了注销账号。\n`
            + `账号会保留 ${DELETE_GRACE_MS / 86400000} 天（到期由系统自动删除），期间他可以在个人页取消。`
        });
      }
    } catch (err) {
      console.warn('通知站长注销申请失败:', err);
    }

    // 会话不销毁: 用户还要靠它登录进来点「取消注销」, 这就是保留 7 天的意义
    return Response.json({ ok: true, pending_days: DELETE_GRACE_MS / 86400000, delete_at: now + DELETE_GRACE_MS });
  } catch (err) {
    console.error('注销账号失败:', err && (err.message || err.cause) || err);
    return Response.json({ error: '注销失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 撤销注销: POST /api/account/cancel-deletion
async function handleCancelDeletion(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const pending = await loadPendingDeletion(env, me.id);
    if (!pending) return Response.json({ error: '这个账号没有在注销流程里' }, { status: 400 });

    await env.DB.prepare(
      `UPDATE users SET is_deleted = 0, deleted_at = NULL, delete_cancelled_at = ? WHERE id = ?`
    ).bind(Date.now(), me.id).run();

    try {
      const owners = await ownerUserIdList(env);
      for (const ownerId of owners) {
        if (ownerId === me.id) continue;
        await sendNotice(env, ownerId, {
          kind: 'system',
          title: '有用户取消了注销申请',
          body: `${me.nickname || me.username}（@${me.username}）取消了注销申请，账号恢复正常。`
        });
      }
    } catch (err) {
      console.warn('通知站长取消失败:', err);
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error('取消注销失败:', err);
    return Response.json({ error: '取消失败，请稍后再试' }, { status: 500 });
  }
}


export { handleRegister, handleLogin, handleLogout, handleMe, handleVerifyPassword, handleDeleteAccount, handleCancelDeletion };
