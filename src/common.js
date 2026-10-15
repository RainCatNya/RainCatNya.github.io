/* common.js 基础层 */
/*
  内容: 常量 / 工具 / 会话·权限组·限流 / OSS 签名 / 邮件 / SEO
  依赖: permission.js(权限组与属性)
*/

// ⚠️ common.js 是被别处 import 最多的文件, 反过来 import permission.js 是安全的 (那边不依赖这边)
import { groupPermissions, loadAttributes, normalizeGroup } from './permission.js';

function withoutEncoding(request) {
  // 复制请求并去掉 Accept-Encoding, 拿到未压缩文本
  const copy = new Request(request);
  copy.headers.delete('Accept-Encoding');
  return copy;
}

function serveNotFound(url, env) {
  return Response.redirect(new URL("/access-denied.html?reason=404", url.origin).href, 302);
}

/* 权限不足的落地页 (serveNotFound 说「页面不存在」, 这个说「你没有权限」) */
function serveAccessDenied(url) {
  return Response.redirect(new URL('/access-denied.html?reason=denied', url.origin).href, 302);
}

/* SEO: OG 分享卡 + sitemap */
// 零构建没有统一写 <head> 的地方, 交给 Worker 过一遍 HTMLRewriter 算出标题与描述
const SITE_ORIGIN = 'https://foraine.xyz';
const SITE_NAME = 'Foraine';
const DEFAULT_DESC = 'RainCat 的个人站 —— 写点文章、折腾点东西。';

// 键统一用归一化路径, 否则 /login.html 与 /login 这类入口会没有 meta
const PAGE_META = {
  '/': { title: 'Foraine', desc: DEFAULT_DESC },
  '/articles': { title: '文章 · Foraine', desc: 'Foraine 的全部文章与随笔。' },
  '/resource': { title: '资源 · Foraine', desc: 'Foraine 资源中心里的全部文件。' },
  '/login': { title: '登录 · Foraine', desc: DEFAULT_DESC, noindex: true },
  '/profile': { title: '个人 · Foraine', desc: DEFAULT_DESC, noindex: true },
  '/stats': { title: '访客统计 · Foraine', desc: 'Foraine 的访客足迹统计。' },
  // 终端: 给站主自己玩的入口, 不让搜索引擎收录
  '/terminal': { title: '终端 · Foraine', desc: 'Foraine 的终端。', noindex: true },
  // 终端秘钥闸门 (没有 terminal.access 的人先来这里)
  '/terminal/verify': { title: '终端 · Foraine', desc: 'Foraine 的终端。', noindex: true },
  '/aceris': { title: '星历 · Foraine', desc: 'Foraine 的星历 —— 一年十二月、每月三十日，附公历对照。' },
  '/access-denied': { title: '访问受限 · Foraine', desc: DEFAULT_DESC, noindex: true }
};

// 路径归一化: 去掉 index.html / .html / 结尾斜杠
function normalizePath(pathname) {
  let out = String(pathname || '/').replace(/index\.html$/, '');
  out = out.replace(/\.html$/, '');
  if (out.length > 1) out = out.replace(/\/$/, '');
  return out || '/';
}

// 属性值转义
function escapeAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 分享卡图片: 能用头像外链就用, 否则回站点图标
function ogImage(avatarUrl) {
  if (avatarUrl && /^https:\/\//i.test(avatarUrl)) return avatarUrl;
  return SITE_ORIGIN + '/assets/Icon/foraine-icon-v2.png';
}

/* 访客国家 -> 语言: 没列到的一律英文, 中文圈统一走简体 (语言包里没有繁体那门) */
const LANG_BY_COUNTRY = { CN: 'zh-CN', HK: 'zh-CN', MO: 'zh-CN', TW: 'zh-CN', SG: 'zh-CN', JP: 'ja-JP' };

// 按访客 IP 猜一门语言 (XX/T1 与本地 dev 都没有国家信息, 回空串让前端退兜底)
function suggestLang(request) {
  const country = (request && request.cf && request.cf.country) || '';
  if (!country || country === 'XX' || country === 'T1') return '';
  return LANG_BY_COUNTRY[country] || 'en-US';
}

// 拼一份完整的 meta 标签串
function buildMetaTags(meta, canonical) {
  const tags = [
    `<meta name="description" content="${escapeAttr(meta.desc)}">`,
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    `<meta property="og:type" content="${meta.type || 'website'}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${escapeAttr(meta.title)}">`,
    `<meta property="og:description" content="${escapeAttr(meta.desc)}">`,
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    `<meta property="og:image" content="${escapeAttr(meta.image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`
  ];
  if (meta.noindex) tags.push('<meta name="robots" content="noindex,follow">');
  return tags.join('\n        ');
}

// asyfunc 按路径算出 meta 并改写 HTML, 出错就原样返回
async function injectPageMeta(response, env, url, request) {
  let meta = null;
  let canonical = SITE_ORIGIN + url.pathname;
  const cleanPath = normalizePath(url.pathname);

  try {
    if (url.pathname.startsWith('/u/')) {
      // 公开个人主页
      const username = decodeURIComponent(url.pathname.slice(3)).replace(/\/$/, '');
      const user = await loadPublicUser(env, username);
      if (user) {
        meta = {
          title: (user.nickname || user.username) + ' · ' + SITE_NAME,
          desc: user.bio || ('@' + user.username + ' 在 Foraine 的主页。'),
          image: ogImage(user.avatar_url),
          type: 'profile'
        };
        canonical = SITE_ORIGIN + '/u/' + encodeURIComponent(user.username);
      }
    } else if (cleanPath === '/article') {
      const id = parseInt(url.searchParams.get('id') || '', 10);
      if (Number.isInteger(id)) {
        const row = await env.DB.prepare(
          `SELECT a.title, a.intro, a.content, p.avatar_url
           FROM articles a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN profiles p ON p.user_id = a.user_id
           WHERE a.id = ? AND a.status = 'published' AND a.is_deleted = 0`
        ).bind(id).first();
        if (row) {
          const title = row.title || row.intro || makeSummary(row.content) || '文章';
          meta = {
            title: title + ' · ' + SITE_NAME,
            // 有简介就用简介当描述
            desc: row.intro || makeSummary(row.content) || DEFAULT_DESC,
            image: ogImage(row.avatar_url),
            type: 'article'
          };
          canonical += '?id=' + id;
        }
      }
      if (!meta) meta = { title: '文章 · ' + SITE_NAME, desc: DEFAULT_DESC, noindex: true, image: ogImage() };
    } else if (cleanPath === '/resource') {
      // 带 id 是文件详情, 不带 id 是列表页 (走 PAGE_META)
      const id = parseInt(url.searchParams.get('id') || '', 10);
      if (Number.isInteger(id)) {
        const row = await env.DB.prepare(
          `SELECT title, name, description, size, mime FROM resource
            WHERE id = ? AND scope = 'library'`
        ).bind(id).first();
        if (row) {
          meta = {
            title: (row.title || row.name || '资源') + ' · ' + SITE_NAME,
            // 简介没写就给「名字 · 大小」
            desc: row.description || `${row.name || '文件'} · ${Math.max(1, Math.round((row.size || 0) / 1024))} KB`,
            image: ogImage(),
            type: 'website'
          };
          canonical += '?id=' + id;
        }
        // 带了 id 却查不到: 用 noindex 兜底, 别让搜索引擎收录空壳
        if (!meta) meta = { title: '资源 · ' + SITE_NAME, desc: DEFAULT_DESC, noindex: true, image: ogImage() };
      } else {
        meta = PAGE_META['/resource'];
      }
    } else {
      meta = PAGE_META[cleanPath] || null;
    }
  } catch (err) {
    console.warn('生成页面元信息失败 (已降级为不改写):', err && (err.message || err.cause) || err);
    return response;
  }

  const ipLang = suggestLang(request);

  if (!meta && !ipLang) return response; // 没登记的页面又猜不出语言, 保持原样

  const rewriter = new HTMLRewriter();
  /* 语言提示走 <head> 里的 meta: i18n.js 拿它当「用户没手动选过语言」时的依据
     (别写成 <html> 上的属性 —— 线上 workerd 对 html 选择器不匹配, 本地 miniflare 却会, 很难发现) */
  if (ipLang) {
    rewriter.on('head', { element(el) { el.prepend(`<meta name="foraine-ip-lang" content="${ipLang}">`, { html: true }); } });
  }
  if (meta) {
    meta.image = meta.image || ogImage();
    rewriter
      .on('title', { element(el) { el.setInnerContent(meta.title); } })
      .on('head', { element(el) { el.append(buildMetaTags(meta, canonical), { html: true }); } });
  }
  return rewriter.transform(response);
}

function notifyIndexNow(env, ctx, articleId) {
  // 发布 / 删除后通知 Bing(Edge) 改索引; 失败不影响主流程
  const target = SITE_ORIGIN + '/article/?id=' + articleId;
  if (!env.INDEXNOW_KEY) return;
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pingIndexNow(env, target));
  else pingIndexNow(env, target).catch(() => {});
}

// asyfunc 通知 Bing / Edge 收录 (IndexNow); 没配 key 或非线上域名直接跳过
async function pingIndexNow(env, urlStr) {
  const key = env.INDEXNOW_KEY;
  if (!key || !urlStr.startsWith(SITE_ORIGIN)) return;
  try {
    await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'foraine.xyz',
        key,
        keyLocation: SITE_ORIGIN + '/' + key + '.txt',
        urlList: [urlStr]
      })
    });
  } catch (err) {
    console.warn('IndexNow 通知失败 (不影响发布):', err);
  }
}

/* 发信 (Resend) */
// MAIL_FROM 放 wrangler.jsonc 的 vars, RESEND_API_KEY 用 wrangler secret put 存
const MAIL_API = 'https://api.resend.com/emails';

// 邮件服务是否配好
function mailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

// 把 Resend 的报错压成一句人能读的话, 直接回给前端
function describeResendError(status, raw) {
  let reason = '';
  try {
    const parsed = JSON.parse(raw);
    reason = (parsed && (parsed.message || parsed.error)) || '';
  } catch (err) {
    reason = String(raw || '');
  }
  reason = String(reason).replace(/\s+/g, ' ').trim().slice(0, 160);
  return '邮件发送失败（Resend ' + status + (reason ? '：' + reason : '') + '）';
}

// asyfunc 发一封邮件, 统一的模板: 标题 + 说明行 + 按钮链接 + 小字提示
async function sendMail(env, { to, subject, title, lines, link, linkText, tip }) {
  if (!mailConfigured(env)) return { ok: false, error: '邮件服务未配置' };

  const body = (lines || []).map(l => `<p style="margin:0 0 12px">${l}</p>`).join('');
  const button = link
    ? `<p style="margin:24px 0"><a href="${link}" style="display:inline-block;padding:10px 22px;border-radius:8px;background:#945EEC;color:#fff;text-decoration:none">${linkText || '点击确认'}</a></p>
       <p style="margin:0 0 12px;color:#888;word-break:break-all">${link}</p>`
    : '';
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#222">
    <h2 style="margin:0 0 16px;font-size:19px">${title}</h2>
    ${body}${button}
    <p style="margin:20px 0 0;color:#888;font-size:13px">${tip || '若非本人操作，请忽略此邮件。'}</p>
  </div>`;

  try {
    const response = await fetch(MAIL_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html })
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      console.error('发信失败:', response.status, raw.slice(0, 300));
      return { ok: false, error: describeResendError(response.status, raw) };
    }
    return { ok: true };
  } catch (err) {
    console.error('发信异常:', err && (err.message || err.cause) || err);
    return { ok: false, error: '邮件发送失败，请稍后再试' };
  }
}

/* 邮箱验证 / 解绑 */
// 每小时最多真发 5 封, 只算发成功的 (否则调试时会把自己锁死)
const MAIL_LIMIT = 5;
const EMAIL_TOKEN_TTL = 30 * 60 * 1000; // 30 分钟
const EMAIL_MAX = 120;

// 邮箱格式校验
function isValidEmail(value) {
  return value.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loadEmailState(env, userId) {
  // 缺 email_verified 列时一律当未验证
  try {
    const row = await env.DB.prepare(`SELECT email, email_verified FROM users WHERE id = ?`).bind(userId).first();
    return { email: (row && row.email) || '', verified: Boolean(row && row.email_verified) };
  } catch (err) {
    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first();
    return { email: (row && row.email) || '', verified: false };
  }
}

async function emailTakenByOther(env, email, userId) {
  // 一个邮箱只能被一个账号验证 (未验证的不算占位), 比对前 LOWER 一下
  const row = await env.DB.prepare(
    `SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND email_verified = 1 AND id != ?`
  ).bind(email, userId).first();
  return Boolean(row);
}

async function createEmailToken(env, userId, purpose, email) {
  // 同一用途只留最新一条, 重新发送会让旧链接立刻失效
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?`).bind(userId, purpose),
    env.DB.prepare(
      `INSERT INTO email_tokens (token, user_id, purpose, email, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(token, userId, purpose, email || null, now + EMAIL_TOKEN_TTL, now)
  ]);
  return token;
}

function isPageRequest(request) {
  // 页面请求的 Accept 含 text/html; 请求 CSS/JS/图片 时是 text/css、image/*, 不含它
  if (request.method !== 'GET') return false;
  return (request.headers.get('Accept') || '').includes('text/html');
}

// 登录 / 注册 / 会话
// 访问统计走 Cloudflare 的站级分析, 不再自己写库
const encoder = new TextEncoder();

function randomHex(bytes = 16) {
  // 生成随机十六进制字符串
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* OAuth 建号的账号没有密码, password_hash 用 `!oauth!` 前缀标记 (密码登录必然比不出这个值) */
const OAUTH_PASSWORD_PREFIX = '!oauth!';

function hasPassword(user) {
  const hash = user && user.password_hash;
  return typeof hash === 'string' && hash.length > 0 && !hash.startsWith(OAUTH_PASSWORD_PREFIX);
}

async function verifyUserPassword(user, password) {
  if (!user || !hasPassword(user) || !password) return false;
  const hash = await hashPassword(password, user.salt);
  return hash === user.password_hash;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltHex) {
  // PBKDF2-SHA256, 100000 次迭代, 输出 256 bit
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });
  return cookies;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
}

/* 限流 */
// D1 当计数器 (Workers 无状态); 表缺失时一律放行, 限流是防刷用的, 不能把正常登录卡死
async function checkRateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare(
      `SELECT count, expires_at FROM rate_limits WHERE key = ?`
    ).bind(key).first();

    if (!row || row.expires_at < now) {
      await env.DB.prepare(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`
      ).bind(key, now + windowMs).run();
      return { ok: true };
    }
    if (row.count >= limit) {
      return { ok: false, retryAfterSec: Math.ceil((row.expires_at - now) / 1000) };
    }
    await env.DB.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).bind(key).run();
    return { ok: true };
  } catch (err) {
    console.warn('限流检查跳过:', err && (err.message || err.cause) || err);
    return { ok: true };
  }
}

// asyfunc 只看不记, 给「先放行、事成了才计数」的场合用 (发信就是这种)
async function peekRateLimit(env, key, limit) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare(
      `SELECT count, expires_at FROM rate_limits WHERE key = ?`
    ).bind(key).first();
    if (!row || row.expires_at < now) return { ok: true };
    if (row.count >= limit) {
      return { ok: false, retryAfterSec: Math.ceil((row.expires_at - now) / 1000) };
    }
    return { ok: true };
  } catch (err) {
    console.warn('限流检查跳过:', err && (err.message || err.cause) || err);
    return { ok: true };
  }
}

// asyfunc 记一次限流计数 (配合 peekRateLimit: 真的发出去了才调)
async function hitRateLimit(env, key, windowMs) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare(
      `SELECT expires_at FROM rate_limits WHERE key = ?`
    ).bind(key).first();
    if (!row || row.expires_at < now) {
      await env.DB.prepare(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`
      ).bind(key, now + windowMs).run();
      return;
    }
    await env.DB.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).bind(key).run();
  } catch (err) {
    console.warn('限流计数跳过:', err && (err.message || err.cause) || err);
  }
}

/* asyfunc 限流行清理: 过期行留着没用, 但按 IP 的 key 会随访客一直增行 —— 不清就会把表撑大 */
async function purgeRateLimits(env) {
  try {
    const res = await env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at < ?`).bind(Date.now()).run();
    return (res.meta && res.meta.changes) || 0;
  } catch (err) {
    // 还没有 rate_limits 表 -> 当无事发生
    console.warn('清理限流行跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

// 「还有多久能再试」的人话版本
function retryText(seconds) {
  const sec = Math.max(0, Math.ceil(seconds || 0));
  if (sec >= 60) return Math.ceil(sec / 60) + ' 分钟';
  return sec + ' 秒';
}

// asyfunc 一次 JOIN 取齐会话 + 资料 + OAuth 绑定, 省掉每页 /api/me 的三次查询
async function loadSessionUser(env, token) {
  try {
    return await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.password_hash, u.salt, u.email_verified,
              p.nickname, p.avatar_url, p.bio, p.other,
              p.bg_image, p.bg_blur, p.chat_bg, p.chat_blur,
              p.font_chat, p.font_forum, p.font_article,
              u.github_login AS github_login
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, Date.now()).first();
  } catch (err) {
    // 缺 github_login / email_verified 列时退回不含它们的版本
    const row = await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.password_hash, u.salt,
              p.nickname, p.avatar_url, p.bio, p.other
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, Date.now()).first();
    return row ? { ...row, github_login: null, email_verified: 0 } : null;
  }
}

// asyfunc 建会话并返回 Set-Cookie 的值 (OAuth 回调要跳转带 Cookie, 不能回 JSON)
async function createSessionCookie(env, userId, url) {
  const token = randomHex(32);
  const now = Date.now();
  const expiresAt = now + 3 * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).bind(token, userId, expiresAt, now).run();

  // 最后登录时间记在 users 上 (sessions 会被 cron 清, 当不了登录记录); 缺列时静默跳过
  await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
    .bind(now, userId).run().catch(() => {});

  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `foraine_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=259200${secure}`;
}

// asyfunc 新建会话并写入 Cookie (3 天)
async function createSession(env, userId, url) {
  const cookie = await createSessionCookie(env, userId, url);
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
}

// 个人资料字段上限 (超长直接截断, 不报错)
const PROFILE_NICKNAME_MAX = 40;
const PROFILE_BIO_MAX = 300;
const PROFILE_OTHER_MAX = 500;
// 背景图只存桶里的地址, 不用留太长
const PROFILE_IMAGE_URL_MAX = 400;

/* 背景图地址: undefined = 没传不动, '' = 清空, 其它必须是 http(s) 地址, 非法值 false */
function readImageUrl(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > PROFILE_IMAGE_URL_MAX) return false;
  if (!/^https?:\/\//i.test(text)) return false;
  return text;
}

/* 模糊度 0~100 的整数 (没传 = 不动; 越界就夹回去) */
function readBlur(value) {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/* 字体只认白名单, 认不出存空串; 加新字体时三处一起改: 这里、core.js 的 FONT_CHOICES、main.css 的 --font-* */
const FONT_VALUES = ['', 'hand'];
function readFont(value) {
  if (value === undefined) return undefined;
  const text = String(value || '').trim();
  if (!FONT_VALUES.includes(text)) return '';
  return text;
}

/* 反查出来的地点缓存 (只在本 isolate 内有效; 两个反查服务都有限速) */
const geoCache = new Map();

/* asyfunc 经纬度 -> 「城市, 省/州, 国家」的英文地址; 依次试 BigDataCloud 与 Nominatim, 都没有就回空串 */
async function reverseGeocode(lat, lon) {
  const attempts = [
    async () => {
      const res = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client'
        + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`,
        { headers: { Accept: 'application/json' } });
      if (!res.ok) return '';
      const data = (await res.json().catch(() => null)) || {};
      // 去掉 "Sichuan Sheng" / "Zigong Shi" 这种后缀
      const state = String(data.principalSubdivision || '').replace(/\s+(Sheng|Shi|Xian|Zizhiqu)$/i, '');
      return [data.city || data.locality || '', state, data.countryName || ''].filter(Boolean).join(', ');
    },
    async () => {
      const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en'
        + `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
        // Nominatim 的使用条款要求带一个能认出本站的 User-Agent
        { headers: { 'User-Agent': 'Foraine/1.0 (https://foraine.xyz)', Accept: 'application/json' } });
      if (!res.ok) return '';
      const data = await res.json().catch(() => null);
      const addr = (data && data.address) || {};
      // 城市可能落在好几个字段里 (city / town / village / county), 挨个试
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
      const state = addr.state || addr.province || addr.state_district || addr.region || '';
      return [city, state, addr.country || ''].filter(Boolean).join(', ');
    }
  ];
  for (const attempt of attempts) {
    try {
      const label = await attempt();
      if (label) return label;
    } catch (err) {
      console.warn('反查位置的一次尝试失败:', err && (err.message || err));
    }
  }
  return '';
}

/* GitHub OAuth */
// GITHUB_CLIENT_ID 放 wrangler.jsonc 的 vars, GITHUB_CLIENT_SECRET 用 wrangler secret put 存
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const OAUTH_STATE_COOKIE = 'foraine_oauth_state';

// 回调地址必须与 GitHub OAuth App 里填的完全一致
function githubCallbackUrl(url) {
  return `${url.origin}/api/auth/github/callback`;
}

// 清掉 state Cookie (Max-Age=0)
function clearStateCookie() {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// GitHub OAuth 是否配好
function githubConfigured(env) {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

// 302 + 多个 Set-Cookie; 必须用 Headers.append, 给对象只能发一条
function redirectTo(location, cookies) {
  const headers = new Headers({ Location: location });
  (cookies || []).filter(Boolean).forEach(c => headers.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers });
}

/* 注销账号 */
/* 注销只打标记 (is_deleted / deleted_at), 满 7 天才由 cron 真删; 邮箱验证码是必需的一环, 光有密码不算本人 */
const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 至少留 7 天

// asyfunc 账号是否「申请了注销、还在 7 天保留期里」; 缺列当没有
async function loadPendingDeletion(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT is_deleted, deleted_at FROM users WHERE id = ?`
    ).bind(userId).first();
    if (!row || !row.is_deleted) return null;
    const at = row.deleted_at || 0;
    return { at, deleteAt: at + DELETE_GRACE_MS, daysLeft: Math.max(0, Math.ceil((at + DELETE_GRACE_MS - Date.now()) / 86400000)) };
  } catch (err) {
    return null;
  }
}

/* asyfunc 读「取消注销」的冷静期; 缺列 / 过了 7 天都当没有 */
async function loadDeleteCooldown(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT delete_cancelled_at FROM users WHERE id = ?`
    ).bind(userId).first();
    const at = Number(row && row.delete_cancelled_at) || 0;
    if (!at) return null;
    const until = at + DELETE_GRACE_MS;
    if (until <= Date.now()) return null;
    return { at, until, daysLeft: Math.ceil((until - Date.now()) / 86400000) };
  } catch (err) {
    return null;
  }
}

/* 敏感操作的一次性通行证 (用户 2026-09-20) */
const VERIFY_PASS_MS = 5 * 60 * 1000;

// asyfunc 验证身份通过后发一张通行证 (via = 怎么验的, 只作记录)
async function issueVerifyPass(env, userId, via) {
  const token = randomHex(16);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO verify_pass (token, user_id, via, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(token, userId, via, now + VERIFY_PASS_MS, now).run();
  return token;
}

// asyfunc 校验并消费一张通行证 (用掉即删; 缺表 / 过期 / 不是本人的都不认)
async function consumeVerifyPass(env, userId, token) {
  const value = String(token || '').trim();
  if (!value) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT expires_at FROM verify_pass WHERE token = ? AND user_id = ?`
    ).bind(value, userId).first();
    if (!row) return false;
    await env.DB.prepare(`DELETE FROM verify_pass WHERE token = ?`).bind(value).run();
    return row.expires_at >= Date.now();
  } catch (err) {
    return false;
  }
}

/* asyfunc 真删一个账号 (cron 到期清理 + 站长手动删号共用); 文章只软删除, 内容不凭空消失 */
async function hardDeleteUser(env, userId) {
  await env.DB.prepare(
    `UPDATE articles SET is_deleted = 1, updated_at = ? WHERE user_id = ?`
  ).bind(Date.now(), userId).run();

  // 头像要在删资料行之前取出来, 行一删就没人引用它了
  const avatarRow = await env.DB.prepare(
    `SELECT avatar_url FROM profiles WHERE user_id = ?`
  ).bind(userId).first().catch(() => null);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM profiles WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId)
  ]);

  const avatarKey = avatarRow
    ? keyFromPublicUrl(avatarRow.avatar_url, AVATAR_PUBLIC_BASE, 'avatar/')
    : null;
  if (avatarKey) {
    const del = await deleteObject(env, 'avatar', avatarKey);
    if (del !== 204 && del !== 404) console.warn('注销清理时没清掉头像:', avatarKey, del);
  }
}

/* asyfunc 到期清理: 注销申请满 7 天的账号才真删 (cron 每天调一次) */
async function purgePendingDeletions(env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, username FROM users
        WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at <= ?`
    ).bind(Date.now() - DELETE_GRACE_MS).all();
    let done = 0;
    for (const row of (rows.results || [])) {
      await hardDeleteUser(env, row.id);
      console.log('注销保留期已过, 删除账号:', row.username);
      done += 1;
    }
    return done;
  } catch (err) {
    // 缺这两列 -> 没有待注销的账号, 当无事发生
    console.warn('清理待注销账号跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* 反悔: 取消注销申请, 顺手给站长们记一封通知 */

/* 邮箱: 验证 / 换绑 / 验证码 */
/* 三条流程都是「发一封带链接或验证码的邮件, 确认了才生效」; 链接令牌 30 分钟, 重发会让旧链接失效 */
/* 换绑必须一步到位: 邮箱是身份凭证, 只解绑会留下一段没有邮箱的空窗期 */
/* 注销用的邮箱验证码: 6 位数字, 10 分钟有效, 存在 email_tokens.token (purpose='delete') */
const DELETE_CODE_TTL = 10 * 60 * 1000;

// asyfunc 从 Cookie 解析当前登录用户, 未登录或过期返回 null
async function getSessionUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.foraine_session;
  if (!token) return null;

  try {
    const session = await env.DB.prepare(
      `SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?`
    ).bind(token, Date.now()).first();
    if (!session) return null;

    return await env.DB.prepare(
      `SELECT u.id, u.username, p.nickname
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    ).bind(session.user_id).first();
  } catch (err) {
    console.error('获取会话用户失败:', err);
    return null;
  }
}

// asyfunc 这号的邮箱验证过没有 (「允许其他人编辑」「改译名」这类门槛); 老库缺列一律当未验证
// ⚠️ getSessionUser 只取了 id/username/nickname, 拿不到 email_verified, 所以要单独查一次
async function emailVerified(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT email, email_verified FROM users WHERE id = ?')
      .bind(userId).first();
    return Boolean(row && row.email && row.email_verified);
  } catch (err) {
    return false;
  }
}

/* 文章 / 标签 */
const ARTICLE_TITLE_MAX = 120;
const ARTICLE_CONTENT_MAX = 20000;
// 简介: 作者自己写的一句话主题, 为空就只剩标题; 自动截正文的摘要只留给 SEO / 搜索
const ARTICLE_INTRO_MAX = 120;
const TAGS_MAX = 8;
// 作者账号被注销后文章保留, 作者名兜底 (LEFT JOIN 后 username 可能为 NULL)
const DELETED_AUTHOR = '已注销';

/* 属性与权限组 (permission.js) —— 判定全都走它, 这里只做一层薄封装 */

/* asyfunc 这个人属于哪个权限组 (没登录 = default; 被封禁 = basis) */
async function loadUserGroup(env, user) {
  if (!user) return 'default';
  try {
    if (await isBanned(env, user.id)) return 'basis';
  } catch (err) {
    // 封禁表读不到就当他没被封
  }
  try {
    const row = await env.DB.prepare(
      `SELECT r.name FROM users u JOIN roles r ON r.name = u.role WHERE u.id = ?`
    ).bind(user.id).first();
    return normalizeGroup(row && row.name);
  } catch (err) {
    console.warn('取权限组失败 (降级为 user):', (err && (err.message || err.cause)) || err);
    return 'user';
  }
}

// asyfunc 这个人能不能做这一项 (组 + 他身上的额外属性)
async function loadPermissions(env, userId) {
  const out = new Set();
  if (!userId) {
    for (const one of groupPermissions('default')) out.add(one);
    return out;
  }
  let group = 'user';
  try {
    const row = await env.DB.prepare(
      `SELECT r.name FROM users u JOIN roles r ON r.name = u.role WHERE u.id = ?`
    ).bind(userId).first();
    group = normalizeGroup(row && row.name);
  } catch (err) {
    console.warn('加载权限组失败 (降级为 user):', (err && (err.message || err.cause)) || err);
  }
  for (const one of groupPermissions(group)) out.add(one);
  // 额外属性也算进来: <secret> 之外, 终端通行证这类就靠它
  for (const one of await loadAttributes(env, userId)) out.add(one);
  return out;
}

// 判断权限集合里有没有这一项 ('*' = 全部; a.b.* 顶 a.b.c)
function hasPermission(perms, permission) {
  if (!perms) return false;
  if (perms.has('*') || perms.has(permission)) return true;
  const want = String(permission || '');
  const parts = want.split('.');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (perms.has(parts.slice(0, i).join('.') + '.*')) return true;
  }
  return false;
}

/* 用户名规则: 3–20 位字母数字下划线短横线, 首尾为字母或数字; 一律小写入库, 前端有同一份规则 */
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,18})[A-Za-z0-9]$/;
const USERNAME_RESERVED = [
  'admin', 'administrator', 'root', 'system', 'official', 'support', 'moderator', 'owner',
  'foraine', 'raincatnya', 'fiflizc'
];

// 校验用户名, 返回 { ok, value: 小写名, raw: 用户原样打的字 }
function checkUsername(name) {
  const value = String(name || '').trim();
  if (value.length < 3) return { ok: false, error: '用户名至少 3 个字符' };
  if (value.length > 20) return { ok: false, error: '用户名最多 20 个字符' };
  if (!USERNAME_RE.test(value)) {
    return { ok: false, error: '用户名只能用半角字母、数字、下划线（_）和短横线（-），首尾必须是字母或数字' };
  }
  if (USERNAME_RESERVED.includes(value.toLowerCase())) {
    return { ok: false, error: '该用户名已被占用' };
  }
  // value = 入库用的小写名, raw = 用户原样打的字 (当默认昵称)
  return { ok: true, value: value.toLowerCase(), raw: value };
}

function makeSummary(content) {
  // 列表 / 标题回退用: 去掉代码块与 Markdown 符号, 取前 80 字
  const text = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

/* 阅读时长: 中文 380 字/分, 西文 200 词/分, 每代码块加 4 秒; 与文章页必须是同一套算法 */
const READING_CJK_PER_MIN = 380;
const READING_WORD_PER_MIN = 200;
// 阅读时长文案, 不足 1 分钟按 5 秒取整
function readingTimeText(text) {
  const raw = String(text || '');
  const cjk = (raw.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const words = (raw.match(/[A-Za-z][A-Za-z'\u2019\-]*/g) || []).length;
  const numbers = (raw.match(/\d+/g) || []).length;
  const codeBlocks = Math.floor((raw.match(/```/g) || []).length / 2);
  const seconds = (cjk / READING_CJK_PER_MIN) * 60
    + ((words + numbers) / READING_WORD_PER_MIN) * 60
    + codeBlocks * 4;
  if (seconds < 60) return Math.max(5, Math.round(seconds / 5) * 5) + ' 秒';
  return Math.round(seconds / 60) + ' 分钟';
}

// 标签去重 + 去空白, 最多 TAGS_MAX 个
function normalizeTags(input) {
  const out = [];
  if (Array.isArray(input)) {
    for (const raw of input) {
      const name = String(raw).trim().replace(/\s+/g, ' ');
      if (name && name.length <= 24 && !out.includes(name)) out.push(name);
      if (out.length >= TAGS_MAX) break;
    }
  }
  return out;
}

async function attachTags(env, articles) {
  // 为文章数组批量补上 tags 字段
  if (!articles || articles.length === 0) return articles;
  const ids = articles.map(a => a.id);
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT at.article_id AS article_id, t.name AS name
       FROM article_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.article_id IN (${placeholders}) ORDER BY t.name`
    ).bind(...ids).all();
    const map = {};
    (rows.results || []).forEach(r => {
      (map[r.article_id] = map[r.article_id] || []).push(r.name);
    });
    articles.forEach(a => { a.tags = map[a.id] || []; });
  } catch (err) {
    console.warn('附加标签失败:', err);
    articles.forEach(a => { a.tags = []; });
  }
  return articles;
}

async function saveTags(env, articleId, tagNames) {
// asyfunc 重建该文章的标签关联
  try {
    const stmts = [env.DB.prepare(`DELETE FROM article_tags WHERE article_id = ?`).bind(articleId)];
    tagNames.forEach(name => {
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`).bind(name));
    });
    await env.DB.batch(stmts);

    if (tagNames.length > 0) {
      const placeholders = tagNames.map(() => '?').join(',');
      const tags = await env.DB.prepare(
        `SELECT id FROM tags WHERE name IN (${placeholders})`
      ).bind(...tagNames).all();
      const links = (tags.results || []).map(t =>
        env.DB.prepare(`INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)`).bind(articleId, t.id)
      );
      if (links.length > 0) await env.DB.batch(links);
    }
  } catch (err) {
    console.error('保存标签失败:', err);
  }
}

/* 公开个人主页 */

/* asyfunc 谁能打开文章编辑页: 登录 + 未封禁 + 作者本人; 不满足时一律当 404 (别泄露文章存在) */
async function canOpenEditor(request, env, url) {
  try {
    const user = await getSessionUser(request, env);
    if (!user) return false;
    if (await isBanned(env, user.id)) return false;

    const edit = String(url.searchParams.get('edit') || '');
    if (edit === 'new') return true;      // 写新文章
    if (edit !== '1') return false;       // 不认识的取值一律不放

    const id = parseInt(url.searchParams.get('id') || '', 10);
    if (!Number.isInteger(id)) return false;
    const row = await env.DB.prepare(
      `SELECT user_id FROM articles WHERE id = ? AND is_deleted = 0`
    ).bind(id).first();
    if (!row) return false;
    // 只有作者本人
    return row.user_id === user.id;
  } catch (err) {
    console.warn('编辑页身份校验失败 (当作不允许):', err && (err.message || err.cause) || err);
    return false;
  }
}

async function loadPublicUser(env, username) {
  // 只取公开字段; 别把 u.email 加进来, 那样就变成无条件外露 (互关才给的邮箱走单独的门控查询)
  if (!username) return null;
  try {
    // github_login 在 users 表上, 写成 p.github_login 会掉进降级分支 (静默少几个字段)
    return await env.DB.prepare(
      `SELECT u.id, u.username, u.created_at, p.nickname, p.avatar_url, p.bio, p.other,
              u.github_login AS github_login, p.bg_image, p.bg_blur
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE LOWER(u.username) = LOWER(?)`
    ).bind(username).first();
  } catch (err) {
    // 旧库可能还没有背景图那几列
    try {
      return await env.DB.prepare(
        `SELECT u.id, u.username, u.created_at, p.nickname, p.avatar_url, p.bio, p.other
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
         WHERE LOWER(u.username) = LOWER(?)`
      ).bind(username).first();
    } catch (err2) {
      console.warn('读取公开用户失败:', err2);
      return null;
    }
  }
}

/* 评论: 照 Waline 只有两级 (顶层 + 缩进回复), 删除走软删除留占位, 回复指那一层由前端往上找根 */
const COMMENT_MAX = 600;

/* asyfunc 这条评论下面任意一层还有没有活评论 (留不留占位的判据); 只看直接回复不够 */
async function commentHasLiveDescendant(env, commentId) {
  try {
    const row = await env.DB.prepare(
      `WITH RECURSIVE sub(id, is_deleted) AS (
         SELECT id, is_deleted FROM comments WHERE reply_to_comment_id = ?
         UNION ALL
         SELECT c.id, c.is_deleted FROM comments c JOIN sub ON c.reply_to_comment_id = sub.id
       )
       SELECT COUNT(*) AS count FROM sub WHERE is_deleted = 0`
    ).bind(commentId).first();
    return !!(row && row.count > 0);
  } catch (err) {
    // 查不出来就当「下面还有人」, 宁可留个占位
    console.warn('查评论子回复失败:', err);
    return true;
  }
}

/* asyfunc 抹掉一条评论, 连它下面整棵死掉的子树一起清 (只删 is_deleted = 1) */
async function purgeComment(env, commentId) {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM comments WHERE id IN (
         WITH RECURSIVE sub(id, is_deleted) AS (
           SELECT id, is_deleted FROM comments WHERE reply_to_comment_id = ?
           UNION ALL
           SELECT c.id, c.is_deleted FROM comments c JOIN sub ON c.reply_to_comment_id = sub.id
         )
         SELECT id FROM sub WHERE is_deleted = 1
       )`
    ).bind(commentId),
    env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(commentId)
  ]);
}

/* asyfunc 顺着 reply_to_comment_id 往上收集上级, 遇到活评论就停; 必须在 purge 之前调用 */
async function commentAncestorChain(env, commentId) {
  const chain = [];
  let cursorId = commentId;
  for (let hops = 0; hops < 20; hops += 1) {
    const row = await env.DB.prepare(
      `SELECT reply_to_comment_id FROM comments WHERE id = ?`
    ).bind(cursorId).first();
    const parentId = row ? row.reply_to_comment_id : null;
    if (!parentId) break;
    const parent = await env.DB.prepare(
      `SELECT id, is_deleted, reply_to_comment_id FROM comments WHERE id = ?`
    ).bind(parentId).first();
    if (!parent) break;
    chain.push(parent);
    if (!parent.is_deleted) break; // 活评论: 它以上都不用管了
    cursorId = parent.id;
  }
  return chain;
}

/* asyfunc 往上清占位: 已软删的评论下面再没有活评论时, 连带更上面的同类一起抹掉 */
async function pruneDeadAncestors(env, chain) {
  for (const parent of chain) {
    if (!parent.is_deleted) break;
    if (await commentHasLiveDescendant(env, parent.id)) break;
    await purgeComment(env, parent.id);
  }
}

/* 注册页的「这个用户名能不能用」: 补上「库里有没有」这一问, 顺便回规范化后的小写名 */

/* 头像存储 (阿里云 OSS) */
// 对象名 = avatar/<用户名> 不带扩展名, 换图必然覆盖; URL 拼 ?v=<时间戳> 破缓存
// AK/SK 只放 secret (wrangler secret put), 本地调试写在 .dev.vars 里
const OSS_BUCKET = 'foraine-image';
const OSS_REGION = 'us-west-1';
const OSS_UPLOAD_HOST = 'foraine-image.oss-us-west-1.aliyuncs.com';
const AVATAR_PUBLIC_BASE = 'https://img.foraine.xyz';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// 文章配图桶 foraine-image (us-west-1 硅谷, 对外 img.foraine.xyz); RAM 里三个桶并列: img/* 、 res/* 、 avatar/*
const IMG_BUCKET = 'foraine-image';
const IMG_UPLOAD_HOST = 'foraine-image.oss-us-west-1.aliyuncs.com';
const IMG_PUBLIC_BASE = 'https://img.foraine.xyz';
const IMG_MAX_BYTES = 20 * 1024 * 1024; // 配图 / 聊天图单张上限
const IMG_UPLOAD_LIMIT = 40;           // 每人每小时最多 40 张 (从源头挡刷图)
// 聊天图登记进 stored_image 表 + 默认留 7 天, 到期连对象带记录一起删
const CHAT_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* 资源桶 foraine-resource (us-west-1 硅谷, 对外 res.foraine.xyz); 上传先在 resource 表登记再传字节 */
const RES_BUCKET = 'foraine-resource';
const RES_UPLOAD_HOST = 'foraine-resource.oss-us-west-1.aliyuncs.com';
const RES_PUBLIC_BASE = 'https://res.foraine.xyz';
/* 单个资源上限 5GB (OSS 单次 PUT 的上限); 中转那条受请求体与 128MB 内存限制, 只到 ~24MB */
const RES_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/* 一次上传的字节总量上限 (单文件 5GB / 单次 10GB / 每天 40GB 是三道不同的闸,
   前两道管「这一次», 第三道管「这一天」) */

const RES_BATCH_MAX_BYTES = 10 * 1024 * 1024 * 1024;
/* 日配额, 防「一下子把带宽占满」这种突发 */
const RES_DAILY_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
/* 「资源量限制方案」关掉时用的日配额 (那套方案之前的值) */
const RES_QUOTA_LEGACY_DAILY_BYTES = 40 * 1024 * 1024 * 1024;

/* 资源配额: 三道闸 (存量 / 7 天累计 / 单组文件数) 按身份分档, 0 = 不限, 站长全放开 */
const RES_QUOTA_TIERS = {
  owner: { storage: 0, weekly: 0, groupFiles: 0 },
  admin: { storage: 500 * 1024 * 1024 * 1024, weekly: 0, groupFiles: 200 },
  member: { storage: 100 * 1024 * 1024 * 1024, weekly: 0, groupFiles: 50 },
  user: { storage: 20 * 1024 * 1024 * 1024, weekly: 20 * 1024 * 1024 * 1024, groupFiles: 20 }
};
/* 7 天累计那道的窗口 (含今天共 7 个 UTC 日) */
const RES_WEEKLY_DAYS = 7;
/* 下载并发上限 (按身份), 0 = 不限; 游客只能按 IP 算, 所以给 1 */
const DL_CONCURRENCY = { owner: 0, admin: 0, member: 4, user: 2, guest: 1 };
/* 占用并发槽后多久自动释放 (防浏览器关掉、槽没还) */
const DL_SLOT_TTL_MS = 30 * 60 * 1000;
/* 大流量上传要通知站长 / 上传者的两道阈值 */
const RES_NOTIFY_BATCH_BYTES = 2 * 1024 * 1024 * 1024;
const RES_NOTIFY_BIG_BYTES = 5 * 1024 * 1024 * 1024;
/* 这一批的总字节超过它就默认开防盗链 (只在开新组那一下判, 不动老组原来的开关) */
const RES_AUTO_GUARD_BYTES = 5 * 1024 * 1024 * 1024;
const RES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 默认 7 天

// 资源允许的 MIME -> 扩展名; 不收 html / svg / js (挂在自己域名下能被当页面渲染)
const RESOURCE_TYPES = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/java-archive': 'jar'
};

/* 按文件名猜扩展名 (直传备用, 浏览器偶尔不给 mime); 只在 RESOURCE_TYPES 白名单里挑 */
function extFromFilename(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (!match) return '';
  const wanted = match[1];
  if (wanted === 'jpeg') return 'jpg';
  return Object.values(RESOURCE_TYPES).indexOf(wanted) >= 0 ? wanted : '';
}

/* 资源中心的类型分组: 键是扩展名, 值是分组名; 筛选按对象名后缀 LIKE, 不单开一列 */
const RESOURCE_KINDS = {
  zip: 'archive', rar: 'archive', '7z': 'archive',
  pdf: 'document', txt: 'document', md: 'document', json: 'document',
  png: 'image', jpg: 'image', webp: 'image', gif: 'image',
  mp3: 'audio', ogg: 'audio', wav: 'audio',
  mp4: 'video', webm: 'video',
  jar: 'program'
};

// 分组的显示名 (右栏与卡片徽标共用)
const RESOURCE_KIND_LABELS = {
  archive: '压缩包', document: '文档', image: '图片',
  audio: '音频', video: '视频', program: '程序'
};

// 一个分组对应哪些扩展名 (拼 SQL 的 LIKE 用)
function resourceKindExtensions(kind) {
  return Object.keys(RESOURCE_KINDS).filter((ext) => RESOURCE_KINDS[ext] === kind);
}

/* 上传配额 (按字节, 每人每天); 表缺失或查询出错一律放行, 配额是防刷用的 */
// 时间戳 -> UTC 日期串 (YYYY-MM-DD)
function utcDay(ts) {
  return new Date(ts || Date.now()).toISOString().slice(0, 10);
}

/* 下载日志与并发槽: 不做字节级限速, 改成按身份限同时下载数 + 记日志; 直链那条路拦不住 */

/* asyfunc 现在有几个下载在跑 (按人, 游客按 IP), 顺手清过期槽; 游客那条必须带 user_id IS NULL */
async function dlActiveCount(env, userId, ip) {
  const who = userId
    ? `user_id = ${Number(userId)}`
    : `user_id IS NULL AND ip = '${String(ip || '').replace(/'/g, '')}'`;
  try {
    await env.DB.prepare(`DELETE FROM dl_active WHERE updated_at < ?`).bind(Date.now() - DL_SLOT_TTL_MS).run();
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dl_active WHERE ${who}`).first();
    return (row && row.n) || 0;
  } catch (err) {
    console.warn('读下载并发跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* asyfunc 占一个下载槽 (返回槽 id, 收尾时要还); 并发满了返回 null */
async function dlTakeSlot(env, userId, ip) {
  try {
    await env.DB.prepare(`DELETE FROM dl_active WHERE updated_at < ?`).bind(Date.now() - DL_SLOT_TTL_MS).run();
    const token = randomHex(8);
    await env.DB.prepare(
      `INSERT INTO dl_active (token, user_id, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(token, userId || null, ip || '', Date.now(), Date.now()).run();
    return token;
  } catch (err) {
    console.warn('占下载槽跳过:', err && (err.message || err.cause) || err);
    return null;   // 表没建 -> 当作没抢到, 调用方会放行 (见 handleResourceDownload)
  }
}

// asyfunc 还一个下载槽
async function dlReleaseSlot(env, token) {
  if (!token) return;
  try {
    await env.DB.prepare(`DELETE FROM dl_active WHERE token = ?`).bind(token).run();
  } catch (err) {
    console.warn('还下载槽跳过:', err && (err.message || err.cause) || err);
  }
}

/* asyfunc 记一条下载; 失败也不拦人, 日志是给站长看的 */
async function logDownload(env, { userId, ip, resourceId, groupId, bytes, via }) {
  try {
    await env.DB.prepare(
      `INSERT INTO download_log (user_id, ip, resource_id, group_id, bytes, via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId || null, ip || '', resourceId || null, groupId || null, bytes || 0, via || 'worker', Date.now()).run();
  } catch (err) {
    console.warn('记下载日志跳过:', err && (err.message || err.cause) || err);
  }
}

/* asyfunc 这个人属于哪一档 (站长 / 管理员 / 已验邮箱的成员 / 普通成员); 查不到当最普通那档 */
async function resQuotaTier(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT role, email_verified FROM users WHERE id = ?`
    ).bind(userId).first();
    const role = (row && row.role) || 'user';
    if (role === 'owner') return { key: 'owner', ...RES_QUOTA_TIERS.owner };
    if (role === 'admin') return { key: 'admin', ...RES_QUOTA_TIERS.admin };
    if (row && row.email_verified) return { key: 'member', ...RES_QUOTA_TIERS.member };
  } catch (err) {
    console.warn('读配额档位跳过:', err && (err.message || err.cause) || err);
  }
  return { key: 'user', ...RES_QUOTA_TIERS.user };
}

/* asyfunc 这个人现在还占着多少字节 (口径 = 行还在 + 没过期), 拿行当占空间的代理比去 OSS HEAD 便宜 */
async function peekStorageUsed(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM resource
        WHERE uploader_id = ? AND scope = 'library'
          AND (expires_at IS NULL OR expires_at > ?)`
    ).bind(userId, Date.now()).first();
    return (row && row.bytes) || 0;
  } catch (err) {
    console.warn('读存量占用跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* asyfunc 最近 7 个 UTC 日里传过的总字节 (upload_usage 求和, 与日配额共一张表) */
async function peekWeeklyUsed(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM upload_usage
        WHERE user_id = ? AND day >= date('now', ?)`
    ).bind(userId, `-${RES_WEEKLY_DAYS - 1} day`).first();
    return (row && row.bytes) || 0;
  } catch (err) {
    console.warn('读 7 天用量跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* asyfunc 一次上传前的配额总检查: 返回 { tier } = 放行, 返回 Response = 直接回给调用方 */
async function checkUploadQuota(env, user, size, groupId) {
  const tier = await resQuotaTier(env, user.id);
  /* ① 存量 (主闸): 算上这一次要传的字节 */
  if (tier.storage) {
    const used = await peekStorageUsed(env, user.id);
    if (used + size > tier.storage) {
      return Response.json({
        error: `存储已用 ${sizeText(used)}，上限 ${sizeText(tier.storage)}，放不下这个文件了。删掉一些旧文件再传。`,
        quota: 'storage', used, limit: tier.storage
      }, { status: 429 });
    }
  }
  /* ② 7 天累计 */
  if (tier.weekly) {
    const used = await peekWeeklyUsed(env, user.id);
    if (used + size > tier.weekly) {
      return Response.json({
        error: `最近 ${RES_WEEKLY_DAYS} 天已上传 ${sizeText(used)}，上限 ${sizeText(tier.weekly)}，请过几天再传。`,
        quota: 'weekly', used, limit: tier.weekly
      }, { status: 429 });
    }
  }
  /* ③ 单组文件数 (只在新加到某个已有的组时才有意义) */
  if (tier.groupFiles && Number.isInteger(groupId) && groupId > 0) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM resource WHERE group_id = ?`
    ).bind(groupId).first().catch(() => null);
    if (row && row.n >= tier.groupFiles) {
      return Response.json({
        error: `一个资源组最多 ${tier.groupFiles} 个文件，这一组已经满了。另开一组再传。`,
        quota: 'group', limit: tier.groupFiles
      }, { status: 429 });
    }
  }
  return { tier };
}

/* 站点级开关: 站长「Foraine」页签那几套方案, 表里只存被改过的键 (缺键 = 默认开), 带 30 秒缓存 */
const SITE_FLAG_DEFAULTS = { downlink: 1, quota: 1 };
const SITE_FLAG_KEYS = Object.keys(SITE_FLAG_DEFAULTS);
const SITE_FLAG_TTL_MS = 30 * 1000;
let siteFlagCache = { at: 0, data: null };

// asyfunc 读站点开关 (只存被改过的键, 缺键用默认值)
async function loadSiteFlags(env) {
  if (siteFlagCache.data && Date.now() - siteFlagCache.at < SITE_FLAG_TTL_MS) return siteFlagCache.data;
  const flags = { ...SITE_FLAG_DEFAULTS };
  try {
    const rows = await env.DB.prepare(`SELECT key, value FROM site_flags`).all();
    (rows.results || []).forEach((row) => {
      if (SITE_FLAG_KEYS.indexOf(row.key) >= 0) flags[row.key] = String(row.value) === '0' ? 0 : 1;
    });
  } catch (err) {
    // 表没建或查询失败一律按默认值 (都开着)
    console.warn('读站点开关跳过:', err && (err.message || err.cause) || err);
  }
  siteFlagCache = { at: Date.now(), data: flags };
  return flags;
}

async function setSiteFlag(env, key, on) {
  // asyfunc 改一个站点开关
  if (SITE_FLAG_KEYS.indexOf(key) < 0) return false;
  await env.DB.prepare(
    `INSERT INTO site_flags (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, on ? '1' : '0', Date.now()).run();
  siteFlagCache = { at: 0, data: null };   // 立刻失效
  return true;
}

/* asyfunc 今天传了多少 (日配额那道副闸); limit 可传, 「资源量限制方案」关掉时用旧值 */
async function peekUploadQuota(env, userId, limit) {
  const cap = Number(limit) || RES_DAILY_QUOTA_BYTES;
  try {
    const row = await env.DB.prepare(
      `SELECT bytes FROM upload_usage WHERE user_id = ? AND day = ?`
    ).bind(userId, utcDay()).first();
    const used = (row && row.bytes) || 0;
    return { ok: used < cap, used, limit: cap };
  } catch (err) {
    console.warn('上传配额检查跳过:', err && (err.message || err.cause) || err);
    return { ok: true, used: 0, limit: cap };
  }
}

// asyfunc 记一笔上传用量 (人 + UTC 日 + 字节)
async function addUploadUsage(env, userId, bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (!size) return;
  try {
    await env.DB.prepare(
      `INSERT INTO upload_usage (user_id, day, bytes) VALUES (?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET bytes = bytes + excluded.bytes`
    ).bind(userId, utcDay(), size).run();
  } catch (err) {
    // 记账失败不能连累已经传完的文件
    console.error('上传用量记账失败:', err && (err.message || err.cause) || err);
  }
}

// 服务端提示用的人类可读大小 (前端 formatFileSize 的粗版本)
function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return Math.round(value / 1024 / 1024 / 1024) + ' GB';
  return Math.round(value / 1024 / 1024) + ' MB';
}

// 头像和配图共用的格式表; 不收 SVG (能塞 <script>, 挂在自己域名下等于自找 XSS)
const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

// 站长自查接口能切的桶 (省略 = 头像桶)
const OSS_BUCKETS = {
  avatar: { bucket: OSS_BUCKET, host: OSS_UPLOAD_HOST, publicBase: AVATAR_PUBLIC_BASE, prefix: 'avatar/' },
  image: { bucket: IMG_BUCKET, host: IMG_UPLOAD_HOST, publicBase: IMG_PUBLIC_BASE, prefix: 'img/' },
  resource: { bucket: RES_BUCKET, host: RES_UPLOAD_HOST, publicBase: RES_PUBLIC_BASE, prefix: 'res/' }
};

// OSS 密钥是否配好
function avatarStorageReady(env) {
  return !!(env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET);
}

// ArrayBuffer -> 十六进制串
function hexOf(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* 阿里云 OSS V4 签名 (OSS4-HMAC-SHA256); 三处与 AWS V4 不同, 别凭 AWS 印象改:
   ① 规范请求末尾没有 SignedHeaders 段, ② host 不参与签名, ③ 起始密钥是 'aliyun_v4' + Secret */
async function ossSignedRequest(env, { method, key, body, contentType, bucket, host, query, cacheControl, contentDisposition, signOnly, signHeaders, extraHeaders, canonicalUriStyle, canonicalUri, canonicalQuery }) {
  // query 是排好序并编码过的查询串, 同时进规范请求与真实 URL;
  // canonicalUri / canonicalQuery 是照抄 OSS 回显用的, 只换签名依据, 发出去的请求一个字节不改
  const bucketName = bucket || OSS_BUCKET;
  const endpointHost = host || OSS_UPLOAD_HOST;
  const queryString = query || '';
  const canonicalQueryStr = canonicalQuery || queryString;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260912T120000Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';

  // 对象名按路径分段编码 (斜杠留着当分隔符; 列桶时是空串)
  const encodedKey = String(key || '').split('/').map(encodeURIComponent).join('/');
  /* 规范化 URI 必须带桶名 (/<bucket>/<object>), 漏了就是 403 SignatureDoesNotMatch;
     列桶时尾斜杠留不留由 ossListObjects 的候选表实测 */
  const canonicalUriStr = canonicalUri || (canonicalUriStyle === 'plain'
    ? `/${bucketName}${encodedKey ? '/' + encodedKey : ''}`
    : `/${bucketName}/${encodedKey}`);

  // 要签的头按名字字典序: content-type (有就签) + x-oss-content-sha256 + x-oss-date + signHeaders;
  // 请求里出现的 x-oss-* 头必须全部进签名, 漏签一个就是 403 SignatureDoesNotMatch
  const headerEntries = [];
  if (contentType) headerEntries.push(['content-type', contentType]);
  headerEntries.push(['x-oss-content-sha256', payloadHash]);
  headerEntries.push(['x-oss-date', amzDate]);
  const extraSigned = Object.entries(signHeaders || {});
  extraSigned.forEach(([name, value]) => headerEntries.push([String(name).toLowerCase(), value]));
  const canonicalHeaders = headerEntries
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}:${String(value).trim()}\n`)
    .join('');

  const canonicalRequest = [
    method,
    canonicalUriStr,
    canonicalQueryStr,  // CanonicalQueryString (没参数就是空行)
    canonicalHeaders,   // 每条头自带结尾换行
    '',                 // AdditionalHeaders: 我们没额外声明要签的可选头
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${OSS_REGION}/oss/aliyun_v4_request`;
  const hashedCanonical = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest));
  const stringToSign = `OSS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hexOf(hashedCanonical)}`;

  // 派生签名密钥: kDate / kRegion / kService / kSigning
  let signingKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('aliyun_v4' + env.OSS_ACCESS_KEY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  for (const step of [dateStamp, OSS_REGION, 'oss', 'aliyun_v4_request']) {
    const sig = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(step));
    signingKey = await crypto.subtle.importKey(
      'raw', sig, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
  }
  const signature = hexOf(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(stringToSign)));

  const headers = {
    'x-oss-date': amzDate,
    'x-oss-content-sha256': payloadHash,
    Authorization: `OSS4-HMAC-SHA256 Credential=${env.OSS_ACCESS_KEY_ID}/${scope},Signature=${signature}`
  };
  if (contentType) headers['Content-Type'] = contentType;
  extraSigned.forEach(([name, value]) => { headers[name] = value; });
  /* extraHeaders: 只发不签的头 (Range 这类), 不进签名 */
  Object.entries(extraHeaders || {}).forEach(([name, value]) => { headers[name] = value; });
  /* 长缓存: 对象名带时间戳+随机串, 换图就是换地址; Cache-Control 不进签名, 随便加 */
  if (method === 'PUT' && cacheControl !== null) {
    headers['Cache-Control'] = cacheControl || 'public, max-age=31536000, immutable';
  }
  /* 对象级 Content-Disposition: 直链点开即下载, 文件名可带中文 (RFC 5987 的 filename*); 不进签名 */
  if (method === 'PUT' && contentDisposition) {
    headers['Content-Disposition'] = contentDisposition;
  }

  // 实际请求的路径不带桶名 (桶名在 host 里), 与上面的规范化 URI 不同
  const target = `https://${endpointHost}/${encodedKey}${queryString ? '?' + queryString : ''}`;
  /* signOnly: 只返回该发的请求, 自己不发 (大文件直传用); 调用方必须一个不差地带上这些头 */
  if (signOnly) return { url: target, headers, canonicalRequest };
  return fetch(target, { method, headers, body });
}

/* 把查询参数拼成 OSS 要的样子 (字典序 + 键值编码); 签名与请求必须共用这一个, slashRaw = '/' 不编码 */
function ossQueryString(params, style) {
  const enc = (v) => {
    const s = encodeURIComponent(String(v));
    return style === 'slashRaw' ? s.replace(/%2F/g, '/') : s;
  };
  return Object.keys(params).sort()
    .map(k => `${enc(k)}=${enc(params[k])}`)
    .join('&');
}

/* 列一个前缀下的对象 (ListObjectsV2): 空的查询参数不能发, 否则 403; 兜底是照抄 OSS 回显重签 */
const OSS_LIST_STYLES = [
  { uri: 'slash', query: 'encoded' },   // 正常走这条
  { uri: 'slash', query: 'slashRaw' }   // 值里的 '/' 不编码 (列桶的另一种写法, 见 ossQueryString)
];
let ossListStyleWins = 0;   // 上次试赢的写法下标

// 解析列桶返回的 XML
function ossParseListXml(raw) {
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
    return m ? m[1] : '';
  };
  const contents = Array.from(raw.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)).map(m => ({
    key: tag(m[1], 'Key'),
    size: Number(tag(m[1], 'Size')) || 0,
    lastModified: tag(m[1], 'LastModified')
  }));
  return {
    contents,
    keys: contents.length ? contents.map(c => c.key) : Array.from(raw.matchAll(/<Key>([^<]*)<\/Key>/g)).map(m => m[1]),
    prefixes: Array.from(raw.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)).map(m => tag(m[1], 'Prefix')),
    truncated: /<IsTruncated>true<\/IsTruncated>/.test(raw),
    nextToken: tag(raw, 'NextContinuationToken'),
    count: Number(tag(raw, 'KeyCount')) || contents.length
  };
}

/* 从 SignatureDoesNotMatch 的响应体里抠出 OSS 自己算的规范请求 (第 2 行 URI, 第 3 行查询串) */
function ossCanonicalEcho(raw) {
  const m = /<CanonicalRequest>([\s\S]*?)<\/CanonicalRequest>/.exec(String(raw || ''));
  if (!m) return null;
  const text = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  const lines = text.replace(/\r/g, '').split('\n');
  const uri = String(lines[1] || '').trim();
  if (uri.charAt(0) !== '/') return null;
  return { uri, query: String(lines[2] || '').trim() };
}

/* asyfunc 发一次列桶请求并留下我们算的规范请求; hint 给了 = 照抄 OSS 的回显去签 */
async function ossListAttempt(env, params, opts, style, hint) {
  const visible = {};
  Object.keys(params).forEach((k) => { if (params[k] !== '') visible[k] = params[k]; });
  const signed = await ossSignedRequest(env, {
    method: 'GET',
    key: '',
    query: ossQueryString(visible, style.query),
    canonicalQuery: hint ? hint.query : '',
    canonicalUri: hint ? hint.uri : '',
    canonicalUriStyle: style.uri,
    bucket: opts.bucket,
    host: opts.host,
    signOnly: true
  });
  const res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
  const raw = await res.text().catch(() => '');
  return {
    status: res.status,
    raw,
    params: visible,
    url: signed.url,
    canonical: signed.canonicalRequest,
    ...ossParseListXml(raw)
  };
}

// asyfunc 列桶: 先试上次赢的写法, 再照抄 OSS 回显的规范请求兜底
async function ossListObjects(env, prefix, options) {
  const opts = options || {};
  const params = { 'list-type': '2', 'max-keys': 1000, prefix: prefix || '' };
  if (opts.token) params['continuation-token'] = opts.token;
  if (opts.delimiter) params.delimiter = opts.delimiter;

  // 先试上次赢的那种, 再试另一种写法
  const order = [ossListStyleWins].concat(OSS_LIST_STYLES.map((_, i) => i).filter((i) => i !== ossListStyleWins));
  let last = null;
  for (const idx of order) {
    const style = OSS_LIST_STYLES[idx];
    const got = await ossListAttempt(env, params, opts, style);
    last = { ...got, style: style.query };
    if (got.status < 400) {
      ossListStyleWins = idx;   // 同一个 isolate 后面直接用
      return last;
    }
    if (!/SignatureDoesNotMatch/.test(got.raw)) return last;   // 别的错换写法也没用

    const hint = ossCanonicalEcho(got.raw);
    if (!hint) continue;
    const learned = await ossListAttempt(env, params, opts, style, hint);
    last = { ...learned, style: style.query, echo: hint };
    if (learned.status >= 400) continue;   // 照抄都不行 -> 换下一种写法
    if (hint.uri === '/' + opts.bucket + '/' || hint.uri === '/' + opts.bucket) {
      // 认得出是哪种写法 -> 记下来, 下次直接用
      ossListStyleWins = ossQueryString(learned.params, 'encoded') === hint.query ? 0 : 1;
    } else {
      console.warn('列桶: OSS 请求错误', JSON.stringify(hint));
    }
    // style 报的是「以后会用哪一种」, 不是这一次的 URL 用的那种
    return { ...last, style: OSS_LIST_STYLES[ossListStyleWins].query, learned: true };
  }
  return last;
}

function looksLikeImage(bytes, mime) {
  // 光看 Content-Type 不够, 顺手核一下文件头
  const b = bytes;
  if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/gif') return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  if (mime === 'image/webp') {
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  }
  return false;
}

function avatarObjectKey(username) {
  // 对象名 = avatar/<用户名> 不带扩展名, 换头像必然覆盖; 类型靠 PUT 的 Content-Type
  const slug = String(username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `avatar/${slug.length >= 2 ? slug : 'user'}`;
}

function ossErrorText(status, raw, bucketName) {
  // OSS 出错时会在 XML 里给 Code + Message, 直接捞出来给用户看
  const code = (String(raw).match(/<Code>([^<]+)<\/Code>/) || [])[1];
  const message = (String(raw).match(/<Message>([^<]+)<\/Message>/) || [])[1];
  if (code === 'SignatureDoesNotMatch') return 'OSS 签名校验失败）';
  if (code === 'AccessDenied') return 'AccessKey 没有这项权限';
  if (code === 'NoSuchBucket') return '桶不存在 ' + (bucketName || OSS_BUCKET);
  // 桶建在别的地域时走这条: Message 里会直接给出正确端点
  if (code === 'PermanentRedirect' || code === 'Redirect') {
    return '桶不在这个地域（' + (message || 'OSS 未指定') + '）';
  }
  return [code, message].filter(Boolean).join(': ') || `HTTP ${status}`;
}

function previousAvatarKey(oldUrl, newKey) {
  // 从旧 URL 里抠出对象名 (形如 https://img.foraine.xyz/avatar/xxx.png?v=123)
  if (!oldUrl || oldUrl.indexOf(AVATAR_PUBLIC_BASE) !== 0) return null;
  const path = oldUrl.slice(AVATAR_PUBLIC_BASE.length).split('?')[0].replace(/^\//, '');
  if (!path || path === newKey) return null;
  return path;
}

/* 桶里的垃圾回收: 改文章 / 删号后自动清, 站长接口 ?orphans=1[&apply=1] 扫全桶;
   删之前必须查引用 (同一张图可能被多篇文章 / 草稿用着) */

/* 从正文里抠出本站图床的对象名 (只认自己的域名, 外链不是我们的对象) */
function imageKeysIn(content) {
  const out = [];
  const re = /https?:\/\/img\.foraine\.xyz\/([^\s)"'<>?]+)/g;
  let m;
  while ((m = re.exec(String(content || '')))) {
    let key = m[1];
    try { key = decodeURIComponent(key); } catch (err) { /* 原样用 */ }
    if (key.startsWith('img/') && key.indexOf('..') < 0 && out.indexOf(key) < 0) out.push(key);
  }
  return out;
}

/* 从公开 URL 里抠出对象名 (头像桶那种) */
function keyFromPublicUrl(rawUrl, publicBase, prefix) {
  const raw = String(rawUrl || '');
  if (!raw || raw.indexOf(publicBase) !== 0) return null;
  let key = raw.slice(publicBase.length).split('?')[0].replace(/^\//, '');
  try { key = decodeURIComponent(key); } catch (err) { /* 原样用 */ }
  if (!key.startsWith(prefix) || key.indexOf('..') >= 0) return null;
  return key;
}

/* asyfunc 这个对象还有没有人在用 (删之前必问); 查文章 / 评论 / 聊天 / 表情 / 背景, 少一处就误删 */
async function objectStillReferenced(env, key, which) {
  try {
    if (which === 'image') {
      const like = '%' + IMG_PUBLIC_BASE + '/' + key + '%';
      const article = await env.DB.prepare(
        `SELECT 1 AS ok FROM articles WHERE is_deleted = 0 AND content LIKE ? LIMIT 1`
      ).bind(like).first();
      if (article) return true;
      const comment = await env.DB.prepare(
        `SELECT 1 AS ok FROM comments WHERE is_deleted = 0 AND content LIKE ? LIMIT 1`
      ).bind(like).first();
      if (comment) return true;
      const chat = await env.DB.prepare(
        `SELECT 1 AS ok FROM chats WHERE is_deleted = 0 AND body LIKE ? LIMIT 1`
      ).bind(like).first();
      if (chat) return true;
      const emo = await env.DB.prepare(
        `SELECT 1 AS ok FROM emoji WHERE object_key = ? OR url LIKE ? LIMIT 1`
      ).bind(key, like).first();
      if (emo) return true;
      // 个性化背景也住在 img/user/<用户名>/ 下, 不查会当垃圾删掉
      const bg = await env.DB.prepare(
        `SELECT 1 AS ok FROM profiles WHERE bg_image LIKE ? OR chat_bg LIKE ? LIMIT 1`
      ).bind(like, like).first();
      return !!bg;
    }
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM profiles WHERE avatar_url LIKE ? LIMIT 1`
    ).bind('%' + key + '%').first();
    return !!row;
  } catch (err) {
    // 查不了就当还在用, 宁可留垃圾也不能误删
    console.warn('检查对象引用失败 (当作在用):', err && (err.message || err));
    return true;
  }
}

// asyfunc 删一个对象, 返回 HTTP 状态码
async function deleteObject(env, which, key) {
  const cfg = which === 'resource' ? OSS_BUCKETS.resource
    : (which === 'image' ? OSS_BUCKETS.image : OSS_BUCKETS.avatar);
  const res = await ossSignedRequest(env, { method: 'DELETE', key, bucket: cfg.bucket, host: cfg.host }).catch(() => null);
  return res ? res.status : 0;
}

/* asyfunc 文章改动后: 删掉「旧正文里用、新正文里不用、别处也没用」的图 */
async function cleanupRemovedImages(env, oldContent, newContent) {
  if (!avatarStorageReady(env)) return [];
  const before = imageKeysIn(oldContent);
  if (!before.length) return [];
  const after = imageKeysIn(newContent);
  const removed = [];
  for (const key of before) {
    if (after.indexOf(key) >= 0) continue;
    if (await objectStillReferenced(env, key, 'image')) continue;
    removed.push({ key, status: await deleteObject(env, 'image', key) });
  }
  if (removed.length) console.log('清掉不再引用的配图:', JSON.stringify(removed));
  return removed;
}

/* asyfunc 列全桶找出没人引用的对象, 可选真删 */
async function storageOrphans(env, which, apply) {
  const cfg = which === 'image' ? OSS_BUCKETS.image : OSS_BUCKETS.avatar;
  const prefix = which === 'image' ? 'img/' : 'avatar/';
  const listed = await ossListObjects(env, prefix, { bucket: cfg.bucket, host: cfg.host });
  const report = {
    bucket: cfg.bucket,
    prefix,
    list_status: listed.status,
    listed_count: listed.keys.length,
    // 一次最多 1000 个, 超了要再扫一遍
    truncated: /<IsTruncated>true<\/IsTruncated>/.test(listed.raw),
    orphans: [],
    deleted: []
  };
  if (listed.status >= 400) {
    report.list_error = ossErrorText(listed.status, listed.raw, cfg.bucket);
    return report;
  }

  const refs = new Set();
  if (which === 'image') {
    const arts = await env.DB.prepare(`SELECT content FROM articles WHERE is_deleted = 0`).all();
    (arts.results || []).forEach((row) => imageKeysIn(row.content).forEach((k) => refs.add(k)));
    const cms = await env.DB.prepare(`SELECT content FROM comments WHERE is_deleted = 0`).all();
    (cms.results || []).forEach((row) => imageKeysIn(row.content).forEach((k) => refs.add(k)));
    const msgs = await env.DB.prepare(`SELECT body FROM chats WHERE is_deleted = 0`).all();
    (msgs.results || []).forEach((row) => imageKeysIn(row.body).forEach((k) => refs.add(k)));
    const emos = await env.DB.prepare(`SELECT object_key FROM emoji`).all();
    (emos.results || []).forEach((row) => { if (row.object_key) refs.add(row.object_key); });
  } else {
    const { results } = await env.DB.prepare(`SELECT avatar_url FROM profiles`).all();
    (results || []).forEach((row) => {
      const key = keyFromPublicUrl(row.avatar_url, cfg.publicBase, prefix);
      if (key) refs.add(key);
    });
  }
  report.referenced_count = refs.size;
  report.orphans = listed.keys.filter((k) => !refs.has(k));

  if (apply) {
    for (const key of report.orphans) {
      report.deleted.push({ key, status: await deleteObject(env, which, key) });
    }
    console.log('清理无引用对象:', JSON.stringify(report.deleted));
  }
  return report;
}

/* 资源上传 (foraine-resource 桶 + resource 表): 先登记行再 PUT 字节, 传失败就删行, 过期清理走 cron */
/* 大文件: 只签名 + 登记, 字节由浏览器直接 PUT 给 OSS; 桶上必须配 CORS, 签好的头一个都不能漏 */

/* 下载一个资源 (GET /api/resource/download?id=<resource.id>): Worker 签名代取并压 Content-Disposition */

/* asyfunc 到期清理: 过期的资源连对象带记录一起删 (cron 每天跑一次, 跟注销清理同一趟) */
async function purgeExpiredResources(env, limit) {
  const max = limit || 40; // 一次别删太多, 免得撞上子请求数上限
  try {
    const rows = await env.DB.prepare(
      `SELECT id, object_key FROM resource WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY id ASC LIMIT ?`
    ).bind(Date.now(), max).all();
    const list = rows.results || [];
    let done = 0;
    for (const row of list) {
      const status = await deleteObject(env, 'resource', row.object_key);
      // 对象已经不在了 (404) 也算成功 —— 记录得跟着走
      if (status && status < 300 || status === 404) {
        await env.DB.prepare(`DELETE FROM resource WHERE id = ?`).bind(row.id).run();
        done += 1;
      }
    }
    return done;
  } catch (err) {
    // 还没有 resource 表 -> 当无事发生
    console.warn('清理过期资源跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* asyfunc 聊天图的过期清理: 默认留 7 天, 到期连对象带记录一起删 */
async function purgeExpiredImages(env, limit) {
  const max = limit || 40;
  try {
    const rows = await env.DB.prepare(
      `SELECT id, object_key FROM stored_image WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY id ASC LIMIT ?`
    ).bind(Date.now(), max).all();
    const list = rows.results || [];
    let done = 0;
    for (const row of list) {
      /* 过期不等于没人用: 表情 / 背景 / 文章图都可能指着同一张聊天图, 先问一句引用,
         有人在用就只丢记录 */
      let stillUsed = false;
      try {
        stillUsed = await objectStillReferenced(env, row.object_key, 'image');
      } catch (err) { /* 查不出来就保守当它在用 */ stillUsed = true; }
      if (stillUsed) {
        await env.DB.prepare(`DELETE FROM stored_image WHERE id = ?`).bind(row.id).run();
        done += 1;
        continue;
      }
      const status = await deleteObject(env, 'image', row.object_key);
      // 对象已经不在了 (404) 也算成功 —— 记录得跟着走
      if ((status && status < 300) || status === 404) {
        await env.DB.prepare(`DELETE FROM stored_image WHERE id = ?`).bind(row.id).run();
        done += 1;
      }
    }
    return done;
  } catch (err) {
    // 还没建 stored_image 表 -> 当无事发生
    console.warn('清理过期聊天图跳过:', err && (err.message || err.cause) || err);
    return 0;
  }
}

/* asyfunc 评论被删后清掉正文里「别处也没人用」的图; 必须在删评论行之前把 key 抠出来 */
async function cleanupCommentImages(env, keys) {
  if (!avatarStorageReady(env) || !keys || !keys.length) return [];
  const removed = [];
  for (const key of keys) {
    if (await objectStillReferenced(env, key, 'image')) continue;
    removed.push({ key, status: await deleteObject(env, 'image', key) });
  }
  if (removed.length) console.log('清掉评论里不再引用的图:', JSON.stringify(removed));
  return removed;
}

/* 私聊的附件 / 引用: chats.body 要么是纯文本, 要么是 {"t":"image"/"file"/"quote",…} 的 JSON;
   引用是快照 (被引用的那条撤回也不变), 服务端读文字得走 chatBodyText() */
const CHAT_QUOTE_TEXT_MAX = 120;  // 引用条里那行「被引用的话」最多多长
const CHAT_QUOTE_NAME_MAX = 40;

function parseChatBody(body) {
  const raw = String(body || '');
  if (raw.charAt(0) !== '{') return null;
  try {
    const data = JSON.parse(raw);
    if (!data) return null;
    // 引用: 只有文字 + 一个快照名字, 没有 URL 要校验
    if (data.t === 'quote') {
      const quoted = String(data.text || '').slice(0, CHAT_QUOTE_TEXT_MAX);
      const mine = String(data.body || '').slice(0, CHAT_BODY_MAX);
      if (!quoted && !mine) return null;
      return {
        t: 'quote',
        name: String(data.name || '').slice(0, CHAT_QUOTE_NAME_MAX),
        text: quoted,
        body: mine
      };
    }
    if (data.t !== 'image' && data.t !== 'file') return null;
    const url = String(data.url || '');
    if (!url) return null;
    // 只认自己桶里的东西, 外链当普通文字
    const okHost = data.t === 'image' ? url.indexOf(IMG_PUBLIC_BASE + '/') === 0 : url.indexOf(RES_PUBLIC_BASE + '/') === 0;
    if (!okHost) return null;
    return {
      t: data.t,
      url,
      name: String(data.name || '').slice(0, 120),
      size: Number.isFinite(data.size) ? Math.max(0, Math.floor(data.size)) : 0
    };
  } catch (err) {
    return null;
  }
}

// 会话列表那一行的预览文案, 必须与前端 chatPreviewTextClient() 逐字一致
function chatPreviewText(body) {
  const att = parseChatBody(body);
  if (!att) return String(body || '');
  if (att.t === 'image') return '[图片]';
  if (att.t === 'quote') return '[引用] ' + (att.body || att.text || '');
  return '[文件] ' + (att.name || '未命名');
}

/* 一次性迁移: 把旧 foraine-avatar 桶的头像搬进配图桶的 avatar/ 前缀 (站长在浏览器里跑) */

/* 密码重置 */
/* 两条路: ① 自助 (验证过邮箱的人走邮件链接)  ② 托站长 (提交哈希后的新密码, 全程无明文) */
const PASSWORD_MIN = 6;

// 校验新密码的长度
function checkPasswordRule(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 个字符` };
  if (value.length > 200) return { ok: false, error: '密码太长了' };
  return { ok: true, value };
}

// asyfunc 重设密码, 返回新的 hash 与 salt
async function setUserPassword(env, userId, password) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`)
    .bind(hash, salt, userId).run();
  return { hash, salt };
}

// 改密只能走申请制: 申请人自己写好加密后的新密码, 站长只负责点「同意」
// (见 handleAdminApprovePassword; 站长直接给人设密码等于能冒充任何人)

/* 站内信 */
/* 两条来源: 系统通知 (from_user_id 为 NULL) 与用户互发 (kind = 'user') */

const NOTICE_TITLE_MAX = 60;
const NOTICE_BODY_MAX = 600;

// asyfunc 发一封站内信
async function sendNotice(env, toUserId, { kind = 'system', title, body, fromUserId = null, articleId = null, commentId = null }) {
  if (!toUserId) return;
  try {
    await env.DB.prepare(
      `INSERT INTO notices (to_user_id, from_user_id, kind, title, body, article_id, comment_id, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).bind(
      toUserId, fromUserId, kind,
      String(title || '').slice(0, NOTICE_TITLE_MAX),
      String(body || '').slice(0, NOTICE_BODY_MAX),
      articleId || null, commentId || null,
      Date.now()
    ).run();
  } catch (err) {
    // 写失败绝不连累主流程 (比如文章已经删掉了)
    console.error('写站内信失败:', err);
  }
}

// asyfunc 未读站内信数
async function countUnreadNotices(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notices WHERE to_user_id = ? AND read_at IS NULL`
    ).bind(userId).first();
    return row ? row.count : 0;
  } catch (err) {
    return 0;
  }
}

// asyfunc 未读私信数
async function countUnreadChats(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM chats WHERE to_user_id = ? AND read_at IS NULL`
    ).bind(userId).first();
    return row ? row.count : 0;
  } catch (err) {
    return 0;
  }
}

/* 关注 (追随者): follows 一行 = 「A 关注了 B」; 计数公开, 「你有没有关注他」只给本人看 */
async function followStats(env, userId, viewerId) {
  const [followers, following] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM follows WHERE followee_id = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?`).bind(userId).first()
  ]);
  let isFollowing = false;
  if (viewerId && viewerId !== userId) {
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM follows WHERE follower_id = ? AND followee_id = ?`
    ).bind(viewerId, userId).first();
    isFollowing = !!row;
  }
  return {
    followers: followers ? followers.count : 0,
    following: following ? following.count : 0,
    is_following: isFollowing,
    is_self: !!viewerId && viewerId === userId
  };
}

/* 私聊: 只有「两个人和一条线程」, 没有群聊与推送; 打开时拉最近 200 条, 之后前端每 5 秒轮询 */
const CHAT_BODY_MAX = 600;
const CHAT_PAGE_MAX = 200;

/* 表情包: 对象落在 img/<用户名>/emoji/…; 列表走 emoji 登记表而不列桶 (RAM 里没给 ListObjects) */
const EMOJI_MAX = 120;          // 每人上限
const EMOJI_UPLOAD_LIMIT = 40;  // 每小时上限

// asyfunc 按用户名找对方 (昵称兜底)
async function findPeer(env, username) {
  return await env.DB.prepare(
    `SELECT u.id, u.username, COALESCE(p.nickname, u.username) AS nickname, p.avatar_url
     FROM users u LEFT JOIN profiles p ON p.user_id = u.id
     WHERE LOWER(u.username) = LOWER(?)`
  ).bind(username).first();
}

/* 撤回 / 删除 / 另存为: 撤回 = 双方都消失 (软删, 5 分钟内)、删除 = 只删自己这边 (不进服务端) */
const CHAT_RECALL_MS = 5 * 60 * 1000;
// 增量轮询回看被撤回消息的窗口, 比 5 分钟长一点, 让网络慢的一方也不漏
const CHAT_RECALL_WINDOW_MS = 10 * 60 * 1000;

/* 「另存为」的图片代理 (GET /api/chat/media?id=<消息 id>): 跨域的 <a download> 会被忽略,
   所以由 Worker 代取; 必须先确认消息在双方之间 */

/* 封禁 / 审核留痕 */

const MOD_REASON_MAX = 300;

async function isBanned(env, userId) {
  // 返回 null (没封) 或 { reason, until }; until 为 null 表示永久封禁
  if (!userId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT reason, until FROM bans WHERE user_id = ?`
    ).bind(userId).first();
    if (!row) return null;
    if (row.until && row.until <= Date.now()) {
      // 到期就直接清掉, 免得每次都要判一遍 (到期本身就是安静地过去)
      await env.DB.prepare(`DELETE FROM bans WHERE user_id = ?`).bind(userId).run();
      return null;
    }
    return { reason: row.reason || '', until: row.until || null };
  } catch (err) {
    // 表还没建或出错一律当未封禁
    console.warn('读取封禁状态失败 (按未封禁处理):', err && (err.message || err) || err);
    return null;
  }
}

// asyfunc 记一行管理日志
async function logModeration(env, { action, targetUser = null, articleId = null, reason = '', byUserId = null }) {
  try {
    await env.DB.prepare(
      `INSERT INTO moderation_log (action, target_user, article_id, reason, by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      action, targetUser, articleId,
      String(reason || '').slice(0, MOD_REASON_MAX),
      byUserId, Date.now()
    ).run();
  } catch (err) {
    console.error('写管理日志失败:', err);
  }
}

// asyfunc 所有站长的 id
async function ownerUserIdList(env) {
  try {
    const rows = await env.DB.prepare(`SELECT id FROM users WHERE role = 'owner'`).all();
    return (rows.results || []).map(r => r.id);
  } catch (err) {
    return [];
  }
}

// 操作者的显示名
function actorName(user) {
  return user.nickname || user.username || '管理员';
}

/* D1 控制台 (仅站长): 单条语句无注释, 读走白名单, 写要 write:true + 'RUN', 密钥类字段打码 */
const D1_ROW_MAX = 200;
/* 「行数: 最大」那一档的上限; 不能真不限 (响应要过内存 / 带宽, 还要一次画进 DOM) */
const D1_ROW_HARD_MAX = 5000;
const D1_READ_FIRST = /^\s*(select|with|pragma|explain|values)\b/i;
const D1_WRITE_WORDS = /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|reindex|attach|detach|grant|revoke|begin|commit|rollback)\b/i;
const D1_MASK_COLUMNS = ['password_hash', 'salt', 'token', 'secret', 'password', 'digest'];
const D1_WRITE_CONFIRM = 'RUN';   // 写操作口令 (d1-console.js 同名)
const D1_WRITE_PER_MIN = 30;      // 写操作单独限流

// 把字符串字面量抠掉再检查关键字: 不然 'article.delete' 这种值会把查询误判成写操作
function stripSqlLiterals(sql) {
  return String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

// 只读白名单 + 写操作识别
function d1Guard(rawSql) {
  const text = String(rawSql || '').trim();
  if (!text) return { error: 'SQL 不能为空' };
  if (/--|\/\*/.test(text)) return { error: '不支持 SQL 注释（-- 与 /* */）' };
  const body = text.replace(/;\s*$/, '');
  if (body.includes(';')) return { error: '一次只能执行一条语句' };
  const bare = stripSqlLiterals(body);
  // 抠掉字面量后出现写关键字就算 (WITH … DELETE 也跑不掉)
  if (D1_WRITE_WORDS.test(bare)) return { sql: body, write: true };
  if (!D1_READ_FIRST.test(body)) {
    return { error: '不支持的语句：只读时只能 SELECT / WITH / PRAGMA / EXPLAIN' };
  }
  return { sql: body, write: false };
}

// 密钥类列打码
function d1MaskRows(columns, rows) {
  const masked = [];
  columns.forEach((col, i) => {
    if (D1_MASK_COLUMNS.includes(String(col).toLowerCase())) masked.push(i);
  });
  if (!masked.length) return rows;
  return rows.map((row) => row.map((v, i) => (masked.includes(i) && v !== null ? '•••' : v)));
}


/* 改用户的 id: 主键散在十几张表里, 集中列成下面的表 (加新表必须补进来); 搬完要抬 AUTOINCREMENT */
const USER_ID_REFS = [
  ['profiles', 'user_id'],
  ['sessions', 'user_id'],
  ['articles', 'user_id'],
  ['comments', 'user_id'],
  ['chats', 'from_user_id'],
  ['chats', 'to_user_id'],
  ['follows', 'follower_id'],
  ['follows', 'followee_id'],
  ['notices', 'to_user_id'],
  ['notices', 'from_user_id'],
  ['emoji', 'user_id'],
  ['resource', 'uploader_id'],
  ['stored_image', 'user_id'],
  ['bans', 'user_id'],
  ['bans', 'by_user_id'],
  ['moderation_log', 'target_user'],
  ['moderation_log', 'by_user_id'],
  ['password_requests', 'user_id'],
  ['email_tokens', 'user_id']
];

// asyfunc 把用户主键从 from 搬到 to, 返回改过的行数
async function remapUserId(env, from, to) {
  const user = await env.DB.prepare(`SELECT id, username FROM users WHERE id = ?`).bind(from).first();
  if (!user) return { error: '没找到这个用户' };
  const clash = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`).bind(to).first()
    .catch(() => null);
  if (clash) return { error: '目标 id 的用户已存在', username: clash.username };

  const updated = {};
  // 逐条来 (某张表在旧库可能还不存在, 一条失败不该把整批带走)
  for (const [table, col] of USER_ID_REFS) {
    try {
      const res = await env.DB.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`)
        .bind(to, from).run();
      const n = (res.meta && res.meta.changes) || 0;
      if (n) updated[table + '.' + col] = n;
    } catch (err) { /* 没这张表就算了 */ }
  }
  await env.DB.prepare(`UPDATE users SET id = ? WHERE id = ?`).bind(to, from).run();
  await env.DB.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'users' AND seq < ?`)
    .bind(to, to).run().catch(() => { /* 没有 sqlite_sequence 就算了 */ });
  return { ok: true, user, updated };
}


export { ARTICLE_CONTENT_MAX, CHAT_IMAGE_TTL_MS, cleanupCommentImages, purgeExpiredImages, purgeRateLimits, ARTICLE_INTRO_MAX, ARTICLE_TITLE_MAX, AVATAR_MAX_BYTES, AVATAR_PUBLIC_BASE, CHAT_BODY_MAX, CHAT_PAGE_MAX, CHAT_QUOTE_NAME_MAX, CHAT_QUOTE_TEXT_MAX, CHAT_RECALL_MS, CHAT_RECALL_WINDOW_MS, COMMENT_MAX, D1_MASK_COLUMNS, D1_READ_FIRST, D1_ROW_HARD_MAX, D1_ROW_MAX, D1_WRITE_CONFIRM, D1_WRITE_PER_MIN, D1_WRITE_WORDS, DEFAULT_DESC, DELETED_AUTHOR, DELETE_CODE_TTL, DELETE_GRACE_MS, EMAIL_MAX, EMAIL_TOKEN_TTL, EMOJI_MAX, EMOJI_UPLOAD_LIMIT, emailVerified, FONT_VALUES, GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, IMAGE_TYPES, IMG_BUCKET, IMG_MAX_BYTES, IMG_PUBLIC_BASE, IMG_UPLOAD_HOST, IMG_UPLOAD_LIMIT, MAIL_API, MAIL_LIMIT, MOD_REASON_MAX, NOTICE_BODY_MAX, NOTICE_TITLE_MAX, OAUTH_PASSWORD_PREFIX, OAUTH_STATE_COOKIE, OSS_BUCKET, OSS_BUCKETS, OSS_REGION, OSS_UPLOAD_HOST, PAGE_META, PASSWORD_MIN, PROFILE_BIO_MAX, PROFILE_IMAGE_URL_MAX, PROFILE_NICKNAME_MAX, PROFILE_OTHER_MAX, READING_CJK_PER_MIN, READING_WORD_PER_MIN, RESOURCE_TYPES, RESOURCE_KINDS, RESOURCE_KIND_LABELS, RES_BUCKET, RES_MAX_BYTES, RES_PUBLIC_BASE, RES_TTL_MS, RES_UPLOAD_HOST, RES_BATCH_MAX_BYTES, RES_DAILY_QUOTA_BYTES, RES_QUOTA_TIERS, RES_WEEKLY_DAYS, DL_CONCURRENCY, RES_NOTIFY_BATCH_BYTES, RES_NOTIFY_BIG_BYTES, RES_AUTO_GUARD_BYTES, SITE_FLAG_DEFAULTS, RES_QUOTA_LEGACY_DAILY_BYTES, loadSiteFlags, setSiteFlag, DL_SLOT_TTL_MS, resQuotaTier, peekStorageUsed, peekWeeklyUsed, checkUploadQuota, dlActiveCount, dlTakeSlot, dlReleaseSlot, logDownload, SITE_NAME, SITE_ORIGIN, suggestLang, TAGS_MAX, USERNAME_RE, USERNAME_RESERVED, USER_ID_REFS, actorName, attachTags, avatarObjectKey, avatarStorageReady, buildMetaTags, bytesToHex, canOpenEditor, chatPreviewText, checkPasswordRule, checkRateLimit, checkUsername, cleanupRemovedImages, clearStateCookie, clientIp, commentAncestorChain, commentHasLiveDescendant, countUnreadChats, countUnreadNotices, createEmailToken, createSession, createSessionCookie, d1Guard, d1MaskRows, deleteObject, describeResendError, emailTakenByOther, encoder, escapeAttr, extFromFilename, resourceKindExtensions, peekUploadQuota, addUploadUsage, sizeText, findPeer, followStats, geoCache, getSessionUser, githubCallbackUrl, githubConfigured, hardDeleteUser, hasPassword, hasPermission, hashPassword, hexOf, hexToBytes, hitRateLimit, imageKeysIn, injectPageMeta, isBanned, isPageRequest, isValidEmail, consumeVerifyPass, issueVerifyPass, keyFromPublicUrl, loadDeleteCooldown, loadEmailState, loadPendingDeletion, loadPermissions, loadPublicUser, loadUserGroup, loadSessionUser, logModeration, looksLikeImage, mailConfigured, makeSummary, normalizePath, normalizeTags, notifyIndexNow, objectStillReferenced, ogImage, ossErrorText, ossCanonicalEcho, ossListObjects, ossQueryString, ossSignedRequest, ownerUserIdList, parseChatBody, parseCookies, peekRateLimit, pingIndexNow, previousAvatarKey, pruneDeadAncestors, purgeComment, purgeExpiredResources, purgePendingDeletions, randomHex, readBlur, readFont, readImageUrl, readingTimeText, redirectTo, remapUserId, retryText, reverseGeocode, saveTags, sendMail, sendNotice, serveAccessDenied, serveNotFound, setUserPassword, storageOrphans, stripSqlLiterals, verifyUserPassword, withoutEncoding };
