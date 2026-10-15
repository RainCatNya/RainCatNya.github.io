/* handlers/comment.js 评论 */
/*
  内容: 列表 / 发表 / 删除 (两级楼中楼, 带配图清理与站内信通知)
  依赖: ../common.js(权限 限流 评论树工具)
*/

import { cleanupCommentImages, COMMENT_MAX, DELETED_AUTHOR, checkRateLimit, commentAncestorChain, commentHasLiveDescendant, getSessionUser, hasPermission, imageKeysIn, isBanned, loadPermissions, pruneDeadAncestors, purgeComment, retryText, sendNotice } from '../common.js';


// asyfunc 评论列表: GET /api/comments
async function handleListComments(request, env, url) {
  const articleId = parseInt(url.searchParams.get('article_id') || '', 10);
  if (!Number.isInteger(articleId)) return Response.json({ error: '无效的文章' }, { status: 400 });

  try {
    const user = await getSessionUser(request, env);
    const perms = user ? await loadPermissions(env, user.id) : new Set();
    const canDeleteAny = hasPermission(perms, 'article.comment.delete.any');

    const rows = await env.DB.prepare(
      `SELECT c.id, c.user_id, c.content, c.reply_to_comment_id, c.is_deleted, c.created_at,
              u.username AS username, COALESCE(p.nickname, u.username) AS nickname,
              p.avatar_url AS avatar_url
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN profiles p ON p.user_id = c.user_id
       WHERE c.article_id = ?
       ORDER BY c.created_at ASC, c.id ASC`
    ).bind(articleId).all();

    const list = (rows.results || []).map((c) => ({
      id: c.id,
      user_id: c.user_id,
      username: c.username || null,
      nickname: c.nickname || c.username || DELETED_AUTHOR,
      avatar_url: c.avatar_url || null,
      content: c.is_deleted ? '' : c.content,
      is_deleted: !!c.is_deleted,
      reply_to_comment_id: c.reply_to_comment_id || null,
      created_at: c.created_at,
      mine: !!(user && user.id === c.user_id),
      can_delete: !c.is_deleted && !!(user && (user.id === c.user_id || canDeleteAny))
    }));
    // 「回复 @谁」: 拿 id 反查昵称 (被删掉的那条也留着名字, 否则看不出回的是谁)
    const byId = {};
    list.forEach((c) => { byId[c.id] = c; });
    list.forEach((c) => {
      const parent = c.reply_to_comment_id ? byId[c.reply_to_comment_id] : null;
      c.reply_to_nickname = parent ? parent.nickname : null;
    });

    // 统计每条评论「还有多少条活着的回复」: 有活回复的删时只能软删, 留个落点给那些回复
    const liveReplies = {};
    list.forEach((c) => {
      if (c.reply_to_comment_id && !c.is_deleted) {
        liveReplies[c.reply_to_comment_id] = (liveReplies[c.reply_to_comment_id] || 0) + 1;
      }
    });
    list.forEach((c) => {
      c.has_replies = !!liveReplies[c.id];
    });

    return Response.json({
      comments: list,
      count: list.length,
      tops: list.filter((c) => !c.reply_to_comment_id).length,
      can_comment: !!user
    });
  } catch (err) {
    console.error('读取评论失败:', err);
    return Response.json({ error: '读取评论失败' }, { status: 500 });
  }
}


// asyfunc 发表评论: POST /api/comments
async function handleCreateComment(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '登录后才能评论' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: '无效的请求' }, { status: 400 });

  const articleId = parseInt(body.article_id, 10);
  const content = String(body.content || '').trim();
  if (!Number.isInteger(articleId)) return Response.json({ error: '无效的文章' }, { status: 400 });
  if (!content) return Response.json({ error: '评论不能为空' }, { status: 400 });
  if (content.length > COMMENT_MAX) {
    return Response.json({ error: `评论最多 ${COMMENT_MAX} 字` }, { status: 400 });
  }

  // 被封禁的用户能看不能发 (和发文章一样)
  const ban = await isBanned(env, user.id);
  if (ban) {
    const untilText = ban.until ? `（至 ${new Date(ban.until).toISOString().slice(0, 10)} 止）` : '（永久）';
    return Response.json({
      error: `你的账号已被封禁${untilText}，暂时无法评论` + (ban.reason ? `。理由：${ban.reason}` : ''),
      banned: { reason: ban.reason, until: ban.until }
    }, { status: 403 });
  }

  // 限流放在校验之后: 写错了内容不该白白吃掉配额
  const perMinute = await checkRateLimit(env, `comment:${user.id}`, 10, 60 * 1000);
  if (!perMinute.ok) {
    return Response.json({ error: `评论过于频繁，请 ${retryText(perMinute.retryAfterSec)}后再试` }, { status: 429 });
  }
  const perHour = await checkRateLimit(env, `commenth:${user.id}`, 60, 60 * 60 * 1000);
  if (!perHour.ok) {
    return Response.json({ error: `一小时内评论数已达上限，请 ${retryText(perHour.retryAfterSec)}后再试` }, { status: 429 });
  }

  try {
    // 只能评论「存在 + 已发布 + 没被删」的文章 (草稿下面不能评论)
    // 叙述 (narra) 的详情页没有评论系统, 接口这层也一并挡掉 —— 不然会攒出永远看不见的评论
    const article = await env.DB.prepare(
      `SELECT id, user_id, title, narra FROM articles WHERE id = ? AND is_deleted = 0 AND status = 'published'`
    ).bind(articleId).first();
    if (!article) return Response.json({ error: '文章不存在' }, { status: 404 });
    if (article.narra) return Response.json({ error: '叙述不开放评论' }, { status: 403 });

    // 要回复的那条必须还在这篇文章下面
    let replyTarget = null;
    if (body.reply_to_comment_id != null && body.reply_to_comment_id !== '') {
      const targetId = parseInt(body.reply_to_comment_id, 10);
      replyTarget = Number.isInteger(targetId)
        ? await env.DB.prepare(
            `SELECT id, user_id FROM comments WHERE id = ? AND article_id = ? AND is_deleted = 0`
          ).bind(targetId, articleId).first()
        : null;
      if (!replyTarget) return Response.json({ error: '要回复的评论已经不在了' }, { status: 404 });
    }

    const res = await env.DB.prepare(
      `INSERT INTO comments (article_id, user_id, content, reply_to_comment_id, is_deleted, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).bind(articleId, user.id, content, replyTarget ? replyTarget.id : null, Date.now()).run();
    const commentId = (res.meta && res.meta.last_row_id) || null;

    // 站内信: 评论文章通知作者, 回复只通知被回复的人 (不给自己发, 再给作者一份就是噪音)
    // 通知失败不能连累评论本身 (sendNotice 自己吞异常)
    const articleTitle = article.title || '无标题';
    if (replyTarget) {
      if (replyTarget.user_id !== user.id) {
        await sendNotice(env, replyTarget.user_id, {
          kind: 'comment.reply',
          title: articleTitle,
          body: content,
          fromUserId: user.id,
          articleId,
          commentId
        });
      }
    } else if (article.user_id !== user.id) {
      await sendNotice(env, article.user_id, {
        kind: 'comment.article',
        title: articleTitle,
        body: content,
        fromUserId: user.id,
        articleId,
        commentId
      });
    }

    return Response.json({ ok: true, id: commentId });
  } catch (err) {
    console.error('发表评论失败:', err);
    return Response.json({ error: '发表失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 删除评论: POST /api/comments/delete
async function handleDeleteComment(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const id = body ? parseInt(body.id, 10) : NaN;
  if (!Number.isInteger(id)) return Response.json({ error: '无效的评论' }, { status: 400 });

  try {
    const comment = await env.DB.prepare(
      `SELECT id, user_id, is_deleted, content FROM comments WHERE id = ?`
    ).bind(id).first();
    if (!comment || comment.is_deleted) return Response.json({ error: '评论不存在' }, { status: 404 });

    const perms = await loadPermissions(env, user.id);
    if (comment.user_id !== user.id && !hasPermission(perms, 'article.comment.delete.any')) {
      return Response.json({ error: '没有权限删除这条评论' }, { status: 403 });
    }

    // 两种删法: 下面还有活评论就软删 (留「该评论已删除」当落点), 没人了直接抹掉
    // 两种都要往上清「已软删且下面没有活评论」的占位; 上级链必须在 purge 之前抓
    // 先把正文里的图 key 抠出来: 行删掉之后就查不到了
    const imgKeys = imageKeysIn(comment.content);
    const chain = await commentAncestorChain(env, id);
    if (await commentHasLiveDescendant(env, id)) {
      await env.DB.prepare(`UPDATE comments SET is_deleted = 1 WHERE id = ?`).bind(id).run();
      await pruneDeadAncestors(env, chain);
      if (imgKeys.length) await cleanupCommentImages(env, imgKeys);
      return Response.json({ ok: true, purged: false });
    }
    await purgeComment(env, id);
    await pruneDeadAncestors(env, chain);
    if (imgKeys.length) await cleanupCommentImages(env, imgKeys);
    return Response.json({ ok: true, purged: true });
  } catch (err) {
    console.error('删除评论失败:', err);
    return Response.json({ error: '删除失败，请稍后再试' }, { status: 500 });
  }
}


export { handleListComments, handleCreateComment, handleDeleteComment };
