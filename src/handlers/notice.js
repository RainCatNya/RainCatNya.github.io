/* handlers/notice.js 站内信与关注 */
/*
  内容: 站内信列表 / 发送 / 删除 / 标记已读 + 关注状态与开关
  依赖: ../common.js(会话 限流 sendNotice 关注统计)
*/

import { NOTICE_BODY_MAX, countUnreadNotices, followStats, getSessionUser, hitRateLimit, peekRateLimit, retryText, sendNotice } from '../common.js';


// asyfunc 站内信列表: GET /api/notices
async function handleListNotices(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    // 带上发信人; 系统通知的 from_user_id 是 NULL, 前端据此换成别的话
    const rows = await env.DB.prepare(
      `SELECT n.id, n.kind, n.title, n.body, n.read_at, n.created_at, n.article_id, n.comment_id,
              u.username AS from_username, COALESCE(p.nickname, u.username) AS from_nickname,
              p.avatar_url AS from_avatar
       FROM notices n
       LEFT JOIN users u ON u.id = n.from_user_id
       LEFT JOIN profiles p ON p.user_id = n.from_user_id
       WHERE n.to_user_id = ? ORDER BY n.id DESC LIMIT 100`
    ).bind(user.id).all();
    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notices WHERE to_user_id = ?`
    ).bind(user.id).first();
    return Response.json({
      notices: rows.results || [],
      total: total ? total.count : 0,
      unread: await countUnreadNotices(env, user.id)
    });
  } catch (err) {
    console.error('读取站内信失败:', err);
    return Response.json({ error: '加载站内信失败' }, { status: 500 });
  }
}


// asyfunc 发送站内信: POST /api/notices/send
async function handleSendNotice(request, env) {
  // 用户之间互发
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const to = String(payload.to || '').trim();
  const text = String(payload.body || '').trim();

  if (!to) return Response.json({ error: '请选择收信人' }, { status: 400 });
  if (!text) return Response.json({ error: '信是空的' }, { status: 400 });
  if (text.length > NOTICE_BODY_MAX) {
    return Response.json({ error: `一封站内信最多 ${NOTICE_BODY_MAX} 字` }, { status: 400 });
  }
  if (to.toLowerCase() === String(me.username).toLowerCase()) {
    return Response.json({ error: '不能给自己发站内信' }, { status: 400 });
  }

  // 防刷: 每分钟 5 封 / 每小时 30 封 (peek + 成功后计数, 发失败不占额度)
  const perMinute = await peekRateLimit(env, `notice:min:${me.id}`, 5);
  if (!perMinute.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(perMinute.retryAfterSec)}后再试` }, { status: 429 });
  }
  const perHour = await peekRateLimit(env, `notice:hour:${me.id}`, 30);
  if (!perHour.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(perHour.retryAfterSec)}后再试` }, { status: 429 });
  }

  try {
    const target = await env.DB.prepare(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(to).first();
    if (!target) return Response.json({ error: '收信人不存在' }, { status: 404 });

    await sendNotice(env, target.id, {
      kind: 'user',
      title: (me.nickname || me.username) + ' 的站内信',
      body: text,
      fromUserId: me.id
    });
    await hitRateLimit(env, `notice:min:${me.id}`, 60 * 1000);
    await hitRateLimit(env, `notice:hour:${me.id}`, 60 * 60 * 1000);
    return Response.json({ ok: true, to: target.username });
  } catch (err) {
    console.error('发站内信失败:', err);
    return Response.json({ error: '发送失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 删除站内信: POST /api/notices/delete
async function handleDeleteNotice(request, env) {
  // 删掉一条自己的站内信 (卡片右边的小垃圾桶); 只看 to_user_id, 审计记录在 moderation_log 不受影响
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const id = body ? parseInt(body.id, 10) : NaN;
  if (!Number.isInteger(id)) return Response.json({ error: '无效的站内信' }, { status: 400 });

  try {
    await env.DB.prepare(
      `DELETE FROM notices WHERE id = ? AND to_user_id = ?`
    ).bind(id, user.id).run();
    return Response.json({ ok: true, unread: await countUnreadNotices(env, user.id) });
  } catch (err) {
    console.error('删除站内信失败:', err);
    return Response.json({ error: '删除失败' }, { status: 500 });
  }
}


// asyfunc 标记已读: POST /api/notices/read
async function handleReadNotices(request, env) {
  // { all: true } 或 { ids: [1,2] } 或 { id: 1 }
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: '无效的请求' }, { status: 400 });

  try {
    if (body.all) {
      await env.DB.prepare(
        `UPDATE notices SET read_at = ? WHERE to_user_id = ? AND read_at IS NULL`
      ).bind(Date.now(), user.id).run();
    } else {
      const raw = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
      const ids = raw.map(v => parseInt(v, 10)).filter(Number.isInteger);
      if (!ids.length) return Response.json({ error: '缺少要标记的站内信' }, { status: 400 });
      const holders = ids.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE notices SET read_at = ? WHERE to_user_id = ? AND read_at IS NULL AND id IN (${holders})`
      ).bind(Date.now(), user.id, ...ids).run();
    }
    return Response.json({ ok: true, unread: await countUnreadNotices(env, user.id) });
  } catch (err) {
    console.error('标记站内信失败:', err);
    return Response.json({ error: '操作失败' }, { status: 500 });
  }
}


// asyfunc 关注状态: GET /api/follow
async function handleFollowState(request, env, url) {
  // 左侧「N 名追随者」用: 计数谁都能看
  const username = (url.searchParams.get('username') || '').trim();
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });

  try {
    const target = await env.DB.prepare(
      `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(username).first();
    if (!target) return Response.json({ error: '用户不存在' }, { status: 404 });

    const viewer = await getSessionUser(request, env);
    return Response.json(await followStats(env, target.id, viewer ? viewer.id : 0));
  } catch (err) {
    console.error('读取关注状态失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 关注 / 取关: POST /api/follow
async function handleToggleFollow(request, env) {
  // payload.follow 不传就翻转, 传了以它为准
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const username = String(payload.username || '').trim();
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });
  if (username.toLowerCase() === String(me.username).toLowerCase()) {
    return Response.json({ error: '不能关注自己' }, { status: 400 });
  }

  try {
    const target = await env.DB.prepare(
      `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(username).first();
    if (!target) return Response.json({ error: '用户不存在' }, { status: 404 });

    const existing = await env.DB.prepare(
      `SELECT 1 AS ok FROM follows WHERE follower_id = ? AND followee_id = ?`
    ).bind(me.id, target.id).first();

    const follow = payload.follow === undefined ? !existing : !!payload.follow;
    if (follow && !existing) {
      await env.DB.prepare(
        `INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)`
      ).bind(me.id, target.id, Date.now()).run();
    } else if (!follow && existing) {
      await env.DB.prepare(
        `DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`
      ).bind(me.id, target.id).run();
    }

    // 别在这里写 following: follow, followStats 会返回同名字段 (那是对方关注了多少人)
    // 会被后面的展开覆盖, 前端就误判成「取关」; 统一看 is_following
    return Response.json({ ok: true, ...(await followStats(env, target.id, me.id)) });
  } catch (err) {
    console.error('关注失败:', err);
    return Response.json({ error: '操作失败，请稍后再试' }, { status: 500 });
  }
}


export { handleListNotices, handleSendNotice, handleDeleteNotice, handleReadNotices, handleFollowState, handleToggleFollow };
