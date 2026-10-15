// handlers/site.js —— 站点级开关（2026-09-17）。
// 站长个人页「Foraine」页签里那两个 Toggle: 下行流量方案 / 资源量限制方案。
// 开关本身只存一个 0/1（表 site_flags, 键与默认值在 common.js 的 SITE_FLAG_DEFAULTS）——
// **具体方案在哪生效**才是重点: 见 handlers/resource.js 里 loadSiteFlags() 的几处判断。
// ⚠️ 关掉 = 完全回到之前的样子（不拦、不记、不通知），不是「换个更松的档位」。

import { SITE_FLAG_DEFAULTS, checkRateLimit, getSessionUser, hasPermission, loadPermissions, loadSiteFlags, retryText, setSiteFlag, suggestLang } from '../common.js';

const SITE_FLAG_KEYS = Object.keys(SITE_FLAG_DEFAULTS);


/* asyfunc 按 IP 猜语言 (给 i18n 的首屏兜底): GET /api/lang */
async function handleLangSuggest(request, env) {
  const country = (request && request.cf && request.cf.country) || '';
  return Response.json({ country, lang: suggestLang(request) });
}

async function handleSiteFlagsGet(request, env) {
  // 读两个开关: GET /api/site/flags —— 谁能读都行（页面要靠它画开关, 页签本身只有站长看得到）
  try {
    const flags = await loadSiteFlags(env);
    return Response.json({ ok: true, flags });
  } catch (err) {
    console.error('读站点开关失败:', err);
    return Response.json({ ok: true, flags: { ...SITE_FLAG_DEFAULTS } });
  }
}


async function handleSiteFlagsSet(request, env) {
  // 切一个开关: POST /api/site/flags {key, on} —— 仅站长
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload) return Response.json({ error: '无效的请求' }, { status: 400 });
  const key = String(payload.key || '');
  if (SITE_FLAG_KEYS.indexOf(key) < 0) return Response.json({ error: '没有这个开关' }, { status: 400 });
  const on = payload.on === true || payload.on === 1 || payload.on === '1';

  // 站长专用: 判据与防盗 / 公开编辑那套一致（permissions 里有 '*'）
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.site')) return Response.json({ error: '只有站长能改这个' }, { status: 403 });

  // 防手滑连点与脚本刷: 15 分钟 60 次足够了
  const limited = await checkRateLimit(env, `site-flag:${user.id}`, 60, 15 * 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `切换过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  try {
    await setSiteFlag(env, key, on);
    return Response.json({ ok: true, key, on: on ? 1 : 0 });
  } catch (err) {
    console.error('写站点开关失败:', err);
    return Response.json({ error: '站点开关表还没建（见 schema.sql 的 site_flags）' }, { status: 500 });
  }
}


export { handleLangSuggest, handleSiteFlagsGet, handleSiteFlagsSet };
