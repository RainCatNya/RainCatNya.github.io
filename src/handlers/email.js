/* email.js 邮箱验证与换绑 */
/*
  内容: 验证邮箱 / 换绑邮箱 / 注销与身份验证码 / 邮件链路自查 / 邮件链接落地
  依赖: ../common.js(令牌, 限流, 发信, 会话, 权限)
*/

import { DELETE_CODE_TTL, EMAIL_MAX, EMAIL_TOKEN_TTL, MAIL_LIMIT, consumeVerifyPass, createEmailToken, describeResendError, emailTakenByOther, getSessionUser, hitRateLimit, isValidEmail, issueVerifyPass, loadEmailState, loadPermissions, mailConfigured, peekRateLimit, redirectTo, retryText, sendMail, verifyUserPassword } from '../common.js';


// asyfunc 发验证邮件: POST /api/email/verify
async function handleEmailVerifyStart(request, env, url) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const state = await loadEmailState(env, me.id);
  if (!state.email) return Response.json({ error: '请先填写邮箱' }, { status: 400 });
  if (!isValidEmail(state.email)) return Response.json({ error: '邮箱格式不正确' }, { status: 400 });
  if (state.verified) return Response.json({ error: '这个邮箱已经验证过了' }, { status: 400 });
  if (!mailConfigured(env)) {
    return Response.json({ error: '邮件服务未配置，暂时无法发送验证邮件' }, { status: 400 });
  }
  if (await emailTakenByOther(env, state.email, me.id)) {
    return Response.json({ error: '这个邮箱已被其他账号验证' }, { status: 409 });
  }

  const token = await createEmailToken(env, me.id, 'verify', state.email);
  const sent = await sendMail(env, {
    to: state.email,
    subject: '验证你的 Foraine 邮箱',
    title: '验证 Foraine 邮箱',
    lines: [`@${me.username}，点击下面的按钮完成邮箱验证。`],
    link: `${url.origin}/api/email/confirm?token=${token}`,
    linkText: '验证邮箱',
    tip: '链接 30 分钟内有效。'
  });
  if (!sent.ok) {
    // 发不出去就别留个能用的令牌在库里 (也不计数: 失败不该占额度)
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, email: state.email, ttl_minutes: EMAIL_TOKEN_TTL / 60000 });
}


// asyfunc 换绑第一步(给旧邮箱发 6 位码): POST /api/email/unbind
async function handleEmailRebindStart(request, env, url) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const state = await loadEmailState(env, me.id);
  if (!state.email || !state.verified) {
    return Response.json({ error: '当前没有已验证的邮箱' }, { status: 400 });
  }
  if (!mailConfigured(env)) {
    return Response.json({ error: '邮件服务未配置，暂时无法发送验证邮件' }, { status: 400 });
  }
  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  // 码存在 token 列里 (purpose='unbind'); 验过之后才发通行证, 不用密码也不再发链接
  const code = makeEmailCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'unbind'`).bind(me.id),
    env.DB.prepare(
      `INSERT INTO email_tokens (token, user_id, purpose, email, expires_at, created_at)
       VALUES (?, ?, 'unbind', ?, ?, ?)`
    ).bind(code, me.id, state.email, now + DELETE_CODE_TTL, now)
  ]);

  const sent = await sendMail(env, {
    to: state.email,
    subject: 'Foraine 邮箱换绑',
    title: '换绑邮箱',
    lines: [
      `${me.username}，我们收到了你换绑邮箱的请求。`,
      `验证码：<b style="font-size:22px;letter-spacing:3px">${code}</b>`,
      '把上面的 6 位数字填回页面里，接下来会让你填写新邮箱。'
    ],
    tip: '10 分钟内有效。若非本人操作，请忽略此邮件，你的邮箱不会发生任何变化。'
  });
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'unbind'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, email: state.email });
}

// asyfunc 换绑第二步(旧邮箱的码 → 通行证): POST /api/email/unbind/verify
async function handleEmailRebindVerify(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const code = body && body.code ? String(body.code).trim() : '';
  if (!/^\d{6}$/.test(code)) return Response.json({ error: '验证码是 6 位数字' }, { status: 400 });

  const row = await env.DB.prepare(
    `SELECT token, expires_at FROM email_tokens WHERE user_id = ? AND purpose = 'unbind'`
  ).bind(me.id).first();
  if (!row) return Response.json({ error: '请先发送验证邮件' }, { status: 400 });
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'unbind'`).bind(me.id).run();
    return Response.json({ error: '验证码已过期，请重新发送' }, { status: 400 });
  }
  if (row.token !== code) return Response.json({ error: '验证码不正确' }, { status: 403 });
  await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'unbind'`).bind(me.id).run();
  return Response.json({ ok: true, pass: await issueVerifyPass(env, me.id, 'email') });
}


// asyfunc 换绑第三步(通行证 + 新邮箱, 只发码不换): POST /api/email/rebind
// 先发码后换: 打错一个字母不会当场生效, 卡在验证码那一步
async function handleEmailRebind(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const pass = body && body.pass ? String(body.pass).trim() : '';
  const next = body && body.email ? String(body.email).trim().toLowerCase().slice(0, EMAIL_MAX) : '';
  if (!(await consumeVerifyPass(env, me.id, pass))) {
    return Response.json({ error: '身份验证已过期，请重新发起换绑' }, { status: 403 });
  }
  if (!isValidEmail(next)) return Response.json({ error: '邮箱格式不正确' }, { status: 400 });

  const state = await loadEmailState(env, me.id);
  if (next === state.email.toLowerCase()) {
    return Response.json({ error: '新邮箱和现在这个是同一个' }, { status: 400 });
  }
  if (await emailTakenByOther(env, next, me.id)) {
    return Response.json({ error: '这个邮箱已被其他账号验证' }, { status: 409 });
  }
  if (!mailConfigured(env)) {
    return Response.json({ error: '邮件服务未配置，暂时无法发送验证码' }, { status: 400 });
  }

  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  // 6 位码存在 token 列里, purpose = 'rebind', email = 想换成的那个新地址
  const code = makeEmailCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'rebind'`).bind(me.id),
    env.DB.prepare(
      `INSERT INTO email_tokens (token, user_id, purpose, email, expires_at, created_at)
       VALUES (?, ?, 'rebind', ?, ?, ?)`
    ).bind(code, me.id, next, now + DELETE_CODE_TTL, now)
  ]);

  const sent = await sendMail(env, {
    to: next,
    subject: '确认换绑到 Foraine 这个邮箱',
    title: '确认新邮箱',
    lines: [
      `@${me.username} 想把 Foraine 账号的邮箱换成这个地址。`,
      `验证码：<b style="font-size:22px;letter-spacing:3px">${code}</b>`,
      '把上面的 6 位数字填回页面里，换绑才算完成。'
    ],
    tip: '10 分钟内有效。若非本人操作，请忽略此邮件，你的邮箱不会发生任何变化。'
  });
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'rebind'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, pending: true, email: next, ttl_minutes: 10 });
}


// asyfunc 换绑收尾(新邮箱的码填对才真换): POST /api/email/rebind/confirm
async function handleEmailRebindConfirm(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const code = body && body.code ? String(body.code).trim() : '';
  if (!code) return Response.json({ error: '请输入验证码' }, { status: 400 });

  const pending = await env.DB.prepare(
    `SELECT token, email, expires_at FROM email_tokens WHERE user_id = ? AND purpose = 'rebind'`
  ).bind(me.id).first();
  if (!pending) return Response.json({ error: '请先填新邮箱、点「发送验证码」' }, { status: 400 });
  if (pending.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'rebind'`).bind(me.id).run();
    return Response.json({ error: '验证码已过期，请重新发送' }, { status: 400 });
  }
  if (pending.token !== code) return Response.json({ error: '验证码不正确' }, { status: 403 });

  const next = String(pending.email || '').toLowerCase();
  if (!isValidEmail(next)) return Response.json({ error: '新邮箱无效，请重新发起' }, { status: 400 });
  if (await emailTakenByOther(env, next, me.id)) {
    return Response.json({ error: '这个邮箱已被其他账号验证' }, { status: 409 });
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET email = ?, email_verified = 1 WHERE id = ?`).bind(next, me.id),
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose IN ('unbind', 'rebind', 'verify')`).bind(me.id)
  ]);
  return Response.json({ ok: true, email: next });
}


// 验证码固定 6 位, 三处生成都走这里; 改这里要同步改前端的 /^\d{6}$/
function makeEmailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// asyfunc 注销账号的验证码(6 位码, purpose='delete'): POST /api/email/code
async function handleEmailCode(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const state = await loadEmailState(env, me.id);
  if (!state.email) return Response.json({ error: '这个账号还没有邮箱' }, { status: 400 });
  if (!state.verified) {
    return Response.json({ error: '这个邮箱还没验证过，没法用来验证身份（先去点「验证邮箱」）' }, { status: 400 });
  }
  if (!mailConfigured(env)) {
    return Response.json({ error: '邮件服务未配置，暂时无法发送验证码' }, { status: 400 });
  }

  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const code = makeEmailCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'delete'`).bind(me.id),
    env.DB.prepare(
      `INSERT INTO email_tokens (token, user_id, purpose, email, expires_at, created_at)
       VALUES (?, ?, 'delete', ?, ?, ?)`
    ).bind(code, me.id, state.email, now + DELETE_CODE_TTL, now)
  ]);

  const sent = await sendMail(env, {
    to: state.email,
    subject: 'Foraine 账号注销验证码',
    title: '注销账号验证码',
    lines: [
      `${me.username}，我们收到了你注销 Foraine 账号的请求。`,
      `验证码：<b style="font-size:22px;letter-spacing:3px">${code}</b>`,
      '请在注销页面填入上方的 6 位数字'
    ],
    tip: '验证码 10 分钟内有效。不是你本人操作，请忽略这封信，并尝试修改密码。'
  });
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'delete'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, email: state.email, ttl_minutes: 10 });
}

/* 「验证身份」弹窗的邮箱那条 (6 位码) */
// asyfunc 身份验证弹窗发码: POST /api/verify/email/send
// 与注销那条分开: purpose 不同, 邮件也不一样 (在 D1 删一行却收到「注销验证码」会很吓人)
async function handleVerifyEmailSend(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const state = await loadEmailState(env, me.id);
  if (!state.email) return Response.json({ error: '这个账号还没有邮箱' }, { status: 400 });
  if (!state.verified) {
    return Response.json({ error: '这个邮箱还没验证过，用不了（先去点「验证邮箱」）' }, { status: 400 });
  }
  if (!mailConfigured(env)) {
    return Response.json({ error: '邮件服务未配置，暂时无法发送验证码' }, { status: 400 });
  }
  const limited = await peekRateLimit(env, `mail:${me.id}`, MAIL_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }
  const code = makeEmailCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`).bind(me.id),
    env.DB.prepare(
      `INSERT INTO email_tokens (token, user_id, purpose, email, expires_at, created_at)
       VALUES (?, ?, 'verify', ?, ?, ?)`
    ).bind(code, me.id, state.email, now + DELETE_CODE_TTL, now)
  ]);
  const sent = await sendMail(env, {
    to: state.email,
    subject: 'Foraine 身份验证码',
    title: '身份验证码',
    lines: [
      `${me.username}，你正在 Foraine 执行一个敏感操作，需要验证身份。`,
      `验证码：<b style="font-size:22px;letter-spacing:3px">${code}</b>`,
      '请在验证弹窗里填入上方的 6 位数字'
    ],
    tip: '验证码 10 分钟内有效。不是你本人操作，请忽略这封信，并尝试修改密码。'
  });
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`).bind(me.id).run();
    return Response.json({ error: sent.error }, { status: 400 });
  }
  await hitRateLimit(env, `mail:${me.id}`, 60 * 60 * 1000);
  return Response.json({ ok: true, email: state.email, ttl_minutes: 10 });
}

// asyfunc 校验身份验证码(只验不改状态, 成功即删防重放): POST /api/verify/email/check
async function handleVerifyEmailCheck(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return Response.json({ error: '验证码是 6 位数字' }, { status: 400 });
  const row = await env.DB.prepare(
    `SELECT token, expires_at FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`
  ).bind(me.id).first();
  if (!row) return Response.json({ error: '请先点「发送验证码」' }, { status: 400 });
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`).bind(me.id).run();
    return Response.json({ error: '验证码已过期，请重新发送' }, { status: 400 });
  }
  if (row.token !== code) return Response.json({ error: '验证码不正确' }, { status: 403 });
  await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'`).bind(me.id).run();
  // 验过了就发一张通行证: 敏感操作凭它放行
  return Response.json({ ok: true, pass: await issueVerifyPass(env, me.id, 'email') });
}


// asyfunc 站长自查邮件链路(密钥 / 发件人 / Resend 域名): GET /api/email/diag
async function handleEmailDiag(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, me.id);
  if (!perms.has('*')) return Response.json({ error: '只有站长能看' }, { status: 403 });

  const out = {
    mail_ready: mailConfigured(env),
    has_key: Boolean(env.RESEND_API_KEY),
    from: env.MAIL_FROM || null,
    domains: null,
    resend_error: null
  };

  if (env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        out.domains = ((body && body.data) || []).map(d => ({ name: d.name, status: d.status }));
      } else {
        out.resend_error = describeResendError(response.status, JSON.stringify(body || {}));
      }
    } catch (err) {
      out.resend_error = String((err && (err.message || err.cause)) || err);
    }
  }
  return Response.json(out);
}


// asyfunc 邮件里的链接落地(不要求登录, 令牌即凭证): GET /api/email/confirm
async function handleEmailConfirm(request, env, url) {
  // 邮件里那个链接: 不要求登录 (令牌本身就是凭证), 完事回个人页并带上结果参数
  const back = (reason) => redirectTo(`${url.origin}/profile?email=${reason}`);
  const token = url.searchParams.get('token') || '';
  if (!token) return back('invalid');

  const row = await env.DB.prepare(
    `SELECT token, user_id, purpose, email, expires_at FROM email_tokens WHERE token = ?`
  ).bind(token).first();
  if (!row) return back('invalid');
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM email_tokens WHERE token = ?`).bind(token).run();
    return back('expired');
  }

  // reset: 不消费令牌, 还要拿去调 /api/password/reset; 登录本人回个人页弹窗, 否则回登录页
  if (row.purpose === 'reset') {
    const viewer = await getSessionUser(request, env);
    const page = viewer && viewer.id === row.user_id ? '/profile' : '/login.html';
    return redirectTo(`${url.origin}${page}?reset=${token}`);
  }

  // unbind: 也不消费令牌, 且绝不清空邮箱 (真换在 /api/email/rebind)
  if (row.purpose === 'unbind') {
    const viewer = await getSessionUser(request, env);
    const page = viewer && viewer.id === row.user_id ? '/profile' : '/login.html';
    return redirectTo(`${url.origin}${page}?rebind=${token}`);
  }

  // verify: 一次性, 这轮令牌全部清掉 (含同用途的其它旧链接)
  await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?`)
    .bind(row.user_id, row.purpose).run();

  // verify: 发信之后可能又改过邮箱, 也可能别人先验证了同一个邮箱
  const state = await loadEmailState(env, row.user_id);
  if (!state.email) return back('invalid');
  if (row.email && state.email.toLowerCase() !== String(row.email).toLowerCase()) return back('changed');
  if (state.verified) return back('verified');
  if (await emailTakenByOther(env, state.email, row.user_id)) return back('taken');

  await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).bind(row.user_id).run();
  return back('verified');
}



export { handleEmailVerifyStart, handleEmailRebindStart, handleEmailRebindVerify, handleEmailRebind, handleEmailRebindConfirm, handleEmailCode, handleEmailDiag, handleEmailConfirm, handleVerifyEmailSend, handleVerifyEmailCheck };
