/* transition.js 页面转场 */
/*
  内容: 圆形遮罩转场 (点导航时从中心扩大盖住屏幕, 加载完成再缩小露出页面) + history.back/forward/go 也走转场
  依赖: core.js(goPage / LIST_DETAIL_NO_TRANSITION)
*/

(function initPageTransition() {
  const DURATION = 400;      // 扩大/缩小时长
  const MIN_STAY = 400;      // 遮罩最短停留时间
  const HINT_MS = 500;       // 完成提示(实心圆+图标)展示时长

  const mask = document.createElement('div');
  mask.className = 'transition-mask';

  // 完成提示层: 独立于遮罩, 不随遮罩缩放, 用透明度动画
  const hint = document.createElement('div');
  hint.className = 'transition-hint';

  const icon = document.createElement('img');
  icon.className = 'transition-icon';
  icon.src = '/assets/Icon/foraine-icon-v2.png';
  hint.appendChild(icon);

  let startTime = Date.now();
  let hasLeft = false;
  let instantLeave = false;

  /* 「这一趟不要过场」: 文章列表 ↔ 文章详情之间的来回 (点卡片进文章 / 返回列表) 不要遮罩,
     但删除文章、审核这类「动作之后跳走」仍然要。两套标记各管一边:
     window.__skipNextTransition 给 bfcache 回退用, sessionStorage 给新页面加载用 (读一次就删) */
  const SKIP_KEY = '__foraine_skip_transition';

  // 打上「下次不过场」的标记
  function markSkip() {
    window.__skipNextTransition = true;
    try { sessionStorage.setItem(SKIP_KEY, '1'); } catch (e) { /* 隐私模式 */ }
  }
  // 标记读一次就删
  function consumeSkip() {
    try {
      const v = sessionStorage.getItem(SKIP_KEY);
      sessionStorage.removeItem(SKIP_KEY);
      return v === '1';
    } catch (e) { return false; }
  }
  const skipOnLoad = consumeSkip();
  // 供 history 补丁调用 (那边在另一个 IIFE 里, 拿不到这里的闭包)
  window.__markSkipTransition = markSkip;

  // 无过场的跳转: 地址直接换掉, 连离开时都不能盖遮罩
  // 仍然要记一笔站内导航栈, 不记的话 history.back() 会拿到过期的上一页, 从文章返回就跳到别处去了
  window.pageGoInstant = function (target) {
    markSkip();
    if (typeof window.__navRecordDeparture === 'function' && !window.__navSkipRecord) {
      window.__navRecordDeparture();
    }
    window.__navSkipRecord = false;
    instantLeave = true;
    // 走之前先松掉「加载中」牌子: 不然离开时它会弹一下原生「确定要离开吗」
    if (typeof window.__dismissForaineToast === 'function') window.__dismissForaineToast();
    window.location.href = target;
  };

  /* 组件进场动画卡在遮罩消失 3/4 这个点: 一加载就播会被遮罩盖住, 等遮罩全消失才播又会先看到一屏空白 */
  const ENTER_AT = Math.round(DURATION * 0.75);

  // 组件入场的统一入口
  function playEnter() {
    const targets = document.querySelectorAll('[data-anim]');
    if (!targets.length) return;
    targets.forEach((elm, i) => {
      elm.style.animationDelay = (i * 55) + 'ms';
      elm.classList.add('anim-in');
    });
    // 动画放完就把内联延迟清掉, 免得 bfcache 回来重播时还带着上一次的错位
    const total = 420 + targets.length * 55 + 60;
    setTimeout(() => {
      targets.forEach((elm) => { elm.style.animationDelay = ''; });
    }, total);
  }

  // 提前把「隐藏待播」的开关挂到 <html> 上 (脚本没跑或报错时内容照常可见)
  document.documentElement.setAttribute('data-anim-armed', '');

  // 遮罩与提示层挂在 body 末尾 (body 还没解析出来时退到 documentElement)
  function appendMask() {
    const parent = document.body || document.documentElement;
    if (parent) {
      if (!mask.parentNode) parent.appendChild(mask);
      if (!hint.parentNode) parent.appendChild(hint);
    }
  }
  appendMask();
  document.addEventListener('DOMContentLoaded', appendMask);

  // 加载完成: 完成提示淡入 → 淡出 → 遮罩缩小露出页面
  function slideOut() {
    if (hasLeft) return;
    hasLeft = true;
    // 本次加载被标记为「不要过场」→ 遮罩直接收掉, 只留组件入场
    if (skipOnLoad) {
      mask.remove();
      hint.remove();
      playEnter();
      return;
    }
    const wait = Math.max(0, MIN_STAY - (Date.now() - startTime));
    setTimeout(() => {
      hint.classList.add('show');
      setTimeout(() => {
        hint.classList.remove('show');
        mask.classList.add('shrink');
        setTimeout(playEnter, ENTER_AT); // 遮罩消失 3/4 后再让组件飘入
        setTimeout(() => {
          mask.remove();
          hint.remove();
        }, DURATION + 100);
      }, HINT_MS);
    }, wait);
  }

  if (document.readyState === 'complete') {
    slideOut();
  } else {
    window.addEventListener('load', slideOut);
  }

  // 往返缓存(bfcache)恢复时重新播放进入动画 (浏览器后退/前进)
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;

    // 无过场返回 (列表 ↔ 详情): 遮罩直接丢掉, 只重播组件入场
    if (window.__skipNextTransition) {
      window.__skipNextTransition = false;
      hasLeft = true;
      hint.classList.remove('show');
      mask.remove();
      document.querySelectorAll('[data-anim].anim-in').forEach((elm) => {
        elm.classList.remove('anim-in');
        elm.style.animationDelay = '';
      });
      playEnter();
      return;
    }

    hasLeft = false;
    startTime = Date.now();
    hint.classList.remove('show');
    mask.classList.remove('shrink');
    appendMask();
    // 往回退时组件动画也重播一遍 (先把 anim-in 拿掉)
    document.querySelectorAll('[data-anim].anim-in').forEach((elm) => {
      elm.classList.remove('anim-in');
      elm.style.animationDelay = '';
    });
    slideOut();
  });

  // 离开页面时让遮罩盖住, 便于往返缓存恢复后播放缩小
  window.addEventListener('pagehide', () => {
    if (instantLeave) return; // 无过场离开: 别在离开这瞬间把遮罩盖上
    mask.style.transition = 'none';
    mask.classList.remove('shrink');
    hint.classList.remove('show');
    appendMask();
    void mask.offsetWidth;
    mask.style.transition = '';
  });

  // 导航: 圆从中心扩大盖住屏幕, 再跳转
  function coverAndGo(target) {
    hint.classList.remove('show');
    if (!mask.parentNode) {
      mask.classList.add('shrink');      // 先缩成一点
      appendMask();
      void mask.offsetWidth;            // 强制回流
      mask.classList.remove('shrink');  // 扩大到盖住
    } else {
      mask.classList.remove('shrink');
    }
    // 记录站内导航 (供 history.back/forward 转场使用)
    if (typeof window.__navRecordDeparture === 'function' && !window.__navSkipRecord) {
      window.__navRecordDeparture();
    }
    window.__navSkipRecord = false;
    setTimeout(() => {
      // 转场钱都盖上了, 「加载中」牌子可以收了 (锁着的话离开时会被原生框拦一下)
      if (typeof window.__dismissForaineToast === 'function') window.__dismissForaineToast();
      window.location.href = target;
    }, DURATION);
  }
  window.pageTransitionTo = coverAndGo;

  // 拦截内部链接 (新标签打开/外部链接不拦截)
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (link.target) return;  // 显式 target 不拦截
    if (link.hasAttribute('download')) return;  // 下载链接 (blob: 那套) 不拦截
    const base = document.querySelector('base');
    if (base && base.getAttribute('target')) return;  // base target 不拦截
    const url = new URL(href, window.location.href);
    // blob:/data:/mailto:/tel: 一律放行 —— blob: 的 origin 和页面一样 (继承创建它的文档),
    // 只比 origin 拦不住它: 以前导出 CSV 就被这里 preventDefault, 下载没发生、人却飞到 404
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin !== window.location.origin) return;  // 外部链接不拦截
    e.preventDefault();
    const target = url.pathname + url.search + url.hash;

    // 页面可能注册了「导航前钩子」(文章编辑器有未保存改动时会拦一下),
    // 不问一句就直接 coverAndGo 会把钩子绕过去 (点品牌图就直跳首页、确认框弹了也没用)
    const guard = window.__beforeNavigate;
    if (typeof guard === 'function') {
      Promise.resolve(guard())
        .then((ok) => { if (ok !== false) coverAndGo(target); })
        .catch((err) => {
          console.warn('导航前钩子出错, 已放行:', err);
          coverAndGo(target);
        });
      return;
    }
    coverAndGo(target);
  });
})();

/* 站内导航栈 + history 方法覆盖: 让 history.back/forward/go 也走转场动画 */
(function patchHistoryNavigation() {
  const KEY = '__foraine_nav';

  // 读导航栈
  function load() {
    try {
      const raw = sessionStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        back: Array.isArray(parsed.back) ? parsed.back : [],
        forward: Array.isArray(parsed.forward) ? parsed.forward : []
      };
    } catch (e) {
      return { back: [], forward: [] };
    }
  }
  // 写导航栈
  function save(s) {
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }
  // 当前页地址
  function here() {
    return location.pathname + location.search + location.hash;
  }
  // 走转场跳转 (拿不到转场函数就返回 false, 交给原生)
  function goTo(target) {
    if (typeof window.pageTransitionTo === 'function') {
      window.pageTransitionTo(target);
      return true;
    }
    return false;
  }

  // 站内跳转前记录当前页 (由转场逻辑调用)
  window.__navRecordDeparture = function () {
    const s = load();
    s.back.push(here());
    if (s.back.length > 50) s.back.shift();
    s.forward = [];
    save(s);
  };

  try {
    const proto = History.prototype;
    const origBack = proto.back;
    const origForward = proto.forward;
    const origGo = proto.go;

    proto.back = function () {
      const s = load();
      const prev = s.back.pop();
      if (prev) {
        s.forward.push(here());
        save(s);
        window.__navSkipRecord = true;
        // 列表 ↔ 详情之间免不免过场看 core.js 的开关
        if (typeof LIST_DETAIL_NO_TRANSITION !== 'undefined' && LIST_DETAIL_NO_TRANSITION
            && typeof isListDetailRoundTrip === 'function' && isListDetailRoundTrip(prev)) {
          if (typeof window.__markSkipTransition === 'function') window.__markSkipTransition();
          return origBack.call(this);
        }
        if (goTo(prev)) return;
      }
      return origBack.call(this);
    };

    proto.forward = function () {
      const s = load();
      const next = s.forward.pop();
      if (next) {
        s.back.push(here());
        save(s);
        window.__navSkipRecord = true;
        // 列表 ↔ 详情之间免不免过场看 core.js 的开关
        if (typeof LIST_DETAIL_NO_TRANSITION !== 'undefined' && LIST_DETAIL_NO_TRANSITION
            && typeof isListDetailRoundTrip === 'function' && isListDetailRoundTrip(next)) {
          if (typeof window.__markSkipTransition === 'function') window.__markSkipTransition();
          return origForward.call(this);
        }
        if (goTo(next)) return;
      }
      return origForward.call(this);
    };

    proto.go = function (delta) {
      if (delta === -1) { this.back(); return; }
      if (delta === 1) { this.forward(); return; }
      return origGo.call(this, delta);
    };
  } catch (e) {
    console.warn('覆盖 history 方法失败:', e);
  }
})();
