/* grid-bg.js 会呼吸的三角网格背景 (叙述编辑页用) */
/*
  内容: startGridBackground(canvas) —— 铺满画布的等边三角形网格 + 每块按自己的相位一亮一暗,
        还有一点穹顶感 (越靠屏幕中心缩得越小)。不跟鼠标、不能拖, 也不重播
  依赖: 无
  ⚠️ 参数与公式与终端页那层背景格 (terminal.js 的 layout / draw) **逐字一致**: 边长 min(宽,高)/6 夹在 72~200、
     黑缝 3.2px、中性灰面板 [48,48,56]、±35% 呼吸、每块的 j / ph / rate 同一套噪声。改一边就要改两边
*/
(function () {
  const TUNE = {
    sideDiv: 6,
    sideMin: 72,
    sideMax: 200,
    dprMax: 1.5,
    gap: 3.2,          // 缝隙宽度 (px) = 黑色描边粗细
    dome: 0.18,        // 穹顶感: 中心缩到 (1 - dome) 倍, 到四角回到原样
    waveAmp: 0.35,     // 呼吸幅度 (±35% 亮度)
    waveSpeed: 0.0012, // 呼吸时钟的速率 (乘上每块自己的 rate 才是真实频率)
    backPanel: [48, 48, 56],
    panelAlpha: 0.86
  };

  // 稳定伪随机 (同一个格子永远同一个值): 重铺时每块的呼吸相位才不会跳
  function cellNoise(a, b) {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function domeScale(t) {
    const d = TUNE.dome;
    return d ? (1 - d) + d * t * t : 1;
  }

  /* asyfunc 开始画: 铺满 canvas 的三角网格 + 一直呼吸 (窗口尺寸 / 像素比变了会重铺) */
  window.startGridBackground = function (canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let tris = [];
    let maxDist = 1;
    let view = { w: 0, h: 0 };

    function layout() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, TUNE.dprMax);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      view = { w: w, h: h };

      const side = Math.max(TUNE.sideMin, Math.min(TUNE.sideMax, Math.round(Math.min(w, h) / TUNE.sideDiv)));
      const rowH = (side * Math.sqrt(3)) / 2;      // 等边三角形的高
      const cols = Math.ceil(w / side) + 3;
      const rows = Math.ceil(h / rowH) + 3;
      const cx = w / 2;
      const cy = h / 2;
      maxDist = Math.hypot(cx, cy) || 1;

      /* 一格两块: 正三角 (底边在 y+rowH, 尖在顶上) + 倒三角 (顶边在 y, 尖在底下)。
         ⚠️ 一格只画一块的话, 邻格留下的那个洞永远是空的 (半屏都是黑) —— 2026-10-01 修的就是这个:
         旧版按行奇偶只画一种朝向, 铺出来的网比终端页大了一倍、到处是洞 */
      tris = [];
      const push = (ax, ay, bx, by, cxx, cyy, gr, gk) => {
        // 穹顶: 三个顶点各自按「到屏幕中心的距离」缩一下
        const pts = [[ax, ay], [bx, by], [cxx, cyy]].map((p) => {
          const ex = p[0] - cx;
          const ey = p[1] - cy;
          const rr = Math.hypot(ex, ey);
          const kk = rr < 0.0001 ? 1 : domeScale(rr / maxDist);
          return [cx + ex * kk, cy + ey * kk];
        });
        tris.push({
          p: pts,
          j: 0.92 + cellNoise(gk, gr) * 0.16,                  // 每块的透明度微抖 (一块块独立的亚克力)
          ph: cellNoise(gk + 7, gr - 3) * Math.PI * 2,         // 呼吸相位
          rate: 0.7 + cellNoise(gr + 11, gk + 5) * 0.9         // 呼吸快慢
        });
      };
      for (let r = -2; r < rows; r += 1) {
        const y = r * rowH;
        // 隔行错开半条边 —— 不错开的话两行的顶点都在整数倍边上, 交界处全是 T 型接口
        const off = (r & 1) ? side / 2 : 0;
        for (let k = -3; k < cols; k += 1) {
          const x = k * side + off;
          push(x, y + rowH, x + side, y + rowH, x + side / 2, y, r, k);
          push(x + side / 2, y, x + side * 1.5, y, x + side, y + rowH, r, k + 0.5);
        }
      }
    }

    layout();
    window.addEventListener('resize', layout);

    const t0 = performance.now();
    const base = TUNE.backPanel;
    (function frame(now) {
      const t = now - t0;
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.lineJoin = 'round';
      for (let i = 0; i < tris.length; i += 1) {
        const tri = tris[i];
        // 每块按自己的相位/快慢慢慢变亮再变暗 (亮度连续, 不会闪)
        const breath = 0.5 + 0.5 * Math.sin(t * TUNE.waveSpeed * tri.rate + tri.ph);
        const lv = 1 - TUNE.waveAmp + TUNE.waveAmp * 2 * breath;
        const a = TUNE.panelAlpha * tri.j;
        ctx.beginPath();
        ctx.moveTo(tri.p[0][0], tri.p[0][1]);
        ctx.lineTo(tri.p[1][0], tri.p[1][1]);
        ctx.lineTo(tri.p[2][0], tri.p[2][1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(' + Math.round(base[0] * lv) + ',' + Math.round(base[1] * lv) + ',' + Math.round(base[2] * lv) + ',' + a.toFixed(3) + ')';
        ctx.fill();
        ctx.lineWidth = TUNE.gap;
        ctx.strokeStyle = 'rgba(0,0,0,' + Math.min(1, a * 1.35).toFixed(3) + ')';
        ctx.stroke();
      }
      requestAnimationFrame(frame);
    }(performance.now()));
  };
}());
