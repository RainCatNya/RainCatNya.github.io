// handlers/oss.js —— 站长「OSS」页签 (个人页第二级标签栏里那两个桶)。
//   列出两个桶的卡片, 点开后就是桶的内容, 布局像 D1 那样。
//   全是站长专属 (`*` 权限), 和 D1 控制台一个口径 —— 桶里是所有人的图 / 文件。
//   列对象要多一个 RAM 动作 oss:ListObjects (Resource = 桶本身, 不带 /*)。

import {
  IMG_BUCKET, IMG_PUBLIC_BASE, IMG_UPLOAD_HOST,
  RES_BUCKET, RES_PUBLIC_BASE, RES_UPLOAD_HOST,
  avatarStorageReady, deleteObject, getSessionUser, hasPermission, loadPermissions,
  ossErrorText, ossListObjects, ossSignedRequest
} from '../common.js';

const OSS_BUCKET_CARDS = [
  {
    key: 'image',
    bucket: IMG_BUCKET,
    host: IMG_UPLOAD_HOST,
    publicBase: IMG_PUBLIC_BASE,
    about: '图片桶: 头像 / 文章配图 / 表情 / 聊天图'
  },
  {
    key: 'resource',
    bucket: RES_BUCKET,
    host: RES_UPLOAD_HOST,
    publicBase: RES_PUBLIC_BASE,
    about: '资源桶: 上传的文件 (登记在 Resource 页, 默认 7 天过期)'
  }
];

// 顺手复用的那道门 —— 三个接口都要「登录 + 站长」
async function requireOwner(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return { error: Response.json({ error: '未登录' }, { status: 401 }) };
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.r2')) {
    return { error: Response.json({ error: '仅站长可操作' }, { status: 403 }) };
  }
  return { user };
}

function bucketCard(key) {
  return OSS_BUCKET_CARDS.find((b) => b.key === key) || OSS_BUCKET_CARDS[0];
}

async function handleOssBuckets(request, env) {
  // 两个桶的卡片 (页签栏要点开哪个桶, 靠这份清单)
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  return Response.json({
    configured: avatarStorageReady(env),
    buckets: OSS_BUCKET_CARDS
  });
}

async function handleOssList(request, env, url) {
  // 列一个前缀下的东西: 子前缀(folders) + 对象(objects), 一次最多 1000
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }

  const card = bucketCard(url.searchParams.get('bucket') === 'resource' ? 'resource' : 'image');
  const prefix = String(url.searchParams.get('prefix') || '');
  const token = String(url.searchParams.get('token') || '');

  try {
    /* 这里不能给 OSS 传 `delimiter=/` —— 它会把查询串变成 `delimiter=%2F`, 而 OSS V4
       签名对斜杠的编码跟我们的 encodeURIComponent 对不上, 直接 SignatureDoesNotMatch
       (实测: 加上就看不了桶)。所以改成「拉平列表 + 前端自己按下一级目录分组」。 */
    const listed = await ossListObjects(env, prefix, {
      bucket: card.bucket, host: card.host, token
    });
    if (listed.status >= 400) {
      return Response.json({
        error: ossErrorText(listed.status, listed.raw, card.bucket),
        /* 诊断用 —— 列桶签名对不上时, 这几项合起来就是完整的案发现场:
           · oss_raw       OSS 回的原文 (里面会回显它自己算的 CanonicalRequest, 即标准答案)
           · oss_canonical 我们自己算的规范请求, 跟上面那份逐字节比就知道差在哪
           · oss_echo      已经抠出来的那份标准答案 (有值 = 代码能照抄自愈)
           · oss_url       实际发出去的 URL (桶名 / 前缀 / 编码都能看到)
           前端 (oss-console.js) 把它们摊在 R2 页签里, 用户不用再开 F12 翻 Network。 */
        oss_status: listed.status,
        oss_raw: String(listed.raw || '').slice(0, 2000),
        oss_canonical: String(listed.canonical || '').slice(0, 1200),
        oss_echo: listed.echo || null,
        oss_url: listed.url || '',
        oss_style: listed.style,
        oss_learned: listed.learned || false
      }, { status: 502 });
    }
    return Response.json({
      bucket: card.bucket,
      public_base: card.publicBase,
      prefix,
      // 列桶用的签名写法 (#0 正常 / #1 值里不编码斜杠) —— 只在页签的提示行里显示一下
      oss_style: listed.style,
      oss_learned: !!listed.learned,
      objects: listed.contents.map((o) => ({
        key: o.key,
        name: o.key.slice(prefix.length) || o.key,
        size: o.size,
        last_modified: o.lastModified,
        url: card.publicBase + '/' + o.key
      })),
      truncated: listed.truncated,
      next_token: listed.nextToken || null
    });
  } catch (err) {
    console.error('列 OSS 对象失败:', err && (err.message || err.cause) || err);
    return Response.json({ error: '列对象失败，请稍后再试' }, { status: 500 });
  }
}

/* 把一个前缀下所有对象拉平 (分页, 最多 maxPages × 1000 个)。列目录本身不带 delimiter
   (见 handleOssList 的注释), 所以这里拿到的就是整棵子树。 */
async function listAllUnder(env, card, prefix, maxPages) {
  const keys = [];
  let token = '';
  for (let page = 0; page < (maxPages || 20); page += 1) {
    const listed = await ossListObjects(env, prefix, { bucket: card.bucket, host: card.host, token });
    if (listed.status >= 400) return { error: listed, keys };
    (listed.contents || []).forEach((o) => keys.push(o));
    if (!listed.truncated || !listed.nextToken) return { keys, truncated: false };
    token = listed.nextToken;
  }
  return { keys, truncated: true };
}

/* 每个子文件夹的「个数 + 总大小」(大小列显示 xx个 / xxMB)。
   单独一个接口: 塞进主列表就得对每个子目录再列一次, 会把「打开桶」拖成好几秒。 */
async function handleOssFolders(request, env, url) {
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }
  const card = bucketCard(url.searchParams.get('bucket') === 'resource' ? 'resource' : 'image');
  const prefix = String(url.searchParams.get('prefix') || '');

  const listed = await listAllUnder(env, card, prefix, 20);
  if (listed.error) {
    return Response.json({ error: ossErrorText(listed.error.status, listed.error.raw, card.bucket) }, { status: 502 });
  }
  const totals = new Map();
  listed.keys.forEach((o) => {
    const rest = o.key.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut < 0) return;                       // 前缀根下的散文件不算文件夹
    const name = rest.slice(0, cut + 1);
    /* 文件夹占位对象 (0 字节、key 正好是 `名字/`) 不计入个数与体积 ——
       它是「让空文件夹能出现在列表里」的必需品 (OSS 没有真目录, 不留这个对象
       新文件夹就不会出现在上一层的列表里), 但它不是用户眼里的内容。 */
    const isMarker = name === rest && !Number(o.size);
    const cur = totals.get(name) || { name, prefix: prefix + name, count: 0, size: 0 };
    if (!isMarker) {
      cur.count += 1;
      cur.size += o.size || 0;
    }
    totals.set(name, cur);
  });
  return Response.json({
    folders: Array.from(totals.values()).sort((a, b) => (a.name < b.name ? -1 : 1)),
    truncated: !!listed.truncated
  });
}

/* 递归删文件夹。Workers 的子请求有上限 (免费计划 50/请求), 所以一次只删一小批,
   前端循环调用直到 done。 */
async function handleOssDeleteFolder(request, env) {
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }
  const body = await request.json().catch(() => ({}));
  const card = bucketCard(body.bucket === 'resource' ? 'resource' : 'image');
  const prefix = String(body.prefix || '');
  if (!prefix || !prefix.endsWith('/') || prefix.indexOf('..') >= 0) {
    return Response.json({ error: '路径错误或不存在' }, { status: 400 });
  }

  const BATCH = 25;
  const listed = await ossListObjects(env, prefix, { bucket: card.bucket, host: card.host });
  if (listed.status >= 400) {
    return Response.json({ error: ossErrorText(listed.status, listed.raw, card.bucket) }, { status: 502 });
  }
  const keys = (listed.contents || []).map((o) => o.key);
  let deleted = 0;
  let failed = 0;
  for (const key of keys.slice(0, BATCH)) {
    const status = await deleteObject(env, card.key, key);
    if (status >= 400) failed += 1;
    else deleted += 1;
  }
  const done = keys.length <= BATCH && !listed.truncated;
  if (done) await deleteObject(env, card.key, prefix);   // 顺手把「文件夹」本身那个 0 字节标记删掉
  return Response.json({ ok: true, deleted, failed, done });
}

async function handleOssDelete(request, env) {
  // 删对象。只在页签里手删时用 —— 桶里的东西可能有引用 (文章正文 / 头像 / 聊天里),
  // 这里不做引用校验, 所以前端必须把「这幅图还在被用」讲清楚再让人点。
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const card = bucketCard(body && body.bucket === 'resource' ? 'resource' : 'image');
  const key = body && body.key ? String(body.key) : '';
  if (!key) return Response.json({ error: '缺少对象名' }, { status: 400 });

  try {
    const status = await deleteObject(env, card.key === 'resource' ? 'resource' : 'image', key);
    if (status >= 400 && status !== 404) {
      return Response.json({ error: '删除失败 (HTTP ' + status + ')' }, { status: 502 });
    }
    // 桶里的对象没了, 账本上那两行也得跟着走 (聊天图 / 资源文件的登记表)
    let rows = 0;
    try {
      const a = await env.DB.prepare(`DELETE FROM stored_image WHERE object_key = ?`).bind(key).run();
      rows += (a.meta && a.meta.changes) || 0;
    } catch (err) { /* 老库没这张表就算了 */ }
    try {
      const b = await env.DB.prepare(`DELETE FROM resource WHERE object_key = ?`).bind(key).run();
      rows += (b.meta && b.meta.changes) || 0;
    } catch (err) { /* 同上 */ }
    return Response.json({ ok: true, status, rows });
  } catch (err) {
    console.error('删除 OSS 对象失败:', err && (err.message || err.cause) || err);
    return Response.json({ error: '删除失败，请稍后再试' }, { status: 500 });
  }
}

/* ==================== 站长往桶里手放东西 ====================
   OSS 里没有真文件夹 —— 「新建文件夹」就是建一个 key 以 `/` 结尾的空对象
   (列出来正好当目录用, 删掉它也不会动到里面的对象)。
   上传走 Worker 中转 (≤ 50MB): 桶的 CORS 只有资源桶配过, 图片桶直传准挂;
   更大的文件走站点其它入口 (那条是 presign 直传, 不经过 Worker)。
   ============================================================ */
const OSS_ADMIN_UPLOAD_MAX = 50 * 1024 * 1024;

// 只留文件名本身 (去掉路径分隔符 / 控制字符), 不然能写到桶里任意位置
function sanitizeObjectName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .slice(0, 120);
}

async function handleOssFolder(request, env) {
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const card = bucketCard(body && body.bucket);
  const prefix = String((body && body.prefix) || '');
  const name = sanitizeObjectName(body && body.name);
  if (!name) return Response.json({ error: '文件夹名不合法' }, { status: 400 });

  const key = prefix + name + '/';
  try {
    const res = await ossSignedRequest(env, {
      method: 'PUT',
      key,
      body: new Uint8Array(0),
      contentType: 'application/x-directory',
      bucket: card.bucket,
      host: card.host
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return Response.json({ error: ossErrorText(res.status, raw, card.bucket) }, { status: 502 });
    }
    return Response.json({ ok: true, key });
  } catch (err) {
    console.error('建文件夹失败:', (err && (err.message || err.cause)) || err);
    return Response.json({ error: '建文件夹失败，请稍后再试' }, { status: 500 });
  }
}

async function handleOssUpload(request, env) {
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }

  const form = await request.formData().catch(() => null);
  const file = form && form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: '没拿到文件' }, { status: 400 });
  if (file.size > OSS_ADMIN_UPLOAD_MAX) {
    return Response.json({ error: '这个入口单个文件最多 50 MB' }, { status: 413 });
  }

  const card = bucketCard(form.get('bucket'));
  const prefix = String(form.get('prefix') || '');
  const name = sanitizeObjectName(file.name || 'file');
  if (!name) return Response.json({ error: '文件名不合法' }, { status: 400 });
  const key = prefix + name;

  try {
    const res = await ossSignedRequest(env, {
      method: 'PUT',
      key,
      body: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || 'application/octet-stream',
      bucket: card.bucket,
      host: card.host
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return Response.json({ error: ossErrorText(res.status, raw, card.bucket) }, { status: 502 });
    }
    return Response.json({ ok: true, key, size: file.size });
  } catch (err) {
    console.error('上传到 OSS 失败:', (err && (err.message || err.cause)) || err);
    return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
  }
}

/* 下载单个对象 (右键菜单那个「下载」)。资源桶是私有读的, 不能给直链;
   图片桶虽然公读, 但走这里能强制 attachment, 不会把图开成新页面。 */
async function handleOssMedia(request, env, url) {
  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;
  if (!avatarStorageReady(env)) {
    return Response.json({ error: 'OSS 还没配置（缺密钥）' }, { status: 503 });
  }

  const card = bucketCard(url.searchParams.get('bucket'));
  const key = String(url.searchParams.get('key') || '');
  if (!key) return Response.json({ error: '缺少对象名' }, { status: 400 });

  try {
    const res = await ossSignedRequest(env, { method: 'GET', key, bucket: card.bucket, host: card.host });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return Response.json({ error: ossErrorText(res.status, raw, card.bucket) }, { status: 502 });
    }
    const headers = new Headers(res.headers);
    headers.delete('Cache-Control');
    headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(key.split('/').pop() || 'file') + '"');
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    console.error('取 OSS 对象失败:', (err && (err.message || err.cause)) || err);
    return Response.json({ error: '取文件失败，请稍后再试' }, { status: 500 });
  }
}

export { handleOssBuckets, handleOssDelete, handleOssList, handleOssFolder, handleOssUpload, handleOssMedia, handleOssFolders, handleOssDeleteFolder };
