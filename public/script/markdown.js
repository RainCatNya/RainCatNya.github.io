/* markdown.js Markdown 渲染 */
/*
  内容: 块级(标题/引用/列表/分隔线/段落/围栏代码块/公式) + 行内语法 + @提及 + 代码块折叠与复制
  依赖: core.js(escapeHtml) / highlight.js(highlightLines) / latex.js(renderLatex/texDecodeEntities)
        ui.js(showToast) / transition.js(pageTransitionTo)
  安全: 先抽围栏代码块与公式 → 正文整体转义 → 最后替换语法; 链接仅 http(s)
  换行: 单个回车只当空格, 行尾两个以上空格或 <br> 才断行, 空行才是分段
*/

function renderMarkdown(source) {
  const raw = String(source ?? '');
  const codeBlocks = [];
  const mathList = []; // 公式原文, 最后一步才渲染

  // 1) 从原文抽围栏代码块 (高亮要原文), 围栏后那串 = 语言名
  let text = raw.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (match, info, code) => {
    const idx = codeBlocks.length;
    // 收尾要吃掉最后的换行与「只有空白的一行」, 否则代码块尾部多一行空行
    codeBlocks.push({ lang: info.trim(), code: code.replace(/\n[ \t]*$/, '') });
    return `\u0000CODE${idx}\u0000`;
  });

  // 2) 抽独立公式 $$…$$ (代码块已成占位符, 不会误伤), 再从原文拿 tex
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
    const idx = mathList.length;
    mathList.push({ tex, display: true });
    return `\u0003MTH${idx}\u0003`;
  });

  // 3) 跨块的 <secret> 栅栏先整段脱掉 (行内那一步是逐段跑的, 只看得到单行)
  if (text.indexOf('<secret') >= 0) {
    text = text.replace(SECRET_BLOCK_RE, (m, expr, inner) => (
      inner.indexOf('\n') >= 0 && secretExprLooksValid(expr) ? inner : m
    ));
  }

  const escaped = escapeHtml(text);

  const lines = escaped.split('\n');
  const out = [];
  let inQuote = false;
  let listType = null; // 'ul' | 'ol'
  let headingCounter = 0;

  // 段落缓冲: 已累积 HTML + 上一行原文(paraRaw 决定补不补空格) + 上一行是否硬换行
  let paraHtml = '';
  let paraRaw = '';
  let paraHard = false;

  // 行尾两个及以上空格 = 硬换行
  const hasHardBreak = (s) => /[ \t]{2,}$/.test(s);
  const stripHardBreak = (s) => s.replace(/[ \t]+$/, '');

  function joinSep(prev, next) {
    return /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next) ? ' ' : '';
  }

  function addLine(content, hard) {
    if (!paraHtml) {
      paraHtml = content;
    } else {
      paraHtml += (paraHard ? '<br>' : joinSep(paraRaw, content)) + content;
    }
    paraRaw = content;
    paraHard = hard;
  }

  function flushPara() {
    if (!paraHtml) return;
    out.push(`<p>${inlineMarkdown(paraHtml, mathList)}</p>`);
    paraHtml = '';
    paraRaw = '';
    paraHard = false;
  }

  function closeQuote() {
    if (inQuote) {
      flushPara();
      out.push('</blockquote>');
      inQuote = false;
    }
  }

  function closeList() {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  }

  // 遇到「不属于当前块的下一行」时收尾 引用 / 列表 / 段落
  function closeBlocks() {
    closeQuote();
    closeList();
    flushPara();
  }

  for (const line of lines) {
    // 占位符行允许前后带空白 (缩进的围栏会带进来), 否则会漏进段落显示成字面「CODE0」
    const codeMatch = line.match(/^[ \t]*\u0000CODE(\d+)\u0000[ \t]*$/);
    if (codeMatch) {
      closeBlocks();
      out.push(renderCodeBlock(codeBlocks[Number(codeMatch[1])]));
      continue;
    }
    const mathMatch = line.match(/^\u0003MTH(\d+)\u0003$/);
    if (mathMatch) {
      closeBlocks();
      out.push(renderLatex(mathList[Number(mathMatch[1])]));
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeBlocks();
      out.push('<p class="md-empty"></p>');
      continue;
    }
    // 标题: # → h2 … (文章标题本身是 h1, 整体下移一级)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeBlocks();
      const level = Math.min(headingMatch[1].length + 1, 6);
      headingCounter += 1;
      out.push(
        `<h${level} id="h-${headingCounter}" class="md-heading">${inlineMarkdown(headingMatch[2], mathList)}</h${level}>`
      );
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      if (!inQuote) {
        closeList();
        flushPara();
        out.push('<blockquote class="md-quote">');
        inQuote = true;
      }
      const quoteLine = line.replace(/^&gt;\s?/, '');
      addLine(stripHardBreak(quoteLine), hasHardBreak(quoteLine));
      continue;
    }
    // 列表: - / * 无序, 1. 有序; 必须是「符号 + 空格」, 否则 *斜体* 会被误判
    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const olMatch = ulMatch ? null : line.match(/^\s*\d{1,9}[.)]\s+(.+)$/);
    if (ulMatch || olMatch) {
      closeQuote();
      flushPara();
      const want = ulMatch ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want} class="md-list">`);
        listType = want;
      }
      out.push(`<li>${inlineMarkdown((ulMatch || olMatch)[1], mathList)}</li>`);
      continue;
    }
    // 分隔线: 独占一行的 3 个以上 - / * / _ (排在列表之后, 免得吃掉 --- 与 ***粗斜体***)
    if (/^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/.test(line)) {
      closeBlocks();
      out.push('<hr class="md-hr">');
      continue;
    }
    // 普通段落进缓冲, 等空行 / 块级元素才成段
    addLine(stripHardBreak(line), hasHardBreak(line));
  }
  closeBlocks();

  // 最后一步: 公式占位符 → HTML (行内与独立共用同一个数组)
  return out.join('\n')
    .replace(/\u0003MTH(\d+)\u0003/g, (m, i) => {
      const item = mathList[Number(i)];
      return item ? renderLatex(item) : '';
    })
    // 兜底: 漏网的代码块占位符就地渲染, 绝不让「CODE0」字面漏到页面上
    .replace(/\u0000CODE(\d+)\u0000/g, (m, i) => {
      const block = codeBlocks[Number(i)];
      return block ? renderCodeBlock(block) : '';
    });
}

function safeUrl(url) {
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(url)) return '#';
  return url.replace(/"/g, '%22').replace(/'/g, '%27');
}

// 图片额外放行站内绝对路径 (单斜杠开头且后面没有冒号, 挡掉 //host 与 javascript:)
function safeImageUrl(url) {
  const raw = String(url || '');
  if (/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return raw.replace(/"/g, '%22').replace(/'/g, '%27');
  if (/^\/(?!\/)[^:\s"'<>]*$/.test(raw)) return raw;
  return '#';
}

/* ==================== 代码块 ==================== */
// 形制照 双葉橘: 语言标签 + 悬停出现的复制键 + 一行一个 span.md-line (行号由 CSS 计数器画)
const CODE_COPY_ICON = '<span class="md-code-ready"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"></path></svg></span>'
  + '<span class="md-code-copied">已复制</span>';

// 属性值转义: 引号也得自己补 (core.js 的 escapeHtml 只管 &<>)
function escapeAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 行内文本进属性: 正文已整体转义, 这里只补引号 (再 escapeAttr 会二次转义成 &amp;amp;)
function escapeAttrQuotes(text) {
  return String(text ?? '').replace(/"/g, '&quot;');
}

function renderCodeBlock(block) {
  const lang = (block.lang || '').toLowerCase() || 'txt';
  const lines = (typeof highlightLines === 'function')
    ? highlightLines(block.code, lang)
    : block.code.split('\n').map(escapeHtml);
  // 行之间不能留换行符 (.md-line 是 block 而 code 上 white-space: pre, 会渲染成空行)
  const body = lines.map((line) => '<span class="md-line">' + line + '</span>').join('');
  return '<div class="md-code" data-lang="' + escapeAttr(lang) + '">'
    + '<span class="md-code-lang">' + escapeAttr(lang) + '</span>'
    + '<button type="button" class="md-code-copy" aria-label="复制代码" title="复制代码" data-code="'
    + escapeAttr(block.code) + '">' + CODE_COPY_ICON + '</button>'
    + '<pre><code>' + body + '</code></pre>'
    + '</div>';
}

/* ==================== 长代码块折叠 ==================== */
// 结构在 DOM 里补, renderMarkdown 的产物一个字节都不动 (测试断言的是原来那串 HTML)
const MD_COLLAPSE_LINES = 5; // 超过这个行数才折

const MD_ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
const MD_ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"></path></svg>';

// 给容器(正文 / 预览弹窗)里还没处理过的代码块装上折叠
function setupCodeBlocks(root) {
  const scope = root || document;
  const boxes = scope.querySelectorAll ? scope.querySelectorAll('.md-code:not([data-code-ready])') : [];
  Array.prototype.forEach.call(boxes, (box) => {
    box.setAttribute('data-code-ready', '');
    const code = box.querySelector('pre code');
    const pre = box.querySelector('pre');
    if (!code || !pre) return;

    // 末尾那个空行 (代码以换行结尾时会产生) 不算, CSS 本来就把它藏掉了
    let lines = Array.prototype.slice.call(code.querySelectorAll('.md-line'));
    if (lines.length && !lines[lines.length - 1].textContent) lines = lines.slice(0, -1);
    if (lines.length <= MD_COLLAPSE_LINES) return; // 5 行以内不折

    // 现有内容整体挪进裁剪层 (定位基准 .md-code → .md-code-scroll, 位置不变)
    const scroll = document.createElement('div');
    scroll.className = 'md-code-scroll';
    while (box.firstChild) scroll.appendChild(box.firstChild);
    box.appendChild(scroll);

    const fade = document.createElement('span');
    fade.className = 'md-code-fade';
    fade.setAttribute('aria-hidden', 'true');
    scroll.appendChild(fade);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-code-expand';
    btn.innerHTML = '<span class="md-code-arrow md-code-arrow-down">' + MD_ARROW_DOWN + '</span>'
      + '<span class="md-code-arrow md-code-arrow-up">' + MD_ARROW_UP + '</span>';
    box.appendChild(btn);

    const setLabel = (expanded) => {
      const text = expanded ? '收起代码' : '展开代码';
      btn.title = text;
      btn.setAttribute('aria-label', text);
      btn.setAttribute('aria-expanded', String(expanded));
    };
    setLabel(false);
    box.classList.add('is-collapsible', 'is-collapsed');

    btn.addEventListener('click', (event) => {
      event.stopPropagation(); // 代码块在卡片里时别把点击传到外层
      // scrollHeight 不受 max-height 影响, 折叠着也能拿到完整高度
      const full = scroll.scrollHeight;
      const expanded = !box.classList.contains('is-expanded');
      box.classList.toggle('is-expanded', expanded);
      box.classList.toggle('is-collapsed', !expanded);
      scroll.style.maxHeight = expanded ? full + 'px' : '';
      setLabel(expanded);

      btn.classList.remove('is-press');
      void btn.offsetWidth;
      btn.classList.add('is-press');
    });
    btn.addEventListener('animationend', () => btn.classList.remove('is-press'));
  });
}

// 复制键委派到 document (代码块出现在正文与预览弹窗两处, 且是事后插进 DOM 的)
document.addEventListener('click', (event) => {
  const btn = event.target && event.target.closest ? event.target.closest('.md-code-copy') : null;
  if (!btn) return;
  const code = btn.dataset.code || '';
  const done = () => {
    btn.classList.add('is-copied');
    setTimeout(() => btn.classList.remove('is-copied'), 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => showToast('复制失败，请手动选中', 'error'));
  } else {
    const box = document.createElement('textarea');
    box.value = code;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try { document.execCommand('copy'); done(); } catch (err) { showToast('复制失败，请手动选中', 'error'); }
    box.remove();
  }
});

// 正文配图点开放大已整块搬到 ui.js (聊天气泡也要用), 别在这里再加一份

/* ==================== <view …>: 观看者信息 ==================== */
/* 页面拿到 /api/me 之后调 setViewContext 填上; 没填 / 没登录一律 unknown / null。
   ⚠️ time 用「请求这篇文章的那一刻」(页面记下来再传进来), 不是渲染的那一刻 */
let VIEW_CTX = null;
function setViewContext(ctx) { VIEW_CTX = ctx || null; }

// foraine 权限等级: 环上那五档, 越靠后越高 (同时持有就报最高的那一个)
const VIEW_LEVELS = ['iota', 'vapor', 'xenon', 'wreck', 'omega'];

function viewLevelOf(list) {
  let best = -1;
  for (const one of list || []) {
    const name = String(one || '').toLowerCase();
    if (name.slice(0, 8) !== 'foraine.') continue;      // 只看 foraine.* 那一族
    const idx = VIEW_LEVELS.indexOf(name.slice(8));
    if (idx > best) best = idx;
  }
  return best;
}

// 时间文本用与正文其它时间同一个写法 (core.js 的 formatTime), 没加载就退回本地格式
function formatViewTime(ms) {
  if (typeof formatTime === 'function') {
    try { return formatTime(ms); } catch (err) { /* 兜底往下走 */ }
  }
  return new Date(ms).toLocaleString();
}

function viewValue(kind) {
  const ctx = VIEW_CTX || {};
  const now = ctx.time || Date.now();
  switch (String(kind).toLowerCase()) {
    case 'user': return ctx.user || 'unknown';
    case 'nickname': return ctx.nickname || 'unknown';
    case 'time': return String(now);
    case 'timestr': return formatViewTime(now);
    case 'permission': {
      const level = viewLevelOf(ctx.permissions);
      if (level < 0) return 'null';
      const name = VIEW_LEVELS[level];
      return name[0].toUpperCase() + name.slice(1);
    }
    default: return '';
  }
}

function inlineMarkdown(text, mathList, opts) {
  const no = opts || {};
  let s = text;
  const inlineCodes = [];
  const safeLinks = []; // 已经生成的 <a>…</a> (链接 / 裸链接): @提及 不许钻进去
  const math = mathList || [];

  s = s.replace(/`([^`]+)`/g, (m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\u0001INL${idx}\u0001`;
  });
  // 行内公式必须排在代码之后、其它行内语法之前 (公式里的 _ * [ \ 不能被当成语法)
  s = s.replace(/\$(\S[^$\n]*?)\$/g, (m, tex) => {
    const idx = math.length;
    // 这里的 tex 取自已经转义过的正文 → 先解回原文 (见 latex.js 的 texDecodeEntities)
    math.push({ tex: texDecodeEntities(tex), display: false });
    return `\u0003MTH${idx}\u0003`;
  });
  // 显式换行 <br>: 源码里的尖括号已被转义, 这里还原成真标签 (代码里的保持字面)
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');

  /* ---------- 文章的自定义行内标记 ----------
     ⚠️ 「什么算合法」跟 worker.js 的 src/view-permission.js 是一套判定, 改一边要跟着改另一边 */
  // 零宽字符: <zwsp> / <zwj> / <zwnj> (标签名里可能混进看不见的零宽字符, 一起容忍)
  if (!no.noZeroWidth) s = s.replace(/&lt;[\u200b-\u200d]*(zwsp|zwj|zwnj)[\u200b-\u200d]*&gt;/gi, (m, name) => (
    { zwsp: '\u200B', zwj: '\u200D', zwnj: '\u200C' }[name.toLowerCase()] || ''
  ));
  // 审查条: 里面有几个字就几个方块 (方块用 currentColor = 与所处文本同色)
  s = s.replace(/&lt;censored&gt;([\s\S]*?)&lt;\/censored&gt;/gi, (m, inner) => {
    const squares = censoredSquares(inner);
    if (!squares.length) return '';
    return '<span class="md-censored">'
      + squares.map((wide) => (wide ? '<i></i>' : '<i class="is-narrow"></i>')).join('')
      + '</span>';
  });
  // 剧透: 上面盖一层亚克力, 点一下渐隐 (点击在文件末尾的 document 监听里)
  s = s.replace(/&lt;spoiler&gt;([\s\S]*?)&lt;\/spoiler&gt;/gi, (m, inner) => (
    '<span class="md-spoiler" role="button" tabindex="0">' + inner + '</span>'
  ));
  // 荧光笔标记
  s = s.replace(/&lt;notice&gt;([\s\S]*?)&lt;\/notice&gt;/gi, '<span class="md-notice">$1</span>');
  // 下划线 (与 ++…++ 同一个输出)
  s = s.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi, '<u>$1</u>');
  // 指定字体: <font XNS>…</font>; 认不出的字体名原样留着 (让作者看见写错了)
  if (!no.noFont) s = s.replace(FONT_TAG_RE, (m, name, inner) => {
    const family = FONT_TAGS[String(name).toLowerCase()];
    return family ? '<span class="md-font" style="font-family:' + family + '">' + inner + '</span>' : m;
  });
  // 渐变文字: <gradient=#aaa>…</gradient=#bbb>; 哪一端没给颜色就用所处文本的颜色
  s = s.replace(GRADIENT_RE, (m, from, inner, to) => (
    '<span class="md-gradient" style="--md-grad-from:' + (from || 'currentColor')
    + ';--md-grad-to:' + (to || 'currentColor') + '">' + inner + '</span>'
  ));
  // 观看者信息: <view user|nickname|time|timestr|permission> (没有闭合标签, 直接换成值)
  s = s.replace(/&lt;view\s+(user|nickname|time|timestr|permission)\s*&gt;/gi, (m, kind) => viewValue(kind));
  /* 查看权限: 不满足条件的整段在服务端就删了, 这里只把留下来的标签脱掉
     (作者自己看 / 编辑器预览靠这一步); 条件写错的原样留着, 让人一眼看出写错了 */
  if (!no.noSecret) s = s.replace(/&lt;secret='([^']*)'&gt;([\s\S]*?)&lt;\/secret&gt;/gi, (m, expr, inner) => (
    secretExprLooksValid(expr) ? inner : m
  ));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\+\+([^+]+)\+\+/g, '<u>$1</u>');
  // 图片必须排在链接前面 (否则 ![x](y) 里的 [x](y) 先被吃掉, 感叹号孤零零留着)
  // alt = 「表情」→ .md-emoji, 由 CSS 压成 16x16 的行内小图
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const src = safeImageUrl(url);
    if (src === '#') return m; // 地址不合法就原样留着, 不生成 img
    const emoji = String(alt).trim() === '表情';
    return `<img class="${emoji ? 'md-img md-emoji' : 'md-img'}" src="${src}" alt="${escapeAttrQuotes(alt)}" loading="lazy" decoding="async">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // 裸链接: 字符类必须排掉占位符与中文标点 (否则 URL 紧贴行内代码时会被整段吞进 href)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"'\u0001\u0002\u0003，。、！？；：（）「」『』《》【】]+)/g, (m, pre, url) => {
    return `${pre}<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  // 已生成的 <a> 先收起来, 否则 @提及 会钻进链接里造出 <a><a></a></a> 的非法嵌套
  s = s.replace(/<a\s[^>]*>[\s\S]*?<\/a>/g, (m) => {
    const idx = safeLinks.length;
    safeLinks.push(m);
    return `\u0002BLK${idx}\u0002`;
  });
  // @提及 (站内用户)
  s = s.replace(MENTION_RE, (m, pre, name) => (
    `${pre}<a class="md-mention" href="/u/${encodeURIComponent(name)}"`
    + ` data-mention="${escapeAttrQuotes(name)}">@${name}</a>`
  ));
  s = s.replace(/\u0002BLK(\d+)\u0002/g, (m, i) => safeLinks[Number(i)]);
  s = s.replace(/\u0001INL(\d+)\u0001/g, (m, i) => `<code>${inlineCodes[Number(i)]}</code>`);
  return s;
}

/* 标题 / 简介那类「单独一行」的位置: 走同一条行内管线, 但**不解析** secret / 零宽 / font ——
   secret 服务端只在正文上过滤 (标题里的会漏给所有人), 零宽在标题里就是几个看不见的东西,
   font 那支字体子集 1.4MB, 不给标题用。它自己先转义一遍 (inlineMarkdown 收的是已转义的串) */
function inlinePlain(text) {
  const math = [];
  const src = String(text === undefined || text === null ? '' : text);
  let html = inlineMarkdown(escapeHtml(src), math, { noSecret: true, noZeroWidth: true, noFont: true });
  if (math.length) {
    html = html.replace(/\u0003MTH(\d+)\u0003/g, (m, i) => {
      const item = math[Number(i)];
      return item && typeof renderLatex === 'function' ? renderLatex(item) : '';
    });
  }
  return html;
}
/* ==================== 文章的自定义行内标记 ==================== */
/* 审查条每个方块该多宽: 中日韩 / 全角字符算一个字宽 (1em), 半角 (ASCII 这种) 算半个 (0.5em)。
   实体 (&amp; / &#39;) 算一个字 —— 跟以前一样按「可见字符数」数 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const CENSORED_MAX = 600;

// → 每个可见字符一个布尔值 (true = 一个字宽)
function censoredSquares(text) {
  const s = String(text === undefined || text === null ? '' : text).replace(/&[a-zA-Z]+;|&#\d+;/g, '\u0000');
  const out = [];
  for (let i = 0; i < s.length && out.length < CENSORED_MAX; i += 1) {
    const code = s.codePointAt(i);
    if (code > 0xFFFF) { out.push(true); i += 1; continue; }   // 代理对 (emoji / 生僻字) 算一个字宽
    out.push(WIDE_CHAR.test(s[i]));
  }
  return out;
}

// 渐变: <gradient=#aaa>…</gradient=#bbb>, 两端颜色都可以省 (省了就取所处文本的颜色)
const GRADIENT_RE = /&lt;gradient(?:\s*=\s*(#[0-9a-fA-F]{3,8}))?\s*&gt;([\s\S]*?)&lt;\/gradient(?:\s*=\s*(#[0-9a-fA-F]{3,8}))?\s*&gt;/g;

// 指定字体: <font XNS>…</font>; 目前只有 XNS = 手写体「想念是枫糖海盐味」
// 用大子集 (--font-hand-body, 1394KB): @font-face 只在有文字真的用它时才会下 —— 没写 <font XNS> 的页面不会多下
const FONT_TAG_RE = /&lt;font\s+([A-Za-z0-9_-]+)\s*&gt;([\s\S]*?)&lt;\/font&gt;/gi;
const FONT_TAGS = { xns: 'var(--font-hand-body)' };
/* 跨块的 <secret='…'> 栅栏: 开标签与闭合标签之间隔了空行 / 标题等块级语法。
   行内那一步是逐段跑的, 只看得到单行 → 这种在 renderMarkdown 分行之前先整段脱掉 */
const SECRET_BLOCK_RE = /<secret='([^']*)'>([\s\S]*?)<\/secret>/gi;
/* <secret='…'> 的条件像不像合法 —— 跟 worker.js 的 src/view-permission.js 是同一套写法, 改一边要改两边。
   语法不对的一律返回 false (标籾原样留在正文里, 让作者看见自己写错了) */
function secretExprLooksValid(expr) {
  const t = String(expr === undefined || expr === null ? '' : expr).trim().split(/\s+/).filter(Boolean);
  if (!t.length) return false;
  const head = t[0].toUpperCase();
  const i = (head === 'HAS' || head === 'HASNOT') ? 1 : 0;
  const kind = (t[i] || '').toUpperCase();
  if (kind === 'EXACTLY' || kind === 'GLOBALLY') return t.length > i + 1;
  if (kind === 'DATE') {
    const op = (t[i + 1] || '').toUpperCase();
    return (op === 'AFTER' || op === 'BEFORE') && /^\d{1,16}$/.test(t[i + 2] || '');
  }
  if (kind === 'USER') {
    const op = (t[i + 1] || '').toUpperCase();
    return (op === 'WITH' || op === 'WITHOUT') && t.length > i + 2;
  }
  return false;
}

// 剧透: 点一下 (或回车 / 空格) 把亚克力遮罩渐隐
document.addEventListener('click', (event) => {
  const el = event.target && event.target.closest ? event.target.closest('.md-spoiler') : null;
  if (!el || el.classList.contains('is-open')) return;
  el.classList.add('is-open');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target && event.target.closest ? event.target.closest('.md-spoiler') : null;
  if (!el) return;
  event.preventDefault();
  el.classList.add('is-open');
});

/* ==================== @提及 (站内用户) ==================== */
// 四条规则: 前面不能是字母数字/./-/@// (挡邮箱与 URL), 名字与注册规则一致, 后面不能紧跟 .字母
const MENTION_RE = /(^|[^\w.@/-])@([A-Za-z0-9](?:[A-Za-z0-9_-]{0,28}[A-Za-z0-9])?)(?![\w-]|\.[A-Za-z0-9])/g;

// asyfunc 一次问完这批 @提及 的用户在不在 (精确匹配用户名): 命中 → 昵称 + .is-user, 没命中 → 普通链接
async function setupMentions(root) {
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  const tags = Array.prototype.slice.call(scope.querySelectorAll('a.md-mention:not([data-mention-done])'));
  if (!tags.length) return;

  const names = [];
  tags.forEach((tag) => {
    tag.setAttribute('data-mention-done', ''); // 只查一次 (正文与预览可能都走一遍)
    const name = tag.getAttribute('data-mention') || '';
    if (name && names.indexOf(name) < 0) names.push(name);
  });
  if (!names.length) return;

  try {
    const response = await fetch('/api/users/exists?names=' + encodeURIComponent(names.join(',')), { cache: 'no-store' });
    const data = await response.json();
    const exists = {};
    (data.users || []).forEach((u) => {
      const name = (u && u.username) ? u.username : String(u || '');
      if (!name) return;
      exists[name] = { username: name, nickname: (u && u.nickname) || name };
    });
    tags.forEach((tag) => {
      const hit = exists[tag.getAttribute('data-mention') || ''];
      if (!hit) return;
      tag.textContent = '@' + hit.nickname; // 展示昵称 (textContent 不会吃 HTML)
      tag.setAttribute('href', '/u/' + encodeURIComponent(hit.username));
      tag.setAttribute('title', '@' + hit.username); // 悬停能看到真正的用户名
      tag.classList.add('is-user');
    });
  } catch (err) {
    console.warn('查询提及用户失败:', err);
  }
}

/* 点提及 = 站内跳转 (导航按钮用的同一个过场函数), 不整页刷新; 修饰键点击不拦 */
document.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('a.md-mention') : null;
  if (!link) return;
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (typeof window.pageTransitionTo !== 'function') return;
  event.preventDefault();
  window.pageTransitionTo(link.getAttribute('href'));
});
