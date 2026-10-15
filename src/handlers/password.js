// handlers/password.js —— 对应的一批接口处理器。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。

import { MAIL_LIMIT, actorName, checkPasswordRule, consumeVerifyPass, createEmailToken, createSessionCookie, getSessionUser, hasPermission, hashPassword, hitRateLimit, loadEmailState, loadPermissions, logModeration, mailConfigured, ownerUserIdList, peekRateLimit, randomHex, retryText, sendMail, sendNotice, setUserPassword } from '../common.js';


async function handlePasswordResetStart(request, env, url) {
  // 发「重置密码」邮件; 必须已经验证过邮箱 (否则没有可信的送达地址)
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  if (!mailConfigured(env)) return Response.json({ error: '邮件服务未配置' }, { status: 503 });

  const state = await loadEmailState(env, me.id);
  if (!state.email || !state.verified) {
    return Response.json({ error: '这个账号还没有验证过邮箱，请改用「向站长申请」' }, { status: 400 });
  }

  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const token = await createEmailToken(env, me.id, 'reset', state.email);
  const sent = await sendMail(env, {
    to: state.email,
    subject: '重置你的 Foraine 密码',
    title: '重置密码',
    lines: [
      `@${me.username}，有人（希望是你）申请重置这个账号的密码。`,
      '若非本人操作，请忽略此邮件。Foraine 建议你更改密码，以提高账户安全性'
    ],
    link: `${url.origin}/api/email/confirm?token=${token}`,
    linkText: '重置密码',
    tip: '链接 30 分钟内有效，用过一次就作废。'
  });
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, email: state.email });
}


/* asyfunc 重设密码 (本人, 要一次性通行证): POST /api/password/set */
async function handlePasswordSet(request, env, url) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const pass = body && body.pass ? String(body.pass).trim() : '';
  const rule = checkPasswordRule(body && body.password);
  if (!await consumeVerifyPass(env, me.id, pass)) {
    return Response.json({ error: '身份验证已过期，请重新验证' }, { status: 403 });
  }
  if (!rule.ok) return Response.json({ error: rule.error }, { status: 400 });
  await setUserPassword(env, me.id, rule.value);
  await env.DB.prepare(`DELETE FROM password_requests WHERE user_id = ?`).bind(me.id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(me.id).run();
  await sendNotice(env, me.id, {
    kin: 'system',
    title: '密码已重设',
    body: '你的密码刚刚在个人页被重设，之前的登录状态已全部失效。如果不是你本人操作，请立刻联系站长。'
  });
  const cookie = await createSessionCookie(env, me.id, url);
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}

async function handlePasswordReset(request, env, url) {
  // 拿邮件里的令牌换新密码 (不要求登录: 令牌本身就是凭证)
  const body = await request.json().catch(() => null);
  const token = body ? String(body.token || '').trim() : '';
  const rule = checkPasswordRule(body && body.password);
  if (!token) return Response.json({ error: '缺少令牌' }, { status: 400 });
  if (!rule.ok) return Response.json({ error: rule.error }, { status: 400 });

  const row = await env.DB.prepare(
    `SELECT user_id, purpose, expires_at FROM email_tokens WHERE token = ?`
  ).bind(token).first();
  if (!row || row.purpose !== 'reset') return Response.json({ error: '链接无效或已用过' }, { status: 400 });
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE token = ?`).bind(token).run();
    return Response.json({ error: '链接已过期，请重新发起' }, { status: 400 });
  }

  await setUserPassword(env, row.user_id, rule.value);
  await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'`).bind(row.user_id).run();
  await env.DB.prepare(`DELETE FROM password_requests WHERE user_id = ?`).bind(row.user_id).run();
  // 旧会话全部作废 (号要是被别人拿着, 这时候就被踢出去了), 但给本人发一条新的
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id).run();
  const target = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`).bind(row.user_id).first();
  await sendNotice(env, row.user_id, {
    kind: 'system',
    title: '密码已重置',
    body: '你的密码刚刚通过邮箱验证被重置，之前的登录状态已全部失效。如果不是你本人操作，请立刻联系站长。'
  });

  const cookie = await createSessionCookie(env, row.user_id, url);
  return Response.json(
    { ok: true, username: target ? target.username : null },
    { headers: { 'Set-Cookie': cookie } }
  );
}


async function handlePasswordChangeRequest(request, env) {
  // 「向站长申请」: 把加密后的新密码放进待办, 并给每个站长发一封请求信
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const rule = checkPasswordRule(body && body.password);
  if (!rule.ok) return Response.json({ error: rule.error }, { status: 400 });

  const salt = randomHex(16);
  const hash = await hashPassword(rule.value, salt);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO password_requests (user_id, password_hash, salt, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(me.id, hash, salt, Date.now()).run();

  const owners = await ownerUserIdList(env);
  for (const ownerId of owners) {
    await sendNotice(env, ownerId, {
      kind: 'system',
      title: '密码修改请求',
      body: `${me.nickname || me.username}（@${me.username}）申请修改密码。\n` +
        `新密码：${hash}\n` +
        `批准：「连携星点」中右键该用户 → 「批准改密请求」。`
    });
  }
  return Response.json({ ok: true, owners: owners.length });
}


async function handleAdminApprovePassword(request, env) {
  // 站长同意改密请求 -> 立即生效
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.access')) return Response.json({ error: '仅站长可操作' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const username = body ? String(body.username || '').trim() : '';
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });

  try {
    const target = await env.DB.prepare(`SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`).bind(username).first();
    if (!target) return Response.json({ error: '用户不存在' }, { status: 404 });

    const pending = await env.DB.prepare(
      `SELECT password_hash, salt FROM password_requests WHERE user_id = ?`
    ).bind(target.id).first();
    if (!pending) return Response.json({ error: '这个用户没有待处理的改密请求' }, { status: 400 });

    await env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`)
      .bind(pending.password_hash, pending.salt, target.id).run();
    await env.DB.prepare(`DELETE FROM password_requests WHERE user_id = ?`).bind(target.id).run();
    // 旧会话作废, 让他用新密码重新登进来
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(target.id).run();

    await logModeration(env, { action: 'password.approve', targetUser: target.id, byUserId: user.id });
    await sendNotice(env, target.id, {
      kind: 'system',
      title: '你的新密码已生效',
      body: `${actorName(user)} 同意了你的改密请求，请用你申请时填的那个新密码登录。`
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('批准改密失败:', err);
    return Response.json({ error: '操作失败，请稍后再试' }, { status: 500 });
  }
}


/* 会话列表: 每个聊过的人取「最后一条消息」+ 未读数 (手机端 /chat/ 页的首页) */


export { handlePasswordSet, handlePasswordResetStart, handlePasswordReset, handlePasswordChangeRequest, handleAdminApprovePassword };
