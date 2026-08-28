export default {
  async fetch(request, env) {
    // 获取访问者 IP
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    console.log(`Request from IP: ${clientIP} - URL: ${request.url}`);

    const url = new URL(request.url);
    const path = url.pathname;

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    } else {
      return Response.redirect(new URL("/Html/AccessDenied.html?reason=404", url.origin), 302);
    }
  }
};