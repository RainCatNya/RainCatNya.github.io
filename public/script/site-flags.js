/* site-flags.js 站点级总闸 */
/*
  内容: 站长个人页「Foraine」页签的两个 Toggle —— 下行流量 / 最大资源量
  依赖: core.js(apiPost) / ui.js(showToast)
*/
// 关掉一个 = 那套方案服务端完全不执行, 不只是前端藏一下; 接口 GET /api/site/flags (谁都能读) · POST (仅站长)
(function initSiteFlags() {
  const FLAGS = [
    { key: 'downlink', box: 'flag-downlink', state: 'flag-downlink-state', row: 'site-flag-downlink' },
    { key: 'quota', box: 'flag-quota', state: 'flag-quota-state', row: 'site-flag-quota' }
  ];
  let loaded = false;

  // 取元素的简写
  const $ = (id) => document.getElementById(id);

  // 把一个开关画成对应状态
  function paint(one, on) {
    const box = $(one.box);
    const state = $(one.state);
    if (box) box.checked = !!on;
    if (state) {
      state.textContent = on ? '已执行' : '已停用';
      state.classList.toggle('is-on', !!on);
    }
    const row = $(one.row);
    if (row) row.classList.toggle('is-off', !on);
  }

  // asyfunc 拉一次开关状态
  async function load() {
    try {
      const res = await fetch('/api/site/flags', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const flags = (data && data.flags) || {};
      FLAGS.forEach((one) => paint(one, flags[one.key] !== 0));
      loaded = true;
    } catch (err) {
      FLAGS.forEach((one) => {
        const state = $(one.state);
        if (state) state.textContent = '无法读取状态';
      });
    }
  }

  // asyfunc 切一个开关
  async function toggle(one, on) {
    const box = $(one.box);
    if (box) box.disabled = true;
    try {
      await apiPost('/api/site/flags', { key: one.key, on });
      paint(one, on);
      showToast(on ? '方案已开始执行' : '方案已停用', 'ok');
    } catch (error) {
      // 失败要把开关拨回去, 停在「已执行」而服务端没变就是骗人
      paint(one, !on);
      showToast((error && error.message) || '切换失败，请稍后再试', 'error');
    } finally {
      if (box) box.disabled = false;
    }
  }

  // 绑 change 事件
  function bind() {
    FLAGS.forEach((one) => {
      const box = $(one.box);
      if (!box) return;
      box.onchange = () => toggle(one, box.checked);
    });
  }

  // 切到「Foraine」页签时才拉一次 (页签只有站长看得到)
  function open() {
    if (!loaded) load();
  }

  // 页签懒加载用: open() 首次拉取, reload 强制重拉
  window.siteFlags = { open, reload: load };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
