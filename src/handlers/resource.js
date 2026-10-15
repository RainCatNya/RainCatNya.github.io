// handlers/resource.js —— 资源桶 (foraine-resource) 与资源中心。
// 2026-09-16 从 handlers/upload.js 拆出来: upload.js 只管头像与配图, 资源这条线自己成域
// (上传 / 大文件直传 / 下载 / 列表 / 详情 / 删除)。基础设施与常量在 ../common.js。
//
// 一个桶、一张表, 装着两种东西, 靠 resource.scope 分家:
//   'chat'    私聊里粘的文件。默认 7 天, 到期 cron 连对象带记录一起清, 永远不进资源中心。
//   'library' 资源中心的资源。默认永久 (expires_at = NULL), 会出现在 /api/resources 里。
// 桶本身是公共读 (实测匿名 GET 200), 而 res.foraine.xyz 又过 Cloudflare (cf-cache-status: HIT) ——
// 「仅登录可下」在这种配置下只挡得住「从页面点下载」这一条路, 直链谁拿到谁能下。
// 所以资源中心走公开分享的路线: 列表公开、下载公开; 私聊附件那条路仍要求登录。

import { RESOURCE_KIND_LABELS, RESOURCE_KINDS, RESOURCE_TYPES, RES_BUCKET, RES_MAX_BYTES, RES_PUBLIC_BASE, RES_TTL_MS, RES_UPLOAD_HOST, RES_QUOTA_TIERS, RES_WEEKLY_DAYS, RES_QUOTA_LEGACY_DAILY_BYTES, RES_AUTO_GUARD_BYTES, SITE_ORIGIN, addUploadUsage, avatarStorageReady, checkRateLimit, checkUploadQuota, clientIp, deleteObject, extFromFilename, getSessionUser, hasPermission, loadPermissions, loadSiteFlags, logDownload, dlTakeSlot, dlReleaseSlot, dlActiveCount, resQuotaTier, DL_CONCURRENCY, RES_NOTIFY_BATCH_BYTES, RES_NOTIFY_BIG_BYTES, ossErrorText, ossCanonicalEcho, ossSignedRequest, peekStorageUsed, peekUploadQuota, randomHex, retryText, sendNotice, sizeText, verifyUserPassword } from '../common.js';


const RES_TITLE_MAX = 120;
const RES_DESC_MAX = 400;

/* 资源中心给上传者挑的有效期 (键是前端传的 expire, 值是小时数; never = 永久)。
   ⚠️ 只认这几档, 不让上传者自由填天数 —— 过期之后对象就真没了, 手滑填个 1 天等于自删。
   键必须与 public/resource/index.html 的 RES_EXPIRE_CHOICES 对得上。 */
const RES_EXPIRE_OPTIONS = {
  '24h': 24,
  '72h': 72,
  '7': 7 * 24,
  '30': 30 * 24,
  never: 0
};

/* 标题 / 简介 / 校验值: 一律在服务端再截一次 (前端那份只是显示用的) */
function cleanResourceMeta(payload) {
  const rawHash = String(payload.sha256 || '').trim().toLowerCase();
  const rawSha1 = String(payload.sha1 || '').trim().toLowerCase();
  return {
    title: String(payload.title || '').trim().slice(0, RES_TITLE_MAX),
    description: String(payload.description || '').trim().slice(0, RES_DESC_MAX),
    // 只认完整的十六进制; 算不出来的 (老浏览器没有 WebCrypto) 就留空
    sha256: /^[0-9a-f]{64}$/.test(rawHash) ? rawHash : null,
    sha1: /^[0-9a-f]{40}$/.test(rawSha1) ? rawSha1 : null
  };
}

/* 到期时刻 (ms)。scope='library' 时不选 (或填了认不出的档) 就是永久 (NULL, cron 会跳过);
   私聊附件不吃调用方的选择, 固定 RES_TTL_MS。 */
function parseResourceExpiry(expire, scope) {
  if (scope !== 'library') return Date.now() + RES_TTL_MS;
  const hours = RES_EXPIRE_OPTIONS[String(expire || 'never')];
  if (!hours) return null;
  return Date.now() + hours * 60 * 60 * 1000;
}

/* 对象上那条 Content-Disposition (RFC 5987: 老浏览器看 filename, 新的看 filename*)。
   ⚠️ 头里只能出现 ASCII: 中文会被换成一串下划线, 真正的名字走 filename* 的百分号编码。 */
function resourceDisposition(name) {
  const clean = String(name || 'resource').replace(/[\r\n"]/g, '').slice(0, 120) || 'resource';
  return `attachment; filename="${clean.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/* 列表 / 详情里那个「下载」地址。
   非图片对象在 PUT 时就挂了 Content-Disposition, 直链点开就是下载, 而且吃 Cloudflare 缓存;
   图片故意不挂 (挂了 `<img>` 可能就不渲染了), 所以给它补一个 response-content-disposition 参数 ——
   只多一个 query 当缓存键, 图片本来也小。 */
function resourceDownloadUrl(row) {
  const base = `${RES_PUBLIC_BASE}/${row.object_key}`;
  if (String(row.mime || '').indexOf('image/') === 0) {
    return `${base}?response-content-disposition=${encodeURIComponent(resourceDisposition(row.name))}`;
  }
  return base;
}

/* OSS 单次 PUT 回来的 ETag 就是内容的 MD5 (带引号的十六进制)。
   拿它当「服务端校验值」: 5GB 的文件在浏览器里根本算不动 SHA-256, 而这个是 OSS 自己算的,
   准确且零成本。⚠️ 分片上传的 ETag 不是 MD5 (带 -N 后缀), 那时只能返回空。 */
function md5FromEtag(etag) {
  const value = String(etag || '').replace(/"/g, '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) ? value : null;
}

/* 资源中心的对象缓存头要比私聊附件短得多: 桶是公共读、边缘又在缓存,
   对象上写 immutable 的话, 删掉对象之后 Cloudflare 还会继续吐旧副本 (实测过 HIT)。
   永久文件给一天 (反复下载仍吃得到缓存), 会过期的给一小时 (失效的滞后窗口小一点)。
   私聊附件保持原来的 immutable —— 它们本来就只活 7 天, 不值得为这改行为。 */
function resourceCacheControl(expiresAt) {
  return expiresAt ? 'public, max-age=3600' : 'public, max-age=86400';
}

/* 对象名末尾那截扩展名 (卡片上那枚 ZIP / PDF 小标, 以及右栏分组筛选用它) */
function resourceExtOf(objectKey) {
  const match = String(objectKey || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match ? match[1] : '';
}

/* ==================== 防盗 ====================
   「防盗」= 这个文件只能在 Foraine 站内下载。它是**两件事一起做**:
     ① 对象 ACL 设成 private —— 匿名直链 (贴到别处、别人的脚本、迅雷) 一律 403。
        这是真正的那道门: 桶本身是公共读, 不改 ACL 的话直链谁拿到谁能下。
     ② 下载接口校验 Referer —— 挡住「把 /api/resource/download?id=N 贴到别的站」这条。
   ⚠️ OSS 桶上那条 Referer 白名单只对**匿名**请求生效 (实测: 带签名的 Worker 请求照过),
      所以它挡的是直链, 挡不住会签名的脚本; 用户 2026-09-16 认可这个威胁模型
      (「安全问题应该由用户负责」)。别把它当成真保险箱。
   ⚠️ res.foraine.xyz 走 Cloudflare 且**按 URL 缓存** (Referer 不进缓存键), 所以
      刚开启防盗的那一小段时间里, 边缘可能还留着旧的公开副本 —— 库里的对象最长
      max-age=86400 (永久那档), 要立刻生效只能换对象名或等它过期。 */
const RES_SITE_REFERERS = [
  'https://foraine.xyz/',
  'https://www.foraine.xyz/',
  'http://localhost:8788/',
  'http://127.0.0.1:8788/'
];

/* 空 Referer 一律拦 (用户拍板「当然是拦死啦」)。注意首尾斜杠: 前缀匹配要连斜杠一起比,
   否则 https://foraine.xyz.evil.com/ 这种也会被放进来。 */
function siteRefererOk(request) {
  const ref = String(request.headers.get('Referer') || '');
  if (!ref) return false;
  return RES_SITE_REFERERS.some((prefix) => ref.startsWith(prefix));
}

/* 改对象的访问权限: 'private' 挡匿名直链, 'default' = 跟桶走 (桶是公共读)。
   两条路, 先走正门再走后门 —— 原因不是洁癖, 是 RAM 策略:
     ① PutObjectAcl = PUT /<object>?acl + x-oss-object-acl 头。用的是 **oss:PutObjectAcl** 这个单独的动作,
        而我们那把密钥的策略里没有它, 线上实测 403 AccessDenied
        (「You have no right to access this object because of bucket acl」,
         AccessDeniedDetail 里写着 PolicyType=ResourceGroupLevelIdentityBasedPolicy)。
        → 想走这条得往 RAM 策略里补 oss:PutObjectAcl, 补上就会自己换回正门。
     ② 自拷贝 CopyObject: x-oss-copy-source 指向自己 + x-oss-object-acl, 用的是已经有的
        oss:GetObject + oss:PutObject —— 不依赖那个缺失的权限。
        ⚠️ CopyObject 的源最长 5GB (RES_MAX_BYTES 正好也是 5GB, 卡在线上; 再大要走分片拷贝)。
        元数据、Cache-Control、Content-Disposition 都照原样保留 (元数据默认就是 COPY)。
   头都要签 (OSS V4 的规矩: x-oss-* 必须全部进签名), 见 common.js 的 signHeaders。 */
async function setResourceObjectAcl(env, objectKey, acl) {
  const direct = await ossSignedRequest(env, {
    method: 'PUT', key: objectKey, bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
    query: 'acl', cacheControl: null, signHeaders: { 'x-oss-object-acl': acl }
  });
  if (direct.ok) return { status: 0, body: '' };
  const firstBody = await direct.text().catch(() => '');
  if (direct.status !== 403) return { status: direct.status, body: String(firstBody).slice(0, 300) };

  const source = `/${RES_BUCKET}/` + String(objectKey).split('/').map(encodeURIComponent).join('/');
  const copied = await ossSignedRequest(env, {
    method: 'PUT', key: objectKey, bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
    cacheControl: null,
    signHeaders: { 'x-oss-copy-source': source, 'x-oss-object-acl': acl }
  });
  if (copied.ok) return { status: 0, body: '' };
  const body = await copied.text().catch(() => '');
  return { status: copied.status, body: `PutObjectAcl 403 → CopyObject ${copied.status} ${String(body).slice(0, 300)}` };
}

/* 这一行到底防不防盗: 文件上那份是覆盖值 (1 = 强制开 / 0 = 强制关), NULL 才是跟组走。
   schema.sql 里 resource.guard 就是这么定义的, 别把 NULL 当成「关」。 */
function resourceGuarded(row, groupGuard) {
  const own = row ? row.guard : null;
  if (own === null || own === undefined) return !!groupGuard;
  return !!own;
}

/* 按组找那一串文件 (含「老的单文件行」那种自己算一个组的情况)。
   删资源与防盗两处都用它, 免得两边对「什么算一个组」的理解跑偏。
   oldRowId 是给外面用的: group.id 为负数时前端原样传回来, 这里翻译成真实行 id。 */
async function loadResourceTargets(env, id) {
  if (id > 0) {
    const groupRow = await env.DB.prepare(
      `SELECT id, key, title, uploader_id, guard FROM resource_group WHERE id = ?`
    ).bind(id).first().catch(() => null);
    if (!groupRow) return { error: Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 }) };
    const rows = await env.DB.prepare(
      `SELECT id, name, title, object_key, guard FROM resource WHERE group_id = ? AND scope = 'library' ORDER BY seq, id`
    ).bind(id).all();
    return { group: groupRow, rows: rows.results || [] };
  }
  const single = await env.DB.prepare(
    `SELECT id, name, title, object_key, guard, uploader_id FROM resource WHERE id = ? AND scope = 'library'`
  ).bind(0 - id).first().catch(() => null);
  if (!single) return { error: Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 }) };
  return {
    group: { id, key: '', title: single.title, uploader_id: single.uploader_id, guard: single.guard || 0 },
    rows: [single]
  };
}

/* 能不能改这条资源的开关: 自己传的, 或者站长。管理员那套 (resource.delete.any) 只管删,
   防盗是上传者的设置, 不跟着给 (要改就找站长)。 */
async function canToggleResource(env, user, uploaderId) {
  if (user.id === uploaderId) return true;
  const perms = await loadPermissions(env, user.id);
  return hasPermission(perms, 'dev.access');
}

/* 发资源的三道门槛, 中转与直传共用 —— 只在中转那条路上拦是不够的, 直传会绕过去。
   ① 先填过邮箱: 资源桶对外可下载, 邮箱是「这号是你的」唯一的锚点 (老库没这列就放行);
   ② 存储配好了没;
   ③ 配额: 日闸 + 存量 / 7 天累计 / 单组文件数 (后三道见 common.js 的 checkUploadQuota)。
   groupId 给了才查「单组文件数」(往老组里加文件时才知道是哪一组)。 */
async function resourceUploadGuard(env, user, size, groupId) {
  try {
    const anchor = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(user.id).first();
    if (anchor && !anchor.email) {
      return Response.json({ error: '请先在个人主页「资料」里填写邮箱，之后才能发资源' }, { status: 403 });
    }
  } catch (err) { /* 列不存在就当没这条规矩 */ }
  if (!avatarStorageReady(env)) {
    return Response.json({ error: '存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }
  /* 「资源量限制方案」的开关（站长在个人页「Foraine」里切）:
     关掉 = 完全回到之前的样子 —— 存量 / 7 天累计 / 单组文件数 / 大流量通知都不执行,
     而且日配额回到旧值 40GB/天（20GB/天 是这一套带来的）。 */
  const flags = await loadSiteFlags(env);
  const quota = await peekUploadQuota(env, user.id, flags.quota ? 0 : RES_QUOTA_LEGACY_DAILY_BYTES);
  if (!quota.ok) {
    return Response.json({
      error: `今天的上传额度用完了（每天 ${sizeText(quota.limit)}，已用 ${sizeText(quota.used)}）`
    }, { status: 429 });
  }
  if (size && quota.used + size > quota.limit) {
    return Response.json({
      error: `今天只剩 ${sizeText(quota.limit - quota.used)} 额度，装不下这个文件`
    }, { status: 429 });
  }
  if (!flags.quota) return null;
  /* 存量 / 7 天 / 单组文件数: 出错时 checkUploadQuota 自己放行 */
  const checked = await checkUploadQuota(env, user, Number(size) || 0, groupId);
  if (checked instanceof Response) return checked;
  return null;
}

/* ==================== 大流量上传的通知 (用户 2026-09-17) ====================
   一次上传（一个组）的总量 ≥2GB 就给站长发站内信; ≥5GB 时连上传者一起通知。
   另外「单个文件 ≥5GB」也算一档（那种文件不用等一组攒够就已经很吓人了）。
   ⚠️ 去重靠 `resource_group.notify_stage`: 0 还没通知 / 2 已通知 2GB 档 / 5 已通知 5GB 档。
      不记这个的话, 往同一个组里加第二个大文件会再轰一次站长。
   ⚠️ 收件人是站长（role='owner'）; 查不到就算了, 通知这事不能拦上传。 */
async function notifyBigUpload(env, user, groupId, fileSize) {
  try {
    /* 「资源量限制方案」关掉了就不发通知（用户 2026-09-17 的「Foraine」页签开关） */
    if (!(await loadSiteFlags(env)).quota) return;
    let total = 0;
    let files = 0;
    let title = '';
    let stage = 0;
    if (Number.isInteger(groupId) && groupId > 0) {
      const row = await env.DB.prepare(
        `SELECT g.title, g.notify_stage, COALESCE(SUM(r.size), 0) AS bytes, COUNT(r.id) AS n
           FROM resource_group g LEFT JOIN resource r ON r.group_id = g.id
          WHERE g.id = ? GROUP BY g.id`
      ).bind(groupId).first();
      if (!row) return;
      total = row.bytes || 0;
      files = row.n || 0;
      title = row.title || '未命名';
      stage = row.notify_stage || 0;
    } else {
      total = Number(fileSize) || 0;   // 没有组（老的单文件路）就只看这一个文件
      files = 1;
      title = '单文件资源';
    }
    const single = Number(fileSize) || 0;
    const tier = total >= RES_NOTIFY_BIG_BYTES || single >= RES_NOTIFY_BIG_BYTES ? 5 : 2;
    if (total < RES_NOTIFY_BATCH_BYTES && single < RES_NOTIFY_BATCH_BYTES) return;
    if (tier <= stage) return;         // 这个档已经通知过了

    const owners = await env.DB.prepare(
      `SELECT id FROM users WHERE role = 'owner' AND is_deleted = 0`
    ).all().catch(() => ({ results: [] }));
    const who = user.nickname || user.username || ('用户 ' + user.id);
    const used = await peekStorageUsed(env, user.id);
    const link = Number.isInteger(groupId) && groupId > 0 ? `\n资源：${SITE_ORIGIN}/resource/?id=${groupId}` : '';
    /* 「其中最大的一个」只在那个文件本身够大时才写 —— 否则会出现「共 2 GB（其中最大的一个 0 MB）」 */
    const biggest = single >= 1024 * 1024 ? `，其中最大的一个 ${sizeText(single)}` : '';
    const body = `${who} 一次上传了 ${files} 个文件，共 ${sizeText(total)}${biggest}。`
      + `\n该账号当前占用 ${sizeText(used)}。${link}`;
    const title2 = tier >= 5 ? '有大流量上传（超过 5GB）' : '有大流量上传（超过 2GB）';
    for (const row of owners.results || []) {
      await sendNotice(env, row.id, { kind: 'system', title: title2, body });
    }
    /* 5GB 档连上传者一起通知（让他知道站长会看到, 也顺便提醒别把盘塞满） */
    if (tier >= 5) {
      await sendNotice(env, user.id, {
        kind: 'system',
        title: '你上传的内容较大',
        body: `你这次上传了 ${files} 个文件，共 ${sizeText(total)}。管理员会收到这条通知，额度过大时上传会被拦下。`
      });
    }
    if (Number.isInteger(groupId) && groupId > 0) {
      await env.DB.prepare(`UPDATE resource_group SET notify_stage = ? WHERE id = ?`)
        .bind(tier, groupId).run().catch(() => {});
    }
  } catch (err) {
    console.error('大流量上传通知失败:', err);
  }
}

/* 登记一行 resource。顺序不能反: 先登记、再 PUT 字节, 传挂了调用方要把这行删掉
   (别留「有记录没对象」的空条目)。 */
async function insertResourceRow(env, fields) {
  const inserted = await env.DB.prepare(
    `INSERT INTO resource (name, object_key, size, mime, uploader_id, expires_at, created_at, scope, title, description, sha256, sha1, group_id, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    fields.name, fields.objectKey, fields.size, fields.mime, fields.uploaderId,
    fields.expiresAt, fields.now, fields.scope, fields.title, fields.description, fields.sha256, fields.sha1 || null,
    fields.groupId || null, fields.seq || null
  ).run();
  return inserted.meta && inserted.meta.last_row_id ? inserted.meta.last_row_id : null;
}

/* 组 key: 对象名里那一截目录名 (res/<用户名>/<key>/<序号>-<slug>.<ext>)。
   必须**在登记之前**就定下来 —— 我们的规矩是先登记再 PUT, 对象名要先生成,
   所以不能用自增 id 当目录名。 */
function resourceGroupKey() {
  return Date.now().toString(36) + '-' + randomHex(4);
}

/* 开一个新组。资源中心的每个文件都挂在一个组底下 (一次上传 = 一个组, 哪怕只有一个文件)。
   ⚠️ `allow_edit`（「公开编辑」）**不在这一步定**（用户 2026-09-17 把工作台里那个开关删了）:
   新组一律 0, 之后在详情页右栏那块面板上用 `POST /api/resource/allow-edit` 开。
   `batchBytes` = 这一批要传的总字节（前端声明的那份）—— 超过 `RES_AUTO_GUARD_BYTES` (5GB) 时
   新组默认开防盗链（用户 2026-09-17: 大文件最容易被白嫖流量）。返回的 `autoGuard` 让前端能说一句。
   ⚠️ 只在这一步判: 往老组里加文件不动人家原来的开关。 */
async function createResourceGroup(env, user, meta, expiresAt, batchBytes) {
  const key = resourceGroupKey();
  const now = Date.now();
  const autoGuard = Number(batchBytes) > RES_AUTO_GUARD_BYTES ? 1 : 0;
  const inserted = await env.DB.prepare(
    `INSERT INTO resource_group (key, title, description, uploader_id, expires_at, allow_edit, guard, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(key, meta.title, meta.description, user.id, expiresAt, autoGuard, now, now).run();
  const id = inserted.meta && inserted.meta.last_row_id ? inserted.meta.last_row_id : null;
  return { id, key, autoGuard: !!autoGuard };
}

/* 对象名: res/<用户名>/<组key>/<序号>-<文件名slug>.<ext> (用户 2026-09-16 定的规则)。
   按组分目录的好处: 桶里一眼看得出哪几个文件是一组, 删组 / 扫孤儿能按前缀批量处理。
   ⚠️ slug 里不能出现斜杠与 # % 这类会改变 URL 语义的字符 (中文留着, 签名那层会按段编码)。 */
function resourceObjectKey(user, groupKey, seq, name, ext) {
  const slugUser = String(user.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'anon';
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const slug = stem.replace(/[\\/:*?"<>|#%\s]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 40) || 'file';
  return `res/${slugUser}/${groupKey}/${seq}-${slug}.${ext}`;
}

/* 私聊附件还是老样子 (没有组的概念): res/<用户名>/<时间戳36>-<随机>.<ext> */
function chatObjectKey(user, ext) {
  const slug = String(user.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'anon';
  return `res/${slug}/${Date.now().toString(36)}-${randomHex(4)}.${ext}`;
}

/* 组里下一个序号 (新文件排在最后) */
async function nextResourceSeq(env, groupId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM resource WHERE group_id = ?`
  ).bind(groupId).first().catch(() => null);
  return ((row && row.maxSeq) || 0) + 1;
}

/* 取一个自己能往里加文件的组 (自己传的 / 站长的 / **开了「允许其他人编辑」且我邮箱验证过**的)。
   不行就返回 { error: Response }。 */
async function loadEditableGroup(env, id, user) {
  if (!Number.isInteger(id) || id <= 0) return { error: Response.json({ error: '缺少组编号' }, { status: 400 }) };
  const group = await env.DB.prepare(
    `SELECT id, key, uploader_id, title, description, expires_at, guard, allow_edit FROM resource_group WHERE id = ?`
  ).bind(id).first().catch(() => null);
  if (!group) return { error: Response.json({ error: '这个组不存在（可能已被清掉）' }, { status: 404 }) };
  if (group.uploader_id !== user.id) {
    const perms = await loadPermissions(env, user.id);
    if (!hasPermission(perms, 'dev.access') && !(group.allow_edit && await emailVerified(env, user.id))) {
      return { error: Response.json({ error: '不能编辑别人的资源组' }, { status: 403 }) };
    }
  }
  return { group };
}

/* 这号的邮箱验证过没有（「允许其他人编辑」的门槛）。
   ⚠️ 老库可能没这两列 —— 缺列一律当未验证, 绝不能把登录连累掉。 */
async function emailVerified(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT email, email_verified FROM users WHERE id = ?')
      .bind(userId).first();
    return Boolean(row && row.email && row.email_verified);
  } catch (err) {
    return false;
  }
}


async function handleResourceUpload(request, env) {
  // 上传资源 (走 Worker 中转): POST /api/resource/upload
  // multipart: file + name + scope + title + description + sha256 + expire
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json({ error: '无效的上传' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: '没有收到文件' }, { status: 400 });
  if (file.size > RES_MAX_BYTES) {
    return Response.json({ error: `资源不能超过 ${sizeText(RES_MAX_BYTES)}` }, { status: 400 });
  }
  if (!file.size) return Response.json({ error: '这个文件是空的' }, { status: 400 });

  /* 类型判定与直传那条路保持一致: 先看 mime, mime 认不出来再按文件名认。
     只看 mime 的话, 有些系统 (以及拖进来的文件) 给的是 application/octet-stream,
     明明是个 .zip 也被拦下, 用户看到的是那句莫名其妙的「不支持这种文件」。 */
  const ext = RESOURCE_TYPES[file.type] || extFromFilename(String(form.get('name') || file.name || ''));
  if (!ext) return Response.json({ error: '不支持这种文件（仅支持压缩包 / PDF / 文本 / 图片 / 音视频）' }, { status: 400 });

  // 配额要拿字节数去比, 所以得等 formData 解析完才能查 (大小从 request.headers 猜不准)
  const wantedGroup = parseInt(String(form.get('group_id') || ''), 10);
  const blocked = await resourceUploadGuard(env, user, file.size, Number.isInteger(wantedGroup) ? wantedGroup : 0);
  if (blocked) return blocked;

  const scope = form.get('scope') === 'library' ? 'library' : 'chat';
  // 文件自己的标题/简介 (前端左栏队列里每个文件单独设的那对)
  const fileMeta = cleanResourceMeta({
    title: form.get('title'), description: form.get('description'),
    sha256: form.get('sha256'), sha1: form.get('sha1')
  });
  /* 组的那对。开新组时没传 group_title 就拿文件那对顶上 —— 单个文件直接上传时
     （老的单文件弹窗就是这么发的）卡片上总得有个名字。 */
  const groupMeta = cleanResourceMeta({
    title: form.get('group_title') || fileMeta.title,
    description: form.get('group_description') || fileMeta.description
  });
  const originalName = String(form.get('name') || file.name || '').trim().slice(0, 120) || `resource.${ext}`;
  const expiresAt = parseResourceExpiry(form.get('expire'), scope);
  const now = Date.now();

  /* 资源中心的文件一定挂在某个组底下: 前端给了 group_id 就是往老组里加文件, 没给就当场开一个。
     私聊附件没有组。 */
  let group = null;
  let seq = null;
  let newGroupId = null;
  let autoGuard = false;
  let objectKey;
  if (scope === 'library') {
    const wanted = parseInt(String(form.get('group_id') || ''), 10);
    if (Number.isInteger(wanted) && wanted > 0) {
      const found = await loadEditableGroup(env, wanted, user);
      if (found.error) return found.error;
      group = found.group;
      seq = await nextResourceSeq(env, group.id);
    } else {
      // 前端会声明「这一批一共多大」; 没声明 (老客户端) 就只拿当前这个文件算
      const declared = Number(form.get('group_total')) || 0;
      const created = await createResourceGroup(env, user, groupMeta, expiresAt, Math.max(file.size, declared));
      group = { id: created.id, key: created.key };
      newGroupId = created.id;
      autoGuard = created.autoGuard;
      seq = 1;
    }
    objectKey = resourceObjectKey(user, group.key, seq, originalName, ext);
  } else {
    objectKey = chatObjectKey(user, ext);
  }

  let rowId = null;
  try {
    rowId = await insertResourceRow(env, {
      name: originalName, objectKey, size: file.size, mime: file.type, uploaderId: user.id,
      expiresAt, now, scope, title: fileMeta.title, description: fileMeta.description,
      sha256: fileMeta.sha256, sha1: fileMeta.sha1,
      groupId: group ? group.id : null, seq
    });
  } catch (err) {
    console.error('登记资源失败:', err);
    // 刚开出来的组没登记上东西 -> 把它一并收走, 别留空组
    if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
    return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const put = await ossSignedRequest(env, {
      method: 'PUT', key: objectKey, body: bytes, contentType: file.type,
      bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
      cacheControl: scope === 'library' ? resourceCacheControl(expiresAt) : undefined,
      // 资源中心的「非图片」对象挂上 disposition: 直链点开就是下载, 而不是浏览器里打开。
      // 图片不挂 —— 详情页的 `<img>` 要直接渲染它。
      contentDisposition: scope === 'library' && file.type.indexOf('image/') !== 0
        ? resourceDisposition(originalName) : undefined
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      console.error('OSS 资源上传失败:', put.status, detail);
      // 传挂了就把登记行回滚掉 (回滚失败也不致命, 站长能自己删)
      // ⚠️ .catch 只能接在 .run()/.first()/.all() 后面: D1 的 .bind() 返回的是语句对象,
      //    不是 Promise —— 写成 .bind(x).catch() 会在这里再抛一次 TypeError,
      //    结果是「回滚没做成 + 客户端收到 1101 HTML」而不是那句 502 JSON。
      if (rowId) await env.DB.prepare(`DELETE FROM resource WHERE id = ?`).bind(rowId).run().catch(() => {});
      if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
      return Response.json({ error: '上传失败：' + ossErrorText(put.status, detail, RES_BUCKET) }, { status: 502 });
    }
    // 中转这条能直接从 PUT 的响应里拿到 ETag (= MD5), 顺手存下来当「服务端校验值」
    const md5 = md5FromEtag(put.headers.get('etag'));
    if (rowId && md5) {
      await env.DB.prepare(`UPDATE resource SET md5 = ? WHERE id = ?`).bind(md5, rowId).run().catch(() => {});
    }
    await addUploadUsage(env, user.id, file.size);
    /* 大流量上传要告诉站长（用户 2026-09-17）: 按**组**的总量算, 一个组只通知一次 */
    if (scope === 'library') await notifyBigUpload(env, user, group ? group.id : 0, file.size);
    return Response.json({
      ok: true,
      id: rowId,
      name: originalName,
      size: file.size,
      url: `${RES_PUBLIC_BASE}/${objectKey}`,
      key: objectKey,
      scope,
      group_id: group ? group.id : null,
      seq,
      title: fileMeta.title || null,
      description: fileMeta.description || null,
      sha256: fileMeta.sha256,
      sha1: fileMeta.sha1,
      md5,
      expires_at: expiresAt,
      // 新组因这一批超过 5GB 而默认开了防盗链（前端拿它说一句）
      auto_guard: autoGuard
    });
  } catch (err) {
    console.error('上传资源失败:', err);
    if (rowId) await env.DB.prepare(`DELETE FROM resource WHERE id = ?`).bind(rowId).run().catch(() => {});
    if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
    return Response.json({ error: '上传失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourcePresign(request, env) {
  // 大文件直传: 只登记 + 签一个 PUT, 字节由浏览器自己飞 OSS (Worker 的请求体上限与 128MB
  // 内存都不允许中转)。POST /api/resource/presign, JSON: name/size/mime(+ scope 与资源中心那几个字段)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const size = Number(payload.size) || 0;
  const mime = String(payload.mime || '').slice(0, 120);
  const name = String(payload.name || '').trim().slice(0, 120);

  if (!size) return Response.json({ error: '这个文件是空的' }, { status: 400 });
  if (size > RES_MAX_BYTES) {
    return Response.json({ error: `文件不能超过 ${sizeText(RES_MAX_BYTES)}` }, { status: 400 });
  }

  const blocked = await resourceUploadGuard(env, user, size, parseInt(String(payload.group_id || ''), 10) || 0);
  if (blocked) return blocked;

  const ext = RESOURCE_TYPES[mime] || extFromFilename(name);
  if (!ext) {
    return Response.json({ error: '不支持这种文件（仅支持压缩包 / PDF / 文本 / 图片 / 音视频）' }, { status: 400 });
  }

  const scope = payload.scope === 'library' ? 'library' : 'chat';
  // 文件自己那对 (左栏队列里每个文件单独设的) 与组那对 (开新组时才用得上)
  const fileMeta = cleanResourceMeta(payload);
  const groupMeta = cleanResourceMeta({
    title: payload.group_title || fileMeta.title,
    description: payload.group_description || fileMeta.description
  });
  const expiresAt = parseResourceExpiry(payload.expire, scope);
  const now = Date.now();
  const sendType = mime || 'application/octet-stream';
  const displayName = name || `resource.${ext}`;

  let group = null;
  let seq = null;
  let newGroupId = null;
  let autoGuard = false;
  let objectKey;
  if (scope === 'library') {
    const wanted = parseInt(String(payload.group_id || ''), 10);
    if (Number.isInteger(wanted) && wanted > 0) {
      const found = await loadEditableGroup(env, wanted, user);
      if (found.error) return found.error;
      group = found.group;
      seq = await nextResourceSeq(env, group.id);
    } else {
      const declared = Number(payload.group_total) || 0;
      const created = await createResourceGroup(env, user, groupMeta, expiresAt, Math.max(size, declared));
      group = { id: created.id, key: created.key };
      newGroupId = created.id;
      autoGuard = created.autoGuard;
      seq = 1;
    }
    objectKey = resourceObjectKey(user, group.key, seq, displayName, ext);
  } else {
    objectKey = chatObjectKey(user, ext);
  }

  let rowId = null;
  try {
    rowId = await insertResourceRow(env, {
      name: displayName, objectKey, size, mime: sendType, uploaderId: user.id,
      expiresAt, now, scope, title: fileMeta.title, description: fileMeta.description,
      sha256: fileMeta.sha256, sha1: fileMeta.sha1,
      groupId: group ? group.id : null, seq
    });
  } catch (err) {
    console.error('登记资源失败:', err);
    if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
    return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
  }

  try {
    const signed = await ossSignedRequest(env, {
      method: 'PUT', key: objectKey, contentType: sendType,
      bucket: RES_BUCKET, host: RES_UPLOAD_HOST, signOnly: true,
      cacheControl: scope === 'library' ? resourceCacheControl(expiresAt) : undefined,
      // 与中转那条一致: 非图片挂上 disposition; 图片不挂 (详情页要当图渲染)
      contentDisposition: scope === 'library' && sendType.indexOf('image/') !== 0
        ? resourceDisposition(displayName) : undefined
    });
    await addUploadUsage(env, user.id, size);
    /* 直传这条的字节还没走完 (浏览器接着 PUT), 但通知按「要传多少」先发也是一样意思 */
    if (scope === 'library') await notifyBigUpload(env, user, group ? group.id : 0, size);
    return Response.json({
      ok: true,
      id: rowId,
      name: displayName,
      size,
      key: objectKey,
      url: `${RES_PUBLIC_BASE}/${objectKey}`,
      scope,
      group_id: group ? group.id : null,
      seq,
      title: fileMeta.title || null,
      description: fileMeta.description || null,
      sha256: fileMeta.sha256,
      sha1: fileMeta.sha1,
      expires_at: expiresAt,
      upload_url: signed.url,
      headers: signed.headers,
      // 新组因这一批超过 5GB 而默认开了防盗链（前端拿它说一句）
      auto_guard: autoGuard
    });
  } catch (err) {
    // 签不出来就把刚登记的那行撤掉 (不留「有记录没对象」的空条目)
    console.error('签名资源直传失败:', err);
    if (rowId) await env.DB.prepare(`DELETE FROM resource WHERE id = ?`).bind(rowId).run().catch(() => {});
    if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
    return Response.json({ error: '准备直传失败，请稍后再试' }, { status: 500 });
  }
}

/* ⚠️ 直传这条路有个已知的窟窟: 浏览器那边的 PUT 失败或用户直接关掉标签页时,
   登记行已经写进去了但没人回滚 —— 表里会留下点不开的空条目。要补的话得让客户端在
   PUT 失败时再叫一次 /api/resource/abort, 这轮先留着 (列表已经能容忍下载失败)。
   (分片那条路没这个问题: 登记行是 complete 成功之后才写的, 见下面。) */


/* ==================== 分片上传 (断点续传, 2026-09-17) ====================
   大文件 (>24MB) 不再一次 PUT 上去, 而是切成 8MB 一片, 走 OSS 的 Multipart Upload:
     ① 断了只重传没传完的那几片 —— 进度记在浏览器里 (localStorage), 也在 OSS 那边;
     ② 单片失败的重传代价是 8MB, 而不是整个 900MB。
   分工是**被桶的 CORS 定死的** (它只放行 PUT、且没暴露任何响应头):
     * initiate / list / complete / abort 全在 Worker 里做 (签名请求, 不经浏览器);
     * 浏览器只做一件事: PUT 每一个分片 —— 用的就是现有那条 PUT 规则, CORS 一个字段都不用改。
     ⚠️ 所以**浏览器读不到分片的 ETag** (没暴露 ETag 头), complete 要用那份 part 列表只能由
        服务端自己 ListParts 拼出来 —— 客户端只需要知道「还差哪几片」。
     ⚠️ 对象上的 Cache-Control / Content-Disposition 是**在 initiate 那一刻定死的** (跟单次 PUT
        一样, 后面改不了), 所以这两个头在 init 就得算好带上 (走 extraHeaders: 它们不进签名)。
     ⚠️ 没传完就放弃的上传会在桶里留着碎片 (OSS 对未完成的分片不收存储费, 但会占着);
        想自动清就在桶上配一条生命周期规则 (「碎片过期天数」)。 */
const RES_PART_BYTES = 8 * 1024 * 1024;   // 一片 8MB: 5GB 的文件 = 640 片, 远在 OSS 的 10000 片以内
const RES_PART_SIGN_BATCH = 50;           // 一次请求最多签这么多片 (给以后并发传留的口子)

/* 对象名里那个人名段 (与 resourceObjectKey 的 slug 规则必须一致) */
function resUserSlug(user) {
  return String(user.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'anon';
}

/* 这个对象名是不是这个人的 (res/<slug>/...)。
   ⚠️ 分片那条路的 key 是**客户端回传**的, 不校验的话任何人都能拿别人的 objectKey
      去 complete / abort —— abort 是能删掉别人正在传的东西的口子。 */
function resourceKeyOwned(user, key) {
  const match = /^res\/([^/]+)\//.exec(String(key || '').toLowerCase());
  return !!match && match[1] === resUserSlug(user);
}

/* 从 OSS 的 XML 里抠一个标签 (Worker 里没有 DOMParser, 这几条响应的格式很规整) */
function ossXmlTag(raw, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(String(raw || ''));
  return match ? match[1] : '';
}

/* ListParts 响应里每个 <Part> 的 PartNumber / ETag / Size。
   ⚠️ ETag **连着引号原样留着** —— complete 的 XML 要回填的就是这个带引号的串。 */
function ossParseParts(raw) {
  return Array.from(String(raw || '').matchAll(/<Part>([\s\S]*?)<\/Part>/g)).map((m) => ({
    n: Number(ossXmlTag(m[1], 'PartNumber')) || 0,
    etag: ossXmlTag(m[1], 'ETag'),
    size: Number(ossXmlTag(m[1], 'Size')) || 0
  })).filter((part) => part.n > 0);
}

/* 问 OSS: 这个 uploadId 底下已经收下哪些片了 (可能不止一页)。
   返回 { gone: true } = 这个上传在 OSS 那边已经没了 (超时被清 / 已经 complete 过)。 */
async function ossListResourceParts(env, key, uploadId) {
  const parts = [];
  let marker = 0;
  for (let page = 0; page < 20; page += 1) {
    const query = 'max-parts=1000&' + (marker ? `part-number-marker=${marker}&` : '')
      + 'uploadId=' + encodeURIComponent(uploadId);
    const res = await ossSignedRequest(env, {
      method: 'GET', key, bucket: RES_BUCKET, host: RES_UPLOAD_HOST, query
    });
    if (res.status === 404) {
      await res.body?.cancel?.().catch(() => {});
      return { gone: true, parts: [] };
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { error: `${res.status}|${raw}`, parts };
    parts.push(...ossParseParts(raw));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(raw)) break;
    marker = parts.length ? parts[parts.length - 1].n : 0;
    if (!marker) break;
  }
  return { parts };
}


/* 问 OSS 开一个分片上传 (POST /<key>?uploads)。
   ⚠️ 查询串的写法先按 `uploads=` 走; 万一 OSS 认的是另一种写法, 它会回显自己算的规范请求 ——
   那就**照抄着重签一次** (请求一个字节不改, 只把签名依据换成它那份)。这跟 ossListObjects 的
   「学标准答案」是同一个套路: 能调通比猜对重要, 而且猜错时不用回来改代码。 */
async function ossStartMultipart(env, key, contentType, extraHeaders) {
  const attempt = (canonicalQuery) => ossSignedRequest(env, {
    method: 'POST', key, contentType, bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
    query: 'uploads=', canonicalQuery: canonicalQuery || '', signOnly: true,
    // ⚠️ 忘了转发这一份的话, 对象上就没有 Cache-Control / Content-Disposition (踩过一次)
    extraHeaders: extraHeaders || {}
  });
  const first = await attempt('');
  let res = await fetch(first.url, { method: 'POST', headers: first.headers });
  let raw = await res.text().catch(() => '');
  if (res.status === 403 && /SignatureDoesNotMatch/.test(raw)) {
    const hint = ossCanonicalEcho(raw);
    if (hint && hint.query && hint.query !== 'uploads=') {
      const second = await attempt(hint.query);
      const retry = await fetch(second.url, { method: 'POST', headers: second.headers });
      const retryRaw = await retry.text().catch(() => '');
      console.warn('分片发起: 照抄 OSS 的规范请求才调通', JSON.stringify(hint));
      return { status: retry.status, raw: retryRaw, query: hint.query };
    }
  }
  return { status: res.status, raw, canonical: first.canonicalRequest };
}


/* 客户端递上来的分片清单 (只在前一条路 403 时用)。
   ⚠️ 这是**外面来的数据**, 要按外面的数据对待: 片号必须是从 1 开始、不重复的正整数,
   ETag 必须是「一串十六进制 + 可选的 -N 后缀 + 可选引号」—— 别的形状一律丢掉,
   否则就是拿用户输入去拼 XML 发给 OSS。 */
function cleanClientParts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const parts = [];
  raw.slice(0, 10000).forEach((item) => {
    const n = parseInt(item && item.n, 10);
    const etag = String((item && item.etag) || '').replace(/"/g, '').trim();
    if (!Number.isInteger(n) || n < 1 || n > 10000 || seen.has(n)) return;
    if (!/^[0-9a-fA-F]{1,64}(-\d{1,6})?$/.test(etag)) return;
    seen.add(n);
    /* ⚠️ 大小写原样保留: OSS 回的是**大写**十六进制, 而它在比对时是认大小写的
       (实测把 ETag 写成小写 → InvalidPart)。 */
    parts.push({ n, etag: `"${etag}"`, size: 0 });
  });
  return parts.sort((a, b) => a.n - b.n);
}


async function handleResourceMultipartInit(request, env) {
  // 分片上传第一步: POST /api/resource/multipart/init {name, size, mime, + 资源中心那几个字段}
  // 只做三件事: 校验 (登录 / 配额 / 类型) -> 定下对象名 (该建组就建组) -> 让 OSS 开一个分片上传。
  // ⚠️ **不写 resource 行** —— 行要等 complete 成功才写, 否则用户关掉标签页就留一条点不开的空条目
  //    (那正是单次直传那条路的旧毛病)。组行会先建出来 (对象名里要带组的 key)。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const size = Number(payload.size) || 0;
  const mime = String(payload.mime || '').slice(0, 120);
  const name = String(payload.name || '').trim().slice(0, 120);

  if (!size) return Response.json({ error: '这个文件是空的' }, { status: 400 });
  if (size > RES_MAX_BYTES) {
    return Response.json({ error: `文件不能超过 ${sizeText(RES_MAX_BYTES)}` }, { status: 400 });
  }
  if (size < 100 * 1024) return Response.json({ error: '小文件请走普通上传' }, { status: 400 });

  const blocked = await resourceUploadGuard(env, user, size, parseInt(String(payload.group_id || ''), 10) || 0);
  if (blocked) return blocked;

  const ext = RESOURCE_TYPES[mime] || extFromFilename(name);
  if (!ext) {
    return Response.json({ error: '不支持这种文件（仅支持压缩包 / PDF / 文本 / 图片 / 音视频）' }, { status: 400 });
  }

  const scope = payload.scope === 'library' ? 'library' : 'chat';
  const fileMeta = cleanResourceMeta(payload);
  const groupMeta = cleanResourceMeta({
    title: payload.group_title || fileMeta.title,
    description: payload.group_description || fileMeta.description
  });
  const expiresAt = parseResourceExpiry(payload.expire, scope);
  const sendType = mime || 'application/octet-stream';
  const displayName = name || `resource.${ext}`;

  let group = null;
  let seq = null;
  let newGroupId = null;
  let autoGuard = false;
  let objectKey;
  if (scope === 'library') {
    const wanted = parseInt(String(payload.group_id || ''), 10);
    if (Number.isInteger(wanted) && wanted > 0) {
      const found = await loadEditableGroup(env, wanted, user);
      if (found.error) return found.error;
      group = found.group;
      seq = await nextResourceSeq(env, group.id);
    } else {
      const declared = Number(payload.group_total) || 0;
      const created = await createResourceGroup(env, user, groupMeta, expiresAt, Math.max(size, declared));
      group = { id: created.id, key: created.key };
      newGroupId = created.id;
      autoGuard = created.autoGuard;
      seq = 1;
    }
    objectKey = resourceObjectKey(user, group.key, seq, displayName, ext);
  } else {
    objectKey = chatObjectKey(user, ext);
  }

  try {
    const started = await ossStartMultipart(env, objectKey, sendType, {
      /* 对象上的这些头只能在这一刻定 (见文件头上那段说明); 它们不进签名, 所以走 extraHeaders */
      ...(scope === 'library' ? { 'Cache-Control': resourceCacheControl(expiresAt) } : {}),
      ...(scope === 'library' && sendType.indexOf('image/') !== 0
        ? { 'Content-Disposition': resourceDisposition(displayName) } : {})
    });
    const raw = started.raw;
    if (started.status < 200 || started.status >= 300) {
      console.error('发起分片上传失败..:', started.status, raw, started.canonical || '');
      if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
      return Response.json({ error: '失败..：' + ossErrorText(started.status, raw, RES_BUCKET) }, { status: 502 });
    }
    const uploadId = ossXmlTag(raw, 'UploadId');
    if (!uploadId) {
      console.error('分片上传未获取 UploadId:', raw.slice(0, 300));
      if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
      return Response.json({ error: '失败..，请稍后再试' }, { status: 502 });
    }
    return Response.json({
      ok: true,
      key: objectKey,
      upload_id: uploadId,
      part_size: RES_PART_BYTES,
      scope,
      group_id: group ? group.id : null,
      seq,
      name: displayName,
      size,
      mime: sendType,
      expires_at: expiresAt,
      auto_guard: autoGuard
    });
  } catch (err) {
    console.error('发起分片上传异常:', err);
    if (newGroupId) await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(newGroupId).run().catch(() => {});
    return Response.json({ error: '开始上传失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceMultipartParts(request, env) {
  // 断点续传要的那份「已经传完哪些片」: POST /api/resource/multipart/list {key, upload_id}
  // 返回片号与大小 (不给 ETag —— 客户端用不上, 也省得把那串引号带出去)。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const key = String(payload.key || '');
  const uploadId = String(payload.upload_id || '');
  if (!key || !uploadId) return Response.json({ error: '缺少上传编号' }, { status: 400 });
  if (!resourceKeyOwned(user, key)) return Response.json({ error: '没有权限' }, { status: 403 });

  try {
    const listed = await ossListResourceParts(env, key, uploadId);
    if (listed.gone) return Response.json({ ok: true, gone: true, parts: [] });
    if (listed.error) {
      const [status, raw] = String(listed.error).split('|');
      console.error('列分片失败:', status, raw);
      return Response.json({ error: '读不到上传进度：' + ossErrorText(status, raw, RES_BUCKET) }, { status: 502 });
    }
    return Response.json({ ok: true, parts: listed.parts.map((part) => ({ n: part.n, size: part.size })) });
  } catch (err) {
    console.error('列分片异常:', err);
    return Response.json({ error: '读不到上传进度，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceMultipartSign(request, env) {
  // 给分片签几个 PUT 地址: POST /api/resource/multipart/sign {key, upload_id, parts: [n...]}
  // 签完由浏览器直接 PUT 给 OSS (字节不经过 Worker)。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const key = String(payload.key || '');
  const uploadId = String(payload.upload_id || '');
  if (!key || !uploadId) return Response.json({ error: '缺少上传编号' }, { status: 400 });
  if (!resourceKeyOwned(user, key)) return Response.json({ error: '没有权限' }, { status: 403 });

  const wanted = Array.isArray(payload.parts) ? payload.parts.slice(0, RES_PART_SIGN_BATCH) : [];
  if (!wanted.length) return Response.json({ error: '没说要签哪几片' }, { status: 400 });

  try {
    const signed = [];
    for (const item of wanted) {
      const number = parseInt(item, 10);
      if (!Number.isInteger(number) || number < 1 || number > 10000) continue;
      /* ⚠️ 查询串必须按名字排序 (partNumber 在 uploadId 前面), uploadId 里的 + / = 都要编码 ——
         少一个字符都是 SignatureDoesNotMatch。
         ⚠️ cacheControl 要显式给 null: 不写的话 ossSignedRequest 会给 PUT 默认挂一条长缓存头
            (那是给对象 PUT 用的, 分片 PUT 上没意义)。 */
      const one = await ossSignedRequest(env, {
        method: 'PUT', key, bucket: RES_BUCKET, host: RES_UPLOAD_HOST, signOnly: true,
        cacheControl: null,
        query: `partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`
      });
      signed.push({ n: number, url: one.url, headers: one.headers });
    }
    if (!signed.length) return Response.json({ error: '分片编号不对' }, { status: 400 });
    return Response.json({ ok: true, parts: signed });
  } catch (err) {
    console.error('签分片失败:', err);
    return Response.json({ error: '准备上传失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceMultipartComplete(request, env) {
  // 收尾: POST /api/resource/multipart/complete {key, upload_id, + 资源中心那几个字段}
  // 服务端先 ListParts 拿到带引号的 ETag 列表 -> 拼 XML -> CompleteMultipartUpload -> 写登记行。
  // ⚠️ 大小以**服务端列出来的分片大小之和**为准 (那才是真正落到桶里的东西)。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const key = String(payload.key || '');
  const uploadId = String(payload.upload_id || '');
  if (!key || !uploadId) return Response.json({ error: '缺少上传编号' }, { status: 400 });
  if (!resourceKeyOwned(user, key)) return Response.json({ error: '没有权限' }, { status: 403 });

  const scope = payload.scope === 'library' ? 'library' : 'chat';
  const fileMeta = cleanResourceMeta(payload);
  const groupMeta = cleanResourceMeta({
    title: payload.group_title || fileMeta.title,
    description: payload.group_description || fileMeta.description
  });
  const expiresAt = parseResourceExpiry(payload.expire, scope);

  try {
    /* 分片清单从哪来? 先问 OSS (最权威); 但列分片要 RAM 里额外的 `oss:ListParts`,
       那把密钥现在没有 (403 AccessDenied) —— 所以退到**客户端记着的那份**。
       客户端每传完一片就能从响应头里读到 ETag (前提是桶的 CORS 把 ETag 暴露出来),
       它把 {片号: ETag} 存在 localStorage 里, 收尾时递过来。
       ⚠️ 两条路都要能回同一份东西 —— 以后 RAM 里补上那个动作, 服务端那份就自动接管。 */
    const listed = await ossListResourceParts(env, key, uploadId);
    let parts = listed.gone ? [] : listed.parts;
    if (!listed.gone && !parts.length) parts = cleanClientParts(payload.parts);
    if (listed.gone && !parts.length) {
      return Response.json({ error: '这个上传已经失效了，请重新上传' }, { status: 410 });
    }
    if (listed.error && !parts.length) {
      const [status, raw] = String(listed.error).split('|');
      console.error('收尾前列分片失败:', status, raw);
      return Response.json({ error: '收尾失败，请稍后再试' }, { status: 502 });
    }
    if (!parts.length) return Response.json({ error: '这个上传还没有任何分片' }, { status: 400 });

    const body = '<CompleteMultipartUpload>'
      + parts.map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.etag}</ETag></Part>`).join('')
      + '</CompleteMultipartUpload>';
    const done = await ossSignedRequest(env, {
      method: 'POST', key, body, contentType: 'application/xml',
      bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
      query: 'uploadId=' + encodeURIComponent(uploadId)
    });
    const raw = await done.text().catch(() => '');
    if (!done.ok) {
      console.error('合并分片失败:', done.status, raw.slice(0, 500));
      return Response.json({ error: '合并分片失败：' + ossErrorText(done.status, raw, RES_BUCKET) }, { status: 502 });
    }
    /* ⚠️ CompleteMultipartUpload 失败是**HTTP 200 + 错误体**的一种特例 (OSS 的老毛病),
       所以这里还要再看一眼 body 里有没有 <Error>。 */
    if (/<Error>/.test(raw)) {
      console.error('合并分片返回错误体:', raw.slice(0, 500));
      return Response.json({ error: '合并分片失败，请稍后再试' }, { status: 502 });
    }

    /* 大小: 服务端列得出分片就用「各片之和」(那才是真落到桶里的), 否则用客户端报的那个数 */
    const total = listed.parts.length
      ? listed.parts.reduce((sum, part) => sum + (part.size || 0), 0)
      : Math.max(0, Number(payload.size) || 0);
    if (!total) return Response.json({ error: '这个上传的大小有问题，请重新上传' }, { status: 400 });
    const ext = resourceExtOf(key);
    const displayName = String(payload.name || '').trim().slice(0, 120) || `resource.${ext}`;
    const groupId = (() => { const n = parseInt(payload.group_id, 10); return Number.isInteger(n) && n > 0 ? n : null; })();

    let rowId = null;
    let seq = null;
    if (scope === 'library' && groupId) seq = await nextResourceSeq(env, groupId);
    try {
      rowId = await insertResourceRow(env, {
        name: displayName, objectKey: key, size: total, mime: String(payload.mime || '').slice(0, 120),
        uploaderId: user.id, expiresAt, now: Date.now(), scope,
        title: fileMeta.title, description: fileMeta.description, sha256: fileMeta.sha256, sha1: fileMeta.sha1,
        groupId: scope === 'library' ? groupId : null, seq
      });
    } catch (err) {
      console.error('分片上传登记失败:', err);
      // 对象已经在桶里了, 但登记不上 -> 把它删掉, 别留孤儿
      await deleteObject(env, 'resource', key).catch(() => {});
      return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
    }
    await addUploadUsage(env, user.id, total);
    if (scope === 'library') await notifyBigUpload(env, user, scope === 'library' ? (groupId || 0) : 0, total);
    return Response.json({
      ok: true,
      id: rowId,
      name: displayName,
      size: total,
      url: `${RES_PUBLIC_BASE}/${key}`,
      key,
      scope,
      group_id: scope === 'library' ? groupId : null,
      seq,
      title: fileMeta.title || null,
      description: fileMeta.description || null,
      sha256: fileMeta.sha256,
      sha1: fileMeta.sha1,
      /* 分片上传的 ETag 不是内容的 MD5 (带 -N 后缀), 所以这里没有服务端校验值 —— 也可以说
         是多出来的那个空字段: 客户端看到它就不用再去补 hash 了 (补了也只会拿到 502)。 */
      md5: null,
      multipart: true,
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('合并分片异常:', err);
    return Response.json({ error: '收尾失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceMultipartAbort(request, env) {
  // 放弃这次分片上传: POST /api/resource/multipart/abort {key, upload_id}
  // (桶里的碎片就是这么清的; 用户选「放弃」时才调, 点「取消上传」只是停下来, 进度仍然留着)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const key = String(payload.key || '');
  const uploadId = String(payload.upload_id || '');
  if (!key || !uploadId) return Response.json({ error: '缺少上传编号' }, { status: 400 });
  if (!resourceKeyOwned(user, key)) return Response.json({ error: '没有权限' }, { status: 403 });

  try {
    const res = await ossSignedRequest(env, {
      method: 'DELETE', key, bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
      query: 'uploadId=' + encodeURIComponent(uploadId)
    });
    await res.text().catch(() => {});
    // 404 = OSS 那边本来就没有了, 对用户来说一样是「已经放下」
    if (!res.ok && res.status !== 404) {
      return Response.json({ error: '放弃上传失败，请稍后再试' }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('放弃分片上传异常:', err);
    return Response.json({ error: '放弃上传失败，请稍后再试' }, { status: 500 });
  }
}


/* 补一次「服务端校验值」。
   直传那条路 Worker 见不到字节, 也就拿不到 ETag, 所以传完之后客户端再来这一下:
   用公开地址 HEAD 一下对象, OSS 会把 ETag (单次 PUT 的话就是内容的 MD5) 带回来。
   ⚠️ 桶是公共读, 所以这里直接 fetch 就行, 不用签名 —— 以后真上了对象级防盗链
   (对象 ACL 改 private) 的话, 这里要改成签名 HEAD。 */
async function handleResourceHash(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const id = parseInt(payload && payload.id, 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少资源编号' }, { status: 400 });

  try {
    const row = await env.DB.prepare(
      `SELECT id, object_key, uploader_id, md5 FROM resource WHERE id = ?`
    ).bind(id).first();
    if (!row) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
    if (row.md5) return Response.json({ ok: true, md5: row.md5 });
    if (row.uploader_id !== user.id) {
      const perms = await loadPermissions(env, user.id);
      if (!hasPermission(perms, 'dev.access')) return Response.json({ error: '没有权限' }, { status: 403 });
    }

    /* 用带签名的「GET + Range: bytes=0-0」取 ETag，**不要**用 HEAD：
       ⚠️ 线上实测签名 HEAD 在部分对象上回 403（同一个对象的签名 GET 却是 200 —— 说明不是 ACL、
          不是防盗、也不是权限，就是 HEAD 那条路在 OSS 那边不成立），结果「服务端校验值」一直补不上，
          连用户自己传的 44MB 视频都是空的（2026-09-17 实测：id 25 / id 26 都 403）。
       Range 只要 1 个字节，代价可以忽略；Range 头不进签名，走 extraHeaders 加上去。 */
    const grabbed = await ossSignedRequest(env, {
      method: 'GET', key: row.object_key, bucket: RES_BUCKET, host: RES_UPLOAD_HOST,
      extraHeaders: { Range: 'bytes=0-0' }
    });
    if (!grabbed.ok) {
      await grabbed.body?.cancel?.().catch(() => {});
      return Response.json({ error: `拿不到这个对象的校验值（HTTP ${grabbed.status}）` }, { status: 502 });
    }
    await grabbed.arrayBuffer().catch(() => {});
    const md5 = md5FromEtag(grabbed.headers.get('etag'));
    if (!md5) {
      return Response.json({ error: '这个对象的 ETag 不是 MD5（分片上传留下的），没法当校验值' }, { status: 502 });
    }
    await env.DB.prepare(`UPDATE resource SET md5 = ? WHERE id = ?`).bind(md5, id).run();
    return Response.json({ ok: true, md5 });
  } catch (err) {
    console.error('补校验值失败:', err);
    return Response.json({ error: '取校验值失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceDownload(request, env, url) {
  // 下载一个资源: GET /api/resource/download?id=<resource.id>(&inline=1 就地预览)
  // 桶是公共读, 所以其实可以直接拿直链 —— 但直链不强制保存 (跨域的 download 属性会被忽略,
  // 浏览器可能就地打开 PDF / 视频), 所以「下载」按钮仍走这条: Worker 代取 + 强制 attachment。
  // 2026-09-17 起这里还管两件事: 按身份限**同时下载数** + 记下载日志 (用户要的「控制下行流量」)。
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少资源编号' }, { status: 400 });
  const inline = url.searchParams.get('inline') === '1';

  try {
    const row = await env.DB.prepare(
      `SELECT id, name, object_key, size, mime, expires_at, scope, guard, group_id, uploader_id FROM resource WHERE id = ?`
    ).bind(id).first();
    if (!row) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
    if (row.expires_at && row.expires_at <= Date.now()) {
      return Response.json({ error: '这个资源已经过期了' }, { status: 410 });
    }
    /* 私聊附件仍要登录 (那是两个人之间的东西); 资源中心的资源是公开发布, 游客也能下 ——
       但**开了防盗链的文件/组**同样要登录 (用户 2026-09-17: 光靠 Referer 他觉得不够稳)。
       两道门是两件事: 登录 = 「你是谁」, Referer = 「你是不是从站内点的」。 */
    let groupGuard = 0;
    if (row.group_id) {
      const g = await env.DB.prepare(`SELECT guard FROM resource_group WHERE id = ?`)
        .bind(row.group_id).first().catch(() => null);
      groupGuard = g ? g.guard : 0;
    }
    const guarded = resourceGuarded(row, groupGuard);
    const user = await getSessionUser(request, env);
    if ((row.scope !== 'library' || guarded) && !user) {
      return Response.json({ error: '下载这个文件需要先登录' }, { status: 401 });
    }
    /* 防盗的文件: 只认站内来的请求 (空 Referer 也拦)。上面那条 ACL 已经把匿名直链挡死了,
       这一条挡的是「把下载接口地址贴到别的站/别人脚本里」这条路。 */
    if (guarded && !siteRefererOk(request)) {
      return Response.json({ error: '此文件只能在 Foraine 站内下载' }, { status: 403 });
    }
    if (!avatarStorageReady(env)) {
      return Response.json({ error: '存储还没配置（缺 OSS 密钥）' }, { status: 503 });
    }

    /* 同时下载数: 按身份分档 (站长/管理员不限, 已验邮箱 4, 普通成员 2, 游客 1 个 IP 一个)。
       ⚠️ 只管得住走 Worker 的这条 —— 直链的字节根本不经过这里 (与用户说过的代价)。
       ⚠️ 「下行流量方案」被站长关掉时整块跳过: 既不限并发也不记日志（完全回到之前的样子）。
       ⚠️ 拿不到档位 / 表没建时一律当「不限」: 门是防刷的, 不能反把正常下载卡死。 */
    const flags = await loadSiteFlags(env);
    const ip = clientIp(request);
    let slot = null;
    if (flags.downlink) {
      const tier = user ? await resQuotaTier(env, user.id) : { key: 'guest' };
      const limit = DL_CONCURRENCY[tier.key] || 0;
      if (limit) {
        const active = await dlActiveCount(env, user ? user.id : 0, ip);
        if (active >= limit) {
          return Response.json({
            error: `同时下载的数量已到上限（${limit} 个），等其中一个下完再来。`
          }, { status: 429 });
        }
        slot = await dlTakeSlot(env, user ? user.id : 0, ip);
      }
      /* 日志在这记: 已经从 OSS 拿到 200 了, 这事儿就是成了 —— 不放到流结束再写,
         那样「浏览器中途关掉」的下载会一条都记不上。 */
      await logDownload(env, {
        userId: user ? user.id : null, ip, resourceId: row.id,
        groupId: row.group_id || null, bytes: row.size || 0, via: 'worker'
      });
    }

    const got = await ossSignedRequest(env, {
      method: 'GET', key: row.object_key, bucket: RES_BUCKET, host: RES_UPLOAD_HOST
    });
    if (!got.ok) {
      const detail = await got.text().catch(() => '');
      console.error('OSS 资源下载失败:', got.status, detail);
      return Response.json({ error: '下载失败：' + ossErrorText(got.status, detail, RES_BUCKET) }, { status: 502 });
    }

    const name = String(row.name || 'resource').replace(/[\r\n"]/g, '').slice(0, 120) || 'resource';
    const headers = new Headers();
    headers.set('Content-Type', row.mime || got.headers.get('Content-Type') || 'application/octet-stream');
    if (!inline) {
      // 中文文件名: 老浏览器看 filename, 新浏览器看 filename* (RFC 5987)
      headers.set('Content-Disposition',
        `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
    headers.set('X-Resource-Name', encodeURIComponent(name));
    /* 槽要等**流结束**才还 (不能一返回就减 —— 那等于没限住并发)。
       flush 里 await 一下: 流没关完, 请求也还没算完, 这句能跑完。 */
    const body = slot
      ? got.body.pipeThrough(new TransformStream({
        flush: async () => { await dlReleaseSlot(env, slot); }
      }))
      : got.body;
    return new Response(body, { headers });
  } catch (err) {
    console.error('下载资源失败:', err);
    return Response.json({ error: '下载失败，请稍后再试' }, { status: 500 });
  }
}


/* 列表里一张「组卡片」的字段。组 = 一次上传; 加组之前的老行没有 group_id,
   一律当成「只有一个文件的组」(分组键用 0 - 行 id, 与真实的组 id 不会撞)。 */
function resourceGroupView(groupId, files, meta, ownerInfo) {
  const kinds = [];
  const seen = {};
  files.forEach((row) => {
    const key = RESOURCE_KINDS[resourceExtOf(row.object_key)] || 'other';
    if (seen[key]) { seen[key].count += 1; return; }
    seen[key] = { key, label: RESOURCE_KIND_LABELS[key] || '其他', count: 1 };
    kinds.push(seen[key]);
  });
  /* 上传者那一行按**组的主人**取（不是 files[0]: 协作者加的文件可能排在前面） */
  const first = files.find((row) => row.uploader_id === (meta && meta.uploader_id)) || files[0] || {};
  const owner = ownerInfo || first;
  return {
    id: groupId,
    title: (meta && meta.title) || first.title || first.name || '未命名',
    description: (meta && meta.description) || first.description || null,
    file_count: files.length,
    total_size: files.reduce((sum, row) => sum + (row.size || 0), 0),
    kinds,
    // 组卡上那个开关只有「全组都防盗」才算开 (部分开是文件级覆盖值造成的, 卡片不展示这种中间态)
    guard: files.length > 0 && files.every((row) => resourceGuarded(row, meta ? meta.guard : 0)),
    guard_count: files.filter((row) => resourceGuarded(row, meta ? meta.guard : 0)).length,
    // 「允许其他人编辑」（用户 2026-09-17）: 1 = 登录且邮箱验证过的人也能改这一组
    allow_edit: !!(meta && meta.allow_edit),
    uploader: owner.nickname || owner.username || '已注销',
    uploader_username: owner.username || null,
    /* 卡片上的作者要画「头像 + 用户名」（用户 2026-09-18 第 3 条）*/
    uploader_avatar: owner.avatar_url || null,
    created_at: (meta && meta.created_at) || first.created_at || 0,
    expires_at: (meta && meta.expires_at) || first.expires_at || null,
    first_file: first.name || ''
  };
}

/* 详情里一个文件面板的字段 */
/* 详情里一个文件面板的字段。
   ⚠️ 每个文件都带上**上传者**与「这个文件我能不能动」（用户 2026-09-17 第 3 条）:
      开了「公开编辑」的组里, 协作者只能改/删**自己传的那些**, 动不了组主人的文件。
      groupCanDelete / groupCanEdit 是**组那一层**的权限（上传者 / 站长）, 有它就能动任何文件。 */
function resourceFileView(row, groupGuard, viewer, groupCanDelete, groupCanEdit) {
  const ext = resourceExtOf(row.object_key);
  const guarded = resourceGuarded(row, groupGuard);
  const mine = !!(viewer && row.uploader_id === viewer.id);
  return {
    id: row.id,
    name: row.name,
    title: row.title || null,
    description: row.description || null,
    size: row.size || 0,
    mime: row.mime || '',
    ext,
    kind: RESOURCE_KINDS[ext] || 'other',
    seq: row.seq || null,
    guard: guarded,
    guard_own: row.guard === null || row.guard === undefined ? null : !!row.guard,
    sha256: row.sha256 || null,
    sha1: row.sha1 || null,
    md5: row.md5 || null,
    /* 「标记每个文件的上传者」（用户 2026-09-17） */
    uploader: row.nickname || row.username || '已注销',
    uploader_username: row.username || null,
    uploader_avatar: row.avatar_url || null,
    mine,
    can_delete: mine || !!groupCanDelete,
    can_edit_meta: mine || !!groupCanEdit,
    /* 防盗的文件 ACL 是 private, 匿名直链一律 403 —— 所以直链一律换成下载接口。
       这样前端不用判: 它本来就在用 url 预览、用 download_url 下载。 */
    url: guarded ? `/api/resource/download?id=${row.id}&inline=1` : `${RES_PUBLIC_BASE}/${row.object_key}`,
    download_url: guarded ? `/api/resource/download?id=${row.id}` : resourceDownloadUrl(row)
  };
}

async function handleResourceList(request, env, url) {
  // 资源中心列表: 公开 (游客也能看, 与「资源是公开分享的」这条设定一致)。
  // 一张卡片 = 一个组 (一次上传)。⚠️ 必须带 scope='library': 这张表混着私聊附件,
  // 直接查全表等于把别人私聊里发的文件摆到公开列表上 —— 这不是「可能出问题」, 是必然出问题。
  //
  /* 分组、筛选、排序、分页全在 JS 里做。理由: 右栏那几个数字本来就要全量数据, 而且「组」的
     筛选语义 (组里任意一个文件命中就算这组命中) 用 SQL 表达要绕一大圈 —— 得不偿失。
     个人站量级在几百, 一次拉完最省事; 真上千了再改成按组分页的 SQL 聚合。 */
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10) || 20));
  const q = (url.searchParams.get('q') || '').trim();
  const kind = (url.searchParams.get('kind') || '').trim();
  const uploader = (url.searchParams.get('uploader') || '').trim().toLowerCase();
  const sort = (url.searchParams.get('sort') || '').trim();
  const now = Date.now();

  try {
    const rows = await env.DB.prepare(
      `SELECT r.id, r.name, r.title, r.description, r.size, r.mime, r.created_at, r.expires_at,
              r.sha256, r.md5, r.object_key, r.group_id, r.seq, r.guard,
              u.username, COALESCE(p.nickname, u.username) AS nickname, p.avatar_url
         FROM resource r
         LEFT JOIN users u ON u.id = r.uploader_id
         LEFT JOIN profiles p ON p.user_id = r.uploader_id
        WHERE r.scope = 'library' AND (r.expires_at IS NULL OR r.expires_at > ?)
        ORDER BY r.group_id, r.seq, r.id`
    ).bind(now).all();
    const files = rows.results || [];

    // 表还没建过的话 (老库) 当没有组信息, 老行自己成组
    const groupRows = await env.DB.prepare(
      `SELECT id, title, description, expires_at, guard, created_at FROM resource_group`
    ).all().catch(() => ({ results: [] }));
    const groupMeta = new Map();
    (groupRows.results || []).forEach((row) => groupMeta.set(row.id, row));

    const buckets = new Map();
    files.forEach((row) => {
      const gid = row.group_id || (0 - row.id);
      if (!buckets.has(gid)) buckets.set(gid, []);
      buckets.get(gid).push(row);
    });

    let groups = Array.from(buckets, ([gid, list]) => resourceGroupView(gid, list, groupMeta.get(gid)));

    /* 右栏的类型、上传者与统计按「整个资源中心」算, 不跟着当前搜索走 ——
       跟着走的话搜索时胶囊数字会乱跳, 而且换不回别的类型 (它们都被搜没了)。 */
    const kindCounts = {};
    groups.forEach((g) => g.kinds.forEach((k) => { kindCounts[k.key] = (kindCounts[k.key] || 0) + k.count; }));
    const kinds = Object.keys(RESOURCE_KIND_LABELS)
      .map((key) => ({ key, label: RESOURCE_KIND_LABELS[key], count: kindCounts[key] || 0 }))
      .filter((item) => item.count > 0);

    const byUploader = new Map();
    groups.forEach((g) => {
      const key = g.uploader_username || '';
      const item = byUploader.get(key) || { username: g.uploader_username, nickname: g.uploader, count: 0 };
      item.count += 1;
      byUploader.set(key, item);
    });
    const uploaders = Array.from(byUploader.values()).sort((a, b) => b.count - a.count);

    // 「本月新增」按 UTC 的当月 1 日算 (站点的时间戳都是 ms, 不引时区库)
    const clock = new Date();
    const monthStart = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1);
    const totalBytes = files.reduce((sum, row) => sum + (row.size || 0), 0);
    const stats = {
      count: groups.length,
      bytes: totalBytes,
      month: groups.filter((g) => (g.created_at || 0) >= monthStart).length
    };

    // 筛选: 组的标题 / 简介命中, 或者组里**任意一个文件**的标题 / 文件名命中
    if (q) {
      const needle = q.toLowerCase();
      const hit = (text) => String(text || '').toLowerCase().indexOf(needle) >= 0;
      const fileHit = new Set();
      files.forEach((row) => {
        if (hit(row.title) || hit(row.name)) fileHit.add(row.group_id || (0 - row.id));
      });
      groups = groups.filter((g) => hit(g.title) || hit(g.description) || fileHit.has(g.id));
    }
    if (kind) groups = groups.filter((g) => g.kinds.some((k) => k.key === kind));
    if (uploader) groups = groups.filter((g) => String(g.uploader_username || '').toLowerCase() === uploader);

    // 排序只看这三条 (别把用户传的串拼进 SQL —— 这里干脆比较函数都写死)
    groups.sort(sort === 'name' ? (a, b) => String(a.title).localeCompare(String(b.title), 'zh')
      : sort === 'size' ? (a, b) => b.total_size - a.total_size
        : (a, b) => b.created_at - a.created_at);

    const total = groups.length;
    const offset = (page - 1) * size;
    const list = groups.slice(offset, offset + size);

    return Response.json({
      resources: list,
      page,
      size,
      sort: sort === 'name' || sort === 'size' ? sort : 'time',
      total,
      hasMore: offset + list.length < total,
      kinds,
      uploaders,
      stats
    });
  } catch (err) {
    console.error('读资源列表失败:', err);
    return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
  }
}


/* 看一眼这个人能不能动别人的资源 (自己传的直接行; 站长直接行; 管理员得先写理由)。
   详情与删除两处共用同一套判断。 */
async function resourceViewerRights(env, viewer, uploaderId) {
  if (!viewer) return { canDelete: false, mustNotify: false };
  if (viewer.id === uploaderId) return { canDelete: true, mustNotify: false };
  const perms = await loadPermissions(env, viewer.id);
  if (hasPermission(perms, 'dev.access')) return { canDelete: true, mustNotify: false };
  if (hasPermission(perms, 'resource.delete.any')) return { canDelete: true, mustNotify: true };
  return { canDelete: false, mustNotify: false };
}

const RESOURCE_FILE_COLUMNS = `r.id, r.name, r.title, r.description, r.size, r.mime, r.created_at, r.expires_at,
              r.sha256, r.sha1, r.md5, r.object_key, r.group_id, r.seq, r.guard, r.uploader_id,
              u.username, COALESCE(p.nickname, u.username) AS nickname, p.avatar_url`;

async function handleResourceDetail(request, env, url) {
  // 资源详情: GET /api/resource/detail?id=<组 id>, 公开。
  // id 也可以是一个**老的单文件资源行 id** (加组之前发的东西, 或者别人抄的老链接) ——
  // 那一行自己算一个「只有一个文件的组」。顺手把「这个人能不能删」算好给前端。
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少资源编号' }, { status: 400 });

  try {
    const fileSql = `SELECT ${RESOURCE_FILE_COLUMNS}
         FROM resource r
         LEFT JOIN users u ON u.id = r.uploader_id
         LEFT JOIN profiles p ON p.user_id = r.uploader_id`;

    let group = null;
    let files = [];
    if (id > 0) {
      const row = await env.DB.prepare(
        `SELECT id, title, description, expires_at, guard, allow_edit, uploader_id, created_at FROM resource_group WHERE id = ?`
      ).bind(id).first().catch(() => null);
      if (row) {
        group = row;
        const rows = await env.DB.prepare(
          `${fileSql} WHERE r.group_id = ? AND r.scope = 'library' ORDER BY r.seq, r.id`
        ).bind(id).all();
        files = rows.results || [];
      }
    }
    if (!group || !files.length) {
      // 不是组 (或者组是空的) -> 当成「老的单文件行」再试一次
      const row = await env.DB.prepare(
        `${fileSql} WHERE r.id = ? AND r.scope = 'library'`
      ).bind(id).first();
      if (!row) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
      group = {
        id: 0 - row.id, title: row.title, description: row.description,
        expires_at: row.expires_at, guard: row.guard || 0, allow_edit: 0,
        uploader_id: row.uploader_id, created_at: row.created_at
      };
      files = [row];
    }

    // 有效期以文件行上那份为准 (组那一列只是展示与批量改用)
    const liveFiles = files.filter((row) => !row.expires_at || row.expires_at > Date.now());
    if (!liveFiles.length) return Response.json({ error: '这个资源已经过期了' }, { status: 410 });

    const viewer = await getSessionUser(request, env);
    /* ⚠️「主人」一律看**组那一行**的 uploader_id —— 不能再用 files[0].uploader_id：
       开了「允许其他人编辑」之后，协作者加进来的文件按 seq 排前面时，files[0] 就是别人了，
       于是权限与上传者名字会跟着错位（2026-09-17 实测碰到）。 */
    const ownerId = group.uploader_id || files[0].uploader_id;
    const rights = await resourceViewerRights(env, viewer, ownerId);
    /* 组里没有他本人的文件时（协作者传的）得单独把组主人的名字查出来 —— 不然卡上写的
       会是那个协作者。 */
    let ownerInfo = null;
    if (!files.some((row) => row.uploader_id === ownerId)) {
      ownerInfo = await env.DB.prepare(
        `SELECT u.username, COALESCE(p.nickname, u.username) AS nickname, p.avatar_url
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
      ).bind(ownerId).first().catch(() => null);
    }
    const view = resourceGroupView(group.id, files, group, ownerInfo);
    const canGuard = viewer ? await canToggleResource(env, viewer, ownerId) : false;
    /* 「编辑组」到底给不给这个人开（用户 2026-09-17）: 上传者 / 站长 / 服务器开了「允许其他人编辑」
       而我登录且邮箱验证过。前端只按这个字段画按钮, 后端每个写接口再各查一次。 */
    const canEdit = viewer
      ? (viewer.id === ownerId || await canToggleResource(env, viewer, ownerId)
        || (!!group.allow_edit && await emailVerified(env, viewer.id)))
      : false;

    return Response.json({
      group: view,
      files: files.map((row) => resourceFileView(row, group.guard, viewer, rights.canDelete, canGuard)),
      can_delete: rights.canDelete,
      can_guard: canGuard,
      /* 「公开编辑」面板给不给看/给不给点（用户 2026-09-17 把它从工作台搬到详情页）:
         判据与防盗同一个（上传者 / 站长）—— 管理员那套只管删。 */
      can_allow: canGuard,
      can_edit: canEdit,
      must_notify: rights.mustNotify
    });
  } catch (err) {
    console.error('读资源详情失败:', err);
    return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
  }
}


async function handleResourceDelete(request, env) {
  // 删资源: POST /api/resource/delete {id, file_id?, reason?}
  //   id      = 组 id (也可以是一个老的单文件行 id)
  //   file_id = 只删组里的这一个文件; 不给就是删整组
  // 三条分支不变 (用户 2026-09-16 定的规矩):
  //   自己传的     -> 直接删
  //   站长        -> 直接删 (能删能改任何人的)
  //   管理员      -> 必须写理由, 理由原样发给上传者, 然后才删
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const id = parseInt(payload.id, 10);
  const fileId = parseInt(payload.file_id, 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少资源编号' }, { status: 400 });

  /* 删**整组**要验密码 (用户 2026-09-17): 详情页那个「删除组」按钮已经拿掉, 这一下改由
     「编辑组里把文件列表清空再保存」触发。密码是这道门的钥匙 —— 而且**服务端自己验**,
     不只靠前端那个验身份弹窗 (直接调接口也得过这关)。 */
  if (!Number.isInteger(fileId)) {
    const password = String(payload.password || '');
    if (!password) return Response.json({ error: '请输入密码' }, { status: 400 });
    const limited = await checkRateLimit(env, `res-del-group:${user.id}`, 10, 15 * 60 * 1000);
    if (!limited.ok) {
      return Response.json({ error: `尝试次数过多，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
    }
    const me = await env.DB.prepare(
      `SELECT id, password_hash, salt FROM users WHERE id = ?`
    ).bind(user.id).first().catch(() => null);
    if (!me || !(await verifyUserPassword(me, password))) {
      return Response.json({ error: '密码不正确' }, { status: 403 });
    }
  }

  // 先按「组」找, 找不到再按「老的单文件行」找 (那一行自己算一个组)
  let groupRow = await env.DB.prepare(
    `SELECT id, title, uploader_id, allow_edit FROM resource_group WHERE id = ?`
  ).bind(id).first().catch(() => null);
  let rows = [];
  if (groupRow) {
    const listed = await env.DB.prepare(
      `SELECT id, name, title, object_key, uploader_id FROM resource WHERE group_id = ?`
    ).bind(id).all();
    rows = listed.results || [];
  } else {
    const single = await env.DB.prepare(
      `SELECT id, name, title, object_key, uploader_id FROM resource WHERE id = ? AND scope = 'library'`
    ).bind(id).first();
    if (!single) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
    groupRow = { id: 0 - single.id, title: single.title, uploader_id: single.uploader_id, allow_edit: 0 };
    rows = [single];
  }

  // 空组 (文件都被单独删光了): 顺手把组本身清掉就好
  if (!rows.length) {
    if (groupRow.id > 0) {
      await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(groupRow.id).run().catch(() => {});
    }
    return Response.json({ ok: true, deleted: 0, object_deleted: true });
  }

  const targets = Number.isInteger(fileId) ? rows.filter((row) => row.id === fileId) : rows;
  if (!targets.length) return Response.json({ error: '这一组里没有这个文件' }, { status: 404 });

  // 权限按组的主人判 (整组是同一个人传的)
  const rights = await resourceViewerRights(env, user, groupRow.uploader_id);
  /* 「允许其他人编辑」的组: 协作者可以删组里的**单个文件**（看自觉, 用户 2026-09-17 定的）,
     但**删整组**仍然只有主人/站长/管理员能做 —— 那一下连组行一起没, 不是编辑的范畴。 */
  const collaborator = !rights.canDelete && Number.isInteger(fileId) && groupRow.allow_edit
    && await emailVerified(env, user.id);
  if (!rights.canDelete && !collaborator) {
    return Response.json({ error: '没有删除这个资源的权限' }, { status: 403 });
  }
  /* 用户 2026-09-17 第 3 条: 协作者只能删**自己传的**文件, 不了组主人的文件; 站长不受限。
     （「删空整组」下面另有一道门。） */
  if (collaborator && targets.some((row) => row.uploader_id !== user.id)) {
    return Response.json({ error: '只能删自己上传的文件' }, { status: 403 });
  }
  /* 协作者「看自觉」的范围只到**单个文件**: 把这一组删空 (最后一根稻草也是他删的) 不行 ——
     那是删整组, 与用户 2026-09-17 那条「其他人不能删掉所有文件」是同一条规矩。
     ⚠️ 不拦的话, 把文件一个一个删完就能绕开「清空要密码」那道门。 */
  if (collaborator && targets.length === rows.length) {
    return Response.json({ error: '不能删空这一组，只有上传者可以' }, { status: 403 });
  }
  if (rights.mustNotify) {
    const reason = String(payload.reason || '').trim().slice(0, 200);
    if (!reason) return Response.json({ error: '请先填写删除理由（会发给上传者）' }, { status: 400 });
    const what = targets.length === 1
      ? `「${targets[0].title || targets[0].name}」`
      : `「${groupRow.title || '一组资源'}」里的 ${targets.length} 个文件`;
    await sendNotice(env, groupRow.uploader_id, {
      kind: 'system',
      title: '你的资源被管理员移除',
      body: `${what}已从资源中心移除。\n理由：${reason}`
    });
  }

  /* 先删行、再删对象: 行是列表的依据, 删掉它用户立刻看不见。
     对象删失败只记日志 (公共读的桶里留个孤儿, 好过让列表一直挂着一条点不开的记录),
     但要把实情告诉调用方 —— 上传者以为东西没了、其实还能从直链下到, 这不能瞒。 */
  let objectDeleted = true;
  for (const row of targets) {
    await env.DB.prepare(`DELETE FROM resource WHERE id = ?`).bind(row.id).run();
    let status = 0;
    try {
      status = await deleteObject(env, 'resource', row.object_key);
    } catch (err) {
      console.error('删资源对象失败:', err);
    }
    if (!((status > 0 && status < 300) || status === 404)) {
      objectDeleted = false;
      console.error('资源对象没删掉 (行已删):', row.object_key, status);
    }
  }

  // 组里一个文件都不剩了 -> 组也跟着走
  if (targets.length === rows.length && groupRow.id > 0) {
    await env.DB.prepare(`DELETE FROM resource_group WHERE id = ?`).bind(groupRow.id).run().catch(() => {});
  }
  return Response.json({ ok: true, deleted: targets.length, object_deleted: objectDeleted });
}


async function handleResourceLogDownload(request, env) {
  // 直链下载的上报: POST /api/resource/log-download {id}
  // 为什么需要它: OSS 直链的字节不过 Worker, 那条路拦不到也看不到。前端点直链之前
  // 先 ping 一发, 日志里就有了 —— ⚠️ **能被绕过**（不发请求就记不到）, 与用户说清过。
  const payload = await request.json().catch(() => null);
  const id = parseInt(payload && payload.id, 10);
  if (!Number.isInteger(id)) return Response.json({ error: '缺少资源编号' }, { status: 400 });

  /* 「下行流量方案」关掉了就不必记（上行也省一次查询） */
  if (!(await loadSiteFlags(env)).downlink) return Response.json({ ok: true, skipped: true });

  const ip = clientIp(request);
  // 防刷: 一个 IP 一小时最多 300 条 (正常人下载哪用得了这么多)
  const limited = await checkRateLimit(env, `dl-log:${ip}`, 300, 60 * 60 * 1000);
  if (!limited.ok) return Response.json({ ok: true, skipped: true });

  try {
    const row = await env.DB.prepare(
      `SELECT id, size, group_id FROM resource WHERE id = ?`
    ).bind(id).first().catch(() => null);
    if (!row) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
    const user = await getSessionUser(request, env);
    await logDownload(env, {
      userId: user ? user.id : null, ip, resourceId: row.id,
      groupId: row.group_id || null, bytes: row.size || 0, via: 'direct'
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('记直链下载失败:', err);
    return Response.json({ ok: true });   // 日志不是门, 出错也不拦人
  }
}


async function handleStorageOverview(request, env) {
  // 站长看的存储概览（用户 2026-09-17 只要那四张数字卡）。
  // GET /api/storage/overview → { total_bytes, file_count, group_count, week_bytes, users: [...] }
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.access')) return Response.json({ error: '只有站长能看这个' }, { status: 403 });

  try {
    const now = Date.now();
    const live = `scope = 'library' AND (expires_at IS NULL OR expires_at > ${now})`;
    const total = await env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files FROM resource WHERE ${live}`
    ).first();
    const groups = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM resource_group`
    ).first();
    const week = await env.DB.prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS n FROM upload_usage WHERE day >= date('now', ?)`
    ).bind(`-${RES_WEEKLY_DAYS - 1} day`).first();
    /* 每人占用（概览页里那条进度条要用, 顺手一起给） */
    const users = await env.DB.prepare(
      `SELECT u.id, u.username, u.role, u.email_verified, COALESCE(p.nickname, u.username) AS nickname,
              COALESCE(SUM(r.size), 0) AS bytes, COUNT(r.id) AS files
         FROM users u
         LEFT JOIN resource r ON r.uploader_id = u.id AND r.${live}
         LEFT JOIN profiles p ON p.user_id = u.id
        GROUP BY u.id HAVING bytes > 0 ORDER BY bytes DESC LIMIT 50`
    ).all().catch(() => ({ results: [] }));
    /* 超出天数的老行顺手清一清（概览页是站长最常打开的页面, 清在这里最省事） */
    await env.DB.prepare(`DELETE FROM upload_usage WHERE day < date('now', '-90 day')`).run().catch(() => {});
    return Response.json({
      ok: true,
      total_bytes: (total && total.bytes) || 0,
      file_count: (total && total.files) || 0,
      group_count: (groups && groups.n) || 0,
      week_bytes: (week && week.n) || 0,
      users: (users.results || []).map((row) => {
        const tier = RES_QUOTA_TIERS[row.role === 'owner' ? 'owner' : row.role === 'admin' ? 'admin' : (row.email_verified ? 'member' : 'user')] || RES_QUOTA_TIERS.user;
        return { id: row.id, name: row.nickname || row.username, bytes: row.bytes, files: row.files, limit: tier.storage };
      })
    });
  } catch (err) {
    console.error('读存储概览失败:', err);
    return Response.json({ error: '资源表还没建（见 schema.sql 的 resource）' }, { status: 500 });
  }
}


async function handleResourceGroup(request, env) {
  // 改组的信息: POST /api/resource/group {id, title?, description?, expire?, file_id?}
  // 只改传上来的字段 (前端只发改动过的); 有效期跟着组里所有文件一起改 ——
  // 文件行上那份才是权威, 组那一列只是展示与批量改用。
  // file_id 给了 = 改**那一个文件**的标题/简介 (「编辑组」那个工作台里逐个文件改文案用);
  // 这种情况下 expire / 组标题一律忽略, 免得一次请求同时动两个层级。
  // ⚠️ 防盗开关 (resource_group.guard / resource.guard) 两列已经建好了, 但**接口还没开**:
  //    光存一个标志不生效等于骗人, 等对象 ACL 那套做完再一起放出来。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const id = parseInt(payload.id, 10);
  const found = await loadEditableGroup(env, id, user);
  if (found.error) return found.error;

  const meta = cleanResourceMeta(payload);
  const fileId = parseInt(payload.file_id, 10);
  /* 「公开编辑」放进来的协作者只能动**文件那一层** (标题 / 简介 / 加文件 / 删单个文件);
     组的标题、简介、有效期只有上传者(与站长)能改 —— 用户 2026-09-17 定的:
     「就算开启了公开编辑，其他用户仍不能编辑文件组（标题和简介）」。
     前端也会把那三个控件禁用, 这里是真正的门。
     ⚠️ 只在**组那一层**拦: file_id 给了就是改某个文件的标题/简介, 那对字段名是一样的。 */
  const isOwner = await canToggleResource(env, user, found.group.uploader_id);
  const groupLevel = !Number.isInteger(fileId);
  if (groupLevel && !isOwner
    && (payload.title !== undefined || payload.description !== undefined || payload.expire !== undefined)) {
    return Response.json({ error: '只有上传者能修改资源组的信息' }, { status: 403 });
  }
  if (Number.isInteger(fileId)) {
    const row = await env.DB.prepare(
      `SELECT id, uploader_id FROM resource WHERE id = ? AND group_id = ?`
    ).bind(fileId, found.group.id).first().catch(() => null);
    if (!row) return Response.json({ error: '这一组里没有这个文件' }, { status: 404 });
    /* 用户 2026-09-17 第 3 条: 开了「公开编辑」之后, 协作者只能改**自己传的**文件。
       组主人 / 站长不受这个限制 (isOwner 就是「上传者或站长」)。 */
    if (!isOwner && row.uploader_id !== user.id) {
      return Response.json({ error: '这是别人上传的文件，改不了' }, { status: 403 });
    }
    const fileSets = [];
    const fileBinds = [];
    if (payload.title !== undefined) { fileSets.push('title = ?'); fileBinds.push(meta.title); }
    if (payload.description !== undefined) { fileSets.push('description = ?'); fileBinds.push(meta.description); }
    if (!fileSets.length) return Response.json({ ok: true, updated: 0 });
    await env.DB.prepare(`UPDATE resource SET ${fileSets.join(', ')} WHERE id = ?`)
      .bind(...fileBinds, fileId).run();
    return Response.json({ ok: true, updated: fileSets.length, file_id: fileId });
  }

  const sets = [];
  const binds = [];
  if (payload.title !== undefined) { sets.push('title = ?'); binds.push(meta.title); }
  if (payload.description !== undefined) { sets.push('description = ?'); binds.push(meta.description); }
  if (payload.expire !== undefined) {
    const expiresAt = parseResourceExpiry(payload.expire, 'library');
    sets.push('expires_at = ?');
    binds.push(expiresAt);
    await env.DB.prepare(`UPDATE resource SET expires_at = ? WHERE group_id = ?`)
      .bind(expiresAt, found.group.id).run();
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(Date.now(), found.group.id);
    await env.DB.prepare(`UPDATE resource_group SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  return Response.json({ ok: true, updated: sets.length });
}


async function handleResourceGuard(request, env) {
  // 防盗开关: POST /api/resource/guard {id, file_id?, on}
  //   file_id 给了 -> 只改这一个文件 (写成文件级覆盖值 1 / 0)
  //   没给        -> 改整个组 (组开关 + 组内文件的覆盖值清空, 回到「跟组走」)
  // 两件事要一起做: 改对象 ACL (真正的门) + 写标志 (界面照它画)。
  // ⚠️ ACL 一条都没改成功时**不写库** —— 否则界面说「已防盗」、直链照样能下, 那是骗人。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const id = parseInt(payload.id, 10);
  if (!Number.isInteger(id) || id === 0) return Response.json({ error: '缺少资源编号' }, { status: 400 });
  const on = payload.on === true || payload.on === 1 || payload.on === '1';
  const fileId = parseInt(payload.file_id, 10);

  if (!avatarStorageReady(env)) {
    return Response.json({ error: '存储还没配置（缺 OSS 密钥）' }, { status: 503 });
  }

  try {
    const found = await loadResourceTargets(env, id);
    if (found.error) return found.error;
    const group = found.group;
    const rows = found.rows;
    if (!rows.length) return Response.json({ error: '这一组里没有文件' }, { status: 404 });
    if (!(await canToggleResource(env, user, group.uploader_id))) {
      return Response.json({ error: '只有上传者能改防盗开关' }, { status: 403 });
    }

    const targets = Number.isInteger(fileId) ? rows.filter((row) => row.id === fileId) : rows;
    if (!targets.length) return Response.json({ error: '这一组里没有这个文件' }, { status: 404 });

    const acl = on ? 'private' : 'default';
    let aclFailed = 0;
    for (const row of targets) {
      const got = await setResourceObjectAcl(env, row.object_key, acl).catch((err) => {
        console.error('改对象 ACL 异常:', row.object_key, err);
        return { status: -1, body: String((err && err.message) || err) };
      });
      if (got.status) {
        aclFailed += 1;
        console.error('改对象 ACL 失败:', row.object_key, got.status, got.body);
      }
    }
    if (aclFailed === targets.length) {
      // 失败原因里有 OSS 原始报错, 但那是内部信息, 不回给用户 (见 setResourceObjectAcl 上的说明)
      return Response.json({ error: '对象权限没改成功，防盗没能生效，请稍后再试' }, { status: 502 });
    }

    if (Number.isInteger(fileId) || group.id < 0) {
      // 单文件 (或者「老的单文件行」那种自己算一个组的情况)
      await env.DB.prepare(`UPDATE resource SET guard = ? WHERE id = ?`)
        .bind(on ? 1 : 0, targets[0].id).run();
    } else {
      await env.DB.prepare(`UPDATE resource_group SET guard = ?, updated_at = ? WHERE id = ?`)
        .bind(on ? 1 : 0, Date.now(), group.id).run();
      // 文件级那列是「覆盖值」: 整组操作把它清成 NULL, 以后统一跟组开关走
      await env.DB.prepare(`UPDATE resource SET guard = NULL WHERE group_id = ?`).bind(group.id).run();
    }
    return Response.json({ ok: true, on, updated: targets.length, acl_failed: aclFailed });
  } catch (err) {
    console.error('改防盗开关失败:', err);
    return Response.json({ error: '改防盗开关失败，请稍后再试' }, { status: 500 });
  }
}


async function handleResourceAllowEdit(request, env) {
  // 「公开编辑」开关: POST /api/resource/allow-edit {id, on}
  // 开了之后**站内已验邮箱的用户**就能编辑这一组（加文件 / 改标题简介 / 删单个文件）。
  // 权限判据与防盗同一个（上传者 / 站长）—— 管理员只有删除权, 不跟着给。
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const id = parseInt(payload.id, 10);
  // id <= 0 是加组之前的老单文件资源（没有组行可改）
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '缺少资源编号' }, { status: 400 });
  const on = payload.on === true || payload.on === 1 || payload.on === '1';

  try {
    const group = await env.DB.prepare(
      `SELECT id, uploader_id FROM resource_group WHERE id = ?`
    ).bind(id).first().catch(() => null);
    if (!group) return Response.json({ error: '这个资源不存在（可能已被清理）' }, { status: 404 });
    if (!(await canToggleResource(env, user, group.uploader_id))) {
      return Response.json({ error: '只有上传者能改「公开编辑」' }, { status: 403 });
    }
    await env.DB.prepare(`UPDATE resource_group SET allow_edit = ?, updated_at = ? WHERE id = ?`)
      .bind(on ? 1 : 0, Date.now(), id).run();
    return Response.json({ ok: true, on });
  } catch (err) {
    console.error('改公开编辑开关失败:', err);
    return Response.json({ error: '改公开编辑失败，请稍后再试' }, { status: 500 });
  }
}


export {
  handleResourceUpload, handleResourcePresign, handleResourceDownload, handleResourceHash,
  handleResourceList, handleResourceDetail, handleResourceDelete, handleResourceGroup,
  handleResourceGuard, handleResourceAllowEdit,
  handleResourceMultipartInit, handleResourceMultipartParts, handleResourceMultipartSign,
  handleResourceMultipartComplete, handleResourceMultipartAbort,
  handleResourceLogDownload, handleStorageOverview
};
