/* highlight.js 轻量语法高亮 */
/*
  内容: 只给文章里的围栏代码块用, renderMarkdown() 把代码块交给 highlightLines(code, lang), 拿到「每一行一段 HTML」;
        行号由 CSS 计数器画在 .md-line 上, 配色照双葉橘, 颜色值在 page-article.css 的 .tk-*
  依赖: core.js(escapeHtml) / page-article.css
*/
// 返回「行的数组」而不是一整段: 块注释 / 多行字符串这类跨行 token 必须在行尾收掉 span、下一行再开, 否则行号会错位
// 支持 js/ts(jsx tsx) py bash/sh sql html/xml/vue css/scss json yaml/toml/ini + C 家族并集; 其它一律只转义不着色

// 空格分隔的清单 → 数组 (写起来紧凑)
function hlWords(str) {
  return str.trim().split(/\s+/).filter(Boolean);
}

const HL_KW = {
  js: hlWords(`abstract arguments async await break case catch class const continue debugger default delete do else enum
    export extends finally for from function get if implements import in instanceof interface let new of package private
    protected public return set static super switch this throw try typeof var void while with yield`),
  tsExtra: hlWords(`declare namespace type readonly keyof infer is asserts satisfies override abstract symbol as unknown never any`),
  py: hlWords(`and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda nonlocal not or pass raise return try while with yield match case`),
  bash: hlWords(`if then else elif fi for while until do done case esac function return exit export local readonly declare source
    alias unset shift eval exec set trap cd echo printf read test`),
  sql: hlWords(`select from where insert into values update set delete create alter drop table view index primary key foreign
    references join left right inner outer full cross on group by order having limit offset as distinct count sum avg min max
    and or not null is in like between union all exists case when then else end begin commit rollback transaction with`),
  // C 家族并集: 认错顶多多染一个词, 不值得为十几个语言各养一份清单
  clike: hlWords(`abstract assert async await auto bool boolean break byte case catch char class const constexpr continue crate
    data def default defer delete do double dyn else enum event expect explicit export extends extern fallthrough false final
    finally fixed float fn for foreach func function get goto if impl implements import in init inline instanceof int interface
    internal is lambda let lock long loop match mod move mut namespace native new nil noexcept object operator out override
    package params permits private protected protocol pub public readonly record ref register reified require resize return
    sealed select short signed sizeof stackalloc static strictfp struct subscript super switch synchronized template this throw
    throws trait transient true try type typealias typedef typeof unchecked union unsafe unsigned use using val var vararg
    virtual void volatile where while with yield`),
  cssAt: hlWords(`media supports import keyframes font-face charset namespace layer container`),
  yamlBool: hlWords(`true false null yes no on off ~`)
};

const HL_CONST = {
  js: hlWords(`true false null undefined NaN Infinity this super`),
  py: hlWords(`True False None self cls __name__`),
  bash: hlWords(`true false`),
  sql: hlWords(`true false null`),
  clike: hlWords(`null nil none true false this self super undefined NaN Infinity`),
  json: hlWords(`true false null`),
  css: hlWords(`important`)
};

const HL_BUILTIN = {
  js: hlWords(`Array Boolean Date Error Function JSON Map Math Number Object Promise Proxy RegExp Set String Symbol WeakMap
    WeakSet console document window globalThis process require module exports fetch parseInt parseFloat isNaN setTimeout
    setInterval clearTimeout clearInterval structuredClone queueMicrotask`),
  py: hlWords(`print len range str int float list dict set tuple bool bytes bytearray open type isinstance issubclass super
    enumerate zip map filter sorted sum min max abs round any all input repr id hash iter next dir vars format property
    staticmethod classmethod`),
  bash: hlWords(`echo cd pwd ls cat grep sed awk curl wget git npm npx node python pip mkdir rm cp mv chmod export source printf
    read test which sudo apt brew docker`),
  clike: hlWords(`String Integer Boolean Double Float Long Short Character Object Array List Map Set Vector HashMap ArrayList
    Optional Stream System Math Console print println printf scanf fmt error panic Result Option Some None Vec Box Rc Arc Mutex
    Thread File Path Iterator Promise Nullable var dynamic`),
  css: hlWords(`rgb rgba hsl hsla var calc linear-gradient radial-gradient repeating-linear-gradient url translate translateX
    translateY scale rotate skew flex grid calc env min max clamp`),
  yaml: []
};

/* 语言名 → 规则类型 (认不出的返回 null = 不着色) */
const HL_ALIAS = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', node: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'ts',
  py: 'py', python: 'py', python3: 'py',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', powershell: 'bash', ps1: 'bash',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', astro: 'markup',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', config: 'yaml', dotenv: 'yaml',
  java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike', cc: 'clike', hpp: 'clike', 'c#': 'clike',
  cs: 'clike', csharp: 'clike', go: 'clike', golang: 'clike', rust: 'clike', rs: 'clike',
  kotlin: 'clike', kt: 'clike', swift: 'clike', php: 'clike', dart: 'clike', scala: 'clike', groovy: 'clike'
};
// 这些当纯文本处理 (明确列出来, 免得以后有人以为漏了)
const HL_PLAIN = ['txt', 'text', 'plain', 'plaintext', 'log', 'output', 'none', ''];

/* 把一段文本切成「行 HTML」: 外层先用 push 处理跨行 (每行各自包 span) */
// 建一个行收集器: push(cls, text) 收集, done() 取数组
function hlMakeLines() {
  const lines = [];
  let cur = '';
  return {
    push(cls, text) {
      const parts = String(text).split('\n');
      parts.forEach((part, i) => {
        if (i > 0) { lines.push(cur); cur = ''; }
        if (!part) return;
        const safe = escapeHtml(part);
        cur += cls ? '<span class="' + cls + '">' + safe + '</span>' : safe;
      });
    },
    done() {
      lines.push(cur);
      return lines;
    }
  };
}

/* 按语言生成规则表 (懒建 + 缓存)。每条规则 = { cls, 正则(sticky), cond? }
   规则按顺序试, 命中即走 —— 所以注释 / 字符串必须排在关键字前面 */
const HL_RULE_CACHE = {};

// 取某语言的规则表 (没有就现建)
function hlRulesFor(kind) {
  if (HL_RULE_CACHE[kind]) return HL_RULE_CACHE[kind];
  const rules = [];
  const add = (cls, src, flags, cond) => rules.push({ cls, re: new RegExp(src, 'y' + (flags || '')), cond });
  const kw = (list, cls, flags) => { if (list && list.length) add(cls || 'tk-k', '\\b(?:' + list.join('|') + ')\\b', flags); };
  const builtin = (list, flags) => { if (list && list.length) add('tk-b', '\\b(?:' + list.join('|') + ')\\b', flags); };

  const strDouble = '"(?:\\\\.|[^"\\\\\\n])*"';
  const strSingle = "'(?:\\\\.|[^'\\\\\\n])*'";
  const number = '\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[a-zA-Z_]*)\\b';

  if (kind === 'js' || kind === 'ts' || kind === 'clike') {
    add('tk-c', '/\\*[\\s\\S]*?\\*/');
    add('tk-c', '//[^\\n]*');
    if (kind === 'clike') add('tk-k', '#\\s*\\w+', '', (code, i) => i === 0 || code[i - 1] === '\n'); // #include 这类预处理指令
    if (kind !== 'clike') add('tk-s', '`(?:\\\\.|[^`\\\\])*`');   // 模板串 (js/ts)
    add('tk-s', strDouble);
    add('tk-s', strSingle);
    add('tk-n', number);
    kw(kind === 'clike' ? HL_KW.clike : HL_KW.js);
    if (kind === 'ts') kw(HL_KW.tsExtra);
    builtin(kind === 'clike' ? HL_BUILTIN.clike : HL_BUILTIN.js);
    builtin(kind === 'clike' ? HL_CONST.clike : HL_CONST.js);
    add('tk-b', '\\b[A-Z][A-Za-z0-9_$]*\\b');            // 大写开头 = 类型 / 类
    add('tk-f', '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()');      // 后面跟括号 = 函数调用
    add('tk-v', '(?:\\.|->|::)[A-Za-z_$][\\w$]*');       // 属性 / 方法
    add('tk-v', '\\$[A-Za-z_$][\\w$]*');                 // $变量 (php/js 模板)
    add('tk-b', '@[A-Za-z_$][\\w$]*');                   // 注解 / 装饰器
    add('tk-o', '=>|->|::|===|!==|==|!=|<=|>=|&&|\\|\\||\\?\\?|\\.\\.\\.|\\+\\+|--|[-+*/%=<>!&|^~?]+');
  } else if (kind === 'py') {
    add('tk-c', '#[^\\n]*');
    add('tk-s', '(?:[rRbBfFuU]{0,2})("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + strDouble + '|' + strSingle + ')');
    add('tk-n', number);
    kw(HL_KW.py);
    builtin(HL_BUILTIN.py);
    builtin(HL_CONST.py);
    add('tk-b', '@[A-Za-z_][\\w.]*');                    // 装饰器
    add('tk-f', '\\b[A-Za-z_][\\w]*(?=\\s*\\()');
    add('tk-v', '\\.[A-Za-z_][\\w]*');
    add('tk-o', '==|!=|<=|>=|:=|->|\\*\\*|//|[-+*/%=<>!&|^~]+');
  } else if (kind === 'bash') {
    add('tk-c', '#[^\\n]*');
    add('tk-s', strDouble);
    add('tk-s', strSingle);
    add('tk-n', number);
    kw(HL_KW.bash);
    builtin(HL_BUILTIN.bash);
    add('tk-v', '\\$\\{[^}]*\\}|\\$[A-Za-z_][\\w]*|\\$[0-9@*#?!$]');  // 变量
    add('tk-o', '&&|\\|\\||>>|\\||>|<|-{1,2}[a-zA-Z]');
  } else if (kind === 'sql') {
    add('tk-c', '--[^\\n]*');
    add('tk-c', '/\\*[\\s\\S]*?\\*/');
    add('tk-s', strSingle);
    add('tk-n', number);
    // SQL 不分大小写: 控制台/D1 里写的都是 UPDATE / WHERE 这种大写, 清单是小写的
    kw(HL_KW.sql, 'tk-k', 'i');
    builtin(HL_CONST.sql, 'i');
    add('tk-b', '\\b[A-Z][A-Z_]{2,}\\b');                // 大写常量/表名习惯
    add('tk-f', '\\b[A-Za-z_][\\w]*(?=\\s*\\()');
    add('tk-v', '\\.[A-Za-z_][\\w]*');
    add('tk-o', '<>|!=|<=|>=|[-+*/%=<>|]+');
  } else if (kind === 'markup') {
    add('tk-c', '<!--[\\s\\S]*?-->');
    add('tk-c', '<!\\w+[^>]*>');
    add('tk-s', strDouble);
    add('tk-s', strSingle);
    add('tk-a', '[A-Za-z_:][\\w:.-]*(?==)');             // 属性名
    add('tk-t', '</?[A-Za-z][\\w:.-]*|/?>');             // 标签
  } else if (kind === 'css') {
    add('tk-c', '/\\*[\\s\\S]*?\\*/');
    add('tk-s', strDouble);
    add('tk-s', strSingle);
    add('tk-k', '@[a-zA-Z-]+');
    builtin(HL_BUILTIN.css);
    add('tk-n', '#[0-9a-fA-F]{3,8}\\b');                 // 色值
    add('tk-n', number + '(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?');
    add('tk-v', '(?:--[\\w-]+)');                        // 自定义属性
    add('tk-n', '[a-z-]+(?=\\s*:)');                     // 属性名
    add('tk-f', '[.#][A-Za-z_-][\\w-]*');                // 类/ID 选择器
  } else if (kind === 'json') {
    add('tk-c', '//[^\\n]*');
    add('tk-a', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)');     // 键
    add('tk-s', strDouble);
    add('tk-n', number);
    builtin(HL_CONST.json);
  } else if (kind === 'yaml') {
    add('tk-c', '#[^\\n]*');
    add('tk-a', '^[ \\t-]*[A-Za-z_][\\w.-]*(?=\\s*:)', 'm');  // 键
    add('tk-s', strDouble);
    add('tk-s', strSingle);
    add('tk-n', number);
    builtin(HL_KW.yamlBool);
  }

  HL_RULE_CACHE[kind] = rules;
  return rules;
}

/* 主入口: 代码 → 每行一段 HTML */
// 按语言挑规则表, 逐字符扫, 命中就成段
function highlightLines(code, lang) {
  const key = String(lang || '').toLowerCase();
  const kind = HL_PLAIN.indexOf(key) >= 0 ? null : (HL_ALIAS[key] || null);
  const rules = kind ? hlRulesFor(kind) : null;
  const src = String(code ?? '');
  if (!rules || !rules.length) return src.split('\n').map((line) => escapeHtml(line));

  const sink = hlMakeLines();
  let plain = '';
  let i = 0;
  while (i < src.length) {
    let hit = null;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r];
      if (rule.cond && !rule.cond(src, i)) continue;
      rule.re.lastIndex = i;
      const m = rule.re.exec(src);
      if (m && m.index === i && m[0]) { hit = { rule, text: m[0] }; break; }
    }
    if (!hit) { plain += src[i]; i += 1; continue; }
    if (plain) { sink.push(null, plain); plain = ''; }
    sink.push(hit.rule.cls, hit.text);
    i += hit.text.length || 1;
  }
  if (plain) sink.push(null, plain);
  return sink.done();
}
