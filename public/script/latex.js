/* latex.js 轻量 LaTeX 渲染 */
/*
  内容: 手写一个实用子集给 markdown.js 用; 不挂 KaTeX 是因为 CDN 脚本 + 数学字体约 1MB, 断网就整块公式消失
  依赖: markdown.js(renderLatex) / page-article.css 里的 .md-math-*
*/
// 支持: $x^2$ 行内公式 · $$..$$ 独立公式 (独占一行居中小) · \frac \sqrt[3]{} · ^ _ 上下标
//       \alpha 等希腊字母与符号 · \sin 等函数名 (正体) · \text{} \mathrm{} \mathbf{} \mathcal{} 字体变体
//       \overline \underline \vec \hat \bar 上下划线与重音 · \left( \right] 定界符 (尺寸命令忽略)
//       \, \; \quad 各类间距 · \\ 独立公式换行 · \begin{} 环境壳子丢掉、内容照渲染
// 不支持矩阵 / 对齐列 / 宏定义 / \label, 遇到就当普通文字; 写错了也原样显示那一串, 不会静默吞掉
// 安全: 输出文本一律过 texEsc(), 命令只生成下面这些写死的标签, 公式里塞 HTML 也跑不起来
const LATEX_SYMBOLS = {
  // 希腊字母
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 运算符与关系
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡',
  approx: '≈', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
  // 集合与逻辑
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
  therefore: '∴', because: '∵',
  // 大算符
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
  // 箭头
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹',
  mapsto: '↦', uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
  // 其它常用
  infty: '∞', partial: '∂', nabla: '∇', angle: '∠', perp: '⊥', parallel: '∥',
  degree: '°', circ: '∘', prime: '′', ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  quad: '\u2003', qquad: '\u2003\u2003', enspace: '\u2002',
  ',': '\u2009', ';': '\u2005', ':': '\u2005', '!': '', ' ': ' ', thinspace: '\u2009'
};

// 函数名 (排成正体, 不然 sin 会变成 s·i·n 斜体三连)
const LATEX_FUNCS = [
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'limsup',
  'liminf', 'sup', 'inf', 'min', 'max', 'det', 'dim', 'ker', 'deg', 'gcd',
  'arg', 'Pr', 'mod', 'bmod', 'pmod'
];

// \left / \right 后面的定界符
const LATEX_DELIMS = {
  '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '/': '/', '.': '',
  '\\{': '{', '\\}': '}', '\\|': '‖', '\\vert': '|', '\\Vert': '‖',
  '\\langle': '⟨', '\\rangle': '⟩', '\\lceil': '⌈', '\\rceil': '⌉',
  '\\lfloor': '⌊', '\\rfloor': '⌋', '\\backslash': '\\'
};

// 上/下划线类的标记
const LATEX_MARKS = {
  overline: 'md-math-overline', bar: 'md-math-overline',
  underline: 'md-math-underline',
  vec: 'md-math-accent', hat: 'md-math-accent', widehat: 'md-math-accent',
  tilde: 'md-math-accent', widetilde: 'md-math-accent',
  dot: 'md-math-accent', ddot: 'md-math-accent', check: 'md-math-accent'
};
const LATEX_MARK_CHARS = {
  vec: '→', hat: '^', widehat: '^', tilde: '~', widetilde: '~',
  dot: '˙', ddot: '¨', check: 'ˇ'
};

// 字体变体
const LATEX_FONTS = {
  mathbf: 'md-math-bf', bm: 'md-math-bf', textbf: 'md-math-bf',
  mathcal: 'md-math-cal', mathscr: 'md-math-cal',
  mathsf: 'md-math-sf', mathtt: 'md-math-tt',
  mathit: 'md-math-rm', mathrm: 'md-math-rm', textrm: 'md-math-rm',
  text: 'md-math-rm', textnormal: 'md-math-rm', operatorname: 'md-math-op'
};

// 转义 & < >
function texEsc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 行内公式是从已经转义过的正文里抽出来的, 所以先还原回用户写的原文再渲染 (否则 $<x>$ 会被二次转义成 &amp;lt;);
   必须一遍扫完, 不能写成连着的 replace —— 分两步会把用户字面的 &lt; 多解一层 */
function texDecodeEntities(text) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return String(text).replace(/&(amp|lt|gt|quot|#39);/g, (m, name) => map[name]);
}

/* 读一个「组」: {…} 取花括号里面 (配对计数), 否则取下一个 token; 返回原文不渲染, 调用方决定当数学还是当文字 */
function texReadGroup(st) {
  while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i += 1;
  if (st.s[st.i] === '{') {
    const start = st.i + 1;
    let depth = 0;
    for (; st.i < st.s.length; st.i += 1) {
      const ch = st.s[st.i];
      if (ch === '\\') { st.i += 1; continue; } // 跳过被转义的下一个字符
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const inner = st.s.slice(start, st.i);
          st.i += 1;
          return inner;
        }
      }
    }
    return st.s.slice(start); // 括号没闭合: 就当到结尾
  }
  if (st.s[st.i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(st.s.slice(st.i));
    st.i += m ? m[0].length : 1;
    return m ? m[0] : '';
  }
  const ch = st.s[st.i] || '';
  if (ch) st.i += 1;
  return ch;
}

// 读一个 \命令名 (单个非字母字符也算)
function texCommandName(st) {
  const m = /^\\([A-Za-z]+|.)/.exec(st.s.slice(st.i));
  if (!m) { st.i += 1; return ''; }
  st.i += m[0].length;
  return m[1];
}

// 公式源码 → HTML
function texRender(source) {
  const st = { s: String(source || ''), i: 0 };
  const out = [];
  while (st.i < st.s.length) {
    const ch = st.s[st.i];

    if (ch === '\\') {
      out.push(texCmdHtml(st, texCommandName(st)));
      continue;
    }
    if (ch === '{') { // 透明分组: {ab} 与 ab 等价
      out.push(texRender(texReadGroup(st)));
      continue;
    }
    if (ch === '}') { st.i += 1; continue; }
    if (ch === '^' || ch === '_') {
      st.i += 1;
      const inner = texRender(texReadGroup(st));
      out.push(ch === '^' ? `<sup>${inner}</sup>` : `<sub>${inner}</sub>`);
      continue;
    }
    if (/\s/.test(ch)) { st.i += 1; continue; } // 数学模式里的空格无意义
    if (ch === '~') { out.push('&nbsp;'); st.i += 1; continue; }
    if (ch === '&') { out.push('<span class="md-math-align"></span>'); st.i += 1; continue; }
    out.push(texEsc(ch));
    st.i += 1;
  }
  return out.join('');
}

// 单条命令 → HTML (认不出就原样输出)
function texCmdHtml(st, cmd) {
  if (LATEX_SYMBOLS[cmd] !== undefined) return texEsc(LATEX_SYMBOLS[cmd]);

  if (cmd === '\\') return '<br class="md-math-br">'; // 独立公式里换行
  if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
    const num = texRender(texReadGroup(st));
    const den = texRender(texReadGroup(st));
    return `<span class="md-math-frac"><span class="md-math-num">${num}</span>`
      + `<span class="md-math-den">${den}</span></span>`;
  }
  if (cmd === 'sqrt') {
    // 可选的开方次数: \sqrt[3]{x}
    while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i += 1;
    let idx = '';
    if (st.s[st.i] === '[') {
      const end = st.s.indexOf(']', st.i);
      if (end > 0) {
        idx = texRender(st.s.slice(st.i + 1, end));
        st.i = end + 1;
      }
    }
    const body = texRender(texReadGroup(st));
    return '<span class="md-math-root">'
      + (idx ? `<sup class="md-math-idx">${idx}</sup>` : '')
      + `<span class="md-math-rad">√</span><span class="md-math-radicand">${body}</span></span>`;
  }
  if (LATEX_FUNCS.indexOf(cmd) >= 0) {
    return `<span class="md-math-op">${texEsc(cmd)}</span>`;
  }
  if (LATEX_MARKS[cmd]) {
    const body = texRender(texReadGroup(st));
    const mark = LATEX_MARK_CHARS[cmd];
    return `<span class="${LATEX_MARKS[cmd]}">${body}`
      + (mark ? `<span class="md-math-mark">${texEsc(mark)}</span>` : '')
      + '</span>';
  }
  if (LATEX_FONTS[cmd]) {
    const raw = texReadGroup(st);
    // \text{} 里是「文字」: 空格与中文照留; 其余字体命令当数学处理
    const inner = LATEX_FONTS[cmd] === 'md-math-rm' && cmd.indexOf('text') === 0
      ? texEsc(raw)
      : texRender(raw);
    return `<span class="${LATEX_FONTS[cmd]}">${inner}</span>`;
  }
  // 尺寸命令只是「括号大一点」, 这里只保留定界符本身
  if (/^(left|right|big|Big|bigg|Bigg|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr)$/.test(cmd)) {
    while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i += 1;
    if (st.s[st.i] === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(st.s.slice(st.i));
      if (m) {
        st.i += m[0].length;
        const key = '\\' + m[1];
        if (LATEX_DELIMS[key] !== undefined) return texEsc(LATEX_DELIMS[key]);
        return '';
      }
    }
    const d = st.s[st.i];
    if (d === undefined) return '';
    st.i += 1;
    return d === '.' ? '' : texEsc(d);
  }
  // 环境壳子: \begin{cases} … \end{cases} 只丢掉壳, 内容照渲染 (\\ 换行、& 当对齐点)
  if (cmd === 'begin' || cmd === 'end') { texReadGroup(st); return ''; }
  if (cmd === 'limits' || cmd === 'nolimits' || cmd === 'displaystyle'
    || cmd === 'textstyle' || cmd === 'scriptstyle') return '';
  // \% \$ \& \# \_ \{ \} 这类转义字符
  if (cmd && cmd.length === 1 && '%$&#_{},'.indexOf(cmd) >= 0) return texEsc(cmd);
  // 认不出来 → 原样显示 (宁可难看, 也别让用户以为公式丢了)
  return texEsc('\\' + cmd);
}

/* 渲染一条公式: { tex, display } */
function renderLatex(item) {
  if (!item) return '';
  const body = texRender(item.tex).trim();
  if (!body) return '';
  const tag = item.display ? 'div' : 'span';
  return `<${tag} class="md-math${item.display ? ' is-display' : ''}">${body}</${tag}>`;
}
