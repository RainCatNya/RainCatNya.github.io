/* core.js 公共工具 */
/*
  内容: escapeHtml / 邮箱与用户名校验 / 自定义字体 / apiPost / 时间格式 / 角色权限 / 鉴权守位
  依赖: 无 (每个页面最先加载它)
*/

// HTML 转义 (往 innerHTML 里塞东西之前都要过它)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

/* 邮箱格式: 形如 a@b.c 即可, 必须与 worker.js 的 isValidEmail 一致 (注册页与个人页「换绑」都用它) */
function isValidEmailAddress(value) {
  const text = String(value || '').trim();
  return text.length > 0 && text.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/* 自定义字体 (个性化 › 字体): 值存在 profiles 的 font_chat / font_forum / font_article 上, /api/me 带回来,
   这里写成 <html data-font-*> (字体栈在 main.css, 别人看到的永远是他们自己选的);
   同时缓存一份到 localStorage —— /api/me 是异步的, 等它回来才加属性的话首屏会先用默认字体画一遍再跳成手写体。
   FONT_CHOICES 必须与 worker.js 的 FONT_VALUES 对齐 */
const FONT_SCOPES = ['chat', 'forum', 'article'];
const FONT_CHOICES = [
  { value: '', label: '默认字体' },
  { value: 'hand', label: '想念是枫糖海盐味' }
];
const FONT_CACHE_KEY = 'foraine.fonts';

// 只认白名单里的值, 其余一律当默认字体
function normalizeFontValue(value) {
  const text = String(value || '');
  return FONT_CHOICES.some((c) => c.value === text) ? text : '';
}

// 把 { chat, forum, article } 写到 <html data-font-*> 上 (空值 = 撤掉属性 = 默认字体)
function applyUserFonts(fonts) {
  const root = document.documentElement;
  FONT_SCOPES.forEach((scope) => {
    const value = normalizeFontValue(fonts && fonts[scope]);
    if (value) root.setAttribute('data-font-' + scope, value);
    else root.removeAttribute('data-font-' + scope);
  });
}

// 记一份到 localStorage (传 null = 把缓存清掉)
function cacheUserFonts(fonts) {
  try {
    if (fonts) localStorage.setItem(FONT_CACHE_KEY, JSON.stringify(fonts));
    else localStorage.removeItem(FONT_CACHE_KEY);
  } catch (error) {
    /* 隐私模式下 localStorage 可能直接抛错, 静默降级即可 */
  }
}

// 选字体时用这个: 当场生效 + 记缓存 (个人页「个性化 › 字体」调它)
function setUserFonts(fonts) {
  applyUserFonts(fonts);
  cacheUserFonts(fonts);
}

// /api/me 的返回值 → 生效 + 记缓存 (user 为 null = 清干净, 别把上个人的字体留给游客)
function applyFontsFromUser(user) {
  const fonts = user
    ? { chat: user.font_chat, forum: user.font_forum, article: user.font_article }
    : { chat: '', forum: '', article: '' };
  applyUserFonts(fonts);
  cacheUserFonts(user ? fonts : null);
}

// 首屏先用上次那套画 (不用等接口)
(function applyCachedUserFonts() {
  try {
    const raw = localStorage.getItem(FONT_CACHE_KEY);
    if (raw) applyUserFonts(JSON.parse(raw));
  } catch (error) {
    /* 缓存坏了就当没有 */
  }
})();

/* 「默认缩放」已整体删除 (含 syncZoomFlag 与 foraine_zoom 标记), 别加回来 */

/* 身份缓存: 会话 cookie 是 HttpOnly 的 (前端读不到, 故意的), 而 /api/me 又是异步的 ——
   不缓存的话每次进新页面, 导航栏都会先闪一下「登录」再跳成头像。
   这里把上次那份 user 记进 localStorage, 首屏直接拿来画, 接口回来再校正 (接口说没登录就以它为准) */
const USER_CACHE_KEY = 'foraine.user';

// 只留导航栏要用的几项, 别把整个 /api/me 存进来
function cacheUserProfile(user) {
  try {
    if (user && user.username) {
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify({
        username: user.username,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
        unread: user.unread || 0,
        chat_unread: user.chat_unread || 0
      }));
    } else {
      localStorage.removeItem(USER_CACHE_KEY);
    }
  } catch (error) {
    /* 隐私模式下 localStorage 可能直接抛错, 静默降级即可 */
  }
}

// 首屏先用这份画 (可能没有, 也可能过期 —— 接口一回来就被校正)
function readCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

// asyfunc 读 /api/me, 顺带把字体套上 + 更新身份缓存
async function getCurrentUser() {
  try {
    const response = await fetch('/api/me', { cache: 'no-store' });
    const data = await response.json();
    const user = data.user || null;
    applyFontsFromUser(user);
    cacheUserProfile(user);
    return user;
  } catch (error) {
    console.error('获取登录状态失败：', error);
    return readCachedUser();   // 网络挂了就先认上次那个人, 别把头像摘掉
  }
}

// asyfunc 没登录就整页跳登录页
async function requireLogin(redirectUrl = '/login.html') {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = redirectUrl;
  }
  return user;
}

/* 用户名规则: 3–20 位半角字母 / 数字 / 下划线 / 短横线, 首尾必须是字母或数字,
   必须与 worker.js 的 checkUsername 完全一致 (那边才是真正把关的)。
   用户名会进 URL (/u/<用户名>) 与 OSS 对象名, 所以不放中文, 中文请用昵称;
   入库一律小写 (.value 小写 / .raw 用户原样打的), 占用情况不在这里查, 注册页会再去问 /api/username/check */
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,18})[A-Za-z0-9]$/;
const USERNAME_RESERVED = [
  'admin', 'administrator', 'root', 'system', 'official', 'support', 'moderator', 'owner',
  'foraine', 'raincatnya', 'fiflizc'
];

// 校验用户名: 返回 { ok, error } 或 { ok, value(小写), raw }
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
  return { ok: true, value: value.toLowerCase(), raw: value };
}

/* 重置密码弹窗: 邮件链接跳回 /profile?reset=<token> (没登录时是 /login.html?reset=<token>) 时调它,
   两个页面共用, 放 core.js 是因为它属于鉴权这条线 */
// asyfunc 弹重置密码框
async function openPasswordResetDialog(token) {
  if (!token) return;
  // 先把令牌从地址栏抹掉, 免得刷新时又弹一次 (用掉的令牌会报已用过)
  history.replaceState(null, '', location.pathname + location.hash);

  await confirmAction({
    title: '重置密码',
    message: '设置一个新密码。改完之后之前的登录状态会全部失效，请用新密码重新登录。',
    confirmText: '确认修改',
    warning: '',
    fields: [
      { name: 'password', type: 'password', placeholder: '新密码', required: true, maxlength: 200 },
      { name: 'password2', type: 'password', placeholder: '确认密码', required: true, maxlength: 200 }
    ],
    onConfirm: async (values, api) => {
      if ((values.password || '').length < 6) {
        api.setError('密码至少 6 个字符');
        return false;
      }
      if (values.password !== values.password2) {
        api.setError('两次输入的密码不一致');
        return false;
      }
      const result = await apiPost('/api/password/reset', { token, password: values.password });
      // 条件拼接也是两种完整句子, 各给一个 key
      showToast(result && result.username
        ? I18N.t('auth.passwordReset.withUser', '密码已重置，请用新密码登录')
        : I18N.t('auth.passwordReset', '密码已重置'), 'ok');
    }
  });
}

// asyfunc POST JSON, 统一抛错
async function apiPost(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
    cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    // 把服务端那份 JSON 也带上: 调用方有时要看错误码 (如 code: 'has_comments')
    error.status = response.status;
    error.data = result;
    throw error;
  }
  return result;
}

/* 文章列表 ↔ 文章详情要不要过场: false = 要 (改成 true 就免过场, 免过场那套在 transition.js) */
const LIST_DETAIL_NO_TRANSITION = false;

/* 站内跳转入口: 「删了文章再跳走」「审核完跳走」这类动作走 pageTransitionTo (带遮罩), 普通跳转一律走 goPage();
   列表 ↔ 详情按上面的开关决定免不免过场, 路径对比只看这两类, 查询参数与锚点忽略 */
function isListDetailRoundTrip(target) {
  const norm = (p) => String(p || '').split('?')[0].split('#')[0].replace(/\/index\.html$/, '/');
  const from = norm(location.pathname);
  const to = norm(target);
  const isList = (p) => p === '/articles' || p === '/articles/';
  const isDetail = (p) => p.indexOf('/article/') === 0;
  return (isList(from) && isDetail(to)) || (isDetail(from) && isList(to));
}

/* 站内跳转统一入口: 列表↔详情按开关免过场, 其它照旧; options.animate = true 强制带过场 (留给「动作之后的跳转」) */
function goPage(target, options) {
  if (!target) return;
  const forceAnimate = !!(options && options.animate);
  if (!forceAnimate && LIST_DETAIL_NO_TRANSITION
      && isListDetailRoundTrip(target) && typeof window.pageGoInstant === 'function') {
    window.pageGoInstant(target);
    return;
  }
  if (typeof window.pageTransitionTo === 'function') window.pageTransitionTo(target);
  else window.location.href = target;
}

/* 重播一遍入场动画: 摘掉 .anim-in → 强制回流 → 再按顺序加回去 (错开 55ms, 与首屏一致);
   少了 void offsetWidth 那一步, 浏览器会把「摘掉又加回」合成一次, 动画不会重播。
   只用于「这块东西本身就是新内容」的场合 (正文 / 整块面板); 列表里只是多了几条请用下面的 replayItems() */
function replayEnterAnim(root) {
  let targets;
  if (!root || root === document) {
    targets = Array.from(document.querySelectorAll('[data-anim]'));
  } else {
    targets = Array.from(root.querySelectorAll('[data-anim]'));
    if (root.matches && root.matches('[data-anim]')) targets.unshift(root);
  }
  if (!targets.length) return;

  targets.forEach((elm, i) => {
    elm.classList.remove('anim-in');
    void elm.offsetWidth;
    elm.style.animationDelay = (i * 55) + 'ms';
    elm.classList.add('anim-in');
  });
  // 播完把内联延迟清掉 (与 transition.js 的 playEnter 一致)
  setTimeout(() => {
    targets.forEach((elm) => { elm.style.animationDelay = ''; });
  }, 420 + targets.length * 55 + 60);
}

/* 只重播条目的入场动画: 容器外壳 (页签 / 标签栏 / 侧栏) 不动, 里面的条目逐个错开 45ms;
   用法 replayItems(容器, '.article-item'), 条目本身不用写 data-anim。
   动画类播完必须摘掉 (见下面的 animationend) —— animation-fill-mode: both 的收尾帧会压住条目自己的 transform */
function replayItems(container, selector) {
  const root = (typeof container === 'string') ? document.querySelector(container) : container;
  if (!root || !selector) return;
  const items = Array.from(root.querySelectorAll(selector));
  if (!items.length) return;

  // 外壳还没入场时条目根本看不见, 那批动画会白演, 交给外壳那次入场统一演就行
  const shell = items[0].closest ? items[0].closest('[data-anim]') : null;
  if (shell && !shell.classList.contains('anim-in')) return;

  items.forEach((elm, i) => {
    elm.classList.remove('anim-item');
    void elm.offsetWidth; // 强制回流, 不然「摘掉又加回」会被合成一次
    elm.style.animationDelay = (i * 45) + 'ms';
    elm.classList.add('anim-item');
    elm.addEventListener('animationend', (event) => {
      if (event.target !== elm) return; // 子元素冒泡上来的不算
      elm.classList.remove('anim-item');
      elm.style.animationDelay = '';
    });
  });
}

// 时间戳 → YYYY-MM-DD HH:mm
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 时间戳 → YYYY-MM-DD (文章列表左侧那列只显示日期, 不带时间)
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 聊天记录里的时间要短: 今天只写 HH:mm, 更早的补上 MM-DD (桌面弹窗与手机私信页共用)
function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : (pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm);
}

// 悬浮在某条消息上显示的精确时间, 与 QQ 一样带秒: 今年只写 MM-DD HH:mm:ss, 跨年补上年份
function formatChatStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '-'}${date} ${time}`;
}

/* DOM 小工具 */
// 安全创建元素: 文本一律走 textContent, 避免 XSS
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 中点分隔符: 包一层让 · 占满一个汉字宽 (裸的 · 只有半个字宽, 两边的字会显得被挤扁)
function dotSep() {
  return el('span', 'sep-dot', '·');
}

/* 文件哈希: 上传前在浏览器里算出 SHA-256 (小写十六进制), 给上传的人自己留一份凭据;
   WebCrypto 只在安全上下文里有 (https / localhost), 拿不到就返回空串 —— 算不出哈希不该把整条上传拖住。
   没有流式接口, digest 得一次吃下整份字节, 所以多大的文件还算由调用方自己定 */
// asyfunc 算文件的 SHA-256
async function hashFile(file) {
  if (!file || !file.size) return '';
  if (!window.crypto || !window.crypto.subtle) return '';
  try {
    const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i += 1) hex += view[i].toString(16).padStart(2, '0');
    return hex;
  } catch (err) {
    // 读文件失败 (用户中途取消 / 文件被移走) 或 digest 不支持, 都当没算出来
    console.warn('哈希计算失败:', err);
    return '';
  }
}

// 字节缓冲 → 小写十六进制
function digestHex(buffer) {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/* 一次算出 SHA-256 与 SHA-1 (资源详情里要在几个校验值之间切):
   字节只读一遍, 两个 digest 共用同一个 ArrayBuffer, 不然 600MB 的文件要读两遍 */
// asyfunc 算文件的 SHA-256 / SHA-1
async function hashFilePair(file) {
  const blank = { sha256: '', sha1: '' };
  if (!file || !file.size) return blank;
  if (!window.crypto || !window.crypto.subtle) return blank;
  try {
    const bytes = await file.arrayBuffer();
    const [a, b] = await Promise.all([
      window.crypto.subtle.digest('SHA-256', bytes),
      window.crypto.subtle.digest('SHA-1', bytes)
    ]);
    return { sha256: digestHex(a), sha1: digestHex(b) };
  } catch (err) {
    console.warn('哈希计算失败:', err);
    return blank;
  }
}

/* 角色 / 权限: 只有三个角色, 顺序就是权限高低 (服务端的 RBAC 表也是这套 label) */
const ROLE_ORDER = ['普通用户', '管理员', '站长']; // 低 → 高
const ROLE_META = {
  // label = 侧栏徽章上的全称; short = 权限按钮上的短名
  '站长': { key: 'owner', label: 'Foraine 站长', short: '站长' },
  '管理员': { key: 'admin', label: 'Foraine 管理员', short: '管理员' },
  '普通用户': { key: 'member', label: 'Foraine 成员', short: '成员' }
};

// 取用户最高的那个角色 (roles 是中文 label 数组, 没有就是普通用户)
function realRole(user) {
  const list = (user && user.roles) || [];
  let best = '普通用户';
  list.forEach((r) => {
    if (ROLE_ORDER.indexOf(r) > ROLE_ORDER.indexOf(best)) best = r;
  });
  return ROLE_ORDER.indexOf(best) >= 0 ? best : '普通用户';
}

// 取角色的 label / short
function roleMeta(name) {
  return ROLE_META[name] || ROLE_META['普通用户'];
}

/* 「以某权限查看」预览已整块删除 (含 effectiveRole / canActAs 与个人页那行权限按钮), 一律按真实身份画, 别加回来 */

/* 关掉浏览器自动填入: 全站输入框都是「自己填一次」的资料字段, 记住的历史值 / 上次密码只会盖掉真正的内容。
   Chrome 对 type=password 只认 new-password, 写 off 照样会弹密码管理建议 */
// 单个输入框: 关掉自动填入 / 自动大写 / 拼写检查
function hardenField(field) {
  if (!field || !field.getAttribute) return;
  const tag = field.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
  const type = String(field.getAttribute('type') || 'text').toLowerCase();
  if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit') return;
  field.setAttribute('autocomplete', type === 'password' ? 'new-password' : 'off');
  if (tag === 'INPUT') {
    field.setAttribute('autocapitalize', 'off');
    if (type !== 'password') field.setAttribute('spellcheck', 'false');
  }
}

// 整页 (或某一小块) 过一遍
function disableAutofill(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  hardenField(scope); // root 本身就是输入框时也能用 (hardenField 会自己过滤)
  scope.querySelectorAll('input, textarea').forEach(hardenField);
}

// defer 脚本在 DOMContentLoaded 之前就执行, 这个监听器会先注册、解析完立刻生效
document.addEventListener('DOMContentLoaded', () => disableAutofill());

/* 页面鉴权守位 */
// 处理「退出登录后按返回仍能看到旧页面」: 首次加载与 bfcache 恢复时都重新校验
function initAuthGuard(options = {}) {
  const { requireAuth = false, redirectIfAuthed = null, loginUrl = '/login.html' } = options;
  let running = false;

  // asyfunc 校验一次登录态, 通过就广播 authready
  async function check() {
    if (running) return;
    running = true;
    try {
      const user = await getCurrentUser();
      if (requireAuth && !user) {
        window.location.replace(loginUrl); // 用 replace, 避免在历史中留下受保护页面
        return;
      }
      if (!requireAuth && redirectIfAuthed && user) {
        window.location.replace(redirectIfAuthed);
        return;
      }
      window.dispatchEvent(new CustomEvent('authready', { detail: { user } }));
    } finally {
      running = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) check(); // 从往返缓存恢复时重新校验
  });
}

/* 「一屏高」--vh-full: CSS 里是 100dvh, 老浏览器不认它 —— var() 解析成非法值会让 height 整条变 auto
   (页脚落不到底、顶部留白塌掉), 这种浏览器用 innerHeight 兜底 */
function syncVhFull() {
  const root = document.documentElement;
  if (window.CSS && CSS.supports && CSS.supports('height', '100dvh')) {
    root.style.removeProperty('--vh-full');
    return;
  }
  root.style.setProperty('--vh-full', window.innerHeight + 'px');
}
syncVhFull();
window.addEventListener('resize', syncVhFull);
window.addEventListener('orientationchange', syncVhFull);
