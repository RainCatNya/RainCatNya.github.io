// handlers/upload.js —— 头像与配图 (foraine-image 桶)。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。
// 资源桶 (foraine-resource) 那条线 2026-09-16 搬去了 handlers/resource.js ——
// 它自有上传/下载/列表/详情/删除，跟头像与配图不是一回事。

import { CHAT_IMAGE_TTL_MS, AVATAR_MAX_BYTES, AVATAR_PUBLIC_BASE, IMAGE_TYPES, IMG_BUCKET, IMG_MAX_BYTES, IMG_PUBLIC_BASE, IMG_UPLOAD_HOST, IMG_UPLOAD_LIMIT, avatarObjectKey, avatarStorageReady, getSessionUser, hasPermission, hitRateLimit, loadPermissions, looksLikeImage, ossErrorText, ossSignedRequest, peekRateLimit, previousAvatarKey, randomHex, retryText } from '../common.js';


async function handleAvatarUpload(request, env) {
  // 上传头像: POST /api/avatar (multipart/form-data, 字段名 file)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '头像存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json({ error: '无效的上传' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: '没有收到图片' }, { status: 400 });
  if (file.size > AVATAR_MAX_BYTES) {
    return Response.json({ error: `图片不能超过 ${AVATAR_MAX_BYTES / 1024 / 1024} MB` }, { status: 400 });
  }

  const ext = IMAGE_TYPES[file.type];
  if (!ext) return Response.json({ error: '只支持 PNG / JPG / WebP / GIF' }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes, file.type)) {
    return Response.json({ error: '这个文件看起来不是图片' }, { status: 400 });
  }

  const key = avatarObjectKey(user.username);

  try {
    const put = await ossSignedRequest(env, {
      method: 'PUT', key, body: bytes, contentType: file.type
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      console.error('OSS 上传失败:', put.status, detail);
      return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail) }, { status: 502 });
    }

    // 换过扩展名时对象名也变了 (png -> jpg): 老的那张留着只占地方, 顺手删掉;
    // 名字没变的话 PUT 就是覆盖, 不用管。
    const previous = previousAvatarKey(user.avatar_url, key);
    if (previous) {
      const del = await ossSignedRequest(env, { method: 'DELETE', key: previous }).catch(() => null);
      if (del && !del.ok) console.warn('旧头像没删掉 (无所谓):', previous, del.status);
    }

    // 换头像时 URL 会一起变 (?v=时间戳), 客户端不用等缓存过期
    const url = `${AVATAR_PUBLIC_BASE}/${key}?v=${Date.now()}`;
    const now = Date.now();
    const updated = await env.DB.prepare(
      `UPDATE profiles SET avatar_url = ?, updated_at = ? WHERE user_id = ?`
    ).bind(url, now, user.id).run();
    if (!updated.meta || !updated.meta.changes) {
      // 还没有资料行 (OAuth 建号可能没建) -> 补一条
      await env.DB.prepare(
        `INSERT OR IGNORE INTO profiles (user_id, nickname, avatar_url, bio, other, created_at, updated_at)
         VALUES (?, ?, ?, '', '', ?, ?)`
      ).bind(user.id, user.nickname || user.username, url, now, now).run();
    }

    return Response.json({ ok: true, avatar_url: url });
  } catch (err) {
    console.error('上传头像失败:', err);
    return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
  }
}


async function handleImageUpload(request, env) {
  // 上传文章配图: POST /api/image (multipart/form-data, 字段 file + article_id)。
  // 对象名 = img/<文章编号>/<时间戳36>-<随机>.ext —— 文件名带时间戳 + 随机串,
  // 同一篇文章里传两张同名截图也不会互相覆盖。
  // article_id 是必须的: 以前没有编号时会落到 img/unsorted/, 桶里攒出一个「谁都认领不了」
  // 的文件夹 (OSS 没有文件夹, 控制台里还没法改名), 现在这种请求直接驳回, 让作者先存草稿。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '图片存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }

  const limited = await peekRateLimit(env, `img:${user.id}`, IMG_UPLOAD_LIMIT);
  if (!limited.ok) {
    return Response.json({ error: `上传过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
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
    return Response.json({ error: `图片不能超过 ${IMG_MAX_BYTES / 1024 / 1024} MB` }, { status: 400 });
  }

  const ext = IMAGE_TYPES[file.type];
  if (!ext) return Response.json({ error: '只支持 PNG / JPG / WebP / GIF' }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes, file.type)) {
    return Response.json({ error: '这个文件看起来不是图片' }, { status: 400 });
  }

  // 个性化背景: kind = profile(主页) | chat(私聊)。
  //   聊天背景 (chat-image) 暂时下线: 个性化页签里那张卡片已隐藏, 后端分支保留,
  //   以后想恢复只用把前端面板放回来。
  //   对象名固定成 img/user/<用户名>/profile-image, 不带扩展名 —— 换图直接覆盖同一个对象,
  //   所以返回的 URL 带 ?t= 破浏览器 / CDN 缓存。
  const kind = String(form.get('kind') || '');
  if (kind === 'profile' || kind === 'chat') {
    const slug = String(user.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return Response.json({ error: '用户名不适合做文件夹名' }, { status: 400 });
    const name = kind === 'profile' ? 'profile-image' : 'chat-image';
    const bgKey = `img/user/${slug}/${name}`;
    try {
      const put = await ossSignedRequest(env, {
        method: 'PUT', key: bgKey, body: bytes, contentType: file.type,
        bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
      });
      if (!put.ok) {
        const detail = await put.text().catch(() => '');
        console.error('OSS 背景图上传失败:', put.status, detail);
        return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail, IMG_BUCKET) }, { status: 502 });
      }
      await hitRateLimit(env, `img:${user.id}`, 60 * 60 * 1000);
      return Response.json({
        ok: true,
        url: `${IMG_PUBLIC_BASE}/${bgKey}?t=${Date.now()}`,
        key: bgKey,
        size: file.size
      });
    } catch (err) {
      console.error('上传背景图失败:', err);
      return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
    }
  }

  // 私聊粘贴的图片: kind = chatmsg。
  //   聊天不属于任何文章, 所以归到 img/user/<用户名>/chat/<时间戳36>-<随机> (不带扩展名)。
  //   与背景图不同: 一条消息一张图, 名字不能覆盖, 所以带时间戳 + 随机串, URL 也不用 ?t=。
  //   每张都登记进 stored_image + 7 天过期。
  if (kind === 'chatmsg') {
    const slug = String(user.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return Response.json({ error: '用户名不适合做文件夹名' }, { status: 400 });
    const msgKey = `img/user/${slug}/chat/${Date.now().toString(36)}-${randomHex(4)}`;
    try {
      const put = await ossSignedRequest(env, {
        method: 'PUT', key: msgKey, body: bytes, contentType: file.type,
        bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
      });
      if (!put.ok) {
        const detail = await put.text().catch(() => '');
        console.error('OSS 聊天图片上传失败:', put.status, detail);
        return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail, IMG_BUCKET) }, { status: 502 });
      }
      await hitRateLimit(env, `img:${user.id}`, 60 * 60 * 1000);
      const msgUrl = `${IMG_PUBLIC_BASE}/${msgKey}`;
      // 登记 + 过期时间 (登记失败不连累发送, cron 只是少清一张)
      await env.DB.prepare(
        `INSERT INTO stored_image (object_key, url, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(msgKey, msgUrl, user.id, 'chat', Date.now(), Date.now() + CHAT_IMAGE_TTL_MS)
        .run().catch((err) => console.warn('登记聊天图失败 (不影响发送):', err && (err.message || err)));
      return Response.json({ ok: true, url: msgUrl, key: msgKey, size: file.size });
    } catch (err) {
      console.error('上传聊天图片失败:', err);
      return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
    }
  }

  const articleId = parseInt(String(form.get('article_id') || ''), 10);
  // 没有文章编号 -> 驳回 (见函数头注释: 不许再往 img/unsorted/ 里丢东西)
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return Response.json(
      { error: '新文章要先存一下草稿（Ctrl / ⌘ + S），图片才能归到这篇文章的文件夹里' },
      { status: 400 }
    );
  }
  // 编号得是真的文章, 否则桶里会冒出 img/99999/ 这种没人认领的空文件夹。
  // 已发布的文章谁都能往里传 (评论区插图走的就是这条路); 草稿只有作者/有编辑权的人能传。
  const target = await env.DB.prepare(
    `SELECT user_id, status FROM articles WHERE id = ? AND is_deleted = 0`
  ).bind(articleId).first().catch(() => null);
  if (!target) return Response.json({ error: '这篇文章不存在' }, { status: 404 });
  if (target.status !== 'published' && target.user_id !== user.id) {
    const perms = await loadPermissions(env, user.id);
    // 草稿的配图只能由作者自己传 (站点那边取消了 article.edit.any 这一项)
    return Response.json({ error: '没有权限往这篇文章里传图' }, { status: 403 });
  }
  const key = `img/article/${articleId}/${Date.now().toString(36)}-${randomHex(4)}`;

  try {
    const put = await ossSignedRequest(env, {
      method: 'PUT', key, body: bytes, contentType: file.type,
      bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      console.error('OSS 图片上传失败:', put.status, detail);
      return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail, IMG_BUCKET) }, { status: 502 });
    }
    await hitRateLimit(env, `img:${user.id}`, 60 * 60 * 1000);
    // 新对象名不会撞, 不用 ?v= 破缓存
    return Response.json({ ok: true, url: `${IMG_PUBLIC_BASE}/${key}`, key, size: file.size });
  } catch (err) {
    console.error('上传图片失败:', err);
    return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
  }
}


export { handleAvatarUpload, handleImageUpload };
