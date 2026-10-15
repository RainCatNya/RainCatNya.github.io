/* terminal.js 终端页 (/terminal) 的启动画面与世界 */
/*
  内容:
    终端页那一层 terminalBoot (/terminal 一页到底) ——
      ① 冻结的背景格 (世界那层画好就不动) + 图标 + 系统名 + 进度条
      ② 加载期读一次 /api/view-permissions, 按属性把七块面板的状态定下来 (真加载)
      ③ 没有 terminal.access: 进度条停在 75% → 闪掉 → 页内出秘钥闸门 (敲错整条红一下再渐回白)
      ④ 全都有: 进度条接着爬满 → 图标与系统名一起闪掉 → 直接露出面板世界 (同一块背景, 不换页)
    世界那一层 terminalWorld ——
      ⑤ 常驻三角网格 (可拖着走) + 1 主 6 环的面板; 面板各自随指针浮动 (见 applyLook)
  依赖: 无
*/
// 想调: 改下面的 TUNE, 或在控制台改 window.terminalTune
(function initTerminal() {
  /* 调参表 */
  const TUNE = {
    gap: 3.2,           // 缝隙宽度 (px) = 黑色描边粗细
    dome: 0.18,         // 穹顶感: 屏幕正中的格子缩到 (1 - dome) 倍, 到四角回到原样 (0 = 平板)
    bootGap: 260,       // 全黑之后隔多久换页 (ms)
    /* 三段过场 (首页那颗终端图标点下去跑的那趟): ① 三角形 (半透明**黑**面板 + 黑描边) 从中心铺满
       → ② 面板整体变成半透明**深紫** (也是一道从中心往外的波) → ③ 紫涟漪带往外滚, 身后沉成纯黑。
       前两段只换面板底色 (都是半透的, 底下的页面还看得见); ③才是那条亮紫的带子 */
    revealSpread: 620,  // ①「黑面板」的波从中心走到四角花多久 (ms)
    revealTri: 300,     // ①单块三角形自己淡入花多久 (ms)
    shiftSpread: 560,   // ②「变深紫」的波从中心走到四角花多久 (ms)
    shiftTri: 260,      // ②单块三角形自己变紫花多久 (ms)
    glowSpread: 1200,   // ③紫涟漪带从中心走到四角花多久 (ms)
    ringRise: 110,      // ③单块被波前走到之后, 花多久亮到满紫 (ms)
    ringHold: 620,      // ③满紫停留多久再开始沉黑 (ms, 带子的厚度基本由它决定)
    ringFall: 190,      // ③从满紫沉成纯黑花多久 (ms)
    bootLoad: 1400,     // 加载条从 0 爬到 bootStop 花多久 (ms)
    bootStop: 0.75,     // 停在那一个比例 (后面接秘钥闸门)
    bootStopHold: 1000, // 停住之后定格多久, 再开始闪 (ms)
    bootRun: 1600,      // 后半趟 (接着爬到 100% / 敲对秘钥后重爬) 花多久 (ms)
    winkTimes: 5,       // 闪几下再消失 (WinkToDisapper)
    wink: 40,           // 闪一次的半周期 (ms, 越小越快)
    denyMs: 600,        // 敲错时那一下红→白的总时长 (ms)
    barDark: 700,       // 进度条从起始端扫黑花多久 (ms, easeInOutCubic)
    postHold: 1000,     // 图标与系统名停多久再闪 (ms)
    panelFloat: 6,      // 面板浮动 (鼠标): 贴到面板上时最多跟出去多远 (px)
    floatRange: 108,    // 触发浮动的距离 (px, 量到面板边缘): 超出这个距离面板一点不动
    lookEase: 0.045,    // 浮动跟随指针的缓动系数 (越小跟得越慢, 鼠标猛地靠近也不会一下跳过去)
    /* 世界: 拖动像「力」——松手之后按速度继续滑, 摩擦力让它慢慢停;
       到边界就把速度清零; 能拖多远由内容外接框外扩 worldPad 决定 */
    worldPad: 260,      // 边界 = 内容外接框往外扩这么多 (px); 内容变多, 边界跟着长
    worldFric: 0.90,    // 惯性摩擦: 每 16.7ms 速度乘一次 (越小停得越快)
    worldMaxVel: 3.2,   // 甩动速度上限 (px/ms), 免得一甩就飞出去
    worldStop: 0.015,   // 速度低于这个就当作停了 (px/ms)
    panelGap: 30,       // 主面板与环上那六块的**边缘净距** (px)
    waveAmp: 0.35,      // 背景三角形「变亮~暗淡」的幅度 (±35% 亮度)
    waveSpeed: 0.0012,  // 背景呼吸时钟的速率 (乘上每块自己的 rate 才是真实频率; 越小越慢)
    waveRamp: 900,      // 加载完成之后, 呼吸用多久从「最暗」长到正常幅度 (ms)
    /* 背景格那档中性灰 (用户: 背景的三角形是灰色的, 第 1 段那种; 别改成紫) */
    backPanel: [48, 48, 56],
    panelInk: [8, 6, 13],      // ①「半透明黑」面板的底色 (RGB, 过场用)
    panelPlum: [26, 20, 40],   // ②「半透明深紫」面板的底色 (RGB, 过场用)
    seam: [172, 122, 255],     // 缝隙的发光紫 / 涟漪带的颜色 (RGB, 过场用)
    panelAlpha: 0.86,   // 面板最高不透明度 (亚克力是半透的, 别给 1)
    sideDiv: 6,         // 三角形边长 = min(宽,高) / sideDiv
    sideMin: 72,        // 边长下限 (px)
    sideMax: 200,       // 边长上限 (px)
    dprMax: 1.5         // 画布像素比封顶 (网格是软色块, 降下来看不出来)
  };

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let layer = null, canvas = null, ctx = null, bootLayer = null;
  let tris = [], view = { w: 0, h: 0 }, maxDist = 1;
  let raf = 0, barRaf = 0, running = false;
  const NEVER = -1e9;                    // 「这一段还没开始」
  const cursor = { x: 0, y: 0, tx: 0, ty: 0 };   // 指针位置 (px; x/y 是缓动后的, tx/ty 是目标)
  let cursorLive = false;                // 指针是不是还在页面上 (走了/窗口失焦 就收回正中)
  let lookOn = false;                    // 这台设备要不要跑面板浮动 (移动端/减动效 不要)
  let panelEl = null;                    // 世界里的面板层
  let slots = [];                        // 每块面板的世界坐标 (浮动要用, layoutPanels 里填)
  const pan = { x: 0, y: 0 };            // 世界拖动位移 (px)
  const vel = { x: 0, y: 0 };            // 惯性速度 (px/ms)
  const panB = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };   // 拖动能到的范围 (由内容算出)
  let lastMoveT = 0;                     // 上一次指针移动的时刻 (「按住不动」不选惯性)
  let dragActive = false;                // 现在是不是按住拖
  let starEl = null;                     // 星型模态框 (开着的时候)
  let builtX = 0, builtY = 0;            // 上一次铺格子用的位移 (拖动时对不上就重铺)
  let worldRaf = 0, worldAlive = false;  // 世界那条循环
  let bootSkip = null;                   // 启动画面那条「Esc 跳过它」(没有启动画面时是 null)
  let backdropPanel = false;             // 世界那层用「中性灰」那一档 (过场用的是黑 / 紫那一档)
  let articleSets = null;                // 加载期拿到的叙述 (按面板 key 分组, 点开不再请求)
  let linkSpecs = [];                    // 父节点与子节点那些连线 (每帧按实际位置重算)

  /* 指针位置一直记着 (启动画面那会儿也算): 世界解开的那一刻浮动就用得上, 不用等人再动一下鼠标 */
  window.addEventListener('pointermove', (e) => {
    cursor.tx = e.clientX;
    cursor.ty = e.clientY;
    cursorLive = true;
  }, { passive: true });
  const cursorGone = () => { cursorLive = false; };
  document.addEventListener('mouseleave', cursorGone);
  window.addEventListener('blur', cursorGone);

  // 把这一趟整个拆掉 (Esc 退出 / bfcache 残留都用它)
  function teardown() {
    if (raf) cancelAnimationFrame(raf);
    if (barRaf) cancelAnimationFrame(barRaf);
    raf = 0;
    barRaf = 0;
    cursorLive = false;
    cursor.x = cursor.tx = 0;
    cursor.y = cursor.ty = 0;
    backdropPanel = false;
    bootSkip = null;
    /* 世界也一并停掉: 不然那条循环会攥着已经清空的那份 canvas / ctx, 一帧就抛错
       (末尾的 worldStart 会把世界重新架一遍, 也是活的) */
    worldAlive = false;
    if (worldRaf) cancelAnimationFrame(worldRaf);
    worldRaf = 0;
    dragActive = false;
    panelEl = null;
    slots = [];
    linkSpecs = [];
    // 按类名清而不是只删手上那个引用: bfcache 恢复回来的那棵树里, 层可能已经不在我们的变量上了
    Array.prototype.forEach.call(document.querySelectorAll('.term-opening, .term-boot-layer'), (el) => el.remove());
    layer = null;
    canvas = null;
    ctx = null;
    bootLayer = null;
    tris = [];
    running = false;
    // 启动画面收掉之后, 如果这一页是「世界」(带 .term-world-grid), 就把常驻的那层跑起来
    worldStart();
  }

  /* ⚠️ 上趟留下的启动层必须自己收掉: 从 /terminal 返回其它页时, 浏览器会把上一页从 bfcache 里原样恢复,
     连那层盖满屏幕的启动画面一起带上 —— 不收拾的话人就“停在动画结束的界面”上。
     ⚠️ 只认 persisted 那一次: 普通加载也会发 pageshow, 那一下不能把刚建好的启动层一起收了 */
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (bootLayer || document.querySelector('.term-boot-layer')) teardown();
  });

  /* Esc: 启动画面还在就跳过它直接进世界 (背景早铺好了); 首页那趟过场则是收掉不走了 */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (bootSkip) { bootSkip(); return; }
    if (document.querySelector('.term-opening')) teardown();
  });

  /* 穹顶: 把「到屏幕中心的距离」重投一道 —— 越靠中心缩得越小, 到四角回到原样,
     看起来就像贴在穹顶内壁上 (dome = 中心缩掉的比例, 0 = 平板) */
  function domeScale(t) {
    const d = TUNE.dome;
    return d ? (1 - d) + d * t * t : 1;
  }

  /* 稳定伪随机 (同一个格子永远同一个值): 拖动时重铺格子, 每块的呼吸/微抖才不会跳 */
  function cellNoise(a, b) {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  /* 出一块三角形 (ax,ay)->(bx,by)->(cx,cy), 顺手记下它的格子坐标 */
  function pushTri(ax, ay, bx, by, cx, cy, gr, gk) {
    const j = cellNoise(gk, gr);
    tris.push({
      ax, ay, bx, by, cx, cy,
      d: 0,                                    // 到屏幕中心的距离 (0~1), 铺的时候算
      j: 0.92 + j * 0.16,                      // 每块面板的透明度微抖, 看起来才像一块块独立的亚克力
      ph: cellNoise(gk + 7, gr - 3) * Math.PI * 2,   // 背景呼吸的相位
      rate: 0.7 + cellNoise(gr + 11, gk + 5) * 0.9   // 背景呼吸的快慢
    });
  }

  /* 按当前视口铺一遍三角形: 奇偶行交替的正三角 / 倒三角, 多铺两圈免得拖动时露边。
     ox/oy = 世界位移 (拖动), 直接烘进顶点里 —— 拖动不限距离, 而且穹顶镜头永远钉在屏幕中心 */
  function layout(ox, oy) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    view = { w, h };
    const dpr = Math.min(window.devicePixelRatio || 1, TUNE.dprMax);
    // ⚠️ 只在尺寸真变了才改 canvas.width/height: 那句会重建整个后备缓冲, 拖动时每帧做会很贵
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const side = Math.max(TUNE.sideMin, Math.min(TUNE.sideMax, Math.round(Math.min(w, h) / TUNE.sideDiv)));
    const rowH = (side * Math.sqrt(3)) / 2;    // 等边三角形的高
    maxDist = Math.hypot(w / 2, h / 2) || 1;
    const dx = ox || 0;
    const dy = oy || 0;
    const k0 = Math.floor(-dx / side) - 2;
    const k1 = k0 + Math.ceil(w / side) + 4;
    const r0 = Math.floor(-dy / rowH) - 2;
    const r1 = r0 + Math.ceil(h / rowH) + 4;
    const cxA = w / 2;
    const cyA = h / 2;

    tris = [];
    for (let r = r0; r <= r1; r += 1) {
      const y = r * rowH;
      /* ⚠️ 隔行必须错开半条边 —— 不错开的话两行的顶点都在整数倍边上, 交界处全是 T 型接口,
         凑不出六边形 (看起来只是一排排三角)。错开后每个顶点正好有 6 个三角形围着 = 六边形格子 */
      const off = (r & 1) ? side / 2 : 0;
      for (let k = k0; k <= k1; k += 1) {
        const x = k * side + off;
        // 正三角: 底边在 y+rowH, 尖在 (x + side/2, y)
        pushTri(x, y + rowH, x + side, y + rowH, x + side / 2, y, r, k);
        // 倒三角: 顶边在 y, 尖在 (x + side, y + rowH) —— 与右邻的正三角共用一条斜边
        pushTri(x + side / 2, y, x + side * 1.5, y, x + side, y + rowH, r, k + 0.5);
      }
    }

    /* 烘到屏幕坐标: 加世界位移 → 穹顶扭曲 (中心永远是屏幕中心) → 算到中心的距离 */
    for (let i = 0; i < tris.length; i += 1) {
      const tri = tris[i];
      const px = [tri.ax + dx, tri.bx + dx, tri.cx + dx];
      const py = [tri.ay + dy, tri.by + dy, tri.cy + dy];
      for (let v = 0; v < 3; v += 1) {
        const ex = px[v] - cxA;
        const ey = py[v] - cyA;
        const rr = Math.hypot(ex, ey);
        const kk = rr < 0.0001 ? 1 : domeScale(rr / maxDist);
        px[v] = cxA + ex * kk;
        py[v] = cyA + ey * kk;
      }
      tri.ax = px[0]; tri.ay = py[0];
      tri.bx = px[1]; tri.by = py[1];
      tri.cx = px[2]; tri.cy = py[2];
      const mx = (px[0] + px[1] + px[2]) / 3;
      const my = (py[0] + py[1] + py[2]) / 3;
      tri.d = Math.hypot(mx - cxA, my - cyA) / maxDist;
    }
    builtX = dx;
    builtY = dy;
  }

  // 某一块的进度: 波走到它 (d * spread) 之后, 自己再花 dur 毫秒走完
  function progress(d, t, spread, dur) {
    const local = (t - d * spread) / dur;
    return local <= 0 ? 0 : local >= 1 ? 1 : local;
  }

  /* 波前走过一块三角形之后过了多久 → 它现在的进度 [紫到几成, 黑到几成]:
     刚走过 → 花 ringRise 亮到满紫 → 保持 ringHold → 再花 ringFall 沉成纯黑 */
  function ringMix(x) {
    if (x <= 0) return [0, 0];
    const g = x < TUNE.ringRise ? x / TUNE.ringRise : 1;
    const held = TUNE.ringRise + TUNE.ringHold;
    const q = x <= held ? 0 : Math.min(1, (x - held) / TUNE.ringFall);
    return [g, q];
  }

  // 面板底色: ①的半透明黑 → ②的半透明深紫 (k = ②的波走到这一块几成了)
  function mixPanel(k) {
    const A = TUNE.panelInk;
    const B = TUNE.panelPlum;
    return [
      Math.round(A[0] + (B[0] - A[0]) * k),
      Math.round(A[1] + (B[1] - A[1]) * k),
      Math.round(A[2] + (B[2] - A[2]) * k)
    ];
  }

  // 面板底色 → 发光紫 → 纯黑 (g/q 两个权重都来自 ringMix)
  function mixRGB(base, g, q) {
    const S = TUNE.seam;
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const mid = base[i] + (S[i] - base[i]) * g;
      out.push(Math.round(mid * (1 - q)));
    }
    return out;
  }

  /* 一帧。
     t      = ①「三角形铺满」走了多久 (永不为负)
     shiftT = ②「面板变深紫」那一趟 (没到就是 NEVER)
     glowT  = ③「紫涟漪带」那一趟 (没到就是 NEVER)
     waveT  = 背景那层「随机变亮~暗淡」的时钟 (ms; 传 0 = 不呼吸)
     ramp   = 呼吸幅度从多小开始长 (0 = 停在「最暗」那一档, 1 = 正常幅度) */
  function draw(t, shiftT, glowT, waveT, ramp) {
    const { w, h } = view;
    const gap = TUNE.gap;
    const grow = ramp === undefined ? 1 : ramp;
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;

    for (let i = 0; i < tris.length; i += 1) {
      const tri = tris[i];
      // ① 淡入: 波按「到中心的距离」走, 走到这块它才出现, 再自己花 revealTri 淡到满
      const p = progress(tri.d, t, TUNE.revealSpread, TUNE.revealTri);
      if (p <= 0) continue;
      // ② 面板底色 黑 → 深紫
      const k = shiftT > -1e9 ? progress(tri.d, shiftT, TUNE.shiftSpread, TUNE.shiftTri) : 0;
      // 背景层用那档中性灰: ①的面板色在纯黑页面上看不见, ②又是紫的 (用户不要紫)
      let base = backdropPanel ? TUNE.backPanel : mixPanel(k);
      /* 背景层: 每块按自己的相位/快慢慢慢变亮再变暗, 整片就不「死」了
         (同一块三角形的亮度是连续的, 不会闪); ramp 让幅度从「最暗」长出来 */
      const breath = waveT ? 0.5 + 0.5 * Math.sin(waveT * TUNE.waveSpeed * tri.rate + tri.ph) : 0.5;
      const lv = 1 - TUNE.waveAmp + TUNE.waveAmp * 2 * breath * grow;
      base = [Math.round(base[0] * lv), Math.round(base[1] * lv), Math.round(base[2] * lv)];
      // ③ 波前 (z = glowT / glowSpread) 从中心往外滚, 走到哪一块那一块就开始变色
      const m = glowT > -1e9 ? ringMix(glowT - tri.d * TUNE.glowSpread) : [0, 0];
      const g = m[0];
      const q = m[1];
      const rgb = mixRGB(base, g, q);
      /* 面板不透明度: 普通亚克力 = 半透 (tri.j 是每块的微抖, 看起来才像一块块独立的亚克力);
         变紫 / 沉黑 = 实心 —— 不实心就盖不住底下的页面, 收尾也就不是全黑了 */
      const solid = g > q ? g : q;
      const a = (TUNE.panelAlpha * tri.j + (1 - TUNE.panelAlpha * tri.j) * solid) * p;
      // 描边比填充再实一点, 黑边才勾得清楚
      const strokeA = Math.min(1, a * 1.35);

      ctx.beginPath();
      ctx.moveTo(tri.ax, tri.ay);
      ctx.lineTo(tri.bx, tri.by);
      ctx.lineTo(tri.cx, tri.cy);
      ctx.closePath();
      ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')';
      ctx.fill();
      ctx.lineWidth = gap;
      ctx.strokeStyle = 'rgba(0,0,0,' + strokeA.toFixed(3) + ')';
      ctx.stroke();
    }
  }

  // 闪一下的半周期写进 CSS 变量 (TUNE.wink 越小闪得越快)
  function applyWink(el, times) {
    el.style.setProperty('--wink-count', String(times));
    el.style.setProperty('--wink-ms', (TUNE.wink * 2) + 'ms');
  }

  /* 闪 times 次 (WinkToDisapper 那套关键帧); 传了 onEnd 就在闪完之后叫一声。
     ⚠️ 除了 animationend 还挂了一个保险的定时器: 万一那条关键帧没生效 (样式没跟上 / 元素不可见),
     animationend 永远不来, 整条链子就卡死在原地 —— 宁可早一点往下走, 也不能卡住不动 */
  function winkEl(el, times, onEnd) {
    if (!el) { if (onEnd) onEnd(); return; }
    applyWink(el, times);
    el.classList.remove('is-winking');
    void el.offsetWidth;            // 强制回流: 连闪两次时后一次才会重新播
    el.classList.add('is-winking');
    if (!onEnd) return;
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      el.classList.remove('is-winking');
      onEnd();
    };
    el.addEventListener('animationend', once, { once: true });
    setTimeout(once, TUNE.wink * 2 * times + 120);
  }

  // 闪完就消失 (WinkToDisapper)
  function winkToDisapper(el, times, onEnd) {
    winkEl(el, times, () => { el.remove(); if (onEnd) onEnd(); });
  }

  /* 加载条: 一段一段地抽速度 + 偶尔卡一下 (「卡壳感」), 从 from 爬到 to (都是 0~1 的比例) */
  function runLoadBar(fill, from, to, duration, done) {
    const chunks = 12;
    const grow = [];
    const dur = [];
    let sumGrow = 0;
    let sumDur = 0;
    for (let i = 0; i < chunks; i += 1) {
      // 两个随机数相乘 = 多数是小步、偶尔一大步, 看着才像真的在加载
      grow.push(Math.random() * Math.random() + 0.05);
      // 偶尔来一段特别长的 = 卡一下 (权重后面会被归一化, 所以是个相对值)
      dur.push(0.3 + Math.random() * (Math.random() < 0.22 ? 2.4 : 0.9));
      sumGrow += grow[i];
      sumDur += dur[i];
    }
    const stops = [[0, from]];
    let accG = 0;
    let accD = 0;
    for (let i = 0; i < chunks; i += 1) {
      accG += grow[i] / sumGrow;
      accD += dur[i] / sumDur;
      stops.push([accD, from + (to - from) * accG]);
    }
    stops[stops.length - 1][1] = to;   // 收尾正正好好停在 to

    const t0 = performance.now();
    function frame(now) {
      const f = Math.min(1, (now - t0) / duration);
      let i = 1;
      while (i < stops.length - 1 && stops[i][0] < f) i += 1;
      const prev = stops[i - 1];
      const next = stops[i];
      const k = next[0] > prev[0] ? (f - prev[0]) / (next[0] - prev[0]) : 1;
      fill.style.width = ((prev[1] + (next[1] - prev[1]) * k) * 100).toFixed(2) + '%';
      if (f >= 1) { fill.style.width = (to * 100) + '%'; done(); return; }
      barRaf = requestAnimationFrame(frame);
    }
    barRaf = requestAnimationFrame(frame);
  }

  /* 一条新进度条: i = 推进的填充, b = 从起始端扫过来的黑幕 (完成时用) */
  function makeBar() {
    const box = document.createElement('div');
    box.className = 'term-boot-bar';
    const fill = document.createElement('i');
    const wipe = document.createElement('b');
    box.appendChild(fill);
    box.appendChild(wipe);
    return { box: box, fill: fill, wipe: wipe };
  }

  // 进度条爬满之后: 黑幕从起始端扫过来 (0.7s, easeInOutCubic), 扫完整条就看不见了
  function darkenBar(bar) {
    bar.wipe.style.transition = 'width ' + TUNE.barDark + 'ms cubic-bezier(0.65, 0, 0.35, 1)';
    void bar.wipe.offsetWidth;   // 先让那个 transition 生效, 再改宽度
    bar.wipe.style.width = '100%';
    setTimeout(() => bar.box.remove(), TUNE.barDark + 60);
  }

  /* asyfunc 把敲的秘钥交给服务端校验 (POST /api/terminal/access)。
     服务端对着 D1 的 secret 表比 (key = terminal.accessKey, "case" = 大小写是否必须一致),
     对了才顺手把 terminal.access 属性发下来 —— 秘钥不落前端, 这里也拿不到它 */
  async function verifyTerminalKey(key) {
    try {
      const response = await fetch('/api/terminal/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      if (!response.ok) return false;
      const data = await response.json();
      return data && data.ok === true;
    } catch (err) {
      return false;
    }
  }

  /* asyfunc 我自己的全部属性 (加载期定面板状态用): GET /api/view-permissions */
  async function fetchAttributes() {
    try {
      const response = await fetch('/api/view-permissions', { cache: 'no-store' });
      if (!response.ok) return [];
      const data = await response.json();
      return data && Array.isArray(data.attributes) ? data.attributes : [];
    } catch (err) {
      return [];
    }
  }

  /* asyfunc 加载期那两件真活: 我的属性 + 那两张文章卡的叙述 (并行发, 谁慢等谁) */
  function worldData() {
    /* 叙述正文里可能写了 <view …> (观看者信息): 顺手把上下文填上 —— 不 await, 点开那张卡时早就回来了。
       time 取这一次请求的时刻 (用户 2026-10-01: 按请求该文章的时间) */
    const at = Date.now();
    if (typeof getCurrentUser === 'function') {
      getCurrentUser().then((me) => {
        if (typeof setViewContext !== 'function') return;
        setViewContext({
          user: me && me.username,
          nickname: me && (me.nickname || me.username),
          permissions: (me && me.permissions) || [],
          time: at
        });
      });
    }
    return Promise.all([fetchAttributes(), fetchTerminalArticles()]);
  }

  /* asyfunc 终端那两张文章卡的内容: 加载期一次拿完 (按面板 key 分组, 点开不再请求) */
  async function fetchTerminalArticles() {
    try {
      const response = await fetch('/api/terminal/articles', { cache: 'no-store' });
      if (!response.ok) return {};
      const data = await response.json();
      return (data && data.panels) || {};
    } catch (err) {
      return {};
    }
  }

  /* asyfunc 把答案交给服务端 (POST /api/terminal/iota): 对了那边发 foraine.iota 属性, 答案不落前端 */
  async function submitIotaKey(key) {
    try {
      const response = await fetch('/api/terminal/iota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      if (!response.ok) return false;
      const data = await response.json();
      return data && data.ok === true;
    } catch (err) {
      return false;
    }
  }

  /* 密钥闸门: 拒绝访问 + 一个「左右各一个向外三角」的纯白输入框。
     敲错了不整块闪, 而是整条 (输入框 + 两侧三角) 一起红一下再渐回白; 敲对了才闪掉 */
  function showGate(host, onPass) {
    const gate = document.createElement('div');
    gate.className = 'term-gate';

    const msg = document.createElement('p');
    msg.className = 'term-gate-msg';
    msg.setAttribute('data-i18n', 'terminal.denied');
    msg.textContent = '拒绝访问 - 请输入终端秘钥';

    /* 输入框 + 左上角那行小字标签 (terminal 的输入框一律不用 placeholder) */
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'term-field';
    const fieldLabel = document.createElement('span');
    fieldLabel.className = 'term-field-label';
    fieldLabel.setAttribute('data-i18n', 'terminal.needKey');
    fieldLabel.textContent = '需要秘钥';
    const field = document.createElement('div');
    field.className = 'term-gate-field';
    const input = document.createElement('input');
    input.className = 'term-gate-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '终端秘钥');
    field.appendChild(input);
    fieldWrap.appendChild(fieldLabel);
    fieldWrap.appendChild(field);

    gate.appendChild(msg);
    gate.appendChild(fieldWrap);
    host.appendChild(gate);
    if (window.I18N) I18N.apply(gate);

    void gate.offsetWidth;
    gate.classList.add('is-in');
    input.focus();

    /* 敲错: 清空 + 红一下再渐回白 (动效在 CSS 里, 这里只负责挂类) */
    let wrongTimer = 0;
    const markWrong = () => {
      input.value = '';
      gate.classList.remove('is-wrong');
      void gate.offsetWidth;      // 强制回流: 连着错两次时后一次才会重新播
      gate.classList.add('is-wrong');
      clearTimeout(wrongTimer);
      wrongTimer = setTimeout(() => gate.classList.remove('is-wrong'), TUNE.denyMs);
    };
    const clearWrong = () => { clearTimeout(wrongTimer); gate.classList.remove('is-wrong'); };

    /* 验证中: 立刻变灰 + 锁住输入 (结果出来再解锁)。
       ⚠️ 不用 input.disabled —— 全站那条 `input:disabled` 会把底色刷成半透黑
       (0,1,1 压得过 .term-gate-input 的 0,1,0), 看起来就是「输入框变黑了」 */
    const setChecking = (on) => {
      gate.classList.toggle('is-checking', on);
      input.readOnly = on;
      if (on) input.blur();
      else input.focus();
    };

    let checking = false;
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || checking) return;
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      checking = true;
      /* ⚠️ 先锁再等: 等接口回话才变色的话, 慢网下按下去会有明显一段没反应 (用户报的延迟) */
      setChecking(true);
      const ok = await verifyTerminalKey(value);
      checking = false;
      setChecking(false);      // 结果出来了, 解锁 (红闪 / 白闪都看得见)
      if (!ok) { markWrong(); return; }
      clearWrong();
      input.blur();
      // 输入框整体闪掉 (连两侧三角一起), 闪完再往下走
      winkEl(field, 3, () => { gate.remove(); onPass(); });
    });
  }

  /* 面板浮动: **每块各自判定** —— 指针靠近到 floatRange 之内才动, 方向是**跟着指针**,
     越近跟得越多 (贴上去时最多 panelFloat); 整层不再一起挪。
     屏幕坐标 = 屏幕中心 + 拖世界那个 pan + 这块自己的世界坐标 */
  function applyLook() {
    if (!panelEl) return;
    panelEl.style.setProperty('--pan-x', pan.x.toFixed(1) + 'px');
    panelEl.style.setProperty('--pan-y', pan.y.toFixed(1) + 'px');
    // 目标: 指针在页面上就用它, 否则回屏幕正中 → 所有面板的偏移一起收回去
    cursor.tx = cursorLive ? cursor.tx : window.innerWidth / 2;
    cursor.ty = cursorLive ? cursor.ty : window.innerHeight / 2;
    cursor.x += (cursor.tx - cursor.x) * TUNE.lookEase;
    cursor.y += (cursor.ty - cursor.y) * TUNE.lookEase;
    const cx = window.innerWidth / 2 + pan.x;
    const cy = window.innerHeight / 2 + pan.y;
    for (let i = 0; i < slots.length; i += 1) {
      const s = slots[i];
      if (!lookOn) {
        s.fx = 0;
        s.fy = 0;
        s.el.style.setProperty('--fx', '0px');
        s.el.style.setProperty('--fy', '0px');
        continue;
      }
      const dx = cursor.x - (cx + s.x);
      const dy = cursor.y - (cy + s.y);
      const dist = Math.hypot(dx, dy) || 1;
      // 量到「面板边缘」的距离: 面板自己的半径算进去了, 大块小块的触发手感才一致
      const near = 1 - Math.max(0, dist - s.radius) / TUNE.floatRange;
      if (near <= 0) {
        s.fx = 0;
        s.fy = 0;
        s.el.style.setProperty('--fx', '0px');
        s.el.style.setProperty('--fy', '0px');
        continue;
      }
      const k = near * TUNE.panelFloat / dist;   // 正值 = 往指针那边靠
      s.fx = dx * k;
      s.fy = dy * k;
      s.el.style.setProperty('--fx', s.fx.toFixed(2) + 'px');
      s.el.style.setProperty('--fy', s.fy.toFixed(2) + 'px');
    }
    // 父节点与子节点都在浮动 → 连线得按它们**现在**的位置重算角度与长度
    paintLinks();
  }

  /* 连线: 两端各停在两个形状的边界上, 而且跟着组件当下的位置 (含浮动偏移) 走 */
  function paintLinks() {
    for (let i = 0; i < linkSpecs.length; i += 1) {
      const s = linkSpecs[i];
      const px = s.parent.x + (s.parent.fx || 0);
      const py = s.parent.y + (s.parent.fy || 0);
      const cx = s.child.x + (s.child.fx || 0);
      const cy = s.child.y + (s.child.fy || 0);
      const dx = cx - px;
      const dy = cy - py;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const a = polyRay(s.parent.w, s.parent.h, HEX_PTS, ux, uy);
      const b = polyRay(s.child.w, s.child.h, CARD_PTS, -ux, -uy);
      // svg 铺在 -2000..+2000 那方块里, 所以要加 2000 的偏移
      s.line.setAttribute('x1', (2000 + px + a * ux).toFixed(1));
      s.line.setAttribute('y1', (2000 + py + a * uy).toFixed(1));
      s.line.setAttribute('x2', (2000 + cx - b * ux).toFixed(1));
      s.line.setAttribute('y2', (2000 + cy - b * uy).toFixed(1));
    }
  }

  /* 浮动开不开: 只有桌面 (有真指针) 才开; 移动端与「减少动效」保持完全静止 */
  function bindLook() {
    lookOn = !reduceMotion && matchMedia('(hover: hover) and (pointer: fine)').matches;
    // 起点就摆在指针那儿 (它可能已经停在屏幕上了): 不然头几帧会从原点抳过去
    cursor.x = cursorLive ? cursor.tx : window.innerWidth / 2;
    cursor.y = cursorLive ? cursor.ty : window.innerHeight / 2;
  }

  /* 六边形沿单位方向 (dx, dy) 的半宽 (支撑函数: 六个顶点在 d 上的投影取最大)。
     顶点与 page-terminal.css 的 clip-path 一致: 平边朝上, 左右各一个尖角 */
  function hexSupport(w, h, dx, dy) {
    return polySupport(w, h, HEX_PTS, dx, dy);
  }

  /* 四边形沿单位方向 (dx, dy) 的半宽: 顶点用百分比给 (与 clip-path 同一套) */
  function polySupport(w, h, pts, dx, dy) {
    let best = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const v = (pts[i][0] - 0.5) * w * dx + (pts[i][1] - 0.5) * h * dy;
      if (v > best) best = v;
    }
    return best;
  }

  // 六边形 (面板) 与平行四边形 (文章卡) 在 CSS 里的顶点
  const HEX_PTS = [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]];
  const CARD_PTS = [[0.22, 0], [1, 0], [0.78, 1], [0, 1]];

  /* 形状沿单位方向 (dx, dy) 从中心到边界的距离: 射线与每条边求交, 取最小的正 t。
     ⚠️ 不能用支撑函数顶替 —— 它给的是顶点投影的最大值, 只有中心对称的形状才等于边界距离;
     平行四边形上就能看出来了 (左线缩到卡片中心 / 右线甩到卡片外面) */
  function polyRay(w, h, pts, dx, dy) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const ax = (pts[i][0] - 0.5) * w;
      const ay = (pts[i][1] - 0.5) * h;
      const j = (i + 1) % pts.length;
      const bx = (pts[j][0] - 0.5) * w;
      const by = (pts[j][1] - 0.5) * h;
      const ex = bx - ax;
      const ey = by - ay;
      const den = ex * dy - ey * dx;          // cross(e, d)
      if (!den) continue;                     // 这条边与射线平行
      const t = (ex * ay - ey * ax) / den;     // cross(e, A) / cross(e, d)
      if (t <= 0 || t >= best) continue;
      const hx = t * dx;
      const hy = t * dy;
      // 交点得落在这一条边里, 不是它的延长线上
      if ((hx - ax) * (hx - bx) + (hy - ay) * (hy - by) <= 0) best = t;
    }
    return best === Infinity ? 0 : best;
  }

  // 第 slot 块的方向 (12 点起顺时针): 屏幕坐标 y 向下, 所以向上的分量是 -cos
  function slotDir(slot) {
    const rad = ((slot - 1) * 60) * Math.PI / 180;
    return { dx: Math.sin(rad), dy: -Math.cos(rad) };
  }

  /* 环的外接框 (缩放 s 时多大): syncTermScale 拿它反解出「整环都装得下」的比例。
     面板尺寸对 s 是线性的, 只有 panelGap 那几段不跟着缩, 所以量 s=1 与 s=0 两点就能外推 */
  function ringBox(s, mw, mh, sw, sh) {
    let minX = -mw * s / 2, maxX = mw * s / 2, minY = -mh * s / 2, maxY = mh * s / 2;
    for (let slot = 1; slot <= 6; slot += 1) {
      const d = slotDir(slot);
      const r = s * (hexSupport(mw, mh, d.dx, d.dy) + hexSupport(sw, sh, -d.dx, -d.dy)) + TUNE.panelGap;
      const x = r * d.dx;
      const y = r * d.dy;
      minX = Math.min(minX, x - sw * s / 2);
      maxX = Math.max(maxX, x + sw * s / 2);
      minY = Math.min(minY, y - sh * s / 2);
      maxY = Math.max(maxY, y + sh * s / 2);
    }
    return { w: maxX - minX, h: maxY - minY };
  }

  /* 面板摆位: 主面板在正中 (0,0), 其余六块按 data-slot 环在 12/2/4/6/8/10 点。
     圆心距 = 主面板沿该方向的半宽 + panelGap + 那一块自己沿反方向的半宽 —— 两块边缘正好隔 panelGap。
     顺手量出内容外接框 → 拖动的边界 (panB)。⚠️ 面板尺寸是响应式的, 视口一变就得重摆一次 */
  function layoutPanels() {
    const wrap = panelEl;
    if (!wrap) return;
    const main = wrap.querySelector('.term-panel[data-cell="0,0"]');
    if (!main) return;
    const mw = main.offsetWidth;
    const mh = main.offsetHeight;
    main.style.left = '0px';
    main.style.top = '0px';
    slots = [{ el: main, x: 0, y: 0, radius: Math.hypot(mw, mh) / 2 }];
    let minX = -mw / 2, maxX = mw / 2, minY = -mh / 2, maxY = mh / 2;
    Array.prototype.forEach.call(wrap.querySelectorAll('.term-panel[data-slot]'), (el) => {
      const slot = parseInt(el.getAttribute('data-slot'), 10) || 1;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const d = slotDir(slot);
      // 沿这条线量：主面板的半宽 + 缝 + 那一块的半宽 —— 对面是同一个六边形, 方向反过来即可
      const r = hexSupport(mw, mh, d.dx, d.dy) + TUNE.panelGap + hexSupport(w, h, -d.dx, -d.dy);
      const x = r * d.dx;
      const y = r * d.dy;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      slots.push({ el: el, x: x, y: y, radius: Math.hypot(w, h) / 2 });   // 浮动要用 (见 applyLook)
      minX = Math.min(minX, x - w / 2);
      maxX = Math.max(maxX, x + w / 2);
      minY = Math.min(minY, y - h / 2);
      maxY = Math.max(maxY, y + h / 2);
    });

    /* Iota 两肩那两张平行四边形卡: 11 点与 1 点方向, 离 Iota 面板边缘 TUNE.panelGap
       (卡的形状是斜的, 用与 clip-path 同一套顶点算支撑函数) */
    const iota = wrap.querySelector('.term-panel[data-cell="0,1"]');
    if (iota) {
      const kw = iota.offsetWidth;
      const kh = iota.offsetHeight;
      const kx = parseFloat(iota.style.left) || 0;
      const ky = parseFloat(iota.style.top) || 0;
      // 父节点那一份槽位 (它也在浮动, 连线要用它的实际位置); 顺手把尺寸记上
      let parentSlot = null;
      for (let i = 0; i < slots.length; i += 1) if (slots[i].el === iota) parentSlot = slots[i];
      if (parentSlot) { parentSlot.w = kw; parentSlot.h = kh; }
      linkSpecs = [];
      Array.prototype.forEach.call(wrap.querySelectorAll('.term-card'), (el) => {
        const dir = el.getAttribute('data-side') === 'left' ? -1 : 1;
        const rad = dir * (Math.PI / 6);        // ±30° = 11 点 / 1 点
        const dx = Math.sin(rad);
        const dy = -Math.cos(rad);
        const cw = el.offsetWidth;
        const ch = el.offsetHeight;
        const r = hexSupport(kw, kh, dx, dy) + TUNE.panelGap + polySupport(cw, ch, CARD_PTS, -dx, -dy);
        const x = kx + r * dx;
        const y = ky + r * dy;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        const cardSlot = { el: el, x: x, y: y, radius: Math.hypot(cw, ch) / 2, w: cw, h: ch };
        slots.push(cardSlot);
        // 父节点与这张卡之间那根细线: 端点几何交给 paintLinks (它每帧按实际位置重算)
        const line = wrap.querySelector('.term-links line[data-link="' + el.getAttribute('data-key') + '"]');
        if (line && parentSlot) linkSpecs.push({ line: line, parent: parentSlot, child: cardSlot });
        minX = Math.min(minX, x - cw / 2);
        maxX = Math.max(maxX, x + cw / 2);
        minY = Math.min(minY, y - ch / 2);
        maxY = Math.max(maxY, y + ch / 2);
      });
    }
    paintLinks();
    /* 边界 (用户: 设定边界, 到边界时滑动速度变为 0 / 如果有内容, 则根据内容扩展):
       管的是「屏幕上看到的世界中心」——它必须待在内容外接框外扩 worldPad 之内。
       内容变多, 外接框变大, 能拖的范围跟着长 */
    const pad = TUNE.worldPad;
    panB.minX = -maxX - pad;
    panB.maxX = pad - minX;
    panB.minY = -maxY - pad;
    panB.maxY = pad - minY;
    clampPan();
  }

  // 撞到边界就把那一边的速度清零 (用户: 到边界时滑动速度变为0)
  function clampPan() {
    if (pan.x <= panB.minX) { pan.x = panB.minX; if (vel.x < 0) vel.x = 0; }
    else if (pan.x >= panB.maxX) { pan.x = panB.maxX; if (vel.x > 0) vel.x = 0; }
    if (pan.y <= panB.minY) { pan.y = panB.minY; if (vel.y < 0) vel.y = 0; }
    else if (pan.y >= panB.maxY) { pan.y = panB.maxY; if (vel.y > 0) vel.y = 0; }
  }

  /* 松手之后的惯性滑行: 按速度往前走, 摩擦力让速度每帧乘一次 (dt 归一化, 跟帧率无关);
     速度小到几乎看不见就归零, 免得一直挂着一帧帧地跑 */
  function glide(dt) {
    if (!vel.x && !vel.y) return;
    const k = Math.pow(TUNE.worldFric, dt / 16.67);
    vel.x *= k;
    vel.y *= k;
    pan.x += vel.x * dt;
    pan.y += vel.y * dt;
    if (Math.abs(vel.x) < TUNE.worldStop) vel.x = 0;
    if (Math.abs(vel.y) < TUNE.worldStop) vel.y = 0;
    clampPan();
  }

  /* 矩形亚克力模态框 (0,1 那块面板里的钥匙点开的): 题干 + 输入框 + 绿色确认按钮, 全部在框体内。
     输入框与按钮跟「密钥闸门」同一形制 (白/绿六边形)。
     ⚠️ 挂在 body 上而不是 .term-world 里: 免得世界的拖动/视差把弹窗一起拖走
     (终端页不加载 layout.js, 没有全站那个 #modal-overlay 可用) */
  function openStarModal() {
    if (starEl) return;    const back = document.createElement('div');
    back.className = 'term-modal-back';
    const modal = document.createElement('div');
    modal.className = 'term-modal';

    const text = document.createElement('p');
    text.className = 'term-modal-text';
    text.setAttribute('data-i18n', 'terminal.quest');
    text.textContent = '解锁 Iota 访问权限';

    // 输入框: 外层白六边形 + 里面透明输入框 (和密钥闸门同一套类)
    // 输入框 + 左上角那行小灰字 (用户: 输入框左上侧放一个小字「需要秘钥」, 不再用 placeholder)
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'term-field';
    const fieldLabel = document.createElement('span');
    fieldLabel.className = 'term-field-label';
    fieldLabel.setAttribute('data-i18n', 'terminal.needKey');
    fieldLabel.textContent = '需要秘钥';
    const field = document.createElement('div');
    field.className = 'term-gate-field';
    const input = document.createElement('input');
    input.className = 'term-gate-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '终端秘钥');
    field.appendChild(input);
    fieldWrap.appendChild(fieldLabel);
    fieldWrap.appendChild(field);

    // 按钮: 与输入框同形制, 底色换成绿
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'term-modal-btn';
    confirmBtn.setAttribute('data-i18n', 'terminal.submit');
    confirmBtn.textContent = '确认';

    // 横带里的排版: 左右各一半 (分割线落在正中), 左边标题、右边输入框 + 按钮; 窄屏由 CSS 改回竖排
    const inner = document.createElement('div');
    inner.className = 'term-modal-inner';
    const right = document.createElement('div');
    right.className = 'term-modal-right';
    right.appendChild(fieldWrap);
    right.appendChild(confirmBtn);
    inner.appendChild(text);
    inner.appendChild(right);

    // 分割线是 .term-modal-right::before (跟着右栏走, 比例改了也不会错位)
    modal.appendChild(inner);
    back.appendChild(modal);
    document.body.appendChild(back);
    if (window.I18N) I18N.apply(back);
    void back.offsetWidth;      // 先算过样式再挂类, 那 0.36s 的「长出来」才会播
    back.classList.add('is-in');
    input.focus();

    // 已经解开过 → 右栏只留那行「终端权限已解密」, 不再给输入框
    // (属性加载期就读过了, 这里直接看面板状态, 不再异步查 —— 否则输入框会先出现再被换掉)
    const showUnlocked = () => {
      input.blur();
      right.textContent = '';
      const note = document.createElement('p');
      note.className = 'term-modal-note';
      note.setAttribute('data-i18n', 'terminal.permission.unlocked');
      note.textContent = '终端权限已解密';
      right.appendChild(note);
      if (window.I18N) I18N.apply(right);
    };
    const panel = document.querySelector('.term-panel[data-cell="0,1"]');
    if (panel && panel.getAttribute('data-state') === 'done') showUnlocked();

    let checking = false;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    const close = () => {
      if (starEl !== back) return;
      window.removeEventListener('keydown', onKey, true);
      /* 关闭也有动画: 撤掉 .is-in → 高度缩回 0 + 淡出, 等它收完再把节点摘掉 */
      back.classList.remove('is-in');
      starEl = null;
      setTimeout(() => back.remove(), 420);
    };
    const markWrong = () => {
      input.value = '';
      back.classList.remove('is-wrong');
      void back.offsetWidth;      // 强制回流, 连着错两次时后一次才会重新播
      back.classList.add('is-wrong');
      setTimeout(() => back.classList.remove('is-wrong'), TUNE.denyMs);
    };
    /* 验证中: 立刻变灰 + 锁住输入框与按钮 (结果出来再解锁)。
       ⚠️ 输入框用 readOnly 不用 disabled —— 全站那条 input:disabled 会把底色刷成半透黑 */
    const setChecking = (on) => {
      back.classList.toggle('is-checking', on);
      input.readOnly = on;
      confirmBtn.disabled = on;
    };
    /* 回车与按钮共用这一条: 对了变绿 → 合上 (核对了但先不做事, 用户: 还没想好这里写什么解密) */
    const trySubmit = async () => {
      if (checking) return;
      const value = input.value.trim();
      if (!value) return;
      checking = true;
      setChecking(true);
      input.blur();
      const ok = await submitIotaKey(value);
      checking = false;
      setChecking(false);
      if (!ok) { markWrong(); input.focus(); return; }
      input.blur();
      // 答对了: 这块面板从此算「已完成」(紫), 然后变绿合上
      setPanelState('0,1', 'done');
      back.classList.add('is-ok');
      setTimeout(close, 620);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      trySubmit();
    });
    confirmBtn.addEventListener('click', trySubmit);
    // 点空白处合上 (框体自己不算「空白」)
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    window.addEventListener('keydown', onKey, true);
    starEl = back;
  }

  /* 「显示终端文章面板的 QuoteKey」开关 (个性化 > 显示 里那张卡; 只影响本机) */
  function showQuoteKeyOn() {
    try { return localStorage.getItem('foraine.term.quoteKey') === '1'; } catch (err) { return false; }
  }

  /* 文章集模态框: 左边一列 quotekey 卡片 (点了切右边), 右边是那一篇的正文。
     最高 80vh, 超高时右栏内部滚 (滚动条平时隐形, 鼠标进右栏才出现)。
     ⚠️ 内容全在加载期拿好了 (articleSets), 这里不再发请求 */
  function openArticleModal(panelKey) {
    if (starEl) return;
    const rows = (articleSets && articleSets[panelKey]) || [];
    const back = document.createElement('div');
    back.className = 'term-modal-back';
    const modal = document.createElement('div');
    modal.className = 'term-modal term-article-modal';
    const inner = document.createElement('div');
    inner.className = 'term-modal-inner';
    const left = document.createElement('div');
    left.className = 'term-modal-text term-article-list';
    const right = document.createElement('div');
    right.className = 'term-modal-right term-article-body';
    inner.appendChild(left);
    inner.appendChild(right);
    modal.appendChild(inner);
    // 面板的 key: 待「个性化 > 显示 > QuoteKey」打开才给 (灰字, 可选中复制)
    if (showQuoteKeyOn()) {
      const keyEl = document.createElement('span');
      keyEl.className = 'term-article-key';
      keyEl.textContent = panelKey;
      modal.appendChild(keyEl);
    }
    back.appendChild(modal);

    /* 窄屏: 左栏那列文章整块收进右下角的圆形按钮 → 右侧抽屉 (灰色亚克力 + 斜条纹 + 模糊遮罩)。
       宽屏照旧是两栏并排; 两份列表都在 DOM 里, 同一屏只会看见一份 (与资源页的「类型」抽屉同一个做法) */
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'term-article-toggle';
    toggle.setAttribute('aria-label', '文章');
    toggle.title = '文章';
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
      + ' stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z"></path><circle cx="7.6" cy="7.6" r="1.2"></circle></svg>';
    const shade = document.createElement('div');
    shade.className = 'term-article-shade';
    const drawer = document.createElement('aside');
    drawer.className = 'term-article-drawer';
    const drawerHead = document.createElement('div');
    drawerHead.className = 'term-article-drawer-head';
    const drawerTitle = document.createElement('p');
    drawerTitle.className = 'term-article-drawer-title';
    drawerTitle.setAttribute('data-i18n', 'name.article');
    drawerTitle.textContent = '文章';
    const drawerClose = document.createElement('button');
    drawerClose.type = 'button';
    drawerClose.className = 'term-article-drawer-close';
    drawerClose.setAttribute('aria-label', '关闭');
    drawerClose.title = '关闭';
    drawerClose.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
    drawerHead.appendChild(drawerTitle);
    drawerHead.appendChild(drawerClose);
    const drawerBody = document.createElement('div');
    drawerBody.className = 'term-article-drawer-body';
    drawer.appendChild(drawerHead);
    drawer.appendChild(drawerBody);
    back.appendChild(toggle);
    back.appendChild(shade);
    back.appendChild(drawer);
    const setDrawer = (on) => {
      drawer.classList.toggle('is-on', on);
      shade.classList.toggle('is-on', on);
    };
    toggle.addEventListener('click', () => setDrawer(true));
    drawerClose.addEventListener('click', () => setDrawer(false));
    shade.addEventListener('click', () => setDrawer(false));

    document.body.appendChild(back);

    // 右栏: 选中那一篇的正文 (Markdown); 查不到就红字「终端查询错误」
    const showArticle = (row, idx) => {
      // 两份列表都要跟上高亮 (左栏那一份与抽屉里那一份, 抽屉挂在 back 上所以要查 back)
      Array.prototype.forEach.call(back.querySelectorAll('.term-article-item'), (n) => {
        n.classList.toggle('is-on', n.getAttribute('data-idx') === String(idx));
      });
      right.textContent = '';
      if (!row || row.missing) {
        const err = document.createElement('p');
        err.className = 'term-article-error';
        err.setAttribute('data-i18n', 'terminal.article.error');
        err.textContent = '终端查询错误';
        right.appendChild(err);
        if (window.I18N) I18N.apply(right);
        return;
      }
      const box = document.createElement('div');
      box.className = 'term-article-md';
      if (typeof window.renderMarkdown === 'function') box.innerHTML = window.renderMarkdown(row.content || '');
      else box.textContent = row.content || '';
      right.appendChild(box);
    };

    const makeItem = (row, idx) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'term-article-item';
      item.setAttribute('data-idx', String(idx));
      // 卡片上写文章标题; 找不到文章就写键名 (点开右边是红字)
      item.textContent = (row.missing || !row.title) ? row.quotekey : row.title;
      item.addEventListener('click', () => {
        showArticle(row, idx);
        setDrawer(false);   // 抽屉里选完就收起来, 看得见正文
      });
      return item;
    };
    rows.forEach((row, idx) => {
      left.appendChild(makeItem(row, idx));
      drawerBody.appendChild(makeItem(row, idx));
    });
    if (!rows.length) {
      [left, drawerBody].forEach((box) => {
        const note = document.createElement('p');
        note.className = 'term-article-note';
        note.setAttribute('data-i18n', 'terminal.article.empty');
        note.textContent = '尚未登记文章';
        box.appendChild(note);
        if (window.I18N) I18N.apply(box);
      });
    }

    void back.offsetWidth;      // 先算过样式再挂类, 那 0.36s 的「长出来」才会播
    back.classList.add('is-in');
    showArticle(rows[0] || null, 0);

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // 抽屉开着就先收抽屉, 再按一下才是关模态框
      if (shade.classList.contains('is-on')) { setDrawer(false); return; }
      close();
    };
    const close = () => {
      if (starEl !== back) return;
      window.removeEventListener('keydown', onKey, true);
      back.classList.remove('is-in');
      starEl = null;
      setTimeout(() => back.remove(), 420);
    };
    // 点空白处合上 (框体自己不算「空白」)
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    window.addEventListener('keydown', onKey, true);
    starEl = back;
  }

  /* 面板尺寸: 宽高按**同一个**比例缩 (各自 min(…, Nvw / Nvh) 的话窄屏上会被压扁),
     比例让「1 主 + 6 环」这一整环都装得下 —— 先把 scale 归 1 量出基准尺寸, 再反解 */
  function syncTermScale() {
    const root = document.documentElement;
    const main = document.querySelector('.term-panel[data-cell="0,0"]');
    const sat = document.querySelector('.term-panel[data-slot="1"]');
    if (!main || !sat) return;
    root.style.setProperty('--term-scale', '1');   // 量基准尺寸 (读 offsetWidth 会强制回流)
    const mw = main.offsetWidth;
    const mh = main.offsetHeight;
    const sw = sat.offsetWidth;
    const sh = sat.offsetHeight;
    if (!mw || !mh || !sw || !sh) return;
    const full = ringBox(1, mw, mh, sw, sh);
    const bare = ringBox(0, mw, mh, sw, sh);
    /* 尺寸对缩放是线性的 (只有 panelGap 那几段不缩): 解 (目标 - bare) / (full - bare) */
    let s = 1;
    if (full.w - bare.w > 0.001) s = Math.min(s, (window.innerWidth * 0.90 - bare.w) / (full.w - bare.w));
    if (full.h - bare.h > 0.001) s = Math.min(s, (window.innerHeight * 0.90 - bare.h) / (full.h - bare.h));
    s = Math.max(0.25, Math.min(1, s));
    root.style.setProperty('--term-scale', s.toFixed(4));
  }

  /* 面板状态 (权威是服务端): 持有面板 data-attribute 声明的属性 = 已完成;
     没持有的里面, 0,0 (回首页) 与 0,1 (还能答 Iota) 是可点, 其余锁着。
     ⚠️ 不再用 localStorage 记「已完成」—— 那正是「没权限也显示紫」的根 */
  function setPanelState(cell, state) {
    const el = document.querySelector('.term-panel[data-cell="' + cell + '"]');
    if (!el) return;
    if (state) el.setAttribute('data-state', state);
    else el.removeAttribute('data-state');
  }
  function applyPermissions(attrs) {
    Array.prototype.forEach.call(document.querySelectorAll('.term-panel[data-cell]'), (el) => {
      const cell = el.getAttribute('data-cell');
      const need = el.getAttribute('data-attribute');
      if (need && attributeHeld(attrs, need)) { el.setAttribute('data-state', 'done'); return; }
      if (cell === '0,0' || cell === '0,1') el.setAttribute('data-state', 'active');
      else el.removeAttribute('data-state');
    });
    applyChildStates();
  }

  /* 节点「完成」的判据: 面板 = 持有自己那条属性; 卡片这类没有属性的节点 = **子节点全部完成**,
     没有子节点就算默认完成 (用户 2026-10-01 定: 文章卡暂时没有子节点, 所以它就是完成的) */
  function nodeDone(el) {
    if (!el) return false;
    if (el.getAttribute('data-attribute')) return el.getAttribute('data-state') === 'done';
    const id = el.getAttribute('data-cell') || el.getAttribute('data-key') || '';
    if (!id) return false;
    const kids = document.querySelectorAll('[data-parent="' + id + '"]');
    for (let i = 0; i < kids.length; i += 1) if (!nodeDone(kids[i])) return false;
    return true;
  }

  /* 子节点 (挂在 data-parent 上的那些卡): 用户定的规矩 —— **看子节点前要先完成父节点**。
     父节点不是「已完成」→ 卡片锁死 (压暗 + 点不动); 连线三档颜色:
     父没完成 = 灰 / 父完成 = 白 / 父子全完成 = 紫。
     ⚠️ 「解锁」(active) 不等于「完成」(done): 解锁了但还没做完, 线依旧灰 */
  function applyChildStates() {
    const cards = Array.prototype.slice.call(document.querySelectorAll('.term-card[data-parent]'));
    if (!cards.length) return;
    const parent = document.querySelector('.term-panel[data-cell="' + cards[0].getAttribute('data-parent') + '"]');
    const open = nodeDone(parent);
    let allDone = true;
    cards.forEach((card) => {
      if (!nodeDone(card)) allDone = false;
      card.classList.toggle('is-locked', !open);
    });
    const links = document.querySelector('.term-links');
    if (links) {
      links.classList.toggle('is-done', open && allDone);
      links.classList.toggle('is-open', open && !allDone);
    }
  }

  /* 属性通配: a.b.* 也顶 a.b.c (与 src/permission.js 的 attributeCovers 一套语义) */
  function attributeHeld(list, need) {
    const target = String(need || '').toLowerCase();
    if (!target) return false;
    for (let i = 0; i < list.length; i += 1) {
      const one = String(list[i] || '').toLowerCase();
      if (one === target) return true;
      if (one.slice(-2) === '.*') {
        const head = one.slice(0, -1);
        if (target.indexOf(head) === 0 && target.length > head.length) return true;
      }
    }
    return false;
  }

  /* 终端页那层「世界」: 常驻的背景格 (可以拖着走) + 上面的面板层 (鼠标视差)。
     格子是**烘在世界坐标里的**, 拖到哪铺到哪, 所以拖多远都没有边界;
     拖动时每帧重铺一次 (算 300 多块三角形, 很便宜), 相位/微抖由格子坐标定, 所以呼吸图案不会跳。
     建好先只画**一帧冻结的**背景 (waveT 传 0 = 不呼吸): 启动画面那会儿看到的背景就是它 */
  function terminalWorld() {
    const world = document.querySelector('.term-world');
    const cv = document.querySelector('.term-world-grid');
    if (!world || !cv) return;
    panelEl = document.querySelector('.term-world-panels');
    canvas = cv;
    ctx = cv.getContext('2d');
    if (!ctx) return;
    backdropPanel = true;
    layout(0, 0);
    syncTermScale();
    layoutPanels();
    // 冻结帧 = 已铺满 + 最暗那一档 (加载完成时再让呼吸长出来)
    draw(TUNE.revealSpread + TUNE.revealTri, NEVER, NEVER, 0, 0);
    // 0,1 那块面板里的钥匙: 点开星型模态框
    const keyBtn = world.querySelector('.term-node-key');
    if (keyBtn) keyBtn.addEventListener('click', openStarModal);
    // 两肩那两张文章卡: 点开文章集 (父节点没解锁时卡片锁着, 点了不做事)
    Array.prototype.forEach.call(world.querySelectorAll('.term-card-btn'), (btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.term-card');
        if (!card || card.classList.contains('is-locked')) return;
        openArticleModal(card.getAttribute('data-key'));
      });
    });
  }

  /* 解开世界 (启动画面收掉时调): 呼吸接着冻结那一帧往下走 + 放开拖动/浮动, 面板层同时淡入 */
  function startWorldLive() {
    if (worldAlive || !ctx) return;
    layoutPanels();
    bindLook();
    bindDrag(document.querySelector('.term-world'));
    if (panelEl) panelEl.classList.add('is-ready');
    // reveal 那一趟早就走完了 (冻结帧就是按它画出来的), 这里只管接着呼吸
    const revealDone = TUNE.revealSpread + TUNE.revealTri;
    const t0 = performance.now();
    let last = t0;
    worldAlive = true;
    (function frame(now) {
      if (!worldAlive) return;
      const dt = Math.min(64, Math.max(1, now - last));
      last = now;
      /* 按住不动就把惯性速度清掉 —— 不然「慢慢拖 → 停一下 → 松手」会莫名其妙甩出去 */
      if (dragActive) { if (now - lastMoveT > 90) { vel.x = 0; vel.y = 0; } }
      else glide(dt);
      const dpr = Math.min(window.devicePixelRatio || 1, TUNE.dprMax);
      const resized = view.w !== window.innerWidth || view.h !== window.innerHeight;
      if (resized || canvas.width !== Math.floor(window.innerWidth * dpr)
        || builtX !== pan.x || builtY !== pan.y) layout(pan.x, pan.y);
      if (resized) syncTermScale();
      if (resized) layoutPanels();   // 面板尺寸跟着 --term-scale 走: 视口一变就得重摆 + 重算边界
      const elapsed = now - t0;
      // 呼吸幅度从「最暗」慢慢长出来 (waveRamp 毫秒后才是正常幅度), 不会一下子跳
      draw(revealDone + elapsed, NEVER, NEVER, elapsed, Math.min(1, elapsed / TUNE.waveRamp));
      applyLook();
      worldRaf = requestAnimationFrame(frame);
    }(performance.now()));
  }

  // teardown 之后把世界重新架一遍 (bfcache 回来时用): 建好就是活的
  function worldStart() {
    if (panelEl || !document.querySelector('.term-world-grid')) return;
    terminalWorld();
    startWorldLive();
  }

  /* 拖动世界: 按住往哪拖, 网格就往哪走 —— 松手之后不立刻停, 而是按甩出去的速度继续滑 (惯性),
     摩擦力让它慢慢停; 碰到边界那一边的速度直接清零 */
  function bindDrag(el) {
    let captured = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    // 平滑一下瞬时速度: 手/鼠标抖一下不会被当成甩动
    const addVel = (vx, vy) => {
      vel.x = vel.x * 0.4 + vx * 0.6;
      vel.y = vel.y * 0.4 + vy * 0.6;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      // 不让浏览器顺手开始「拖图片 / 选文字」, 否则后面的 pointermove 会被原生拖拽吃掉
      e.preventDefault();
      dragActive = true;
      captured = false;
      moved = 0;
      vel.x = 0;              // 按下去的瞬间先刹住
      vel.y = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveT = e.timeStamp;
      el.classList.add('is-grabbing');
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragActive) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastMoveT);
      pan.x += dx;
      pan.y += dy;
      clampPan();            // 拖到边界就停在那儿
      addVel(dx / dt, dy / dt);
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveT = e.timeStamp;
      /* ⚠️ 真开始拖了才抢指针: pointerdown 就抢的话, 连点击都会被改派到这一层上,
         面板里那个图标按钮的 click 就永远收不到了 (不拖 = 不抢, 点得动) */
      if (!captured && moved > 4) {
        captured = true;
        if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      }
    });
    const stop = () => {
      if (!dragActive) return;
      dragActive = false;
      el.classList.remove('is-grabbing');
      // 甩太快就限一下速
      const cap = TUNE.worldMaxVel;
      vel.x = Math.max(-cap, Math.min(cap, vel.x));
      vel.y = Math.max(-cap, Math.min(cap, vel.y));
      // 拖过头就不算点击 (否则一拖就顺手点开面板里的按钮)
      if (moved > 6) {
        const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  // 进度条的 Promise 版 (两件事并行时用)
  function barTo(fill, from, to, duration) {
    return new Promise((resolve) => runLoadBar(fill, from, to, duration, resolve));
  }

  /* asyfunc 启动画面 (/terminal 一页到底, 没有第二个页面):
     冻结的背景 (世界那层画的) + 图标 + 系统名 + 进度条 → 加载期真去读一次属性
     → 没 terminal.access 就先出闸门 → 收条 + 淡出 → 直接露出面板世界 */
  function terminalBoot() {
    if (bootLayer) return;

    bootLayer = document.createElement('div');
    bootLayer.className = 'term-boot-layer';

    const boot = document.createElement('div');
    boot.className = 'term-boot';

    const logo = document.createElement('div');
    logo.className = 'term-boot-logo';
    logo.appendChild(document.createElement('i'));

    const name = document.createElement('p');
    name.className = 'term-boot-name';
    name.setAttribute('data-i18n', 'terminal.system');
    name.textContent = 'Narralethe 系统';

    boot.appendChild(logo);
    boot.appendChild(name);
    bootLayer.appendChild(boot);
    document.body.appendChild(bootLayer);
    if (window.I18N) I18N.apply(boot);

    void boot.offsetWidth;     // 先算过样式再挂类, 那 0.4s 的淡入才会播
    boot.classList.add('is-in');

    /* 收尾: 图标与系统名一起闪掉 → 启动层淡出 → 世界解开 (背景接着那一帧呼吸, 面板同时浮现) */
    let done = false;
    const revealWorld = () => {
      if (done) return;
      done = true;
      bootSkip = null;
      boot.classList.remove('is-run', 'is-gate');
      boot.classList.add('is-solo');
      setTimeout(() => {
        winkEl(boot, 3, () => {
          if (bootLayer) bootLayer.classList.add('is-out');
          startWorldLive();
          setTimeout(() => {
            if (bootLayer) { bootLayer.remove(); bootLayer = null; }
          }, 560);
        });
      }, TUNE.postHold);
    };
    bootSkip = revealWorld;      // Esc 跳过启动画面

    /* 敲对秘钥之后: 服务端刚把 terminal.access 发下来, 重新读一次属性再进世界 */
    const afterGate = () => {
      worldData().then(([attrs, panels]) => {
        articleSets = panels;
        applyPermissions(attrs);
        if (reduceMotion) { revealWorld(); return; }
        // 第二趟: 进度条重新从 0 爬到满 (原来这条是爬满就换页, 现在是收条直接进世界)
        boot.classList.remove('is-gate');
        boot.classList.add('is-run');
        const bar = makeBar();
        boot.appendChild(bar.box);
        barTo(bar.fill, 0, 1, TUNE.bootRun).then(() => {
          darkenBar(bar);
          setTimeout(revealWorld, TUNE.barDark);
        });
      });
    };

    const dataPromise = worldData();   // 加载期那件真活: 属性 + 那两张文章卡的内容

    // 「减少动效」: 不演动画, 直接摆成品 (没权限就把闸门摆出来)
    if (reduceMotion) {
      dataPromise.then(([attrs, panels]) => {
        articleSets = panels;
        applyPermissions(attrs);
        if (attributeHeld(attrs, 'terminal.access')) { revealWorld(); return; }
        boot.classList.add('is-gate');
        showGate(boot, afterGate);
      });
      return;
    }

    const bar = makeBar();
    boot.appendChild(bar.box);
    /* 真加载: 进度条爬到 75% **并且**数据读回来了才往下走 (谁慢等谁) */
    Promise.all([dataPromise, barTo(bar.fill, 0, TUNE.bootStop, TUNE.bootLoad)]).then(([[attrs, panels]]) => {
      articleSets = panels;
      applyPermissions(attrs);
      if (!attributeHeld(attrs, 'terminal.access')) {
        // 没权限: 条停住 → 闪掉 → 页内出闸门 (敲对再往下走)
        setTimeout(() => {
          winkToDisapper(bar.box, TUNE.winkTimes, () => {
            boot.classList.add('is-gate');
            showGate(boot, afterGate);
          });
        }, TUNE.bootStopHold);
        return;
      }
      // 有权限: 同一条进度条接着 75% → 100%, 收条就进世界
      boot.classList.add('is-run');
      barTo(bar.fill, TUNE.bootStop, 1, TUNE.bootRun).then(() => {
        darkenBar(bar);
        setTimeout(revealWorld, TUNE.barDark);
      });
    });
  }

  // 全黑: 画一遍纯黑盖死 (面板半透明那一层可能还透出一点底下的页面)
  function blackout() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, view.w, view.h);
  }

  /* asyfunc 首页那颗终端图标点下去那趟三段式过场:
     ① 黑面板的三角形从中心铺满 → ② 面板整体转深紫 (同样是一道从中心往外的波)
     → ③ 紫涟漪带往外滚, 身后沉成纯黑 → 全黑之后换到 /terminal */
  function openingTerminal(target) {
    if (running) return;
    const to = target || '/terminal';
    const leave = () => {
      if (typeof window.pageGoInstant === 'function') window.pageGoInstant(to);
      else window.location.href = to;
    };
    // 「减少动效」: 整个过场跳过, 交给平常那套圆形转场
    if (reduceMotion) {
      if (typeof window.pageTransitionTo === 'function') window.pageTransitionTo(to);
      else window.location.href = to;
      return;
    }
    running = true;

    layer = document.createElement('div');
    layer.className = 'term-opening';
    canvas = document.createElement('canvas');
    layer.appendChild(canvas);
    document.body.appendChild(layer);
    ctx = canvas.getContext('2d');
    if (!ctx) { layer.remove(); running = false; leave(); return; }

    layout(0, 0);
    window.addEventListener('resize', () => layout(0, 0));

    const shiftStart = TUNE.revealSpread + TUNE.revealTri;
    const glowStart = shiftStart + TUNE.shiftSpread + TUNE.shiftTri;
    // 收尾要等波前走到最远的角, 再等它亮起 + 停留 + 沉黑
    const endAt = glowStart + TUNE.glowSpread + TUNE.ringRise + TUNE.ringHold + TUNE.ringFall;
    const t0 = performance.now();

    (function frame(now) {
      const t = now - t0;
      if (t >= endAt) {
        blackout();
        setTimeout(leave, TUNE.bootGap);
        return;
      }
      // waveT / ramp 传 0: 过场里不要呼吸
      draw(t, t >= shiftStart ? t - shiftStart : NEVER, t >= glowStart ? t - glowStart : NEVER, 0, 1);
      raf = requestAnimationFrame(frame);
    }(performance.now()));
  }

  window.openingTerminal = openingTerminal;
  window.terminalBoot = terminalBoot;
  window.terminalTune = TUNE;

  /* 终端页 (/terminal 一个页面搞定): 先把世界建起来 (背景格停在最暗那一帧), 再跑启动画面;
     首页那颗终端图标走 openingTerminal 那趟三段式过场, 全黑后落到这里 */
  if (document.body && document.body.classList.contains('page-terminal')) {
    const start = () => { terminalWorld(); terminalBoot(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
