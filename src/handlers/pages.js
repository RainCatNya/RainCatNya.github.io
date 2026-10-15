// handlers/pages.js —— 对应的一批接口处理器。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。

import { SITE_ORIGIN, getSessionUser, hasPermission, loadPermissions } from '../common.js';


async function handleSitemap(request, env) {
  // 静态页 + 已发布文章
  const staticPaths = ['/', '/articles/'];
  let rows = [];
  try {
    const result = await env.DB.prepare(
      // 叙述 (narra) 对外隐藏, 不进 sitemap
      `SELECT id, updated_at FROM articles WHERE status = 'published' AND is_deleted = 0 AND narra = 0 ORDER BY created_at DESC`
    ).all();
    rows = result.results || [];
  } catch (err) {
    console.warn('生成 sitemap 失败 (降级为只列静态页):', err);
  }

  const urls = staticPaths.map(p => ({ loc: SITE_ORIGIN + p, lastmod: null }));
  rows.forEach(r => {
    urls.push({
      loc: SITE_ORIGIN + '/article/?id=' + r.id,
      lastmod: r.updated_at ? new Date(Number(r.updated_at)).toISOString().slice(0, 10) : null
    });
  });

  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => '  <url><loc>' + u.loc + '</loc>' +
      (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') + '</url>').join('\n') +
    '\n</urlset>\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600'
    }
  });
}


const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const CF_ACCOUNT_ID = '1d9ea8111f031b7e8b085f35d2135a1b';
const D1_DATABASE_ID = '4b212cea-af1a-4663-aba3-54df8bd418c6';

/* 访客统计: 数据源是 Cloudflare 站级分析 (zone 的 httpRequests1dGroups) +
   站长额外看 D1 用量 (账号级 d1AnalyticsAdaptiveGroups)。

   所以先要一年: 套餐 / 令牌不给这么长的区间时 CF 会报错 (不是截断), 按 STATS_RANGE_TRIES
   逐档退, 退到哪档就用哪档, 前端只显示实际拿到的天数。
   数据集只吃「日期」(YYYY-MM-DD), 给 ISO 时间戳会报 date format 错。
   两块各自独立: D1 用量是账号级数据集、访问是站级 —— 令牌只授了一边时, 另一边会报
   not authorized, 但不能因此把好的那块也吞掉。
   D1 用量只在站长的请求里查、也只回给站长 (省掉访客那次子请求)。 */
const STATS_RANGE_TRIES = [365, 90, 30];

/* 必须按 zoneTag 锁定, 不能像以前那样取 `zones[0]` —— 这个令牌能看到 3 个 zone,
   zones[0] 抽到的是流量最少的那个, 于是面板上是 24h 10.19k 请求 / 113 人, 我们只拿到
   12 天 26 人 / 135 请求 (差两个量级)。三个 zone 的 24h 量:
     290ee3f4327e5f136c6dfe7bfd7e5972 -> 6 请求 / 6 人   (以前拿的就是它)
     76567bfe77b260b911447c2b42cac71b -> 6 请求 / 5 人
     c057c1aa8bdfcb7ffa5aef78f967105d -> 5151 请求 / 80 人 (foraine.xyz 是这个)
   Zone 类型上没有 name 字段, 只能比 zoneTag, 所以只能写死这个 id;
   换了域名 / 重建 zone 会换 tag, 那时 /api/stats 的 zones_seen 诊断 (只回给站长) 能看出该改成谁。 */
const FORAINE_ZONE_TAG = 'c057c1aa8bdfcb7ffa5aef78f967105d';

/* D1 用量那个数据集有硬性区间上限: 实测报 `cannot request a time range wider than 4w4d`
   (4 周 4 天 = 32 天)。写 31 而不是 32: date_geq 是「从那天 00:00 起」, 实际跨度 =
   31 天 + 今天已过的时分秒, 写 32 就会刚好超出一点点 (实测差 35 分钟被拒)。
   访问那一边没有这个限制, 所以两边区间可能不一样长 —— 各自按自己的上限拿。 */
const D1_RANGE_MAX_DAYS = 31;

function dayString(offsetDays) {
  return new Date(Date.now() - offsetDays * 86400e3).toISOString().slice(0, 10);
}

async function cfGraphql(token, query) {
  try {
    const res = await fetch(CF_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ query })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errors) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || ('CF 返回 ' + res.status);
      return { error: msg };
    }
    return { data: data.data || {} };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

// 站长判定（统计页对所有人开放，但 D1 用量 / 诊断只回给站长）
async function isOwnerRequest(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return false;
  const perms = await loadPermissions(env, user.id);
  return hasPermission(perms, 'dev.access');
}

async function handleStats(request, env) {
  const token = env.CF_API_TOKEN;
  if (!token) return Response.json({ error: '统计服务暂时不可用' }, { status: 503 });

  // ① 站级：逐档试区间，拿到最长的那份
  const dayTo = dayString(0);
  let groups = [];
  let usedDays = 0;
  let lastError = '';
  for (const days of STATS_RANGE_TRIES) {
    const dayFrom = dayString(days);
    const res = await cfGraphql(token, `{
      viewer {
        zones(filter: { zoneTag: "${FORAINE_ZONE_TAG}" }) {
          zoneTag
          httpRequests1dGroups(filter: { date_geq: "${dayFrom}", date_leq: "${dayTo}" }, limit: 400, orderBy: [date_ASC]) {
            dimensions { date }
            uniq { uniques }
            sum { requests countryMap { clientCountryName requests } }
          }
        }
      }
    }`);
    if (res.error) { lastError = res.error; continue; }
    const zone = ((res.data.viewer && res.data.viewer.zones) || [])[0];
    if (!zone) { lastError = '这个令牌看不到 zone ' + FORAINE_ZONE_TAG + '（可能要重新授权）'; continue; }
    groups = zone.httpRequests1dGroups || [];
    usedDays = days;
    break;
  }

  /* 诊断: 这个令牌到底能看到哪几个 zone, 各自 24 小时有多少量 (只回给站长)。
     当初就是靠它查出「取 zones[0]」拿错了 zone; 确认完以后可以删 (多一次子请求)。 */
  let zonesSeen = null;
  if (await isOwnerRequest(request, env)) {
    const res = await cfGraphql(token, `{
      viewer {
        zones {
          zoneTag
          httpRequests1dGroups(filter: { date_geq: "${dayTo}", date_leq: "${dayTo}" }, limit: 5) {
            sum { requests }
            uniq { uniques }
          }
        }
      }
    }`);
    const list = (!res.error && res.data.viewer && res.data.viewer.zones) || [];
    zonesSeen = res.error ? [{ zoneTag: 'error', error: res.error }]
      : list.map((z) => {
        const g = (z.httpRequests1dGroups || [])[0] || {};
        return { zoneTag: z.zoneTag, requests: (g.sum && g.sum.requests) || 0, uniques: (g.uniq && g.uniq.uniques) || 0 };
      });
  }
  if (!usedDays) {
    console.error('访客统计查询失败:', lastError);
    return Response.json({ error: '统计服务暂时不可用' }, { status: 502 });
  }

  let uniques = 0;
  let requests = 0;
  const countryCount = {};
  const series = groups.map((g) => {
    const u = (g.uniq && g.uniq.uniques) || 0;
    const r = (g.sum && g.sum.requests) || 0;
    uniques += u;   // 按天累加: 同一个人隔天再来会算两次 (数据集只到「天」这一档)
    requests += r;
    ((g.sum && g.sum.countryMap) || []).forEach((c) => {
      const k = c.clientCountryName || '未知';
      countryCount[k] = (countryCount[k] || 0) + (c.requests || 0);
    });
    return { date: (g.dimensions && g.dimensions.date) || '', uniques: u, requests: r };
  });

  const countries = Object.keys(countryCount)
    .map((code) => ({ code, requests: countryCount[code] }))
    .sort((a, b) => b.requests - a.requests);

  const first = series[0] ? series[0].date : dayTo;
  const last = series.length ? series[series.length - 1].date : dayTo;

  // ② 账号级：D1 用量（只有站长看得到）
  let d1 = null;
  let d1Error = '';
  if (await isOwnerRequest(request, env)) {
    const d1DayFrom = dayString(Math.min(usedDays, D1_RANGE_MAX_DAYS));
    const res = await cfGraphql(token, `{
      viewer {
        accounts(filter: { accountTag: "${CF_ACCOUNT_ID}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { databaseId: "${D1_DATABASE_ID}", date_geq: "${d1DayFrom}", date_leq: "${dayTo}" },
            orderBy: [date_ASC],
            limit: 10000
          ) {
            dimensions { date }
            count
            sum { rowsRead rowsWritten }
          }
        }
      }
    }`);
    if (res.error) {
      d1Error = res.error;
    } else {
      const accounts = (res.data.viewer && res.data.viewer.accounts) || [];
      const rows = ((accounts[0] && accounts[0].d1AnalyticsAdaptiveGroups) || []).map((g) => ({
        date: (g.dimensions && g.dimensions.date) || '',
        queries: g.count || 0,
        rowsRead: (g.sum && g.sum.rowsRead) || 0,
        rowsWritten: (g.sum && g.sum.rowsWritten) || 0
      }));
      const totals = rows.reduce((acc, r) => ({
        queries: acc.queries + r.queries,
        rowsRead: acc.rowsRead + r.rowsRead,
        rowsWritten: acc.rowsWritten + r.rowsWritten
      }), { queries: 0, rowsRead: 0, rowsWritten: 0 });
      d1 = { series: rows, totals, days: rows.length };
    }
  }

  return Response.json(
    {
      ok: true,
      days: series.length,
      range: { from: first, to: last },
      uniques,
      requests,
      series,
      countries,
      d1,
      d1_error: d1Error,
      zones_seen: zonesSeen
    },
    { headers: { 'Cache-Control': 'public, max-age=600' } }
  );
}


/* 「首页下雨」要的天气。定位用 Cloudflare 给的经纬度 (不弹浏览器授权框),
   天气用 Open-Meteo (免费、不要 key, 边缘缓存 10 分钟)。
   查不到就什么都不给 —— 前端按时段表自己定, 反正最少也是小雨。 */
const RAIN_TIERS = [0.75, 1.15, 1.75, 2.60];   // 小 / 中 / 大 / 暴雨 -> 雨量倍率

// WMO 天气代码 -> 四档中的哪一档 (不下雨的名字也叫「小雨」)
function rainTier(code) {
  const c = Number(code) || 0;
  if (c >= 95) return 3;                       // 雷暴
  if (c >= 80) return 2;                       // 阵雨
  if (c >= 61 && c <= 67) return c === 63 || c === 65 ? 2 : 1;
  return 0;                                    // 毛毛雨 / 晴 / 阴
}

async function handleRain(request, env, url) {
  const cf = request.cf || {};
  const lat = cf.latitude || url.searchParams.get('lat');
  const lon = cf.longitude || url.searchParams.get('lon');
  if (!lat || !lon) return Response.json({ ok: false, reason: 'no-geo' });

  const api = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=weather_code,precipitation,wind_speed_10m,is_day&timezone=auto';
  try {
    const res = await fetch(api, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const cur = data.current || {};
    const precip = Number(cur.precipitation) || 0;
    const wind = Number(cur.wind_speed_10m) || 0;
    return Response.json({
      ok: true,
      city: cf.city || null,
      code: cur.weather_code,
      day: cur.is_day === 1,
      // 雨量: 按档位, 再按当前降水量微调 (下得越猛越密)
      intensity: RAIN_TIERS[rainTier(cur.weather_code)] * (1 + Math.min(precip, 8) / 20),
      // 风: 5~20 度 (用户定的范围), 风越大越斜
      angle: Math.max(5, Math.min(20, 5 + wind * 0.55))
    });
  } catch (err) {
    console.warn('查天气失败, 前端会按时段来:', (err && err.message) || err);
    return Response.json({ ok: false, reason: 'weather-failed' });
  }
}

export { handleSitemap, handleStats, handleRain };
