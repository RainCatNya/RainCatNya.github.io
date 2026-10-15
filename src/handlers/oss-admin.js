// handlers/oss-admin.js —— 对应的一批接口处理器。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。

import { AVATAR_PUBLIC_BASE, IMG_BUCKET, IMG_PUBLIC_BASE, IMG_UPLOAD_HOST, OSS_BUCKET, OSS_BUCKETS, OSS_REGION, avatarObjectKey, avatarStorageReady, deleteObject, getSessionUser, hasPermission, loadPermissions, ossErrorText, ossListObjects, ossSignedRequest, storageOrphans } from '../common.js';


async function handleRekeyImages(request, env) {  // 站长工具: 把 img/unsorted/ 里的对象搬进某篇文章的文件夹, 顺手改掉正文里的引用。
  // 老代码会把「新文章还没保存时传的图」丢进 img/unsorted/, 桶里于是留下一个没人认领的
  // 文件夹 —— OSS 根本没有文件夹, 控制台里也没法给它改名, 只能在服务端 copy + delete。
  // 走公读的 publicBase 取原图再签名 PUT 放回去, 绕开 copy-source 那套签名。
  // body: { article_id: 8, apply: true } —— 不带 apply 只预演, 不动任何东西。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.r2')) return Response.json({ error: '仅站长可操作' }, { status: 403 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '图片存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) || {};
  const articleId = parseInt(body.article_id, 10);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return Response.json({ error: '要指明搬进哪篇文章的文件夹（article_id）' }, { status: 400 });
  }
  const apply = body.apply === true;
  const from = 'img/unsorted/';
  const to = `img/${articleId}/`;
  const report = { from, to, apply };

  const listed = await ossListObjects(env, from, { bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST });
  report.list_status = listed.status;
  if (listed.status >= 400) {
    report.error = ossErrorText(listed.status, listed.raw, IMG_BUCKET);
    report.hint = '列对象要在 RAM 里给 oss:ListObjects（这个动作的 Resource 写桶本身，不带 /*）';
    return Response.json(report, { status: 502 });
  }
  report.count = listed.keys.length;

  // 哪些文章引用着这些图 —— 搬完必须把正文里的 img/unsorted/ 一起改掉, 否则图全裂
  const rows = await env.DB.prepare(
    `SELECT id, content FROM articles WHERE is_deleted = 0 AND content LIKE '%img/unsorted/%'`
  ).all().catch(() => ({ results: [] }));
  const refs = rows.results || [];
  report.referencing_articles = refs.map((r) => r.id);

  if (!listed.keys.length) {
    return Response.json({ ok: true, note: 'img/unsorted/ 里已经没有对象了', ...report });
  }
  if (!apply) {
    report.keys = listed.keys;
    report.note = '这是预演（只报告）；body 里加 "apply": true 才会真的搬';
    return Response.json(report);
  }

  report.moved = [];
  for (const key of listed.keys) {
    const newKey = to + key.slice(from.length);
    const item = { key, to: newKey };
    try {
      const got = await fetch(`${IMG_PUBLIC_BASE}/${key}`);
      item.get_status = got.status;
      if (!got.ok) {
        item.error = '取原图失败';
      } else {
        const type = got.headers.get('Content-Type') || 'application/octet-stream';
        const bytes = new Uint8Array(await got.arrayBuffer());
        const put = await ossSignedRequest(env, {
          method: 'PUT', key: newKey, body: bytes, contentType: type,
          bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
        });
        item.put_status = put.status;
        if (!put.ok) {
          item.error = ossErrorText(put.status, await put.text().catch(() => ''), IMG_BUCKET);
        } else {
          // 放好了才删原件 (反过来的话失败一次就丢图)
          const del = await ossSignedRequest(env, {
            method: 'DELETE', key, bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST
          });
          item.delete_status = del.status;
          item.ok = del.ok;
          if (!del.ok) {
            item.error = ossErrorText(del.status, await del.text().catch(() => ''), IMG_BUCKET);
            item.hint = '删原件要 RAM 里给 oss:DeleteObject';
          }
        }
      }
    } catch (err) {
      item.error = String((err && err.message) || err);
    }
    report.moved.push(item);
  }

  // 正文引用一起改 (只动真的引用了 img/unsorted/ 的文章)
  report.rewritten = [];
  for (const row of refs) {
    const fixed = String(row.content).split(from).join(to);
    if (fixed === row.content) continue;
    await env.DB.prepare(`UPDATE articles SET content = ?, updated_at = ? WHERE id = ?`)
      .bind(fixed, Date.now(), row.id).run();
    report.rewritten.push(row.id);
  }

  console.log('OSS 搬运 img/unsorted →', to, JSON.stringify({
    count: report.moved.length,
    failed: report.moved.filter((m) => !m.ok).length,
    rewritten: report.rewritten
  }));
  return Response.json({ ok: true, ...report });
}


async function handleAvatarDiag(request, env, url) {
  // 站长自查: 密钥配没配、桶通不通、凭证能不能写。只回状态码与 OSS 的话, 不外露密钥本体
  // (AccessKey ID 只回前 4 位 + 长度, 这两个足够看出「粘多了空格」这类问题)。
  // 参数: ?bucket=image 换到配图桶 (省略 = 头像桶), ?list=<前缀> 列对象,
  //       ?cleanup=1 清掉探针残留, ?delete=<对象名> 删单个对象, ?probe=1 真写一个再删掉。
  // 列对象要 RAM 里有 oss:ListObjects (Resource 是桶本身, 不带 /*), 没给就会 403 ——
  // 那条错误会原样回到 list_error 里。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.r2')) return Response.json({ error: '仅站长可操作' }, { status: 403 });

  const wantImage = !!(url && url.searchParams.get('bucket') === 'image');
  const which = wantImage ? OSS_BUCKETS.image : OSS_BUCKETS.avatar;
  // 对象名前面那一截: 头像桶是 avatar/, 配图桶是 img/
  const keyPrefix = wantImage ? 'img/' : 'avatar/';
  const ak = String(env.OSS_ACCESS_KEY_ID || '');
  const sk = String(env.OSS_ACCESS_KEY_SECRET || '');
  const out = {
    configured: avatarStorageReady(env),
    target: wantImage ? 'image' : 'avatar',
    bucket: which.bucket,
    region: OSS_REGION,
    upload_host: which.host,
    public_base: which.publicBase,
    credential: {
      ak_length: ak.length,
      ak_prefix: ak.slice(0, 4),
      ak_has_whitespace: /\s/.test(ak),
      sk_length: sk.length,
      sk_has_whitespace: /\s/.test(sk)
    }
  };

  try {
    const probe = await fetch(`${which.publicBase}/`, { method: 'GET' });
    out.public_status = probe.status;
  } catch (err) {
    out.public_error = String((err && err.message) || err);
  }

  // ?delete=<对象名> 删一个对象 (只允许 avatar/ 或 img/ 开头) —— 站长手工清理用
  if (url && url.searchParams.get('delete')) {
    const key = String(url.searchParams.get('delete')).trim();
    if (!(key.startsWith('avatar/') || key.startsWith('img/')) || key.includes('..')) {
      out.delete_key_status = '只允许删 avatar/ 或 img/ 下的对象';
    } else {
      const del = await ossSignedRequest(env, { method: 'DELETE', key, bucket: which.bucket, host: which.host });
      out.deleted = key;
      out.delete_key_status = del.status;
      if (!del.ok) out.delete_key_error = ossErrorText(del.status, await del.text().catch(() => ''), which.bucket);
    }
  }

  // ?list=<前缀> 列对象; ?cleanup=1 = 列 <桶前缀>__diag__* 并逐个删掉
  // (探针写过又没删成功的残留文件就靠这个清; 需要 RAM 里给 oss:ListObjects)
  const cleanup = url && url.searchParams.get('cleanup');
  const listPrefix = url && (url.searchParams.get('list') || (cleanup ? keyPrefix + '__diag__' : ''));
  if (listPrefix) {
    try {
      const listed = await ossListObjects(env, listPrefix, { bucket: which.bucket, host: which.host });
      out.list_prefix = listPrefix;
      out.list_status = listed.status;
      out.list_count = listed.keys.length;
      out.list_keys = listed.keys.slice(0, 200);
      if (listed.status >= 400) out.list_error = ossErrorText(listed.status, listed.raw, which.bucket);
      if (cleanup && listed.keys.length) {
        const done = [];
        for (const k of listed.keys) {
          const del = await ossSignedRequest(env, { method: 'DELETE', key: k, bucket: which.bucket, host: which.host });
          const raw = del.ok ? '' : await del.text().catch(() => '');
          done.push({ key: k, status: del.status, error: del.ok ? undefined : ossErrorText(del.status, raw, which.bucket) });
        }
        out.cleaned = done;
      }
    } catch (err) {
      out.list_error = String((err && err.message) || err);
    }
  }

  // ?orphans=1 找「桶里有、但数据库里没人引用」的对象 (默认只报告); &apply=1 真删
  if (url && url.searchParams.get('orphans')) {
    if (!avatarStorageReady(env)) {
      out.orphans_report = { error: '缺 OSS 密钥 (本地没写 .dev.vars 时就是这样)' };
    } else {
      try {
        out.orphans_report = await storageOrphans(env, wantImage ? 'image' : 'avatar', !!url.searchParams.get('apply'));
      } catch (err) {
        out.orphans_report = { error: String((err && err.message) || err) };
      }
    }
  }

  // ?probe=1 会真的写一个小对象再删掉, 用来确定「这个 AK 能不能写这个桶」
  if (url && url.searchParams.get('probe')) {
    const key = keyPrefix + '__diag__' + Date.now() + '.txt';
    try {
      // 先用同一个对象名做一次「删不存在的对象」探删除权限 (允许时返回 204):
      // 没有 oss:DeleteObject 就直接不写了 —— 否则探针写进去的东西删不掉, 留一堆垃圾。
      const pre = await ossSignedRequest(env, { method: 'DELETE', key, bucket: which.bucket, host: which.host });
      out.predelete_status = pre.status;
      if (!pre.ok) {
        out.predelete_error = ossErrorText(pre.status, await pre.text().catch(() => ''), which.bucket);
        out.write_status = '跳过（没有删除权限，不留垃圾）';
        return Response.json(out);
      }
      const put = await ossSignedRequest(env, {
        method: 'PUT', key, body: new TextEncoder().encode('foraine diag'), contentType: 'text/plain',
        bucket: which.bucket, host: which.host
      });
      out.write_status = put.status;
      const raw = await put.text().catch(() => '');
      out.write_response = raw.slice(0, 900); // OSS 会把签错时它算的 StringToSign 一并回显
      if (!put.ok) out.write_error = ossErrorText(put.status, raw, which.bucket);
      else {
        const del = await ossSignedRequest(env, { method: 'DELETE', key, bucket: which.bucket, host: which.host });
        out.delete_status = del.status;
        out.probe_key = key; // 万一没删掉, 这里能捞到对象名
        if (!del.ok) {
          const delRaw = await del.text().catch(() => '');
          out.delete_error = ossErrorText(del.status, delRaw, which.bucket);
        }
      }
    } catch (err) {
      out.write_error = String((err && err.message) || err);
    }
  }

  return Response.json(out);
}


async function handleMigrateAvatars(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.r2')) return Response.json({ error: '仅站长可操作' }, { status: 403 });
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '缺 OSS 密钥（本地没写 .dev.vars 时就是这样）' }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const apply = !!(body && body.apply);

  const OLD_BASE = 'https://avatar.foraine.xyz';
  const OLD_BUCKET = 'foraine-avatar';
  const OLD_HOST = 'foraine-avatar.oss-us-west-1.aliyuncs.com';
  const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

  const { results } = await env.DB.prepare(
    `SELECT p.user_id, p.avatar_url, u.username
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE p.avatar_url LIKE 'https://avatar.foraine.xyz/%'`
  ).all();
  const rows = results || [];
  const report = { total: rows.length, migrated: [], failed: [] };

  for (const row of rows) {
    const oldPath = String(row.avatar_url).slice(OLD_BASE.length).split('?')[0].replace(/^\//, '');
    let ext = (String(oldPath).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || 'png';
    if (ext === 'jpeg') ext = 'jpg';
    if (!MIME_OF[ext]) ext = 'png';
    const key = avatarObjectKey(row.username, ext);
    const toUrl = `${AVATAR_PUBLIC_BASE}/${key}?v=${Date.now()}`;

    if (!apply) {
      report.migrated.push({ username: row.username, from: row.avatar_url, to: toUrl });
      continue;
    }
    try {
      const fetched = await fetch(String(row.avatar_url).split('?')[0]);
      if (!fetched.ok) {
        report.failed.push({ username: row.username, reason: '旧头像拉取失败 HTTP ' + fetched.status });
        continue;
      }
      const bytes = new Uint8Array(await fetched.arrayBuffer());
      const put = await ossSignedRequest(env, { method: 'PUT', key, body: bytes, contentType: MIME_OF[ext] });
      if (!put.ok) {
        report.failed.push({ username: row.username, reason: '上传失败: ' + ossErrorText(put.status, await put.text().catch(() => ''), OSS_BUCKET) });
        continue;
      }
      await env.DB.prepare(`UPDATE profiles SET avatar_url = ? WHERE user_id = ?`).bind(toUrl, row.user_id).run();
      const del = await ossSignedRequest(env, { method: 'DELETE', key: oldPath, bucket: OLD_BUCKET, host: OLD_HOST }).catch(() => null);
      report.migrated.push({ username: row.username, to: toUrl, old_deleted: del ? del.status : 'n/a' });
    } catch (err) {
      report.failed.push({ username: row.username, reason: String((err && err.message) || err) });
    }
  }

  return Response.json({ ok: true, apply, ...report });
}

/* 一次性清理: 把旧布局的 img/ 对象全删掉 (新布局 = img/article/ 与 img/user/)。
   线上文章 / 评论的引用已为 0, 只有少量 emoji / 聊天图会显示失效。
   只删不属于新前缀的对象, 所以任何时候跑都安全; 顺手清掉库里指向它们的死引用。 */


async function handlePurgeImages(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.r2')) return Response.json({ error: '仅站长可操作' }, { status: 403 });
  if (!avatarStorageReady(env)) return Response.json({ error: '缺 OSS 密钥' }, { status: 503 });

  const body = await request.json().catch(() => null);
  const apply = !!(body && body.apply);

  const listed = await ossListObjects(env, 'img/', { bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST });
  const report = { bucket: IMG_BUCKET, list_status: listed.status, listed_count: listed.keys.length, old: [], deleted: [], db_cleaned: {} };
  if (listed.status >= 400) {
    report.list_error = ossErrorText(listed.status, listed.raw, IMG_BUCKET);
    return Response.json({ ok: false, apply, ...report });
  }
  // 新布局的两个前缀之外的全算旧对象
  report.old = listed.keys.filter((k) => !k.startsWith('img/article/') && !k.startsWith('img/user/'));
  if (!apply) return Response.json({ ok: true, apply, ...report });

  for (const key of report.old) {
    report.deleted.push({ key, status: await deleteObject(env, 'image', key) });
  }
  // 顺手把库里指向这些对象的死引用清掉 (表情行删掉; 背景地址置空)
  let emojiDel = 0, bgCleared = 0, chatBgCleared = 0;
  for (const key of report.old) {
    const like = '%' + IMG_PUBLIC_BASE + '/' + key + '%';
    const a = await env.DB.prepare(`DELETE FROM emoji WHERE url LIKE ?`).bind(like).run();
    emojiDel += (a.meta && a.meta.changes) || 0;
    const b = await env.DB.prepare(`UPDATE profiles SET bg_image = '' WHERE bg_image LIKE ?`).bind(like).run();
    bgCleared += (b.meta && b.meta.changes) || 0;
    const c = await env.DB.prepare(`UPDATE profiles SET chat_bg = '' WHERE chat_bg LIKE ?`).bind(like).run();
    chatBgCleared += (c.meta && c.meta.changes) || 0;
    await env.DB.prepare(`DELETE FROM stored_image WHERE url LIKE ?`).bind(like).run();
  }
  report.db_cleaned = { emoji: emojiDel, bg_image: bgCleared, chat_bg: chatBgCleared };
  console.log('清掉旧 img/ 对象:', JSON.stringify(report.deleted));
  return Response.json({ ok: true, apply, ...report });
}


export { handleRekeyImages, handleAvatarDiag, handleMigrateAvatars, handlePurgeImages };
