/* oauth.js GitHub 登录与绑定 */
/*
  内容: 跳授权页 / 回调换令牌与资料 / 绑定已有账号 / 建新账号
  依赖: ../common.js(会话, state Cookie, 随机串)
*/

import { GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, OAUTH_PASSWORD_PREFIX, OAUTH_STATE_COOKIE, clearStateCookie, createSessionCookie, getSessionUser, githubCallbackUrl, githubConfigured, parseCookies, randomHex, redirectTo } from '../common.js';


// asyfunc 跳 GitHub 授权页(?link=1 是绑定, 否则是登录): GET /api/auth/github
async function handleGithubStart(request, env, url) {
  const isLink = url.searchParams.get('link') === '1';
  const loginUrl = `${url.origin}/login.html`;

  if (!githubConfigured(env)) {
    return redirectTo(`${loginUrl}?error=github_unconfigured`);
  }

  if (isLink) {
    const current = await getSessionUser(request, env);
    if (!current) return redirectTo(loginUrl);
  }

  // state 写进 HttpOnly Cookie, 回调时比对 (防 CSRF); 后缀记住本次用途
  const state = `${randomHex(16)}.${isLink ? 'link' : 'login'}`;

  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', githubCallbackUrl(url));
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);

  return redirectTo(authorize.href, [
    `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
  ]);
}


// asyfunc 回调(code 换令牌 -> 建号 / 绑定): GET /api/auth/github/callback
async function handleGithubCallback(request, env, url) {
  const loginUrl = `${url.origin}/login.html`;
  const fail = (reason) => redirectTo(`${loginUrl}?error=${reason}`, [clearStateCookie()]);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const savedState = parseCookies(request)[OAUTH_STATE_COOKIE];

  if (!code || !state || !savedState || state !== savedState) return fail('github_state');
  if (!githubConfigured(env)) return fail('github_unconfigured');

  // 绑定模式: 复查一次登录态 (用户在 GitHub 页面上耽误太久, 本地会话可能已过期)
  const isLink = state.endsWith('.link');
  let currentUser = null;
  if (isLink) {
    currentUser = await getSessionUser(request, env);
    if (!currentUser) return fail('github_state');
  }

  try {
    // 1) code 换 access_token
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: githubCallbackUrl(url)
      })
    });
    const tokenData = await tokenRes.json().catch(() => null);
    const accessToken = tokenData && tokenData.access_token;
    if (!accessToken) return fail('github_token');

    // 2) access_token 换用户资料
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'foraine'
      }
    });
    if (!userRes.ok) return fail('github_user');
    const gh = await userRes.json();
    if (!gh || !gh.id) return fail('github_user');

    const githubId = String(gh.id);
    const githubLogin = String(gh.login || '');
    const avatarUrl = gh.avatar_url ? String(gh.avatar_url) : null;
    const now = Date.now();

    /* 绑定已有账号 */
    if (isLink) {
      const taken = await env.DB.prepare(
        `SELECT id FROM users WHERE github_id = ? AND id != ?`
      ).bind(githubId, currentUser.id).first();
      if (taken) return fail('github_conflict');

      await env.DB.prepare(
        `UPDATE users SET github_id = ?, github_login = ? WHERE id = ?`
      ).bind(githubId, githubLogin, currentUser.id).run();

      if (avatarUrl) {
        await env.DB.prepare(
          `UPDATE profiles SET avatar_url = ?, updated_at = ? WHERE user_id = ?`
        ).bind(avatarUrl, now, currentUser.id).run();
      }

      return redirectTo(`${url.origin}/profile.html?github=linked`, [clearStateCookie()]);
    }

    /* 用 GitHub 登录 */
    let user = await env.DB.prepare(
      `SELECT id FROM users WHERE github_id = ?`
    ).bind(githubId).first();

    if (!user) {
      // 用户名沿用 GitHub login; 被占用就加后缀, 绝不合并进同名账号 (防冒名接管)
      // 入库一律小写、压到 20 位内, 和注册一个口径 (GitHub login 里会有大写字母)
      let username = String(githubLogin || `gh${githubId}`).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!/^[a-z0-9]/.test(username) || username.length < 3) username = `gh${githubId}`;
      if (username.length > 20) username = `${username.slice(0, 12)}-${githubId}`;
      const exists = await env.DB.prepare(
        `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`
      ).bind(username).first();
      if (exists) username = `${username}-gh${githubId}`;

      // OAuth 账号没有密码: 存一个随机串, 密码登录永远匹配不上
      const salt = randomHex(16);
      const passwordHash = OAUTH_PASSWORD_PREFIX + randomHex(32);

      await env.DB.prepare(
        `INSERT INTO users (username, password_hash, salt, email, github_id, github_login, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(username, passwordHash, salt, gh.email || null, githubId, githubLogin, now).run();

      user = await env.DB.prepare(
        `SELECT id FROM users WHERE username = ?`
      ).bind(username).first();

      await env.DB.prepare(
        `INSERT INTO profiles (user_id, nickname, avatar_url, bio, other, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`
      ).bind(user.id, gh.name || githubLogin || username, avatarUrl, gh.bio || null, now, now).run();

      // 角色不用管: users.role 默认就是 'user' (普通用户)
    } else if (avatarUrl) {
      // 老用户: 头像换了就顺手同步
      await env.DB.prepare(
        `UPDATE profiles SET avatar_url = ?, updated_at = ? WHERE user_id = ?`
      ).bind(avatarUrl, now, user.id).run();
    }

    const cookie = await createSessionCookie(env, user.id, url);
    return redirectTo(`${url.origin}/`, [cookie, clearStateCookie()]);
  } catch (err) {
    console.error('GitHub 登录失败:', err && (err.message || err.cause) || err);
    return fail('github_error');
  }
}


export { handleGithubStart, handleGithubCallback };
