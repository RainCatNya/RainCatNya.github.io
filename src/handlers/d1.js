// handlers/d1.js —— 对应的一批接口处理器。
// 从 src/handlers.js 按域拆出; 基础设施与常量在 ../common.js。

import { D1_ROW_HARD_MAX, D1_ROW_MAX, D1_WRITE_CONFIRM, D1_WRITE_PER_MIN, checkRateLimit, d1Guard, d1MaskRows, getSessionUser, hasPermission, loadPermissions, retryText, stripSqlLiterals } from '../common.js';

const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const D1_DATABASE_ID = '4b212cea-af1a-4663-aba3-54df8bd418c6';
const CF_ACCOUNT_ID = '1d9ea8111f031b7e8b085f35d2135a1b';


async function handleD1Tables(request, env) {
  // 所有表 + 每张表的列 (PRAGMA 一次批量问完)
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.d1')) return Response.json({ error: '仅站长可看' }, { status: 403 });

  try {
    const listed = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
    ).all();
    const names = (listed.results || []).map(r => r.name);
    if (!names.length) return Response.json({ tables: [] });

    let info = [];
    try {
      info = await env.DB.batch(names.map(n => env.DB.prepare(`PRAGMA table_info("${String(n).replace(/"/g, '""')}")`)));
    } catch (err) {
      console.warn('PRAGMA 批量取列失败:', err && (err.message || err));
    }

    const tables = names.map((name, i) => {
      const cols = (info[i] && info[i].results) || [];
      return {
        name,
        columns: cols.map(c => ({
          name: c.name,
          type: c.type || '',
          pk: !!c.pk,
          notnull: !!c.notnull,
          // 默认值: 「设为主键」要重建整张表, 列的 DEFAULT 得原样拄回去 (PRAGMA 给的就是 SQL 原文)
          dflt: (c.dflt_value === undefined || c.dflt_value === null) ? null : String(c.dflt_value)
        }))
      };
    });
    return Response.json({ tables });
  } catch (err) {
    console.error('读取表清单失败:', err);
    return Response.json({ error: '读取失败' }, { status: 500 });
  }
}


async function handleD1Query(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.d1')) return Response.json({ error: '仅站长可操作' }, { status: 403 });

  const limited = await checkRateLimit(env, `d1:${user.id}`, 120, 60 * 1000);
  if (!limited.ok) {
    return Response.json({ error: `查询过于频繁，请 ${retryText(limited.retryAfterSec)}后再试` }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.sql) return Response.json({ error: '缺少 sql' }, { status: 400 });
  const guard = d1Guard(body.sql);
  if (guard.error) return Response.json({ error: guard.error }, { status: 400 });

  // 写操作: 前端得先把「键入 RUN」那一步走完, 并把标记与口令一起带上来
  if (guard.write) {
    if (body.write !== true) {
      return Response.json({ error: '这是写操作，需要二次确认后才执行', write: true }, { status: 400 });
    }
    if (String(body.confirm || '') !== D1_WRITE_CONFIRM) {
      return Response.json({ error: `写操作需要确认口令 ${D1_WRITE_CONFIRM}`, write: true }, { status: 400 });
    }
    const writeLimit = await checkRateLimit(env, `d1w:${user.id}`, D1_WRITE_PER_MIN, 60 * 1000);
    if (!writeLimit.ok) {
      return Response.json({ error: `写入过于频繁，请 ${retryText(writeLimit.retryAfterSec)}后再试` }, { status: 429 });
    }
  }

  // 「最大」= 前端送一个很大的数, 这里用 hard max 兜住 (D1_ROW_MAX 只是默认保护值)
  const limit = Math.min(D1_ROW_HARD_MAX, Math.max(1, parseInt(body.limit, 10) || 50));
  const sql = guard.sql;
  // 没写 limit 的只读 select/with 自动包一层 (pragma / explain / 写操作都不包)
  const needsWrap = !guard.write && /^(select|with)\b/i.test(sql) && !/\blimit\b/i.test(stripSqlLiterals(sql));
  const finalSql = needsWrap ? `SELECT * FROM (${sql}) LIMIT ${limit}` : sql;

  const started = Date.now();
  try {
    const res = await env.DB.prepare(finalSql).all();
    const durationMs = Date.now() - started;
    const meta = res.meta || {};
    // 列名优先从第一行取 (顺序就是 SQLite 的列序);
    // 0 行结果没有「第一行」可看 —— 这时退回 meta.columns (不保证有, 拿不到就是空数组)
    const columns = (res.results && res.results[0])
      ? Object.keys(res.results[0])
      : ((meta.columns) || []);
    let rows = (res.results || []).map(r => columns.map(c => r[c]));
    const total = rows.length;
    rows = d1MaskRows(columns, rows.slice(0, limit));
    if (guard.write) {
      // 审计: 写操作留一行日志 (之前只有读, 改坏了不知道谁改的)
      console.log(`D1 写操作 by ${user.username}: ${sql} → 影响 ${meta.changes || 0} 行`);
    }
    return Response.json({
      ok: true,
      write: !!guard.write,
      columns,
      rows,
      row_count: total,
      truncated: !guard.write && total >= limit,
      changes: guard.write ? (meta.changes || 0) : undefined,
      last_row_id: guard.write ? meta.last_row_id : undefined,
      duration_ms: durationMs,
      sql: finalSql
    });
  } catch (err) {
    const message = String((err && (err.message || err.cause)) || err);
    console.error('D1 控制台查询失败:', message, finalSql);
    return Response.json({ error: message, sql: finalSql }, { status: 400 });
  }
}


// 走 Cloudflare GraphQL 问一次 (没有令牌/网络错就返回 { error })。
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

function sumSeries(series, keys) {
  const totals = {};
  keys.forEach((k) => { totals[k] = 0; });
  series.forEach((s) => keys.forEach((k) => { totals[k] += s[k] || 0; }));
  return totals;
}

async function handleD1Stats(request, env, url) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const perms = await loadPermissions(env, user.id);
  if (!hasPermission(perms, 'dev.d1')) return Response.json({ error: '仅站长可看' }, { status: 403 });

  const token = env.CF_API_TOKEN;
  if (!token) return Response.json({ error: '还没配置 Cloudflare 分析令牌（secret 名应为 CF_API_TOKEN）' }, { status: 503 });

  const range = (url && url.searchParams.get('range')) || '24h';
  const hours = range === '7d' ? 24 * 7 : range === '30d' ? 24 * 30 : 24;
  const geq = new Date(Date.now() - hours * 3600e3).toISOString();
  const leq = new Date().toISOString();
  // 这两个数据集都只吃「日期」(YYYY-MM-DD), 给 ISO 时间戳会报 date format 错
  const dayFrom = geq.slice(0, 10);
  const dayTo = leq.slice(0, 10);

  // ① D1 用量 (账号级, 按天聚合)
  const d1Query = `{
    viewer {
      accounts(filter: { accountTag: "${CF_ACCOUNT_ID}" }) {
        d1AnalyticsAdaptiveGroups(
          filter: { databaseId: "${D1_DATABASE_ID}", date_geq: "${dayFrom}", date_leq: "${dayTo}" },
          orderBy: [date_ASC],
          limit: 10000
        ) {
          dimensions { date }
          count
          sum { rowsRead rowsWritten }
        }
      }
    }
  }`;

  // 两块各自独立: D1 用量是账号级数据集, 独一访问是站级 —— 令牌只给了一个权限时,
  // 另一块会报「not authorized for that account」, 但不能因此把好的那块也吞掉。
  const d1Res = await cfGraphql(token, d1Query);
  const accounts = (!d1Res.error && d1Res.data.viewer && d1Res.data.viewer.accounts) || [];
  const groups = (accounts[0] && accounts[0].d1AnalyticsAdaptiveGroups) || [];
  const series = groups.map((g) => ({
    date: (g.dimensions && g.dimensions.date) || '',
    queries: g.count || 0,
    rowsRead: (g.sum && g.sum.rowsRead) || 0,
    rowsWritten: (g.sum && g.sum.rowsWritten) || 0
  }));

  // 站级独一访问 (zone 数据集)
  const zoneQuery = `{
    viewer {
      zones {
        zoneTag
        httpRequests1dGroups(filter: { date_geq: "${dayFrom}", date_leq: "${dayTo}" }, limit: 100, orderBy: [date_ASC]) {
          dimensions { date }
          uniq { uniques }
          sum { requests }
        }
      }
    }
  }`;
  const zoneRes = await cfGraphql(token, zoneQuery);
  let visitors = null;
  let visitorsError = '';
  if (zoneRes.error) {
    visitorsError = zoneRes.error;
  } else {
    const zones = (zoneRes.data.viewer && zoneRes.data.viewer.zones) || [];
    // Zone 类型上没有 name 字段, 只能拿 zoneTag; 这个账号只有一个 zone, 取第一个即可
    const zone = zones[0];
    if (!zone) {
      visitorsError = '这个令牌看不到任何 zone';
    } else {
      const rows = (zone.httpRequests1dGroups || []).map((g) => ({
        date: (g.dimensions && g.dimensions.date) || '',
        uniques: (g.uniq && g.uniq.uniques) || 0,
        requests: (g.sum && g.sum.requests) || 0
      }));
      visitors = { zone: zone.zoneTag, series: rows, totals: sumSeries(rows, ['uniques', 'requests']) };
    }
  }

  return Response.json({
    ok: true,
    range,
    series,
    totals: sumSeries(series, ['queries', 'rowsRead', 'rowsWritten']),
    d1_error: d1Res.error || '',
    visitors,
    visitors_error: visitorsError
  });
}


export { handleD1Tables, handleD1Query, handleD1Stats };
