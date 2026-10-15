/* ==================== Markdown 渲染回归测试 ====================
   renderMarkdown 是纯函数 (输入字符串 → 输出 HTML), 所以不用浏览器也能测。

   跑法:
     node --test tests/            (或者 npm test)

   ⚠️ markdown.js 是给浏览器用的老式脚本 (没有 export), 所以这里用 node:vm
      起一个沙箱把它和 core.js 的 escapeHtml 一起灌进去。
   ============================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sandbox = vm.createContext({
  console,
  // escapeHtml 走的是「createElement + textContent → innerHTML」的浏览器转义,
  // 这里用最小实现复刻它 (浏览器对文本节点只转义 & < >, 引号不动)
  document: {
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    // core.js 末尾会用 documentElement.style 写 --vh-full (老浏览器的一屏高兜底)
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
    createElement() {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      };
    }
  },
  window: { addEventListener() {} },
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}) })
});

vm.runInContext(read('../public/script/core.js'), sandbox);
// ⚠️ markdown.js 抽到 $…$ 时会直接调 latex.js 的 renderLatex(), 所以两个都得灌进去
vm.runInContext(read('../public/script/latex.js'), sandbox);
vm.runInContext(read('../public/script/markdown.js'), sandbox);

const render = (source) => vm.runInContext(`renderMarkdown(${JSON.stringify(source)})`, sandbox);

test('缩进 / 行尾带空格的围栏代码块: 不能漏出 CODE0 占位符', () => {
  const html = render('   ```python\n   x = 1\n   ```  \n\n完了');
  assert.match(html, /md-code/);
  assert.doesNotMatch(html, /CODE\d/);
});

test('单个回车是软换行: 不换行, 合成一个段落', () => {
  assert.equal(render('第一行\n第二行'), '<p>第一行第二行</p>');
});

test('行尾两个空格 = 硬换行', () => {
  assert.equal(render('第一行  \n第二行'), '<p>第一行<br>第二行</p>');
});

test('显式 <br> = 硬换行', () => {
  assert.equal(render('第一行<br>第二行'), '<p>第一行<br>第二行</p>');
  assert.equal(render('第一行<br/>第二行'), '<p>第一行<br>第二行</p>');
});

test('空行才是分段', () => {
  assert.equal(render('第一段\n\n第二段'), '<p>第一段</p>\n<p class="md-empty"></p>\n<p>第二段</p>');
});

/* ==================== LaTeX (轻量渲染) ==================== */

test('行内公式: $…$ 变成 .md-math, 上下标照常', () => {
  const html = render('勾股定理 $a^2 + b^2 = c^2$ 成立');
  assert.match(html, /<span class="md-math">/);
  assert.match(html, /<sup>2<\/sup>/);
  assert.doesNotMatch(html, /\$a/);
});

test('独立公式: $$…$$ 独占一块 (不裹在 <p> 里)', () => {
  const html = render('$$\n\\frac{1}{2}\n$$');
  assert.match(html, /<div class="md-math is-display">/);
  assert.match(html, /md-math-frac/);
  assert.match(html, /md-math-den/);
});

test('行内公式不会被当斜体 / 链接 / 提及', () => {
  const html = render('$x_i * y$');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /<sub>i<\/sub>/);
});

test('代码里的 $ 不是公式', () => {
  assert.match(render('`$x$`'), /<code>\$x\$<\/code>/);
  assert.doesNotMatch(render('```\n$a+b$\n```'), /md-math/);
});

test('公式里的 HTML 会被转义 (安全)', () => {
  const html = render('$<img src=x onerror=1>$');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('不认识的命令原样显示 (不静默吞掉)', () => {
  assert.match(render('$\\notacommand$'), /\\notacommand/);
});

test('常用子集: 分数 / 根号 / 希腊字母 / 函数名 / 定界符', () => {
  assert.match(render('$\\sqrt[3]{x}$'), /md-math-idx/);
  assert.match(render('$\\alpha$'), /α/);
  assert.match(render('$\\sin x$'), /md-math-op[^>]*>sin</);
  assert.match(render('$\\left( x \\right]$'), /\(/);
  assert.match(render('$\\text{中文}$'), /md-math-rm[^>]*>中文</);
});

test('西文软换行之间补空格 (别粘成 HelloWorld)', () => {
  assert.equal(render('Hello\nWorld'), '<p>Hello World</p>');
  assert.equal(render('中文\nabc'), '<p>中文abc</p>');
});

test('标题整体下移一级并带锚点 id', () => {
  assert.equal(render('# 标题'), '<h2 id="h-1" class="md-heading">标题</h2>');
  assert.equal(render('## 二级'), '<h3 id="h-1" class="md-heading">二级</h3>');
});

test('无序 / 有序列表', () => {
  assert.equal(render('- 甲\n- 乙'), '<ul class="md-list">\n<li>甲</li>\n<li>乙</li>\n</ul>');
  assert.equal(render('1. 甲\n2. 乙'), '<ol class="md-list">\n<li>甲</li>\n<li>乙</li>\n</ol>');
});

test('列表切换类型时先闭合上一个', () => {
  assert.equal(
    render('- 甲\n1. 乙'),
    '<ul class="md-list">\n<li>甲</li>\n</ul>\n<ol class="md-list">\n<li>乙</li>\n</ol>'
  );
});

test('列表项里也能用行内语法与换行', () => {
  assert.equal(render('- **粗**甲<br>乙'), '<ul class="md-list">\n<li><strong>粗</strong>甲<br>乙</li>\n</ul>');
});

test('引用: 多行合成同一段 (CommonMark 的 lazy continuation)', () => {
  assert.equal(
    render('> 引用一\n> 引用二'),
    '<blockquote class="md-quote">\n<p>引用一引用二</p>\n</blockquote>'
  );
});

test('引用与普通段落不会互相吞掉', () => {
  assert.equal(
    render('> 引用\n\n正文'),
    '<blockquote class="md-quote">\n<p>引用</p>\n</blockquote>\n<p class="md-empty"></p>\n<p>正文</p>'
  );
});

test('代码块内容保持字面 (不解析 <br>)', () => {
  // ⚠️ 代码块的长相 (语言标签 / 复制键 / 行号 span) 会经常微调,
  //    所以这里只断言「内容保持字面」这一件事, 不逐字节比整段 HTML
  const html = render('```\n<br>\n```');
  assert.ok(html.includes('class="md-code"'), '应该是代码块结构');
  assert.ok(html.includes('<span class="md-line">&lt;br&gt;</span>'), '关字符要原样转义后放进行里');
  assert.ok(!html.includes('<br>'), '代码块里不能出现真的 <br>');
});

test('行内代码里的星号不会被当成斜体', () => {
  assert.equal(render('`a*b*c`'), '<p><code>a*b*c</code></p>');
});

/* ==================== @提及 (2026-09-12 新增的 Md 格式) ====================
   渲染器只管把它变成**普通链接** (指向 /u/<用户名>), 用户到底在不在是
   setupMentions() 拿 /api/users/exists 去问的 (这里测不到, 那是浏览器行为)。 */
const mention = (name) =>
  `<a class="md-mention" href="/u/${name}" data-mention="${name}">@${name}</a>`;

test('@提及: 变成指向 /u/ 的链接', () => {
  assert.equal(render('@RainCatNya'), `<p>${mention('RainCatNya')}</p>`);
  assert.equal(render('感谢 @gh-test 的帮忙'), `<p>感谢 ${mention('gh-test')} 的帮忙</p>`);
  assert.equal(render('(@tester)'), `<p>(${mention('tester')})</p>`);
});

test('@提及: 行尾的英文句号不算进用户名', () => {
  assert.equal(render('感谢 @RainCatNya.'), `<p>感谢 ${mention('RainCatNya')}.</p>`);
});

test('@提及: 邮箱 / 域名 / URL 里的 @ 都不算提及', () => {
  // 邮箱: @ 前面是字母数字 → 不匹配
  assert.ok(!render('gx@example.com').includes('md-mention'), '邮箱不该变成提及');
  // 看着像域名: @ 后面紧跟 .字母 → 不匹配
  assert.ok(!render('写信到 @example.com').includes('md-mention'), '@example.com 不该变成提及');
  // URL 里的 @ (不管有没有被自动识别成链接) 都不该被套上提及
  assert.ok(!render('https://foraine.xyz/@RainCatNya').includes('md-mention'), 'URL 里的 @ 不该变成提及');
  assert.ok(!render('[主页](https://x.com/@foo)').includes('md-mention'), '链接地址里的 @ 不该变成提及');
});

test('@提及: 不会嵌套进别的链接里', () => {
  const html = render('[@RainCatNya](https://example.com)');
  assert.ok(!html.includes('md-mention'), '链接文字里的 @ 不套提及 (不然会造出 <a><a> 嵌套)');
  assert.equal(html, '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">@RainCatNya</a></p>');
});

test('@提及: 行内代码与代码块里的 @ 保持字面', () => {
  assert.equal(render('`@foo`'), '<p><code>@foo</code></p>');
  assert.ok(!render('```\n@foo\n```').includes('md-mention'), '代码块里不该出现提及');
});

test('裸链接: 不会被紧贴着的行内代码 / 中文标点吞进去', () => {
  // 以前 `https://x.com` + 反引号代码 会被整段吞进 href (还原时 <code> 长在链接地址里)
  assert.equal(
    render('看 https://a.b/c`code`'),
    '<p>看 <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a><code>code</code></p>'
  );
  assert.equal(
    render('看 https://a.b/c，很好'),
    '<p>看 <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a>，很好</p>'
  );
});

test('行内语法: 粗体 / 斜体 / 下划线 / 链接', () => {
  assert.equal(render('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(render('*斜*'), '<p><em>斜</em></p>');
  assert.equal(render('++下划线++'), '<p><u>下划线</u></p>');
  assert.equal(
    render('[文字](https://example.com)'),
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">文字</a></p>'
  );
});

test('图片: ![说明](地址) 生成 .md-img', () => {
  assert.equal(
    render('![图注](https://img.foraine.xyz/img/19/abc.png)'),
    '<p><img class="md-img" src="https://img.foraine.xyz/img/19/abc.png" alt="图注" loading="lazy" decoding="async"></p>'
  );
  // 站内相对路径也放行 (文章页有 <base href="/">, localhost 与线上都吃这条)
  assert.equal(
    render('![本地](/assets/Icon/x.png)'),
    '<p><img class="md-img" src="/assets/Icon/x.png" alt="本地" loading="lazy" decoding="async"></p>'
  );
  // 没写说明就是空 alt
  assert.equal(render('![](https://a.b/c.png)'), '<p><img class="md-img" src="https://a.b/c.png" alt="" loading="lazy" decoding="async"></p>');
});

const noImg = (html) => !html.includes('<img class="md-img"');

test('表情包: alt 写成「表情」时加 .md-emoji (固定 16×16, 用户 2026-09-13)', () => {
  const html = render('你好 ![表情](https://img.foraine.xyz/img/19/e.png) 再见');
  assert.ok(html.includes('class="md-img md-emoji"'), html);
  assert.ok(html.includes('src="https://img.foraine.xyz/img/19/e.png"'), html);
  // 别的 alt 一律当普通配图 (不能被误判)
  assert.ok(!render('![图片](https://a.b/c.png)').includes('md-emoji'));
  assert.ok(!render('![表情包](https://a.b/c.png)').includes('md-emoji'), '只有精确写「表情」才算');
});

test('图片: 危险地址 / 协议相对地址都不生成 img', () => {
  assert.ok(noImg(render('![x](javascript:alert(1))')), 'javascript: 不能进 src');
  assert.ok(noImg(render('![x](data:image/svg+xml,<svg onload=alert(1)>)')), 'data: 不能进 src');
  assert.ok(noImg(render('![x](//evil.example/a.png)')), '协议相对地址 (//host) 不放行');
});

test('图片的 alt 会被属性转义 (引号不能漏出去)', () => {
  const html = render('![a"b<c>](https://a.b/c.png)');
  // 正文先过 escapeHtml, 所以 <c> 到这里已经是 &lt;c&gt;; attr 里只需再补引号
  assert.ok(html.includes('alt="a&quot;b&lt;c&gt;"'), html);
});

test('图片与链接互不抢占: 同一行里各管各的', () => {
  const html = render('![图](https://a.b/c.png) 和 [链接](https://a.b/d)');
  assert.ok(html.includes('<img class="md-img" src="https://a.b/c.png"'), '图片要认出来');
  assert.ok(html.includes('<a href="https://a.b/d"'), '链接也得在');
  assert.ok(!html.includes('![图]'), '不能剩下没解析掉的图片语法');
});

test('裸链接自动识别, 危险协议不生成链接', () => {
  assert.equal(
    render('看 https://example.com 这个'),
    '<p>看 <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a> 这个</p>'
  );
  // ⚠️ 已知边角: 链接地址里带括号时 ([点我](javascript:alert(1))),
  //    正则只吃到第一个 ')'，尾巴会剩一个 ')' 留在正文里。
  //    规范 Markdown 会把这种「括号不配平」的整段当纯文本 —— 不值得为它写解析器,
  //    这里只守住关键的一条: 不能生成 javascript: 链接。
  assert.equal(render('[点我](javascript:alert(1))'), '<p><a href="#" target="_blank" rel="noopener noreferrer">点我</a>)</p>');
});

test('HTML 一律转义 (XSS 防线)', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!render('<img src=x onerror=alert(1)>').includes('<img'));
});

test('标签配平: 各种块混着来也不漏闭合', () => {
  const html = render('# 标题\n\n- 甲\n- 乙\n\n> 引用\n\n```\ncode\n```\n\n结尾');
  const opens = (html.match(/<(ul|ol|blockquote|p|pre|h2)\b/g) || []).length;
  const closes = (html.match(/<\/(ul|ol|blockquote|p|pre|h2)>/g) || []).length;
  assert.equal(opens, closes, '开放标签数与闭合标签数应相等\n' + html);
});

/* ==================== 文章的自定义行内标记 ==================== */
test('censored: 里面几个字就几个方块, 原文不进 DOM', () => {
  const html = render('<censored>秘密</censored>');
  assert.match(html, /class="md-censored"/);
  assert.equal((html.match(/<i><\/i>/g) || []).length, 2);
  assert.ok(!html.includes('秘密'), '被打码的原文不该出现在输出里');
});

test('gradient: 两端颜色进变量, 缺的一端写 currentColor', () => {
  assert.match(render('<gradient=#ff0000>甲</gradient=#00ff00>'), /--md-grad-from:#ff0000;--md-grad-to:#00ff00/);
  assert.match(render('<gradient>甲</gradient>'), /--md-grad-from:currentColor;--md-grad-to:currentColor/);
  assert.match(render('<gradient=#abc>甲</gradient>'), /--md-grad-from:#abc;--md-grad-to:currentColor/);
});

test('gradient: hex 带 alpha (#rrggbbaa / #rgba) 也认', () => {
  assert.match(render('<gradient=#ff000080>甲</gradient>'), /--md-grad-from:#ff000080;--md-grad-to:currentColor/);
  assert.match(
    render('<gradient=#ff000080>甲</gradient=#00ff00cc>'),
    /--md-grad-from:#ff000080;--md-grad-to:#00ff00cc/
  );
  assert.match(render('<gradient=#f008>甲</gradient>'), /--md-grad-from:#f008;--md-grad-to:currentColor/);
});

test('gradient: 颜色写坏了就整段原样留着 (让作者看见)', () => {
  assert.match(render('<gradient=zzz>甲</gradient>'), /&lt;gradient=zzz&gt;/);
});

test('font: 认得出的字体名包一层, 认不出的整段原样留着', () => {
  assert.equal(render('<font XNS>手写</font>'), '<p><span class="md-font" style="font-family:var(--font-hand-body)">手写</span></p>');
  assert.equal(render('<font xns>手写</font>'), '<p><span class="md-font" style="font-family:var(--font-hand-body)">手写</span></p>');
  assert.match(render('<font XXX>甲</font>'), /&lt;font XXX&gt;/);
});

test('u: 与 ++…++ 同一个输出', () => {
  assert.equal(render('<u>下划线</u>'), '<p><u>下划线</u></p>');
  assert.equal(render('++下划线++'), '<p><u>下划线</u></p>');
});

test('零宽字符: zwsp / zwj / zwnj', () => {
  assert.equal(render('甲<zwsp>乙'), '<p>甲\u200B乙</p>');
  assert.equal(render('甲<zwj>乙'), '<p>甲\u200D乙</p>');
  assert.equal(render('甲<zwnj>乙'), '<p>甲\u200C乙</p>');
});

test('spoiler: 包一层可点的遮罩, 原文还在', () => {
  const html = render('<spoiler>剧透</spoiler>');
  assert.match(html, /class="md-spoiler"/);
  assert.match(html, /剧透/);
});

test('notice: 荧光笔标记', () => {
  assert.equal(render('<notice>重点</notice>'), '<p><span class="md-notice">重点</span></p>');
});

test('secret: 条件合法就脱标签, 写错的整段原样留着', () => {
  assert.equal(render("<secret='HAS EXACTLY a.b c'>内</secret>"), '<p>内</p>');
  assert.equal(render("<secret='DATE BEFORE 1700000000000'>内</secret>"), '<p>内</p>');
  assert.equal(render("<secret='USER WITHOUT raincatnya'>内</secret>"), '<p>内</p>');
  // 少了操作符 / 时间戳不是数字 / 权限列表为空 → 都不算合法
  assert.match(render("<secret='HAS EXACTLY'>内</secret>"), /&lt;secret=/);
  assert.match(render("<secret='DATE BEFORE abc'>内</secret>"), /&lt;secret=/);
  assert.match(render("<secret='WHAT EXACTLY a'>内</secret>"), /&lt;secret=/);
});

test('secret: 跨块的栅栏也脱得掉 (开标签独占一行时不能漏出字面标签)', () => {
  const html = render("<secret='HAS EXACTLY a.b'>\n## 标题\n\n<font XNS>正文</font>\n</secret>");
  assert.ok(!html.includes('&lt;secret'), '开标签不该以字面出现');
  assert.ok(!html.includes('&lt;/secret'), '闭合标签不该以字面出现');
  assert.match(html, /class="md-heading">标题</);
  assert.match(html, /md-font/);
  // 条件写错的跨块栅栏还是整段原样留着 (跟单行一个态度)
  assert.match(render("<secret='WHAT EXACTLY a'>\n## 标题\n\n甲\n</secret>"), /&lt;secret='WHAT EXACTLY a'&gt;/);
});

test('自定义标记在代码块 / 行内代码里保持字面', () => {
  assert.ok(!render('```\n<censored>甲</censored>\n```').includes('md-censored'));
  assert.ok(!render('`<notice>甲</notice>`').includes('md-notice'));
});

/* ==================== <view …>: 观看者信息 ==================== */

const inline = (source) => vm.runInContext(`inlinePlain(${JSON.stringify(source)})`, sandbox);

test('<view …>: 没登录 / 没填上下文一律 unknown + null', () => {
  vm.runInContext('setViewContext(null)', sandbox);
  const html = render('看的人 <view user> / <view nickname> / <view permission>');
  assert.match(html, /看的人 unknown \/ unknown \/ null/);
});

test('<view …>: 填了上下文就报本人, 权限取 foraine.* 里最高的那一档', () => {
  vm.runInContext(
    "setViewContext({ user: 'raincatnya', nickname: '繁星', time: 1780000000000,"
    + " permissions: ['article.create', 'foraine.iota', 'foraine.xenon'] })",
    sandbox
  );
  const html = render('<view user>|<view nickname>|<view time>|<view permission>');
  assert.match(html, /raincatnya\|繁星\|1780000000000\|Xenon/);
  // timestr 是人看的时间文本, 不该是那串毫秒
  const when = render('<view timestr>');
  assert.doesNotMatch(when, /1780000000000/);
  assert.match(when, /\d{4}-\d{2}-\d{2}/);
});

test('<view …>: 只有低那一档就报低那一档, 别的权限串不算数', () => {
  vm.runInContext("setViewContext({ user: 'u', permissions: ['foraine.vapor', 'dev.access', 'foraine.unknown'] })", sandbox);
  assert.match(render('<view permission>'), /Vapor/);
});

/* ==================== 标题 / 简介用的 inlinePlain ==================== */

test('inlinePlain: 一样解析行内 DOM', () => {
  vm.runInContext('setViewContext({ user: "me" })', sandbox);
  assert.match(inline('<notice>高亮</notice> **粗** <view user>'), /md-notice/);
  assert.match(inline('<notice>高亮</notice> **粗** <view user>'), /me/);
  assert.match(inline('<gradient=#abc>渐变</gradient=#def>'), /md-gradient/);
  // 先转义再解析: 尖括号进不来 (标题也吃不到 XSS)
  assert.match(inline('<img src=x onerror=alert(1)>'), /&lt;img src=x/);
});

test('inlinePlain: secret / 零宽 / font 一律不解析 (原样留着, 让作者看见)', () => {
  assert.match(inline("<secret='HAS foraine.iota'>藏</secret>"), /&lt;secret='HAS foraine\.iota'&gt;/);
  assert.match(inline('甲<zwsp>乙'), /&lt;zwsp&gt;/);
  assert.match(inline('<font XNS>手写</font>'), /&lt;font XNS&gt;/);
  assert.ok(!inline('<font XNS>手写</font>').includes('md-font'));
});
