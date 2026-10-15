// handlers/admin.js —— 管理员 / 站长的那批操作 (封禁 / 删号 / 角色)。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。

import { AVATAR_PUBLIC_BASE, MOD_REASON_MAX, actorName, cleanupRemovedImages, deleteObject, getSessionUser, hasPermission, keyFromPublicUrl, loadPermissions, logModeration, notifyIndexNow, ownerUserIdList, remapUserId, sendNotice } from '../common.js';


async function handleModerateArticle(request, env, ctx) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "article.review")) {
    return Response.json({ error: "没有权限审核文章" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "无效的请求" }, { status: 400 });
  const id = body.id ? parseInt(body.id, 10) : NaN;
  const reason = String(body.reason || "").trim();
  /* 两种审核动作:
       demote = 下架: 强制变成草稿 (status='draft'), 作者还能改、还能再发;
       delete = 删除: 打 is_deleted 标记, 站内已经看不到了, 想恢复只能站长去 D1 改。
     默认 demote —— 轻的那一手。 */
  const mode = body.mode === "delete" ? "delete" : "demote";
  if (!Number.isInteger(id)) return Response.json({ error: "无效的文章" }, { status: 400 });
  if (!reason) return Response.json({ error: "请填写审核理由" }, { status: 400 });
  if (reason.length > MOD_REASON_MAX) {
    return Response.json({ error: `理由最多 ${MOD_REASON_MAX} 字` }, { status: 400 });
  }
  // 站长自己动手就不说「请联系站长」那半句
  const byOwner = hasPermission(perms, "dev.access");
  const appeal = byOwner ? "" : "\n如需撤销这次操作，请联系站长。";
  try {
    const article = await env.DB.prepare(
      `SELECT id, user_id, title FROM articles WHERE id = ? AND is_deleted = 0`
    ).bind(id).first();
    if (!article) return Response.json({ error: "文章不存在" }, { status: 404 });
    if (article.user_id === user.id) {
      return Response.json({ error: "这是你自己的文章，可直接删除" }, { status: 400 });
    }

    if (mode === "delete") {
      await env.DB.prepare(
        `UPDATE articles SET is_deleted = 1, updated_at = ? WHERE id = ?`
      ).bind(Date.now(), id).run();
    } else {
      await env.DB.prepare(
        `UPDATE articles SET status = 'draft', updated_at = ? WHERE id = ?`
      ).bind(Date.now(), id).run();
    }

    await logModeration(env, {
      action: mode === "delete" ? "article.delete" : "article.demote",
      targetUser: article.user_id,
      articleId: id,
      reason,
      byUserId: user.id
    });
    await sendNotice(env, article.user_id, {
      kind: "article.delete",
      title: mode === "delete" ? "你的文章已被删除" : "你的文章已被下架",
      body: mode === "delete"
        ? `《${article.title}》已被 ${actorName(user)} 删除。\n理由：${reason}${appeal}`
        : `《${article.title}》已被 ${actorName(user)} 下架（已转回草稿，你可以修改后再发布）。\n理由：${reason}${appeal}`
    });
    notifyIndexNow(env, ctx, id);
    return Response.json({ ok: true, mode });
  } catch (err) {
    console.error("审核文章失败:", err);
    return Response.json({ error: "删除失败，请稍后再试" }, { status: 500 });
  }
}


async function handleBanUser(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "user.ban")) {
    return Response.json({ error: "没有权限封禁用户" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "无效的请求" }, { status: 400 });
  const username = String(body.username || "").trim();
  const reason = String(body.reason || "").trim();
  const rawDays = body.days;
  const days = rawDays === null || rawDays === void 0 || rawDays === "" ? null : parseInt(rawDays, 10);
  if (!username) return Response.json({ error: "缺少用户名" }, { status: 400 });
  if (!reason) return Response.json({ error: "请填写封禁理由" }, { status: 400 });
  if (reason.length > MOD_REASON_MAX) {
    return Response.json({ error: `理由最多 ${MOD_REASON_MAX} 字` }, { status: 400 });
  }
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    return Response.json({ error: "天数请填 1–3650, 留空表示永久" }, { status: 400 });
  }
  try {
    const target = await env.DB.prepare(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(username).first();
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });
    if (target.id === user.id) return Response.json({ error: "不能封禁自己" }, { status: 400 });
    const targetPerms = await loadPermissions(env, target.id);
    if (hasPermission(targetPerms, "dev.access")) {
      return Response.json({ error: "不能封禁站长" }, { status: 403 });
    }
    const now = Date.now();
    const until = days === null ? null : now + days * 24 * 60 * 60 * 1e3;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO bans (user_id, reason, until, by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(target.id, reason, until, user.id, now).run();
    await logModeration(env, {
      action: "ban",
      targetUser: target.id,
      reason,
      byUserId: user.id
    });
    const duration = days === null ? "永久" : `${days} 天`;
    await sendNotice(env, target.id, {
      kind: "ban",
      title: "你的账号已被封禁",
      body: `你已被 ${actorName(user)} 封禁（时长：${duration}）。
理由：${reason}
封禁期间你仍然可以浏览站内内容，但无法发布或保存文章。`
    });
    const owners = await ownerUserIdList(env);
    for (const ownerId of owners) {
      if (ownerId === user.id) continue;
      await sendNotice(env, ownerId, {
        kind: "ban",
        title: "有用户被封禁",
        body: `${actorName(user)} 封禁了 ${target.username}（时长：${duration}）。
理由：${reason}`
      });
    }
    return Response.json({ ok: true, until, days });
  } catch (err) {
    console.error("封禁失败:", err);
    return Response.json({ error: "封禁失败，请稍后再试" }, { status: 500 });
  }
}


async function handleUnbanUser(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "user.pardon")) {
    return Response.json({ error: "没有权限解除封禁" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const username = body ? String(body.username || "").trim() : "";
  const reason = body ? String(body.reason || "").trim() : "";
  if (!username) return Response.json({ error: "缺少用户名" }, { status: 400 });
  try {
    const target = await env.DB.prepare(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(username).first();
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });
    const existing = await env.DB.prepare(
      `SELECT user_id FROM bans WHERE user_id = ?`
    ).bind(target.id).first();
    if (!existing) return Response.json({ error: "该用户没有被封禁" }, { status: 400 });
    await env.DB.prepare(`DELETE FROM bans WHERE user_id = ?`).bind(target.id).run();
    await logModeration(env, {
      action: "unban",
      targetUser: target.id,
      reason,
      byUserId: user.id
    });
    await sendNotice(env, target.id, {
      kind: "unban",
      title: "你的封禁已解除",
      body: `${actorName(user)} 已解除你的封禁，现在可以正常发布文章了。` + (reason ? `
备注：${reason}` : "")
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("解除封禁失败:", err);
    return Response.json({ error: "操作失败，请稍后再试" }, { status: 500 });
  }
}


async function handleDeleteUser(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "user.delete")) return Response.json({ error: "仅站长可操作" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const username = body ? String(body.username || "").trim() : "";
  const reason = body ? String(body.reason || "").trim() : "";
  if (!username) return Response.json({ error: "缺少用户名" }, { status: 400 });
  try {
    const target = await env.DB.prepare(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`
    ).bind(username).first();
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });
    if (target.id === user.id) return Response.json({ error: "不能删除自己的账号" }, { status: 400 });
    const targetPerms = await loadPermissions(env, target.id);
    if (hasPermission(targetPerms, "dev.access")) {
      return Response.json({ error: "不能删除站长账号" }, { status: 403 });
    }
    const now = Date.now();
    const articles = await env.DB.prepare(
      `UPDATE articles SET is_deleted = 1, updated_at = ? WHERE user_id = ? AND is_deleted = 0`
    ).bind(now, target.id).run();
    const avatarRow = await env.DB.prepare(
      `SELECT avatar_url FROM profiles WHERE user_id = ?`
    ).bind(target.id).first().catch(() => null);
    const avatarKey = avatarRow ? keyFromPublicUrl(avatarRow.avatar_url, AVATAR_PUBLIC_BASE, "avatar/") : null;
    if (avatarKey) {
      const del = await deleteObject(env, "avatar", avatarKey);
      if (del !== 204 && del !== 404) console.warn("删号时没清掉头像:", avatarKey, del);
    }
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(target.id).run();
    await env.DB.prepare(`DELETE FROM bans WHERE user_id = ?`).bind(target.id).run();
    await env.DB.prepare(`DELETE FROM notices WHERE to_user_id = ?`).bind(target.id).run();
    await env.DB.prepare(`DELETE FROM profiles WHERE user_id = ?`).bind(target.id).run();
    try {
      await env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ?`).bind(target.id).run();
    } catch (err) {
    }
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(target.id).run();
    await logModeration(env, {
      action: "user.delete",
      targetUser: target.id,
      reason,
      byUserId: user.id
    });
    return Response.json({
      ok: true,
      articles: articles.meta && articles.meta.changes || 0
    });
  } catch (err) {
    console.error("删除用户失败:", err);
    return Response.json({ error: "删除失败，请稍后再试" }, { status: 500 });
  }
}


async function handleAdminListRoles(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "dev.access") && !hasPermission(perms, "role.manage")) {
    return Response.json({ error: "没有权限" }, { status: 403 });
  }
  try {
    const roles = await env.DB.prepare(`SELECT name, label, rank, permissions FROM roles ORDER BY rank`).all();
    return Response.json({ roles: roles.results || [] });
  } catch (err) {
    console.error("读取角色失败:", err);
    return Response.json({ error: "读取失败" }, { status: 500 });
  }
}


async function handleAdminGrant(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "user.setAsMod")) return Response.json({ error: "仅站长可操作" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const username = body && body.username ? String(body.username).trim() : "";
  const roleName = body && body.role ? String(body.role).trim() : "";
  if (!username || !roleName) return Response.json({ error: "参数不完整" }, { status: 400 });
  try {
    const target = await env.DB.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`).bind(username).first();
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });
    const role = await env.DB.prepare(`SELECT name FROM roles WHERE name = ?`).bind(roleName).first();
    if (!role) return Response.json({ error: "角色不存在" }, { status: 400 });
    await env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role.name, target.id).run();
    return Response.json({ ok: true });
  } catch (err) {
    console.error("授予角色失败:", err);
    return Response.json({ error: "操作失败" }, { status: 500 });
  }
}


async function handleAdminRevoke(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, "user.setAsMember")) return Response.json({ error: "仅站长可操作" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const username = body && body.username ? String(body.username).trim() : "";
  const roleName = body && body.role ? String(body.role).trim() : "";
  if (!username || !roleName) return Response.json({ error: "参数不完整" }, { status: 400 });
  try {
    const target = await env.DB.prepare(`SELECT id, role FROM users WHERE LOWER(username) = LOWER(?)`).bind(username).first();
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });
    const role = await env.DB.prepare(`SELECT name FROM roles WHERE name = ?`).bind(roleName).first();
    if (!role) return Response.json({ error: "角色不存在" }, { status: 400 });
    if (target.id === user.id && role.name === "owner") {
      return Response.json({ error: "不能撤销自己的站长角色" }, { status: 403 });
    }
    if (target.role === role.name) {
      if (role.name === "owner") {
        const owners = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'owner'`).first();
        if (owners && owners.count <= 1) {
          return Response.json({ error: "这是最后一个站长，不能降级" }, { status: 403 });
        }
      }
      await env.DB.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).bind(target.id).run();
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error("撤销角色失败:", err);
    return Response.json({ error: "操作失败" }, { status: 500 });
  }
}


/* 站长的「删除」(管理员只能审核下架, 站长才能删)。
   「审核下架」是软删 (is_deleted = 1, 留痕, 作者能申诉); 这里是真的把行删掉 ——
   连评论、标签关联一起, 正文里那张图没人再引用也顺手清掉。
   仍然留一条 moderation_log + 给作者发站内信 (删了不等于能悄悄删)。 */
async function handleRemoveArticle(request, env, ctx) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.access')) return Response.json({ error: '仅站长可操作' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const id = body && body.id ? parseInt(body.id, 10) : NaN;
  if (!Number.isInteger(id)) return Response.json({ error: '无效的文章' }, { status: 400 });

  try {
    const article = await env.DB.prepare(
      `SELECT id, user_id, title, content FROM articles WHERE id = ?`
    ).bind(id).first();
    if (!article) return Response.json({ error: '文章不存在' }, { status: 404 });

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM article_tags WHERE article_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM comments WHERE article_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM articles WHERE id = ?`).bind(id)
    ]);

    // 正文里的图: 「旧正文有、新正文空、别处也没人用」= 可以删 (cleanupRemovedImages 的老规矩)
    const cleanup = cleanupRemovedImages(env, article.content, '').catch(() => []);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);

    await logModeration(env, {
      action: 'article.remove',
      targetUser: article.user_id,
      articleId: id,
      reason: '站长直接删除',
      byUserId: user.id
    });
    if (article.user_id && article.user_id !== user.id) {
      await sendNotice(env, article.user_id, {
        kind: 'article.delete',
        title: '你的文章已被删除',
        body: `《${article.title}》已被 ${actorName(user)} 直接删除（不是下架，文章内容不再保留）。`
      });
    }
    notifyIndexNow(env, ctx, id);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('站长删文失败:', err);
    return Response.json({ error: '删除失败，请稍后再试' }, { status: 500 });
  }
}

export { handleModerateArticle, handleBanUser, handleUnbanUser, handleDeleteUser, handleAdminListRoles, handleAdminGrant, handleAdminRevoke, handleRemoveArticle, handleRemapUserId };

/* 站长专用: 改某个用户的 id (所有引用一起搬, 见 common.js 的 remapUserId)。
   目标 id 已被占用就回 409, 前端据此弹 toast。 */
async function handleRemapUserId(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, me.id);
  if (!hasPermission(perms, 'dev.renumberUserId')) return Response.json({ error: '仅站长可操作' }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body || body.confirm !== 'RUN') {
    return Response.json({ error: '改 id 得带上 confirm: "RUN"' }, { status: 400 });
  }
  const from = parseInt(body.from, 10);
  const to = parseInt(body.to, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
    return Response.json({ error: 'from / to 要是正整数' }, { status: 400 });
  }
  if (from === to) return Response.json({ error: 'from 跟 to 是同一个 id' }, { status: 400 });

  const result = await remapUserId(env, from, to);
  if (result.error) {
    return Response.json({ error: result.error, username: result.username || null }, { status: 409 });
  }
  await logModeration(env, { action: 'user.remap-id', targetUser: to, byUserId: me.id, reason: from + ' → ' + to });
  return Response.json({ ok: true, from, to, username: result.user.username, updated: result.updated });
}
