/* i18n.js 全站文案 (界面框架层) */
/*
  内容: 语言包读取 / data-i18n 替换 / I18N.t(key) 取词 / 语言清单
  依赖: 无 (放在 core.js 之前, 谁先加载都行)

  用法:
    HTML 静态文字 —— <button data-i18n="nav.resource">资源</button>
      data-i18n              → 换 textContent
      data-i18n-title        → 换 title, 顺带把 aria-label 也换掉 (图标按钮都用它)
      data-i18n-placeholder  → 换 placeholder
    脚本里 —— I18N.t('nav.resource'), 缺项时回退中文, 再缺回退传进来的原文
    带数据的句子 —— I18N.t('key', '已填入：{value}', { value: label }), 词条里写 {value}
    省掉原文 —— I18N.t('key', { value: label }), 这时中文原文只写在词条里 (t 的第二个参数传对象就是 vars)
    静态元素带数据 —— <option data-i18n="value.lines" data-i18n-value="50">, 词条里的 {value} 会填 50
*/

(function initI18n() {
  const STORAGE_KEY = 'foraine.lang';
  // ⚠️ 必须与语言包文件名逐字一致 (它就是兜底包 + /lang/<code>.jsonc 的拼名依据)
  const DEFAULT_LANG = 'zh-CN';
  // 加一门语言: 这里加一行 + 放一份 /lang/<code>.json
  const LANGS = [
    { code: 'zh-CN', label: '中文（简体）' },
    { code: 'en-US', label: 'English (US)' },
    { code: 'ja-JP', label: '日本語（日本）' },
    { code: 'foraine-Raincat', label: 'Foraine (Raincat)' },
    { code: 'lzh-Hans', label: '文言（华夏）'},
    { code: 'custom', label: '自定'}
  ];

  /* 语言优先级: 手动选过 > 访客 IP (worker.js 往 head 里塞的 meta) > 中文基准 */
  const readLang = () => {
    try {
      const saved = (localStorage.getItem(STORAGE_KEY) || '').trim();
      if (LANGS.some((item) => item.code === saved)) return saved;
    } catch (err) { /* 隐私模式读不到, 接着按 IP 猜 */ }
    const hint = document.querySelector('meta[name="foraine-ip-lang"]');
    const hinted = ((hint && hint.content) || '').trim();
    return LANGS.some((item) => item.code === hinted) ? hinted : DEFAULT_LANG;
  };

  let lang = readLang();
  let table = {};      // 当前语言的词表
  let fallback = {};   // 中文兜底

  // 取词: 当前语言的非空值 → 中文 → 传进来的原文 → null (null = 别动它, 页面上原样留着)
  // 空值当「还没翻」, 所以语言包里留空 = 退回中文, 可以一句一句慢慢填
  const read = (bag, key) => {
    const value = bag[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  /* 带数据的句子: 词条里写 {名称}, 取词时把 vars 填进去。漏传的占位符原样留着 (好找出漏的那处)。
     整句不固定的文案走不了 data-i18n —— 那个是整串替换, 拼出来的字它认不出 */
  const fill = (text, vars) => {
    if (text === null || !vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
      vars[name] === undefined || vars[name] === null ? whole : String(vars[name])
    ));
  };

  /* t 的三种写法: t(key) / t(key, '原文') / t(key, { value }) —— 第二个参数是对象就当 vars。
     省掉原文那种写法以「词条里有中文」为前提, 真查不到就把 key 亮出来 (好知道漏了哪条) */
  const t = (key, original, vars) => {
    const asVars = !!original && typeof original === 'object';
    if (asVars) { vars = original; original = undefined; }
    const text = read(table, key) || read(fallback, key) || (original === undefined ? null : original);
    return fill(text === null && asVars ? key : text, vars);
  };

  /* data-i18n-value="50" 取出来给词条里的 {value} 用; 纯数字转成 Number, 其余原样当字符串 (也能塞一个词) */
  const valueVars = (node) => {
    const raw = node.dataset.i18nValue;
    if (raw === undefined || raw === '') return undefined;
    return { value: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw };
  };

  function paint(node) {
    // 有子元素的（头像按钮那种）不动 —— 整体换 textContent 会把里面的图标抹掉
    if (node.children.length) return;
    const text = t(node.dataset.i18n, valueVars(node));
    if (text !== null && node.textContent !== text) node.textContent = text;
  }
  function paintTitle(node) {
    const text = t(node.dataset.i18nTitle);
    if (text === null || node.title === text) return;
    node.title = text;
    if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', text);
  }
  function paintPlaceholder(node) {
    const text = t(node.dataset.i18nPlaceholder);
    if (text !== null && node.placeholder !== text) node.placeholder = text;
  }

  // asyfunc 替换一棵子树 (不传就是整页); 新插进 DOM 的节点由下面的监听兜住
  function apply(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-i18n]').forEach(paint);
    scope.querySelectorAll('[data-i18n-title]').forEach(paintTitle);
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(paintPlaceholder);
    if (scope.dataset) {
      if (scope.dataset.i18n) paint(scope);
      if (scope.dataset.i18nTitle) paintTitle(scope);
      if (scope.dataset.i18nPlaceholder) paintPlaceholder(scope);
    }
  }

  // asyfunc 换语言: 存设备偏好 + 重载 (文案已经散在页面与脚本里, 重载最省事也最一致)
  function setLang(code) {
    if (!LANGS.some((item) => item.code === code)) return;
    try { localStorage.setItem(STORAGE_KEY, code); } catch (err) { /* 隐私模式就算了 */ }
    lang = code;
    // 重载前收掉「加载中」牌子, 否则会被原生「确定要离开吗」拦一下
    if (typeof window.__dismissForaineToast === 'function') window.__dismissForaineToast();
    location.reload();
  }

  // 语言包是 jsonc: 允许写 // 与 /* */ 注释, 解析前先剥掉
  // 逐字符扫 —— 字符串里的 // (https:// 那种) 不能当注释
  const stripComments = (text) => {
    let out = '';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];
      if (quote) {
        out += ch;
        if (ch === '\\') { out += next || ''; i += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"') { quote = ch; out += ch; continue; }
      if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  };

  // asyfunc 读一份语言包: 先找 .jsonc, 没有再退回 .json; 都读不到就当空表 (回退中文)
  async function loadTable(code) {
    for (const ext of ['jsonc', 'json']) {
      try {
        const res = await fetch('/lang/' + code + '.' + ext, { cache: 'no-store' });
        if (!res.ok) continue;
        const text = await res.text();
        /* 站点是 SPA fallback: 不存在的路径也回 200 (内容是一页 HTML)。
           直接丢给 JSON.parse 会抛错被吞掉, 表现就是「切了语言但整页还是中文」, 很难查 */
        if (!/^\s*[{[]/.test(text)) continue;
        return JSON.parse(stripComments(text));
      } catch (err) { /* 换下一个后缀 / 这份包坏了就当没翻 */ }
    }
    console.warn('语言包读不到 (或格式有问题), 退回中文:', code);
    return {};
  }

  async function boot() {
    table = await loadTable(lang);
    if (lang !== DEFAULT_LANG) fallback = await loadTable(DEFAULT_LANG);
    document.documentElement.lang = lang;
    apply(document);
    // 新插进 DOM 的节点与属性变化都要补一次翻译, 否则那一条永远不生效
    if (window.MutationObserver) {
      new MutationObserver((records) => {
        records.forEach((record) => {
          if (record.type === 'attributes') { apply(record.target); return; }
          Array.prototype.forEach.call(record.addedNodes, (node) => {
            if (node && node.nodeType === 1) apply(node);
          });
        });
      }).observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-value']
      });
    }
  }

  window.I18N = { t, apply, setLang, LANGS, get lang() { return lang; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
