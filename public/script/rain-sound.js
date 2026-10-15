/* rain-sound.js 全站雨声 */
/*
  内容: 只负责播, 开关本体在个人页「个性化 → 声音」(profile.html), 两边共用同一个键
  依赖: 无 (个人页调 window.setRainSound / rainSoundOn)
*/
// 开关存 localStorage 'foraine.rain.sound' ('1' = 开); 进度存 sessionStorage —— 换新标签页 / 新会话就该从头开始
// 浏览器禁止网页在用户交互之前出声 (autoplay policy), 「一进站就响」做不到: 开了先试一次, 被拦下就等第一次点/触/按键
// 站内跳转是整页重载, 旧文档连它的 <audio> 一起销毁 (SharedWorker / Service Worker 也办不到), 真无缝做不到 —— 新页面从上次的位置接上
(function initRainSound() {
  const KEY = 'foraine.rain.sound';       // '1' = 开
  const POS_KEY = 'foraine.rain.pos';     // 跨页续播的播放位置（秒）
  const SRC = '/assets/Sound/Raindrop.mp3';
  const VOLUME = 0.35;
  const FADE_MS = 1200;

  let audio = null;
  let armed = false;
  let lastSaved = -1;

  // 开关开着吗
  function enabled() {
    try { return localStorage.getItem(KEY) === '1'; } catch (err) { return false; }
  }

  // 记下当前播放位置
  function savePos() {
    if (!audio) return;
    try { sessionStorage.setItem(POS_KEY, String(audio.currentTime || 0)); } catch (err) { /* 无痕模式 */ }
  }

  // 读回上次的位置
  function readPos() {
    try { return parseFloat(sessionStorage.getItem(POS_KEY)) || 0; } catch (err) { return 0; }
  }

  // 用到才建 Audio
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.src = SRC;        // 到这一步才真正开始下载 (没开的话一个字节都不下)
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    // 时长要等元数据回来才知道, 所以 currentTime 只能在这个回调里设
    audio.addEventListener('loadedmetadata', () => {
      const pos = readPos();
      const dur = audio.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      audio.currentTime = (pos > 1 && pos < dur - 1) ? pos : 0;
    });
    audio.addEventListener('timeupdate', () => {
      // 每 5 秒落一次盘就够（pagehide 那一次是兜底）
      const t = Math.floor(audio.currentTime / 5);
      if (t !== lastSaved) { lastSaved = t; savePos(); }
    });
    return audio;
  }

  // 音量 0 → VOLUME 淡入
  function fadeIn() {
    const a = audio;
    if (!a) return;
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / FADE_MS);
      a.volume = VOLUME * t;
      if (t < 1 && !a.paused) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 开始放 (被 autoplay 拦下就等 armOnce 那一次交互)
  function play() {
    if (!enabled()) return;
    const a = ensureAudio();
    if (!a.paused) return;                       // 已经在放了，别重复触发淡入
    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.then(fadeIn).catch(() => { /* 被 autoplay 拦下了 → 等 armOnce 那一次交互 */ });
    } else {
      fadeIn();
    }
  }

  // 停 (先把进度存下来)
  function stop() {
    savePos();
    if (audio) { audio.pause(); audio.volume = 0; }
  }

  /* 等第一次交互再试, 这是浏览器允许的最早时机; 只挂一次, 触发后自己摘掉。 */
  function armOnce() {
    if (armed) return;
    armed = true;
    const kick = () => {
      ['pointerdown', 'keydown', 'touchstart'].forEach((type) => {
        window.removeEventListener(type, kick, true);
      });
      play();
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach((type) => {
      window.addEventListener(type, kick, true);
    });
  }

  /* 给个人页那个开关用（profile.html 的 initRainSound） */
  function setRainSound(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (err) { /* 无痕模式 */ }
    if (on) { lastSaved = -1; armed = false; armOnce(); play(); } else { stop(); }
  }

  // 开关状态 (给页面画 UI 用)
  function rainSoundOn() { return enabled(); }

  // 个人页那个开关调它
  window.setRainSound = setRainSound;
  window.rainSoundOn = rainSoundOn;

  // 离开这个文档之前把进度存下来（点站内链接就是整页重载）
  window.addEventListener('pagehide', savePos);
  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) {
      savePos();
      if (!audio.paused) { audio.pause(); audio.dataset.autoPaused = '1'; }
    } else if (audio.dataset.autoPaused === '1' && enabled()) {
      // 只是切走又切回来（同一个文档）→ 接着放，不重置进度
      delete audio.dataset.autoPaused;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  });

  if (enabled()) { play(); armOnce(); }
})();

