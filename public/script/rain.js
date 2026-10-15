/* rain.js 首页雨幕 */
/*
  内容: 铺满视口、不吃鼠标事件的 canvas —— 三层粗细不同的雨线 + 落地水花与涟漪 + 玻璃上的镜头水珠;
        强度优先用当时的天气 (GET /api/rain 的 Open-Meteo), 查不到就按 TUNE.timeScale 那张 24 小时表
  首页额外: 点一下屏幕会在落点慢慢扩开一圈涟漪 (起初较粗, 越扩越细); 鼠标还能把玻璃上的泡泡
            推开, 桌面端雨的倾角跟着鼠标位置 (两端 ±steerMax 度), 移动端跟着陀螺仪 (最大 ±gyroMax 度)
  依赖: 无 (导航栏的雨按钮调 window.rainSetEnabled / rainIsEnabled)
*/
// 想调: 改下面的 TUNE, 或在控制台改 window.rainTune (立刻生效)
(function initRain() {
  /* 调参表 */
  const TUNE = {
    // 每小时一个雨量系数 (0~23 点): 后半夜最密, 白天最轻 —— 定位不到天气时按它来
    timeScale: [
      1.30, 1.35, 1.30, 1.25, 1.15, 1.05, // 00-05
      0.95, 0.90, 0.85, 0.80, 0.80, 0.85, // 06-11
      0.90, 0.95, 1.00, 1.05, 1.10, 1.15, // 12-17
      1.20, 1.25, 1.25, 1.30, 1.35, 1.30  // 18-23
    ],
    multiplier: 1.00,   // 总雨量倍率
    angleBase: 5,       // 最小倾角 (度)
    angleMax: 20,       // 最大倾角 (度) —— 风越大越斜
    steerMax: 20,       // 首页: 鼠标到屏幕最左/最右时的最大倾角 (度)
    gyroMax: 15,        // 首页: 手机左右倾斜时的最大倾角 (度)
    steerEase: 0.20,    // 首页: 转向的跟随快慢 (秒, 越小越跟手)
    steerWobble: 0.30,  // 首页: 转向时那条自然风摆动保留多少 (1 = 原样)
    bubbleRadius: 64,   // 首页: 鼠标推泡泡的圆形判定半径 (px)
    bubblePush: 0.55,   // 首页: 推一下给泡泡的初速 (px/帧 @60fps)
    speed: 1.00,        // 下落速度倍率
    density: 1.00,      // 雨滴密度倍率 (基准见 LAYERS)
    splash: 1.00,       // 水花 / 涟漪密度
    lens: 1.00,         // 镜头水珠密度 (0 = 不要)
    fade: 1.00          // 雨的透明度倍率
  };

  // 三层: 越靠"前"越长越粗越快也越亮
  const LAYERS = [
    { density: 0.00010, len: [8, 18], speed: [3.5, 5.5], lw: 0.8, alpha: [0.08, 0.20] },
    { density: 0.000055, len: [18, 36], speed: [6.5, 10], lw: 1.2, alpha: [0.13, 0.30] },
    { density: 0.000022, len: [36, 72], speed: [12, 18], lw: 2.0, alpha: [0.18, 0.38] }
  ];
  const TIERS = [0.75, 1.15, 1.75, 2.60];   // 小 / 中 / 大 / 暴雨 → 雨量倍率

  const canvas = document.createElement('canvas');
  canvas.className = 'rain-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, DPR = 1;
  let drops = [], splashes = [], ripples = [], lensDrops = [];
  let time = 0, raf = 0, running = false, lastT = 0;
  let lensTimer = 0.6;
  let rainOn = true;      // 开关: false = 不再生成新的, 等空中的下完

  let level = 1;          // 当前雨量 (天气或时段给的目标值, 平滑跟随)
  let wantLevel = 1;
  let windBias = Math.tan((TUNE.angleBase * Math.PI) / 180);
  let wantWindBias = windBias;
  let curWind = 0;        // 本帧的风向斜率 (update 算一次, 绘制时直接用)
  let steerAngle = 0;     // 首页指针/陀螺仪给的倾角 (度, 平滑跟随)
  let wantSteerAngle = null;   // 目标倾角; null = 还没有输入, 回天气那份

  /* 性能闸: 高 DPI 大屏上画布像素 = CSS 像素 × DPR², 每帧还要描几千条线, 所以三道闸 ——
     DPR 封顶 (雨是 1~2px 的软线, 降到 1.25× 几乎看不出来) / 雨滴总数封顶 / 连续慢帧自适应降档 */
  const MAX_DROPS = 1500;
  const DENSITY_SUM = LAYERS.reduce((sum, L) => sum + L.density, 0);
  const quality = { density: 1, lens: true, ripples: true, slow: 0, fast: 0 };   // fast = 连续流畅帧数 (用来把降掉的档还回来)

  // 按面积算雨滴数上限, 超了就返回缩放系数
  function dropBudget() {
    const raw = W * H * DENSITY_SUM * TUNE.density * level * quality.density;
    return raw > MAX_DROPS ? MAX_DROPS / raw : 1;
  }

  // 连续慢帧就降档, 连续流畅帧再把降过的档还回来
  function watchFrame(rawDt) {
    // 一帧超过 24ms (≈41fps) 算慢; 连累 8 帧才降一档
    if (rawDt > 0.024) { quality.slow += 1; quality.fast = 0; }
    else {
      quality.slow = Math.max(0, quality.slow - 1);
      quality.fast = rawDt < 0.015 ? quality.fast + 1 : 0;   // 一帧慢了就重新数
    }
    /* 反向也留一条路: 连续 ~4 秒 (240 帧) 都很流畅就把降过的档还回来,
       顺序与降的相反: 先涟漪, 再雨量, 最后才是最贵的镜头水珠 */
    if (quality.fast >= 240) {
      quality.fast = 0;
      if (!quality.ripples) { quality.ripples = true; return; }
      if (quality.density < 1) { quality.density = Math.min(1, quality.density + 0.25); refill(); return; }
      if (!quality.lens) { quality.lens = true; return; }
      return;
    }
    if (quality.slow < 8) return;
    quality.slow = 0;
    if (quality.lens) { quality.lens = false; return; }
    if (quality.density > 0.55) { quality.density -= 0.25; initDrops(); return; }
    if (quality.ripples) quality.ripples = false;
  }

  // 按当前强度重新铺一遍雨滴
  function initDrops() {
    drops = [];
    const budget = dropBudget();
    for (let li = 0; li < LAYERS.length; li += 1) {
      const L = LAYERS[li];
      const n = Math.round(W * H * L.density * TUNE.density * level * quality.density * budget);
      for (let i = 0; i < n; i += 1) {
        drops.push({
          li,
          x: rand(-150, W + 150),
          y: rand(-H, H),
          len: rand(L.len[0], L.len[1]),
          vy: rand(L.speed[0], L.speed[1]),
          w: L.lw,
          a: rand(L.alpha[0], L.alpha[1])
        });
      }
    }
  }

  // 落到底 / 飘出屏幕的雨滴绕回天上
  function respawn(d) {
    const L = LAYERS[d.li];
    d.y = -rand(10, 320);
    d.x = rand(-150, W + 150);
    d.len = rand(L.len[0], L.len[1]);
    d.vy = rand(L.speed[0], L.speed[1]);
    d.a = rand(L.alpha[0], L.alpha[1]);
  }

  // 落点的水花
  function spawnSplash(x, y, li) {
    const scale = 0.6 + li * 0.45;
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i += 1) {
      splashes.push({
        x, y,
        vx: rand(-1.7, 1.7) * scale,
        vy: rand(-4.8, -1.6) * scale,
        r: rand(0.6, 1.7) * scale,
        life: 1
      });
    }
  }

  // 落点的涟漪
  function spawnRipple(x, y, li) {
    if (!quality.ripples) return;   // 性能降档时先舍涟漪
    ripples.push({
      x, y, age: 0,
      dur: rand(0.75, 1.45),
      maxR: rand(12, 34) * (0.55 + li * 0.45)
    });
  }

  // 点一下屏幕: 一圈从指尖慢慢扩开 (首页的交互反馈)
  function spawnClickRipple(x, y) {
    ripples.push({ x, y, age: 0, dur: rand(1.7, 2.1), maxR: rand(60, 90), round: true, lw: rand(3.2, 4.2) });
  }

  // 首页: 鼠标就是个圆形判定箱, 进圈的泡泡吃一次推力, 之后自己飘走
  function pushBubbles(x, y) {
    const radius = TUNE.bubbleRadius;
    for (let i = 0; i < lensDrops.length; i += 1) {
      const l = lensDrops[i];
      if (l.pushed) continue;
      const dx = l.x - x;
      const dy = l.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      // 贴着鼠标中心时方向随机, 否则背着鼠标走
      const away = dist < 0.5 ? rand(0, TAU) : Math.atan2(dy, dx);
      const force = TUNE.bubblePush * rand(0.7, 1.3);
      l.pushed = true;
      l.vx = Math.cos(away) * force;
      l.vy += Math.sin(away) * force * 0.5;
    }
  }

  /* 更新 */
  function update(dt) {
    const k = dt * 60;
    time += dt;

    // 目标值平滑跟随 (天气/时段变了不生硬)
    const ease = Math.min(1, dt / 1.2);
    if (Math.abs(wantLevel - level) > 0.02) {
      level += (wantLevel - level) * ease;
      // 关了雨就别自己补雨滴回来
      if (rainOn && drops.length < Math.round(W * H * 0.0002 * TUNE.density * level) * 0.5) initDrops();
    }
    if (Math.abs(wantWindBias - windBias) > 0.005) windBias += (wantWindBias - windBias) * ease;

    // 转向: 有输入 (鼠标 / 陀螺仪) 就按它, 没输入就缓缓摆回正中
    const steering = wantSteerAngle !== null;
    const steerEase = Math.min(1, dt / (steering ? TUNE.steerEase : 1.2));
    steerAngle += ((steering ? wantSteerAngle : 0) - steerAngle) * steerEase;

    // 风: 两个正弦叠 + (转向时用指针倾角, 否则用天气带来的固定偏角)
    const wobble = Math.sin(time * 0.23) * 0.22 * 0.6 + Math.sin(time * 0.61 + 2.1) * 0.09 * 0.6;
    const wind = wobble * (steering ? TUNE.steerWobble : 1)
      + (steering ? Math.tan((steerAngle * Math.PI) / 180) : windBias);
    const dl = Math.hypot(wind, 1);
    const dirX = wind / dl;
    const dirY = 1 / dl;
    curWind = wind;

    for (let i = 0; i < drops.length; i += 1) {
      const d = drops[i];
      d.x += d.vy * wind * k * TUNE.speed;
      d.y += d.vy * k * TUNE.speed;

      if (d.y > H) {
        const p = [0.12, 0.30, 0.55][d.li] * TUNE.splash;
        // 落点抬 8px: 涟漪是压扁的椭圆, 贴着最底下会被裁掉半边
        if (Math.random() < p) spawnSplash(d.x, H - 8, d.li);
        if (Math.random() < p * 0.45) spawnRipple(d.x, H - 8, d.li);
        /* 关雨中: 落地就消失, 不再绕回天上 —— 把已经在空中的那批下完为止 */
        if (rainOn) respawn(d);
        else { drops.splice(i, 1); i -= 1; }
      } else if (d.x < -220 || d.x > W + 220) {
        if (rainOn) respawn(d);
        else { drops.splice(i, 1); i -= 1; }
      }
    }
    // 全下完了 (水花/涟漪也都没了) → 自己停帧, 省电
    if (!rainOn && !drops.length && !splashes.length && !ripples.length) stop();

    for (let i = splashes.length - 1; i >= 0; i -= 1) {
      const s = splashes[i];
      s.vy += 0.30 * k;
      s.x += s.vx * k;
      s.y += s.vy * k;
      s.life -= 0.05 * k;
      if (s.life <= 0) splashes.splice(i, 1);
    }

    for (let i = ripples.length - 1; i >= 0; i -= 1) {
      const r = ripples[i];
      r.age += dt;
      if (r.age >= r.dur) ripples.splice(i, 1);
    }

    // 镜头水珠: 隔一会儿落一颗, 慢慢往下滑 + 轻微晃动
    lensTimer -= dt;
    const lensMax = quality.lens ? Math.round(24 * TUNE.lens) : 0;
    if (lensTimer <= 0 && lensDrops.length < lensMax) {
      lensTimer = rand(0.3, 1.5) / Math.max(0.2, TUNE.lens);
      lensDrops.push({
        x: rand(0, W),
        y: rand(-H * 0.15, H * 0.72),
        r: rand(1.5, 6.5),
        vx: 0,
        vy: rand(0.03, 0.15),
        wob: rand(0, TAU)
      });
    }
    for (let i = lensDrops.length - 1; i >= 0; i -= 1) {
      const l = lensDrops[i];
      l.vy += 0.0016 * k;
      l.x += l.vx * k;
      l.y += l.vy * k;
      l.wob += 0.03 * k;
      if (l.y - l.r > H || l.x < -80 || l.x > W + 80) lensDrops.splice(i, 1);
    }
  }

  /* 渲染 */
  // 涟漪 (落地的压扁椭圆; 点击那颗是慢慢扩开的正圆, 越扩越细)
  function drawRipples() {
    for (let i = 0; i < ripples.length; i += 1) {
      const r = ripples[i];
      const t = r.age / r.dur;
      const rad = r.maxR * (1 - Math.pow(1 - t, 3));
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, Math.max(0.6, rad * (r.round ? 1 : 0.2)), 0, 0, TAU);
      ctx.strokeStyle = 'rgba(160,205,255,' + (1 - t) * (r.round ? 0.5 : 0.45) + ')';
      ctx.lineWidth = r.round ? Math.max(0.5, r.lw * (1 - t)) : 1;
      ctx.stroke();
    }
  }

  // 三层雨线, 按当前风向斜着画
  function drawRain() {
    ctx.lineCap = 'round';
    const dl = Math.hypot(curWind, 1);
    const dirX = curWind / dl;
    const dirY = 1 / dl;
    for (let i = 0; i < drops.length; i += 1) {
      const d = drops[i];
      ctx.beginPath();
      ctx.moveTo(d.x - dirX * d.len, d.y - dirY * d.len);
      ctx.lineTo(d.x, d.y);
      ctx.strokeStyle = 'rgba(168,206,255,' + Math.min(1, d.a * TUNE.fade) + ')';
      ctx.lineWidth = d.w;
      ctx.stroke();
    }
  }

  // 溅起的水花
  function drawSplashes() {
    for (let i = 0; i < splashes.length; i += 1) {
      const s = splashes[i];
      if (s.life <= 0) continue;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fillStyle = 'rgba(190,222,255,' + s.life * 0.6 + ')';
      ctx.fill();
    }
  }

  // 贴在"镜头"上的水珠: 径向渐变 + 一个高光点
  function drawLensDrops() {
    for (let i = 0; i < lensDrops.length; i += 1) {
      const l = lensDrops[i];
      const fade = Math.min(1, (H - l.y) / 90);
      if (fade <= 0) continue;
      const r = l.r * (1 + Math.sin(l.wob) * 0.05);
      const g = ctx.createRadialGradient(l.x - r * 0.35, l.y - r * 0.4, r * 0.05, l.x, l.y, r * 1.05);
      g.addColorStop(0, 'rgba(232,246,255,' + 0.72 * fade + ')');
      g.addColorStop(0.25, 'rgba(160,200,255,' + 0.24 * fade + ')');
      g.addColorStop(0.75, 'rgba(90,130,200,' + 0.10 * fade + ')');
      g.addColorStop(1, 'rgba(70,110,180,0.01)');
      ctx.beginPath();
      ctx.arc(l.x, l.y, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,215,255,' + 0.18 * fade + ')';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(l.x - r * 0.34, l.y - r * 0.38, r * 0.17, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,' + 0.7 * fade + ')';
      ctx.fill();
    }
  }

  // 每帧: 清屏 → 涟漪 → 雨 → 水花 → 镜头水珠
  function render() {
    ctx.clearRect(0, 0, W, H);
    drawRipples();
    drawRain();
    drawSplashes();
    drawLensDrops();
  }

  /* 主循环 */
  // 一帧: 算间隔 → 降档判定 → 更新 → 渲染
  function step(t) {
    if (!lastT) lastT = t;
    const rawDt = (t - lastT) / 1000;   // 真实帧间隔 —— 自适应降档要看它
    let dt = rawDt;
    lastT = t;
    if (dt > 0.06) dt = 0.06;   // 切回标签页时别跳帧
    if (running) watchFrame(rawDt);
    update(dt);
    render();
    if (running) raf = requestAnimationFrame(step);
  }

  // 开循环
  function start() {
    if (running) return;
    running = true;
    lastT = 0;
    raf = requestAnimationFrame(step);
  }

  // 停循环
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* 强度: 先问天气, 问不到就按几点 */
  // asyfunc 拉一次天气 (2.5 秒超时)
  function applyWeather() {
    wantLevel = (TUNE.timeScale[new Date().getHours()] || 1) * TUNE.multiplier;
    wantWindBias = Math.tan((TUNE.angleBase * Math.PI) / 180);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    fetch('/api/rain', { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.ok) return;
        wantLevel = (d.intensity || TIERS[0]) * TUNE.multiplier;
        const angle = Math.max(TUNE.angleBase, Math.min(TUNE.angleMax, d.angle || TUNE.angleBase));
        wantWindBias = Math.tan((angle * Math.PI) / 180);
      })
      .catch(() => { /* 没网/超时就按时段那份 */ })
      .finally(() => clearTimeout(timer));
  }

  // 尺寸变了就重建画布与雨滴
  function resize() {
    /* DPR 封顶: 大画布用 1.25×, 普通尺寸 1.5× —— 雨线是软线看不出来, 填充量直接降到 1/2 ~ 1/1.8 */
    const area = window.innerWidth * window.innerHeight;
    const cap = area > 2.2e6 ? 1.25 : 1.5;
    DPR = Math.min(window.devicePixelRatio || 1, cap);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initDrops();
    splashes.length = 0;
    ripples.length = 0;
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (rainOn) start();   // 关雨中回到页面别把雨又拉起来
  });

  /* 开关: 关 = 立刻不再生成新的, 把空中的下完 (水花/涟漪也放完) 后自动停帧;
     开 = 只补差值, 因为关雨中落地的雨滴是从数组里 splice 掉的 */
  function refill(spread) {
    const budget = dropBudget();
    const want = LAYERS.map((L) => Math.round(W * H * L.density * TUNE.density * level * quality.density * budget));
    const have = LAYERS.map(() => 0);
    for (let i = 0; i < drops.length; i += 1) have[drops[i].li] += 1;
    for (let li = 0; li < LAYERS.length; li += 1) {
      const L = LAYERS[li];
      const n = want[li] - have[li];
      for (let i = 0; i < n; i += 1) {
        drops.push({
          li,
          x: rand(-150, W + 150),
          // spread = 「开关刚打开」那次: 直接铺满屏 (天上 6 成 / 屏内 4 成)
          y: spread ? (Math.random() < 0.6 ? -rand(10, H * 1.1) : rand(0, H)) : -rand(10, H * 1.1),
          len: rand(L.len[0], L.len[1]),
          vy: rand(L.speed[0], L.speed[1]),
          w: L.lw,
          a: rand(L.alpha[0], L.alpha[1])
        });
      }
    }
  }

  /* 开关记忆按页面分开: 在私聊页把雨关掉不该影响主页 (page-home / page-chat 各记各的) */
  const RAIN_KEY = 'foraine.rain.on.' + (document.body.classList.contains('page-home') ? 'home' : 'chat');
  try {
    let saved = localStorage.getItem(RAIN_KEY);
    // 老版本只有一张全局开关 foraine.rain.on, 只让「私聊」继承它 (用户正是在私聊里关的雨), 主页从「开」开始
    if (saved === null && RAIN_KEY.slice(-5) === '.chat') {
      const legacy = localStorage.getItem('foraine.rain.on');
      if (legacy !== null) { saved = legacy; localStorage.setItem(RAIN_KEY, legacy); }
    }
    if (saved === '0') rainOn = false;
  } catch (err) { /* 无痕模式 */ }

  window.rainSetEnabled = function (on) {
    rainOn = !!on;
    try { localStorage.setItem(RAIN_KEY, rainOn ? '1' : '0'); } catch (err) { /* 无痕模式 */ }
    if (!rainOn) return;              // 关: 剩下的交给 update 自然放完
    /* 开 = 恢复满血: 自适应降掉的档还回去, 数量补到当前目标 */
    quality.density = 1;
    quality.lens = true;
    quality.ripples = true;
    quality.slow = 0;
    quality.fast = 0;
    refill(true);   // 立刻铺满, 不要有一段「雨变少了」的空窗
    start();
  };
  window.rainIsEnabled = () => rainOn;

  /* 首页的交互 (别的地方不加): 点一下在落点扩一圈涟漪;
     桌面端雨的倾角跟鼠标横向位置, 移动端跟陀螺仪 —— 有输入就走指针, 没输入缓缓摆回天气那份风 */
  const isHome = document.body.classList.contains('page-home');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (isHome && !reduceMotion) {
    window.addEventListener('pointerdown', (e) => {
      if (rainOn) spawnClickRipple(e.clientX, e.clientY);
    }, { passive: true });

    if (finePointer) {
      // 横向位置 -> 倾角: 正中 0 度, 两端 ±steerMax; 顺手把进圈的泡泡推开
      window.addEventListener('pointermove', (e) => {
        const nx = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
        wantSteerAngle = nx * TUNE.steerMax;
        pushBubbles(e.clientX, e.clientY);
      }, { passive: true });
      // 指针离开窗口就交还给天气
      document.addEventListener('mouseleave', () => { wantSteerAngle = null; });
      window.addEventListener('blur', () => { wantSteerAngle = null; });
    } else if (typeof DeviceOrientationEvent !== 'undefined') {
      // 左右倾斜 (gamma) 取一半, 封顶 ±gyroMax
      const onOrient = (e) => {
        if (typeof e.gamma !== 'number') return;
        wantSteerAngle = Math.max(-TUNE.gyroMax, Math.min(TUNE.gyroMax, e.gamma * 0.5));
      };
      const listenOrient = () => window.addEventListener('deviceorientation', onOrient);
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 要用户先点一下才准监听 (拒绝就退回天气那份风)
        let asked = false;
        const ask = () => {
          if (asked) return;
          asked = true;
          DeviceOrientationEvent.requestPermission()
            .then((state) => { if (state === 'granted') listenOrient(); })
            .catch(() => {});
        };
        window.addEventListener('pointerdown', ask, { once: true });
        window.addEventListener('touchstart', ask, { once: true });
      } else {
        listenOrient();
      }
    }
  }

  resize();
  applyWeather();
  if (reduceMotion) step(performance.now());   // 「减少动态效果」: 只画一帧静场
  else if (rainOn) start();

  window.rainTune = TUNE;   // 控制台直接改
})();
