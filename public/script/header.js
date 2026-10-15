/* Header.js 导航栏 */
/*
  内容: 图标 站名 / 资源 / 文章 / 聊天 / [用户头像/登录]
  依赖: core.js(getCurrentUser) / transition.js(pageTransitionTo)
*/

(function initSiteHeader() {
  /* 初始化导航栏 */ 

  // 按钮站内路径
  const NAV_ARTICLES = '/articles/';
  const NAV_RESOURCE = '/resource/';
  const NAV_LOGIN = '/login.html';
  const NAV_PROFILE = '/profile.html';
  const NAV_CHAT = '/chat/';
  
  // 没有头像&游客用站点图标替代Avatar
  const AVATAR_FALLBACK = '/assets/Icon/foraine-icon-v2.png';

  // SVG实现
  const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>';
  const ICON_ARTICLES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path><path d="M8.5 13h7M8.5 16.5h4.5"></path></svg>';
  const ICON_RESOURCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"></path><path d="M3 7.5 12 12l9-4.5"></path><path d="M12 12v9"></path></svg>';
  const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-3.2-.6L3.5 21l1.7-4.6A8.3 8.3 0 0 1 4 11.5a8.4 8.4 0 0 1 8.5-8.4A8.4 8.4 0 0 1 21 11.5z"></path><path d="M8.6 11.6h.01M12 11.6h.01M15.4 11.6h.01"></path></svg>';
  const ICON_RAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5c3.4 4 5.6 7 5.6 9.6a5.6 5.6 0 0 1-11.2 0c0-2.6 2.2-5.6 5.6-9.6z"></path></svg>';
  const ICON_RAIN_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5c3.4 4 5.6 7 5.6 9.6a5.6 5.6 0 0 1-11.2 0c0-2.6 2.2-5.6 5.6-9.6z"></path><path d="M4.5 4.5l15 15"></path></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"></path><path d="m12 19-7-7 7-7"></path></svg>';

  // asyfunc: go验证 - 如果钩子返回false则拦截redirect
  async function passNavigateGuard() {
    const guard = window.__beforeNavigate;
    if (typeof guard !== 'function') return true;
    try {
      return (await guard()) !== false;
    } catch (err) {
      console.warn('Redirct Hook 错误.. 放行跳转:', err);
      return true;
    }
  }

  /* asyfunc 跳转页面 */
  async function go(target) {
    if (!target) return;
    if (!(await passNavigateGuard())) return; // 跳转前验证
    goPage(target);
  }

  function isArticlesPage() {
    return location.pathname === '/articles/' || location.pathname.startsWith('/article/');
  }

  function isResourcePage() {
    return location.pathname === '/resource/';
  }

  // 返回上一页
  async function goBack() {
    if (!(await passNavigateGuard())) return;
    const fromSite = document.referrer && document.referrer.startsWith(location.origin);
    if (fromSite && window.history.length > 1) {
      window.history.back();
      return;
    }
    // passNavigateGuard查过一次，故直接redirect
    const target = isArticlesPage() ? NAV_ARTICLES : '/';
    goPage(target);
  }

  // 设定文字按钮
  function navButton(label, target, active) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.target = target;
    if (active) btn.classList.add('site-nav-active');
    btn.addEventListener('click', () => go(btn.dataset.target));
    return btn;
  }

  // 设定图标按钮 (key = 语言包的词条, 挂上后 i18n.js 会把 title 与 aria-label 一起换掉)
  function iconButton(svg, label, extraClass, key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'site-icon-btn' + (extraClass ? ' ' + extraClass : '');
    btn.innerHTML = svg;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (key) btn.dataset.i18nTitle = key;
    return btn;
  }

  /* func设定头像 */
  function setAvatarButton(btn, user) {
    btn.classList.add('site-avatar-btn');
    btn.textContent = '';
    const img = document.createElement('img');
    img.className = 'site-nav-avatar';
    img.alt = '';
    img.src = user.avatar_url || AVATAR_FALLBACK;
    img.onerror = () => { img.onerror = null; img.src = AVATAR_FALLBACK; };
    btn.appendChild(img);
    btn.setAttribute('aria-label', '个人主页');
    btn.dataset.i18nTitle = 'nav.profile';
  }
  
  /* 导航栏构建方法 */
  function build() {
    if (document.querySelector('.site-header')) return;

    const header = document.createElement('header');
    header.className = 'site-header No-slc';

    /* Foraine 招牌 */
    const brand = document.createElement('a');
    brand.className = 'site-brand';
    brand.href = '/';
    brand.setAttribute('aria-label', 'Foraine 首页');

    const logo = document.createElement('img');
    logo.src = '/assets/Icon/foraine-icon-v2.png';
    logo.alt = 'Foraine';
    const brandName = document.createElement('span');
    brandName.textContent = 'Foraine';

    brand.appendChild(logo);
    brand.appendChild(brandName);
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      // 阻止默认跳转, 改用go();
      e.stopPropagation();
      // 阻止点击事件的传递
      go('/');
    });

    // 导航
    const nav = document.createElement('nav');
    nav.className = 'site-nav';

    /* 资源按钮 */
    const resourceBtn = iconButton(ICON_RESOURCE, '资源', 'site-resource-btn', 'nav.resource');
    if (isResourcePage()) resourceBtn.classList.add('site-nav-active');
    resourceBtn.addEventListener('click', () => go(NAV_RESOURCE));
    nav.appendChild(resourceBtn);

    /* 文章按钮 */
    const articlesBtn = iconButton(ICON_ARTICLES, '文章', 'site-articles-btn', 'nav.articles');
    if (isArticlesPage()) articlesBtn.classList.add('site-nav-active');
    articlesBtn.addEventListener('click', () => go(NAV_ARTICLES));
    nav.appendChild(articlesBtn);

    /* 聊天按钮 */
    const chatBtn = iconButton(ICON_CHAT, '私信', 'site-chat-btn', 'nav.chat');
    chatBtn.hidden = true;
    chatBtn.addEventListener('click', () => go(NAV_CHAT));
    nav.appendChild(chatBtn);

    /* 回到顶部 */
    const topBtn = iconButton(ICON_UP, '回到顶部', 'site-top-btn', 'nav.top');
    topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    nav.appendChild(topBtn);

    /* 雨幕开关 */
    let rainBtn = null;
    function paintRainBtn(on) {
      if (!rainBtn) return;
      rainBtn.innerHTML = on ? ICON_RAIN : ICON_RAIN_OFF;
      rainBtn.title = on ? '雨：开' : '雨：关';
      rainBtn.classList.toggle('is-off', !on);
    }
    if (document.body.classList.contains('page-home') && window.matchMedia('(min-width: 901px)').matches) {
      rainBtn = iconButton(ICON_RAIN, '雨', 'site-rain-btn');
      rainBtn.addEventListener('click', () => {
        if (typeof window.rainSetEnabled !== 'function') return;
        const nowOn = typeof window.rainIsEnabled === 'function' ? window.rainIsEnabled() : true;
        window.rainSetEnabled(!nowOn);
        paintRainBtn(!nowOn);
      });
      nav.appendChild(rainBtn);
      // 图标重绘defer (考虑到雨的加载在rain.js, sync下避免状态不一致)
      window.addEventListener('load', () => {
        paintRainBtn(typeof window.rainIsEnabled === 'function' ? window.rainIsEnabled() : true);
      });
    }

    /* 头像按钮 */
    // 未登录时为“登录”文本
    const authBtn = navButton('登录', NAV_LOGIN, location.pathname.startsWith('/profile'));
    authBtn.classList.add('site-auth-btn');
    authBtn.dataset.i18n = 'nav.login';
    nav.appendChild(authBtn);

    header.appendChild(brand);
    header.appendChild(nav);

    /* 外框 */
    const bar = document.createElement('div');
    bar.className = 'site-bar No-slc';

    /* 返回按钮 */
    // 首页不显示; 移动端不显示 (页面缩放过大时容易让按钮把导航栏撑爆, 绝对不是什么区别对待..)
    if (location.pathname !== '/') {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'site-back';
      back.innerHTML = ICON_BACK;
      back.title = '返回';
      back.setAttribute('aria-label', '返回');
      back.dataset.i18nTitle = 'nav.back';
      back.addEventListener('click', goBack);
      bar.appendChild(back);
      back.classList.add('show');
    }

    bar.appendChild(header);
    document.body.prepend(bar);

    // 滚动时变化: 20px
    const onScroll = () => {
      const solid = window.scrollY > 20;
      bar.classList.toggle('not-top', solid);
      header.classList.toggle('not-top', solid);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // 判断登录态
    /* 先拿 localStorage 里那份身份把头像画出来 (不用等接口), 接口回来再校正 ——
       不然每次进新页面都会先闪一下「登录」 */
    const applyAuthState = (user) => {
      if (user) {
        authBtn.dataset.target = NAV_PROFILE;
        setAvatarButton(authBtn, user);
      } else {
        authBtn.textContent = '登录';
        authBtn.dataset.target = NAV_LOGIN;
      }
      if (user && user.unread > 0) {
        authBtn.classList.add('has-dot');
        authBtn.title = (user.nickname || user.username || '个人主页') + ' · ' + user.unread + ' 条未读站内信';
      } else if (user) {
        authBtn.title = (user.nickname || user.username || '') + ' · 个人主页';
      }
      if (user) {
        chatBtn.hidden = false;
        if (location.pathname.startsWith('/chat')) chatBtn.classList.add('site-nav-active');
        if (user.chat_unread > 0) {
          chatBtn.classList.add('has-dot');
          chatBtn.title = user.chat_unread + ' 条未读私信';
        }
      }
    };

    if (typeof readCachedUser === 'function') applyAuthState(readCachedUser());
    if (typeof getCurrentUser === 'function') {
      getCurrentUser().then(applyAuthState).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    // 构建 defer
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();