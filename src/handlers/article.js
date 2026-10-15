/* handlers/article.js 文章 */
/*
  内容: 列表 / 详情 / 保存(含草稿) / 删除 / 我的文章 / 标签
  依赖: ../common.js(权限 标签 摘要 阅读时长 配图清理 IndexNow)
*/

import { ARTICLE_CONTENT_MAX, ARTICLE_INTRO_MAX, ARTICLE_TITLE_MAX, DELETED_AUTHOR, attachTags, cleanupRemovedImages, getSessionUser, hasPermission, isBanned, loadEmailState, loadPermissions, makeSummary, normalizeTags, notifyIndexNow, readingTimeText, saveTags } from '../common.js';
import { attributeCovers, filterSecrets, loadAttributeContext, loadAttributes, releaseArticleAttributes, syncArticleAttributes } from '../permission.js';

/* 叙述的引用键名规矩: 小写字母 / 数字 / - / . , 3~40 位 (入库前先小写化) */
const QUOTEKEY_RE = /^[a-z0-9.-]{3,40}$/;
// 终端世界里那两张卡片的面板 key (与 HTML 上的 data-key 一致)
const TERMINAL_ARTICLE_KEYS = ['terminal.iota.left-1', 'terminal.iota.right-1'];


// asyfunc 文章列表: GET /api/articles
async function handleListArticles(request, env, url) {
  // 公开, 仅已发布; 支持标签筛选 / 搜索 / 分页 / 排序
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10) || 20));
  const tag = (url.searchParams.get('tag') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  // 排序: 默认按发布时间, sort=comments 按评论数; 只从这两条里挑, 不把用户传的串拼进 SQL
  const sort = (url.searchParams.get('sort') || '').trim();
  const orderBy = sort === 'comments'
    ? 'comment_count DESC, a.created_at DESC'
    : 'a.created_at DESC';
  const offset = (page - 1) * size;

  // 叙述不进公开列表 (它只活在个人页与终端世界)
  let where = `a.status = 'published' AND a.is_deleted = 0 AND a.narra = 0`;
  const binds = [];
  if (tag) {
    where += ` AND a.id IN (SELECT at.article_id FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name = ?)`;
    binds.push(tag);
  }
  if (q) {
    // 搜索标题与正文, 顺手把 % _ 转义掉, 不然用户输入会被当通配符
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    where += ` AND (a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')`;
    binds.push(like, like);
  }

  try {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM articles a WHERE ${where}`
    ).bind(...binds).first();

    const rows = await env.DB.prepare(
      `SELECT a.id, a.title, a.intro, substr(a.content, 1, 240) AS excerpt, a.content AS full_content,
              a.created_at, a.updated_at,
              (SELECT COUNT(*) FROM comments c WHERE c.article_id = a.id AND c.is_deleted = 0) AS comment_count,
              u.username AS username, COALESCE(p.nickname, u.username) AS nickname,
              p.avatar_url AS avatar_url
       FROM articles a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN profiles p ON p.user_id = a.user_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    ).bind(...binds, size, offset).all();

    /* 查看权限: 简介与那 240 字摘要里也可能有 <secret='...'>, 按同一个人的凭证过一遍。
       ⚠️ 摘要是在 SQL 里 substr(…, 1, 240) 截出来的, 可能把一段 <secret> 切一半 (闭合标签没了 → 正则匹配不到),
       所以顺手把这种漏网的尾巴直接删掉 */
    const viewer = await getSessionUser(request, env);
    const attrCtx = await loadAttributeContext(env, viewer);
    const list = [];
    for (const a of (rows.results || [])) {
      const intro = a.intro ? await filterSecrets(env, a.intro, null, attrCtx) : a.intro;
      const cut = String(a.excerpt || '').replace(/<secret='[^']*'>[\s\S]*$/i, '');
      list.push({
        id: a.id,
        title: a.title,
        author: a.nickname || a.username || DELETED_AUTHOR,
        // 卡片上作者画成「头像 + 昵称」且可点进主页 (同详情页的 meta 行)
        author_username: a.username || null,
        author_avatar: a.avatar_url || null,
        // 列表那行描述 = 作者写的简介 (没写就没有), 不再拿正文摘要顶替
        intro: intro || null,
        // 只取前 240 字再算摘要: 整篇查出来再截, 文章一长体积就爆
        summary: makeSummary(await filterSecrets(env, cut, null, attrCtx)),
        // 阅读时长要按整篇算, 所以正文只在服务端过一手 (算完就丢, 不进响应)
        read_text: readingTimeText(a.full_content),
        // 卡片右下角的「N 条评论」(删掉的评论不算)
        comment_count: a.comment_count || 0,
        created_at: a.created_at,
        updated_at: a.updated_at
      });
    }
    await attachTags(env, list);

    const total = totalRow ? totalRow.count : 0;
    return Response.json({
      articles: list,
      page,
      size,
      sort: sort === 'comments' ? 'comments' : 'time',
      total,
      hasMore: offset + list.length < total
    });
  } catch (err) {
    console.error('文章列表失败:', err);
    return Response.json({ error: '加载文章失败' }, { status: 500 });
  }
}


// asyfunc 文章详情: GET /api/article
async function handleGetArticle(request, env, url) {
  // 公开; 草稿仅作者 / 有权限者可见
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id)) return Response.json({ error: '无效的文章' }, { status: 400 });

  try {
    const article = await env.DB.prepare(
      `SELECT a.*, u.username AS username, COALESCE(p.nickname, u.username) AS nickname,
              p.avatar_url AS avatar_url,
              (SELECT quotekey FROM article_quotekey q WHERE q.article_id = a.id) AS quotekey,
              (SELECT COUNT(*) FROM comments c WHERE c.article_id = a.id AND c.is_deleted = 0) AS comment_count
       FROM articles a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN profiles p ON p.user_id = a.user_id
       WHERE a.id = ?`
    ).bind(id).first();

    if (!article || article.is_deleted) {
      return Response.json({ error: '文章不存在' }, { status: 404 });
    }

    const user = await getSessionUser(request, env);
    const perms = user ? await loadPermissions(env, user.id) : new Set();
    const isAuthor = !!(user && user.id === article.user_id);
    /* 草稿与**叙述**都只给作者看 (用户 2026-10-01): 别人一律当「文章不存在」——
       原来还放行过 article.review (管理员看未发布稿), 现在一并收掉。
       ⚠️ perms 还得留着: 下面 can.delete / can.moderate 要用 */
    if ((article.status !== 'published' || article.narra) && !isAuthor) {
      return Response.json({ error: '文章不存在' }, { status: 404 });
    }

    const [withTags] = await attachTags(env, [{ ...article, tags: [] }]);

    /* 查看权限 (<secret='...'>): 一律按凭证过滤 —— 连作者本人在详情页也按同一套规矩 (用户 2026-09-28 定的)。
       编辑器那条路要拿到原样正文 (否则一保存就把藏着的段落真删了), 所以带 raw=1 时只给作者放行 */
    const wantRaw = url.searchParams.get('raw') === '1' && isAuthor;
    const content = article.content || '';
    const scope = await loadAttributeContext(env, user);
    const shownContent = wantRaw ? article.content : await filterSecrets(env, content, user, scope);
    const shownIntro = (wantRaw || !article.intro) ? article.intro : await filterSecrets(env, article.intro, user, scope);

    return Response.json({
      article: {
        id: article.id,
        title: article.title,
        intro: shownIntro || null, // 简介 (作者手写的一句话主题)
        content: shownContent,
        status: article.status,
        // 叙述: 1 的话编辑器走叙述模式 (没有简介/标签, 只有一个「保存」)
        narra: !!article.narra,
        quotekey: article.quotekey || null,
        created_at: article.created_at,
        updated_at: article.updated_at,
        author: article.nickname || article.username || DELETED_AUTHOR,
        // 文章页头像 / 名字点进去就是作者主页 (公开信息)
        author_avatar: article.avatar_url || null,
        author_username: article.username || null,
        username: article.username || null,
        user_id: article.user_id,
        // 评论数: 前端拿它决定「转为草稿」该弹哪个框 (有评论 = 两个选择)
        comment_count: article.comment_count || 0,
        tags: withTags.tags
      },
      can: {
        // 没有 article.edit.any 这个权限: 站长也不能编辑别人的文章, edit 只有作者本人为真
        edit: isAuthor,
        delete: isAuthor || hasPermission(perms, 'article.review'),
        // 「审核」: 不是作者但有管理权限 -> 前端显示「审核」而不是「编辑 + 删除」, 删前必须填理由
        moderate: !isAuthor && hasPermission(perms, 'article.review')
      }
    });
  } catch (err) {
    console.error('加载文章失败:', err);
    return Response.json({ error: '加载文章失败' }, { status: 500 });
  }
}


// asyfunc 保存文章: POST /api/articles
async function handleSaveArticle(request, env, ctx) {
  // 新建 / 更新 (支持草稿), 需要登录
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  // 被封禁的用户不能发文但还能看: 发布与存草稿都拦 (让改草稿等于留了半扇门), 图片 / 浏览不受影响
  const ban = await isBanned(env, user.id);
  if (ban) {
    const untilText = ban.until
      ? `（至 ${new Date(ban.until).toISOString().slice(0, 10)} 止）`
      : '（永久）';
    return Response.json({
      error: `你的账号已被封禁${untilText}，暂时无法发布或保存文章` +
        (ban.reason ? `。理由：${ban.reason}` : ''),
      banned: { reason: ban.reason, until: ban.until }
    }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: '无效的请求' }, { status: 400 });

  // 没填邮箱不能发文; 邮箱要单独查 (loadEmailState), getSessionUser 只回 id / username / nickname
  // 只拦新建, 已有旧稿的作者照样能改能重发
  if (!body.id) {
    const mail = await loadEmailState(env, user.id).catch(() => null);
    if (mail && !mail.email) {
      return Response.json({ error: '请先在个人主页「资料」里填写邮箱，之后才能发文' }, { status: 403 });
    }
  }

  const title = body.title ? String(body.title).trim() : '';
  const content = body.content ? String(body.content) : '';
  const intro = body.intro ? String(body.intro).trim().replace(/\s+/g, ' ') : '';
  const status = body.status === 'draft' ? 'draft' : 'published';
  const tags = normalizeTags(body.tags);

  if (!content.trim()) return Response.json({ error: '正文不能为空' }, { status: 400 });
  if (title.length > ARTICLE_TITLE_MAX) return Response.json({ error: `标题最多 ${ARTICLE_TITLE_MAX} 字` }, { status: 400 });
  if (intro.length > ARTICLE_INTRO_MAX) return Response.json({ error: `简介最多 ${ARTICLE_INTRO_MAX} 字` }, { status: 400 });
  if (content.length > ARTICLE_CONTENT_MAX) return Response.json({ error: '正文太长' }, { status: 400 });

  const now = Date.now();

  try {
    if (body.id) {
      const id = parseInt(body.id, 10);
      if (!Number.isInteger(id)) return Response.json({ error: '无效的文章' }, { status: 400 });

      const existing = await env.DB.prepare(
        `SELECT user_id, content, status FROM articles WHERE id = ? AND is_deleted = 0`
      ).bind(id).first();
      if (!existing) return Response.json({ error: '文章不存在' }, { status: 404 });

      const perms = await loadPermissions(env, user.id);
        // 只看作者本人: article.edit.any 权限已取消, 站长也不能编辑别人的文章
      if (existing.user_id !== user.id) {
        return Response.json({ error: '没有权限编辑这篇文章' }, { status: 403 });
      }

      // 已发布改草稿时不能带着评论走 (评论挂在文章编号上, 下架会跟着藏、重发又冒出来), 有评论就驳回
      // 前端据此弹两个选择: 带 delete_comments: true 重来 / 不带 id 另存新草稿
      const demoting = existing.status === 'published' && status === 'draft';
      if (demoting) {
        const counted = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM comments WHERE article_id = ? AND is_deleted = 0`
        ).bind(id).first();
        const commentCount = counted && counted.n ? counted.n : 0;
        if (commentCount > 0 && body.delete_comments !== true) {
          return Response.json({
            error: `这篇文章还有 ${commentCount} 条评论，不能直接下架`,
            code: 'has_comments',
            comment_count: commentCount
          }, { status: 409 });
        }
        if (commentCount > 0) {
          // 用户选了「删除评论并下架」: 连软删除的占位一起清掉
          await env.DB.prepare(`DELETE FROM comments WHERE article_id = ?`).bind(id).run();
        }
      }

      await env.DB.prepare(
        `UPDATE articles SET title = ?, intro = ?, content = ?, status = ?, updated_at = ? WHERE id = ?`
      ).bind(title, intro, content, status, now, id).run();
      await saveTags(env, id, tags);
      // 正文里 <secret> 点过名的属性要登记进名册 (存草稿也算; 失败不影响保存本身)
      await syncArticleAttributes(env, id, content).catch((err) => console.error('同步属性失败:', err));
      if (status === 'published') notifyIndexNow(env, ctx, id);
      // 不再引用的配图顺手从桶里删 (扔后台跑, 失败不影响文章)
      const cleanup = cleanupRemovedImages(env, existing.content, content).catch(() => []);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
      return Response.json({ ok: true, id, deleted_comments: demoting && body.delete_comments === true });
    }

    const result = await env.DB.prepare(
      `INSERT INTO articles (user_id, title, intro, content, status, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(user.id, title, intro, content, status, now, now).run();

    const id = result.meta && result.meta.last_row_id ? result.meta.last_row_id : null;
    if (!id) return Response.json({ error: '保存失败' }, { status: 500 });
    await saveTags(env, id, tags);
    await syncArticleAttributes(env, id, content).catch((err) => console.error('同步属性失败:', err));
    if (status === 'published') notifyIndexNow(env, ctx, id);
    return Response.json({ ok: true, id });
  } catch (err) {
    console.error('保存文章失败:', err);
    return Response.json({ error: '保存失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 删除文章: POST /api/articles/delete
async function handleDeleteArticle(request, env, ctx) {
  // 软删除: 作者本人 或 拥有 article.delete.any
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const id = body && body.id ? parseInt(body.id, 10) : NaN;
  if (!Number.isInteger(id)) return Response.json({ error: '无效的文章' }, { status: 400 });

  try {
    const article = await env.DB.prepare(
      `SELECT user_id FROM articles WHERE id = ? AND is_deleted = 0`
    ).bind(id).first();
    if (!article) return Response.json({ error: '文章不存在' }, { status: 404 });

    const perms = await loadPermissions(env, user.id);
    if (article.user_id !== user.id && !hasPermission(perms, 'article.review')) {
      return Response.json({ error: '没有权限删除这篇文章' }, { status: 403 });
    }

    await env.DB.prepare(
      `UPDATE articles SET is_deleted = 1, updated_at = ? WHERE id = ?`
    ).bind(Date.now(), id).run();
    // 叙述的引用键名跟着文章一起消失 (键没了, 终端那两张卡片就查不到了)
    await env.DB.prepare(`DELETE FROM article_quotekey WHERE article_id = ?`).bind(id).run();
    // 它引用过的 <secret> 权限要还回计数 (归零的权限行跟着删掉)
    await releaseArticleAttributes(env, id);
    notifyIndexNow(env, ctx, id); // 让 Bing/Edge 尽快把这条移出索引
    return Response.json({ ok: true });
  } catch (err) {
    console.error('删除文章失败:', err);
    return Response.json({ error: '删除失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 我的文章: GET /api/my/articles
async function handleMyArticles(request, env) {
  // 含草稿与**叙述** —— 自己看得到 (对外才隐藏: 公开主页与 sitemap 那两处查 narra = 0)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const rows = await env.DB.prepare(
      `SELECT id, title, intro, content, status, narra, created_at, updated_at
       FROM articles WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC`
    ).bind(user.id).all();

    const list = (rows.results || []).map(a => ({
      id: a.id,
      title: a.title,
      intro: a.intro || null,
      status: a.status,
      narra: !!a.narra,          // 作品栏的卡片靠它标「叙述」 (叙述没有草稿/已发布这一说)
      summary: makeSummary(a.content),
      created_at: a.created_at,
      updated_at: a.updated_at
    }));
    await attachTags(env, list);
    return Response.json({ articles: list });
  } catch (err) {
    console.error('加载我的文章失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 新建叙述: POST /api/articles/narra { quotekey }
async function handleCreateNarra(request, env) {
  // 只有站长组有 article.narra; 建一篇空叙述 + 当场把键名占下来 (键名冲突在这里就挡)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'article.narra')) {
    return Response.json({ error: '没有权限创建叙述' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const key = String((body && body.quotekey) || '').trim().toLowerCase();
  if (!QUOTEKEY_RE.test(key)) {
    return Response.json({ error: '键名只能是小写字母、数字、- 与 .，长度 3~40' }, { status: 400 });
  }

  const now = Date.now();
  try {
    const taken = await env.DB.prepare(
      `SELECT 1 AS n FROM article_quotekey WHERE quotekey = ?`
    ).bind(key).first();
    if (taken) return Response.json({ error: '这个引用键名已经被占用了' }, { status: 409 });

    const result = await env.DB.prepare(
      `INSERT INTO articles (user_id, title, intro, content, status, is_deleted, narra, created_at, updated_at)
       VALUES (?, '', '', '', 'draft', 0, 1, ?, ?)`
    ).bind(user.id, now, now).run();
    const id = result.meta && result.meta.last_row_id ? result.meta.last_row_id : null;
    if (!id) return Response.json({ error: '创建失败' }, { status: 500 });

    try {
      await env.DB.prepare(
        `INSERT INTO article_quotekey (quotekey, article_id, user_id, created_at) VALUES (?, ?, ?, ?)`
      ).bind(key, id, user.id, now).run();
    } catch (err) {
      // 刚好被人抢了同一个键: 把刚建的空叙述撤掉, 别留一篇没键的孤儿
      await env.DB.prepare(`DELETE FROM articles WHERE id = ?`).bind(id).run();
      return Response.json({ error: '这个引用键名已经被占用了' }, { status: 409 });
    }
    return Response.json({ ok: true, id, quotekey: key });
  } catch (err) {
    console.error('创建叙述失败:', err);
    return Response.json({ error: '创建失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 终端世界的叙述: GET /api/terminal/articles
async function handleTerminalArticles(request, env) {
  /* 把 terminal_article_redirect 登记的「面板 key → 叙述」一次全给出去 (加载期拿完, 点开不再请求);
     正文按看的人过一遍 <secret>; 找不到文章的那些也带上 (missing), 前端画「终端查询错误」 */
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const held = await loadAttributes(env, user.id);
  if (!held.some((one) => attributeCovers(one, 'terminal.access'))) {
    return Response.json({ error: '没有终端通行证' }, { status: 403 });
  }

  try {
    const rows = await env.DB.prepare(
      `SELECT r.key AS panel_key, r.quotekey, a.title, a.content, a.is_deleted
       FROM terminal_article_redirect r
       LEFT JOIN article_quotekey q ON q.quotekey = r.quotekey
       LEFT JOIN articles a ON a.id = q.article_id
       WHERE r.key IN (${TERMINAL_ARTICLE_KEYS.map(() => '?').join(', ')})
       ORDER BY r.key ASC, r.quotekey ASC`
    ).bind(...TERMINAL_ARTICLE_KEYS).all();

    const attrCtx = await loadAttributeContext(env, user);
    const panels = {};
    for (const row of (rows.results || [])) {
      const found = row.content !== null && row.content !== undefined && !row.is_deleted;
      const list = panels[row.panel_key] || (panels[row.panel_key] = []);
      list.push({
        quotekey: row.quotekey,
        missing: !found,
        title: found ? (row.title || '') : null,
        content: found ? await filterSecrets(env, row.content, user, attrCtx) : null
      });
    }
    return Response.json({ ok: true, panels });
  } catch (err) {
    console.error('加载终端叙述失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 标签列表: GET /api/tags
async function handleListTags(env) {
  // 仅统计已发布文章, 公开
  try {
    const rows = await env.DB.prepare(
      `SELECT t.name AS name, COUNT(at.article_id) AS count
       FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
       JOIN articles a ON a.id = at.article_id AND a.status = 'published' AND a.is_deleted = 0
       GROUP BY t.id
       ORDER BY count DESC, t.name ASC`
    ).all();
    return Response.json({ tags: rows.results || [] });
  } catch (err) {
    console.error('标签列表失败:', err);
    return Response.json({ tags: [] });
  }
}


export { handleListArticles, handleGetArticle, handleSaveArticle, handleDeleteArticle, handleMyArticles, handleListTags, handleCreateNarra, handleTerminalArticles };
