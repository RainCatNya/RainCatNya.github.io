/* handlers/chat.js 私聊与表情 */
/*
  内容: 会话列表 / 图片代理 / 历史(含增量) / 发送 / 撤回 / 表情
  依赖: ../common.js(会话 限流 chatPreviewText parseChatBody OSS 签名)
*/

import { CHAT_BODY_MAX, CHAT_PAGE_MAX, CHAT_RECALL_MS, CHAT_RECALL_WINDOW_MS, EMOJI_MAX, EMOJI_UPLOAD_LIMIT, IMAGE_TYPES, IMG_BUCKET, IMG_MAX_BYTES, IMG_PUBLIC_BASE, IMG_UPLOAD_HOST, avatarStorageReady, chatPreviewText, findPeer, getSessionUser, hitRateLimit, looksLikeImage, ossErrorText, ossSignedRequest, parseChatBody, peekRateLimit, randomHex, retryText } from '../common.js';


// asyfunc 会话列表: GET /api/chat/conversations
async function handleChatConversations(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  try {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.from_user_id,
              u.username AS peer_username,
              COALESCE(p.nickname, u.username) AS peer_nickname,
              p.avatar_url AS peer_avatar,
              (SELECT COUNT(*) FROM chats x
                WHERE x.from_user_id = u.id AND x.to_user_id = ? AND x.read_at IS NULL) AS unread
         FROM chats c
         JOIN (SELECT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS peer_id,
                      MAX(id) AS max_id
                 FROM chats
                WHERE from_user_id = ? OR to_user_id = ?
                GROUP BY peer_id) last ON last.max_id = c.id
         JOIN users u ON u.id = last.peer_id
         LEFT JOIN profiles p ON p.user_id = u.id
        ORDER BY c.id DESC
        LIMIT 100`
    ).bind(me.id, me.id, me.id, me.id).all();

    const conversations = (rows.results || []).map(r => ({
      username: r.peer_username,
      nickname: r.peer_nickname || r.peer_username,
      avatar_url: r.peer_avatar || null,
      last_body: chatPreviewText(r.body),
      last_at: r.created_at,
      last_mine: r.from_user_id === me.id,
      unread: r.unread || 0
    }));

    return Response.json({
      conversations,
      unread: conversations.reduce((n, c) => n + c.unread, 0)
    });
  } catch (err) {
    console.error('读取会话列表失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 图片代理: GET /api/chat/media
// 「另存为」用: 只认消息里那张图, 强制 attachment
async function handleChatMedia(request, env, url) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少消息编号' }, { status: 400 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }

  try {
    const row = await env.DB.prepare(
      `SELECT id, from_user_id, to_user_id, body FROM chats
        WHERE id = ? AND is_deleted = 0
          AND (from_user_id = ? OR to_user_id = ?)`
    ).bind(id, me.id, me.id).first();
    if (!row) return Response.json({ error: '这条消息不在了' }, { status: 404 });
    const att = parseChatBody(row.body);
    if (!att || att.t !== 'image') return Response.json({ error: '这条消息里没有图片' }, { status: 400 });

    // 桶里的对象名 = 公开地址去掉前缀 (再由 ossSignedRequest 拼回桶里)
    const key = att.url.slice(IMG_PUBLIC_BASE.length + 1);
    const got = await ossSignedRequest(env, { method: 'GET', key, bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST });
    if (!got.ok) {
      const detail = await got.text().catch(() => '');
      console.error('OSS 图片代理失败:', got.status, detail);
      return Response.json({ error: '取图失败：' + ossErrorText(got.status, detail, IMG_BUCKET) }, { status: 502 });
    }

    const name = String(att.name || 'image').replace(/[\r\n"]/g, '').slice(0, 120) || 'image';
    const headers = new Headers();
    headers.set('Content-Type', got.headers.get('Content-Type') || 'image/png');
    headers.set('Content-Disposition',
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
    return new Response(got.body, { headers });
  } catch (err) {
    console.error('图片代理失败:', err);
    return Response.json({ error: '取图失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 私聊历史: GET /api/chat
async function handleChatHistory(request, env, url) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const username = (url.searchParams.get('username') || '').trim();
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });
  if (username === me.username) return Response.json({ error: '不能和自己私聊' }, { status: 400 });

  // 增量: 传 after 就只要 id > after 的那几条 (页面上已有第 N 条), 不传就是最近 CHAT_PAGE_MAX 条
  const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;

  try {
    const peer = await findPeer(env, username);
    if (!peer) return Response.json({ error: '用户不存在' }, { status: 404 });

    const rows = after
      ? await env.DB.prepare(
          `SELECT id, from_user_id, body, created_at, cid FROM chats
            WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
              AND is_deleted = 0 AND id > ?
            ORDER BY id ASC LIMIT ?`
        ).bind(me.id, peer.id, peer.id, me.id, after, CHAT_PAGE_MAX).all()
      : await env.DB.prepare(
          `SELECT id, from_user_id, body, created_at, cid FROM chats
            WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
              AND is_deleted = 0
            ORDER BY id DESC LIMIT ?`
        ).bind(me.id, peer.id, peer.id, me.id, CHAT_PAGE_MAX).all();

    // 增量还得告诉客户端「哪几条被撤回了」: 撤回的那条 id < after, 不特意带上就只能刷新才知道
    // 只回最近一段时间里撤回的, 不必每次都扫全表
    let recalled = [];
    if (after) {
      const gone = await env.DB.prepare(
        `SELECT id FROM chats
          WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
            AND is_deleted = 1 AND deleted_at > ?
          ORDER BY id ASC LIMIT 100`
      ).bind(me.id, peer.id, peer.id, me.id, Date.now() - CHAT_RECALL_WINDOW_MS).all();
      recalled = (gone.results || []).map(r => r.id);
    }

    const list = rows.results || [];
    // 增量那条是 ASC (本来就是从旧到新); 全量那边是 DESC, 翻回来
    const ordered = after ? list : list.slice().reverse();
    const messages = ordered.map(m => ({
      id: m.id,
      mine: m.from_user_id === me.id,
      body: m.body,
      created_at: m.created_at,
      cid: m.cid || null
    }));

    // 拉过就算看过 (对方发给我的那些); 增量时也要做, 否则角标不消
    await env.DB.prepare(
      `UPDATE chats SET read_at = ? WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL`
    ).bind(Date.now(), me.id, peer.id).run();

    return Response.json({
      peer: {
        username: peer.username,
        nickname: peer.nickname || peer.username,
        avatar_url: peer.avatar_url || null
      },
      incremental: !!after,
      recalled,
      messages
    });
  } catch (err) {
    console.error('读取私聊失败:', err);
    return Response.json({ error: '加载失败' }, { status: 500 });
  }
}


// asyfunc 发送私聊: POST /api/chat
async function handleSendChat(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const username = String(payload.username || '').trim();
  const rawBody = String(payload.body || '');
  // 客户端 id: 乐观发送去重 / 重发幂等, 可选
  const cid = String(payload.cid || '').trim().slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '') || null;
  // 带附件时 body 是一坨 JSON (见 parseChatBody); 纯文字就是文字
  const attachment = parseChatBody(rawBody);
  const text = attachment ? '' : rawBody.trim();
  if (!username) return Response.json({ error: '缺少用户名' }, { status: 400 });
  if (!text && !attachment) return Response.json({ error: '消息是空的' }, { status: 400 });
  if (!attachment && text.length > CHAT_BODY_MAX) {
    return Response.json({ error: `一条消息最多 ${CHAT_BODY_MAX} 字` }, { status: 400 });
  }
  if (username === me.username) return Response.json({ error: '不能和自己私聊' }, { status: 400 });

  // 防刷: 每分钟 20 条 (聊天比站内信密)
  const gate = await peekRateLimit(env, `chat:min:${me.id}`, 20);
  if (!gate.ok) {
    return Response.json({ error: `发送过于频繁，请 ${retryText(gate.retryAfterSec)}后再试` }, { status: 429 });
  }

  try {
    const peer = await findPeer(env, username);
    if (!peer) return Response.json({ error: '用户不存在' }, { status: 404 });

    // 幂等: 同一个 cid 已存过就直接回给它 (刷新 / 重试都不会变两条), 插入撞唯一索引由下面的 catch 兜
    if (cid) {
      const existed = await env.DB.prepare(
        `SELECT id, body, created_at, cid FROM chats WHERE cid = ?`
      ).bind(cid).first();
      if (existed) {
        return Response.json({
          ok: true,
          dup: true,
          message: { id: existed.id, mine: true, body: existed.body, created_at: existed.created_at, cid: existed.cid }
        });
      }
    }

    // 存的是原始 body, 不是 parseChatBody 洗过的那份: 往 body 里塞的键会原样进库
    const now = Date.now();
    let result;
    try {
      result = await env.DB.prepare(
        `INSERT INTO chats (from_user_id, to_user_id, body, created_at, cid) VALUES (?, ?, ?, ?, ?)`
      ).bind(me.id, peer.id, attachment ? rawBody : text, now, cid).run();
    } catch (err) {
      // 老库没 cid 列 -> 退回不带它的插入
      result = await env.DB.prepare(
        `INSERT INTO chats (from_user_id, to_user_id, body, created_at) VALUES (?, ?, ?, ?)`
      ).bind(me.id, peer.id, attachment ? rawBody : text, now).run();
    }
    await hitRateLimit(env, `chat:min:${me.id}`, 60 * 1000);

    return Response.json({
      ok: true,
      message: {
        id: result.meta && result.meta.last_row_id ? result.meta.last_row_id : null,
        mine: true,
        body: attachment ? rawBody : text,
        created_at: now,
        cid: cid
      }
    });
  } catch (err) {
    console.error('发私聊失败:', err);
    return Response.json({ error: '发送失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 撤回私聊: POST /api/chat/recall
// 只能撤自己发的, 5 分钟内; 服务端软删, 双方记录都消失
async function handleChatRecall(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const id = parseInt(payload && payload.id, 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少消息编号' }, { status: 400 });

  try {
    const row = await env.DB.prepare(
      `SELECT id, from_user_id, created_at, is_deleted FROM chats WHERE id = ?`
    ).bind(id).first();
    if (!row || row.is_deleted) return Response.json({ error: '这条消息已经不在了' }, { status: 404 });
    if (row.from_user_id !== me.id) return Response.json({ error: '只能撤回自己发的消息' }, { status: 403 });
    if (Date.now() - row.created_at > CHAT_RECALL_MS) {
      return Response.json({ error: '超过 5 分钟了，撤不回来了' }, { status: 403 });
    }
    await env.DB.prepare(
      `UPDATE chats SET is_deleted = 1, deleted_at = ? WHERE id = ?`
    ).bind(Date.now(), id).run();
    return Response.json({ ok: true, id });
  } catch (err) {
    console.error('撤回私聊失败:', err);
    return Response.json({ error: '撤回失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 表情列表: GET /api/emoji
async function handleEmojiList(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  try {
    const rows = await env.DB.prepare(
      `SELECT id, url, created_at FROM emoji WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    ).bind(me.id, EMOJI_MAX).all();
    return Response.json({ emoji: rows.results || [], limit: EMOJI_MAX });
  } catch (err) {
    console.warn('读取表情失败 (老库还没建表?):', err && (err.message || err) || err);
    return Response.json({ emoji: [], limit: EMOJI_MAX });
  }
}


// asyfunc 添加表情: POST /api/emoji
async function handleEmojiUpload(request, env) {
  // multipart, 字段 file (前端从某条消息的图里取回字节再传上来)
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: I18N.t('toast.oss.error-NoService') }, { status: 503 });
  }

  const limited = await peekRateLimit(env, `emoji:${me.id}`, EMOJI_UPLOAD_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `添加过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json({ error: '无效的上传' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: '没有收到图片' }, { status: 400 });
  if (file.size > IMG_MAX_BYTES) {
    return Response.json({ error: `表情不能超过 ${IMG_MAX_BYTES / 1024 / 1024} MB` }, { status: 400 });
  }
  const ext = IMAGE_TYPES[file.type];
  if (!ext) return Response.json({ error: '只支持 PNG / JPG / WebP / GIF' }, { status: 400 });

  try {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM emoji WHERE user_id = ?`).bind(me.id).first();
    if (count && count.n >= EMOJI_MAX) {
      return Response.json({ error: `表情已达上限（最多 ${EMOJI_MAX} 张）` }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeImage(bytes, file.type)) {
      return Response.json({ error: '这个文件看起来不是图片' }, { status: 400 });
    }

    const slug = String(me.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return Response.json({ error: '用户名不适合做文件夹名' }, { status: 400 });
    const key = `img/user/${slug}/emoji/${Date.now().toString(36)}-${randomHex(4)}`;

    const put = await ossSignedRequest(env, {
      method: 'PUT', key, body: bytes, contentType: file.type,
      bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      console.error('表情上传失败:', put.status, detail);
      return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail, IMG_BUCKET) }, { status: 502 });
    }

    const url = `${IMG_PUBLIC_BASE}/${key}`;
    const ins = await env.DB.prepare(
      `INSERT INTO emoji (user_id, url, object_key, created_at) VALUES (?, ?, ?, ?)`
    ).bind(me.id, url, key, Date.now()).run();
    await hitRateLimit(env, `emoji:${me.id}`, 60 * 60 * 1000);

    return Response.json({
      ok: true,
      emoji: { id: ins.meta && ins.meta.last_row_id ? ins.meta.last_row_id : null, url, created_at: Date.now() }
    });
  } catch (err) {
    console.error('添加表情失败:', err);
    return Response.json({ error: '添加失败，请稍后再试' }, { status: 500 });
  }
}


// asyfunc 删除表情: POST /api/emoji/delete
async function handleEmojiDelete(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const id = parseInt(payload && payload.id, 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少编号' }, { status: 400 });

  try {
    const row = await env.DB.prepare(
      `SELECT id, object_key FROM emoji WHERE id = ? AND user_id = ?`
    ).bind(id, me.id).first();
    if (!row) return Response.json({ error: '这张表情不在了' }, { status: 404 });
    await env.DB.prepare(`DELETE FROM emoji WHERE id = ?`).bind(id).run();
    // 对象删不掉只 warn, 记录先走: 免得列表里一直挂个死链接
    await ossSignedRequest(env, {
      method: 'DELETE', key: row.object_key, bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
    }).catch(() => null);
    return Response.json({ ok: true, id });
  } catch (err) {
    console.error('删除表情失败:', err);
    return Response.json({ error: '删除失败，请稍后再试' }, { status: 500 });
  }
}


export { handleChatConversations, handleChatMedia, handleChatHistory, handleSendChat, handleChatRecall, handleEmojiList, handleEmojiUpload, handleEmojiDelete };
