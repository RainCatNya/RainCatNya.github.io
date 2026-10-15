/* index.js Worker 入口 */
/*
  内容: fetch 分发 (API / sitemap / 公开个人主页 / 静态资源) + scheduled 定时清理
  依赖: handlers.js(handleApi, handleSitemap) / common.js(页面改写与定时清理)
*/

import { handleApi, handleSitemap } from './handlers.js';
import { withoutEncoding, isPageRequest, injectPageMeta, serveNotFound, serveAccessDenied, canOpenEditor, getSessionUser, purgePendingDeletions, purgeExpiredResources, purgeExpiredImages, purgeRateLimits } from './common.js';
import { extractAttributes, groupCovers, normalizeGroup, reconcileAttributes, syncGroupAttributes } from './permission.js';

export default {
  // asyfunc fetch: 所有请求的入口
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    /* API 路由 */
    // 统一分发, 一律禁止缓存 (否则登录状态会被缓存泄漏)
    if (path.startsWith('/api/')) {
      const response = await handleApi(request, env, url, path, ctx);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }

    /* sitemap */
    // 动态生成: 文章在 D1 里, 静态文件写不出来
    if (path === '/sitemap.xml') {
      return handleSitemap(request, env);
    }

    /* 公开个人主页 */
    // /u/<用户名> 复用 profile.html, 但 URL 保持漂亮的 /u/xxx
    if (path.startsWith('/u/')) {
      // 必须请求 /profile 而不是 /profile.html: 资源层会把 .html 307 掉, 子请求不跟随跳转
      const pageRequest = new Request(new URL('/profile', url.origin), withoutEncoding(request));
      const page = await env.ASSETS.fetch(pageRequest);
      if (page.status === 404 || page.status >= 300) return serveNotFound(url, env);
      return injectPageMeta(page, env, url, request);
    }

    /* 编辑页身份校验 */
    // 不验的话输 /article/?id=<别人的文章>&edit=1 就能进; 权限不足送 access-denied 而不是 404
    if ((path === '/article' || path === '/article/') && url.searchParams.has('edit')) {
      if (!(await canOpenEditor(request, env, url))) return serveAccessDenied(url);
    }

    /* 终端页的门 (用户 2026-09-28 定的): 没登录 → 拒绝访问页。
       权限 (terminal.access) 与秘钥闸门现在都在页内判 (/terminal 一页到底),
       /terminal/verify 只留一张 302 的路, 老书签不至于撞 404 */
    if (path === '/terminal' || path === '/terminal/' || path === '/terminal/verify' || path === '/terminal/verify/') {
      const user = await getSessionUser(request, env);
      if (!user) return serveAccessDenied(url);
      if (path.indexOf('/terminal/verify') === 0) return Response.redirect(new URL('/terminal/', url.origin).href, 302);
    }

    /* 静态资源 */
    // pageRequest 只用来决定要不要去掉 Accept-Encoding 并改写 head (统计已改用 Cloudflare 站级分析)
    const pageRequest = isPageRequest(request);
    if (env.ASSETS) {
      // 要改写的 HTML 必须先去掉 Accept-Encoding: gzip 体 HTMLRewriter 解析不出 <title>
      const assetResponse = await env.ASSETS.fetch(
        pageRequest ? withoutEncoding(request) : request
      );
      if (assetResponse.status !== 404) {
        /* 页面改写 */
        // 只有 HTML 才改写 head (社交平台分享卡 / 搜索引擎收录)
        if (pageRequest && (assetResponse.headers.get('Content-Type') || '').includes('text/html')) {
          return injectPageMeta(assetResponse, env, url, request);
        }
        return assetResponse;
      }
    }
    return serveNotFound(url, env);
  },

  /* 定时任务 */
  // wrangler.jsonc 的 triggers.crons, 每天跑一次
  // asyfunc scheduled: 注销满 7 天的账号真删 (期间用户可在个人页撤销申请)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      purgePendingDeletions(env).then((n) => {
        if (n) console.log(`注销到期清理: 已删除 ${n} 个账号`);
      }),
      // 资源桶的过期清理 (默认 7 天) 走同一趟 cron
      purgeExpiredResources(env).then((n) => {
        if (n) console.log(`资源过期清理: 已删除 ${n} 个资源`);
      }),
      // 聊天图的过期清理 (默认 7 天)
      purgeExpiredImages(env).then((n) => {
        if (n) console.log(`聊天图过期清理: 已删除 ${n} 张`);
      }),
      // 限流的过期计数: 按 IP 的 key 会随访客一直增行
      purgeRateLimits(env).then((n) => {
        if (n) console.log(`限流过期清理: 已删除 ${n} 行`);
      }),
      // <secret> 权限名册的引用计数兜底对账 (硬删/注销清掉的文革靠它抹平)
      reconcileAttributes(env)
    ]));
  }
};
