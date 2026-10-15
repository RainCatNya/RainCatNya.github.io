/* layout.js 页面骨架 */
/*
  内容: 注入弹窗容器 #modal-overlay 与站点页脚 .site-footer; 站内简介也挂在这里 (点版权那行打开)
  依赖: ui.js(showMessage)
*/
// 用 JS 注入而不是抄进每个 HTML: 页脚那段 GitHub SVG 有 20 行, 8 个页面各一份, 改一处要改八处
(function initSiteLayout() {
  const FOOTER_HTML =
    '<span class="site-footer-copy" role="button" tabindex="0" title="简介">© 2026 RaincatNya &amp; fiflizc</span>' +
    '<div class="site-footer-links">' +
    '<a href="https://github.com/RainCatNya/RainCatNya.github.io" target="_blank" rel="noopener" title="GitHub">' +
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"></path></svg>' +
    '</a>' +
    '</div>';

  // 弹窗宿主: ui.js 的 showMessage / confirmAction 都往这里塞
  function buildModal() {
    if (document.getElementById('modal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    const content = document.createElement('div');
    content.id = 'modal-content';
    panel.appendChild(content);
    overlay.appendChild(panel);
    document.body.prepend(overlay);
  }

  // 站点页脚
  function buildFooter() {
    if (document.querySelector('.site-footer')) return;
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = FOOTER_HTML;
    // .page-layout 是弹性列, 页脚要挂在它末尾才会被顶到底; 首页是平铺结构, 直接挂 body
    const host = document.querySelector('.page-layout') || document.body;
    host.appendChild(footer);
    bindIntro(footer);
  }

  /* 站内简介: 原来在首页菜单那颗「简介」按钮上, 2026-09-28 改成点页脚版权那行 (每个页面都能点开) */
  const INTRO_HTML =
    '<span class="font-hand gradient-text No-slc">网站简介</span><br>' +
    '<span class="font-hand">foraine？<br>' +
    '为了下一场雨的宁静，<br>' +
    '也为了一杯咖啡的小憩。</span><br>' +
    '<span class="font-hand text-dim">Copyright (c) 2026 RaincatNya &amp; fiflizc. All rights reserved.</span>';

  // plain: 移动端不要框体, 只剩高斯模糊, 点任意处取消
  function showIntro() {
    showMessage(INTRO_HTML, { plain: true });
  }
  window.showIntro = showIntro;

  // 版权那行可点 (鼠标与键盘都认)
  function bindIntro(footer) {
    const copy = footer.querySelector('.site-footer-copy');
    if (!copy) return;
    copy.addEventListener('click', showIntro);
    copy.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      showIntro();
    });
  }

  // 两块骨架一起建
  function build() {
    buildModal();
    buildFooter();
  }

  // defer 脚本在 DOMContentLoaded 之前执行, 所以同步跑一次骨架就已在位 (没 body 时退回 DOMContentLoaded)
  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
