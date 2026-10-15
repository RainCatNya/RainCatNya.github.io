/* ui.js 弹窗与聊天积木 */
/*
  内容: 轻提示 / 弹窗 / 二次确认 / 右键菜单 / 下拉框 / 敏感操作验证 / 私聊附件与表情积木
  依赖: core.js(el, getCurrentUser, apiPost, hardenField, pageTransitionTo)
*/

// 轻提示图标; kind = ok | error | warn | info
const TOAST_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.2 12.4 2.5 2.5 5-5.4"></path></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.2"></path><path d="M12 16.4h.01"></path></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.2 2.9 19.6h18.2L12 4.2z"></path><path d="M12 10v3.6"></path><path d="M12 16.8h.01"></path></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11.2v5"></path><path d="M12 7.9h.01"></path></svg>'
};

let toastStack = null;

// 触屏设备 (移动端回车键一律是换行); 名字不能叫 TOUCH_ONLY, 内联脚本已占且同名 const 会 SyntaxError
const UI_TOUCH_ONLY = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

// 轻提示: 操作结果与警告一律走这里, 不再往页面里塞状态文字
function showToast(text, kind, options) {
  if (!text) return null;
  const opts = options || {};
  const taste = TOAST_ICONS[kind] ? kind : 'info';

  const host = toastStack || document.getElementById('toast-stack');
  if (host) {
    toastStack = host;
  } else {
    toastStack = document.createElement('div');
    toastStack.id = 'toast-stack';
    toastStack.className = 'toast-stack';
    (document.body || document.documentElement).appendChild(toastStack);
  }

  const node = document.createElement('div');
  node.className = 'toast is-' + taste;
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.innerHTML = TOAST_ICONS[taste];
  node.appendChild(icon);
  node.appendChild(el('span', 'toast-text', text));
  toastStack.appendChild(node);

  // 出错/警告多留一会儿
  const life = opts.duration || (taste === 'info' ? 2400 : taste === 'ok' ? 2600 : 3600);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  }, life);
  return node;
}

// 弹窗: 直接显示一段 HTML (不走 fetch); opts.plain = 无框模式 (面板不留底色/描边, 点任意处关掉)
function showMessage(html, opts) {
  const options = opts || {};
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay || !content) return;
  // 有任务锁着（上传中这类）就不要硬开新弹窗: 会把锁与内容一起弄乱
  if (modalLockDepth > 0) return;

  modalLocked = false;
  modalCloseHook = null;
  closeModal();
  cancelModalReset();   // 撤掉上一个弹窗的「淡出后清空」定时器, 否则它会把新内容抹了
  content.innerHTML = html;
  overlay.classList.toggle('is-plain', !!options.plain);
  overlay.classList.add('show');
  if (options.plain) {
    // 一次性监听, 点哪都关; 延到下一轮事件循环再挂, 免得打开它的那次点击顺手把它关掉
    setTimeout(() => {
      overlay.addEventListener('click', () => closeModal(), { once: true });
    }, 0);
  }
}

// 文章预览里的链接一律不跳转; 挂捕获阶段先于 transition.js 的冒泡拦截吞掉这次点击
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const link = target.closest('#modal-content .modal-preview-body a[href]');
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  showToast('预览里的链接不会跳转', 'info');
}, true);

/* asyfunc 已登录则跳转, 未登录弹登录提示 */
async function goIfLoggedIn(target) {
  // 先挂一块锁定牌: getCurrentUser 可能要走一次接口, 慢的时候用户会以为按钮没反应
  const busy = showForaineToast({ text: I18N.t('foraine-toast.loading'), block: true });
  const user = await getCurrentUser();
  busy.close();
  if (user) {
    pageTransitionTo(target);
    return;
  }
  showMessage(
    "需要登录<br><br>" +
    "<button class='btn' onclick=\"closeModal(); pageTransitionTo('/login.html')\">去登录</button>"
  );
}

// 锁定标志: 有「不可关闭」的弹窗时, 遮罩点击 / Esc 都不生效
let modalLocked = false;
// 非按钮关闭 (Esc / 点遮罩) 时要做的事; 目前只有 confirmAction 用, 靠它把 await 落地成 false
let modalCloseHook = null;
// 锁定次数: lockModal() 锁住后遮罩点击 / Esc 都关不掉, 关标签页也会拦一下
// 用计数是因为会嵌套 (工作台上面再开一个忙等弹窗), 最后一个解锁才真放开
let modalLockDepth = 0;
function beforeUnloadGuard(event) {
  event.preventDefault();
  event.returnValue = '';   // Chrome 要求它非空才会弹那个「确定要离开吗」
  return '';
}
// 锁住弹窗, 返回 { release }
function lockModal() {
  modalLockDepth += 1;
  modalLocked = true;
  if (modalLockDepth === 1) window.addEventListener('beforeunload', beforeUnloadGuard);
  return { release: unlockModal };
}
// 解锁, 计数归零才真放开
function unlockModal() {
  modalLockDepth = Math.max(0, modalLockDepth - 1);
  if (modalLockDepth === 0) {
    modalLocked = false;
    window.removeEventListener('beforeunload', beforeUnloadGuard);
  }
}

// 输入框跟着内容长高 (超 maxLines 行转内部滚动; 行高/内边距从 computed style 读), minLines = 基础行数
// 这两个必须在顶层: 被写进别的函数里会 ReferenceError, 连后面的 paste 监听都注册不上
function autoGrowLines(el, maxLines, minLines) {
  if (!el) return;
  const lines = maxLines || 5;
  const least = minLines || 1;
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 18) * 1.5;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  el.style.height = 'auto';
  el.style.height = Math.max(Math.round(line * least + pad),
    Math.min(el.scrollHeight, Math.round(line * lines + pad))) + 'px';
}

// 给输入框挂上自动长高
function bindAutoGrow(el, maxLines, minLines) {
  if (!el || el.dataset.autoGrow === '1') return;
  el.dataset.autoGrow = '1';
  const run = () => autoGrowLines(el, maxLines, minLines);
  el.addEventListener('input', run);
  run();
}

/* 图片灯箱 */
// 文章正文的 .md-img 与聊天气泡的图共用一个委派 (图都是事后插进 DOM 的); 关灯箱要同时摘掉 keydown
function openImageLightbox(src, alt) {
  if (!src) return;
  const box = document.createElement('div');
  box.className = 'md-lightbox';
  const full = document.createElement('img');
  full.src = src;
  full.alt = alt || '';
  box.appendChild(full);
  document.body.appendChild(box);
  // 读 offsetWidth 强制回流再挂类, 否则进场过渡不播 (别用 requestAnimationFrame: 后台标签会被节流)
  void box.offsetWidth;
  box.classList.add('is-in');

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey);
    // 往下淡出后再 remove; 兜底 setTimeout 不能省 (reduce-motion 下不触发 transitionend)
    box.classList.remove('is-in');
    const drop = () => { box.remove(); box.removeEventListener('transitionend', drop); };
    box.addEventListener('transitionend', drop);
    setTimeout(drop, 400);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

document.addEventListener('click', (event) => {
  const target = event.target && event.target.closest ? event.target : null;
  const img = target ? target.closest('.md-img, .chat-attach-in-bubble') : null;
  if (!img || !img.src) return;
  openImageLightbox(img.src, img.alt);
});

/* 私聊附件 (图片 / 文件, 两个宿主共用) */
// 宿主: 个人页的私聊弹窗 + /chat/ 私信页; 消息体存一坨 JSON, 与 worker 的 parseChatBody 对应
// 客户端这份允许 url 为空: 附件还在上传时先用本地 objectURL 把气泡画出来

// 字节数 -> 可读大小
function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 消息体 -> 附件 / 引用对象 (都不是则 null); 服务端 parseChatBody 是它的正经版, 两边保持同步
function parseChatAttach(body) {
  const raw = String(body || '');
  if (raw.charAt(0) !== '{') return null;
  try {
    const data = JSON.parse(raw);
    if (!data) return null;
    if (data.t === 'quote') {
      return { t: 'quote', name: String(data.name || ''), text: String(data.text || ''), body: String(data.body || '') };
    }
    if (data.t !== 'image' && data.t !== 'file') return null;
    return data;
  } catch (err) {
    return null;
  }
}

// 文字 + 附件 -> 存进 chats.body 的那串 (url 为空时用本地预览地址占位)
// 文件要带上 resource 表那行的 id: 下载走 /api/resource/download?id=… (Worker 代取 + 强制 attachment)
function chatAttachBody(text, att, url, extra) {
  if (!att) return text;
  const info = extra || {};
  if (att.kind === 'image') {
    const img = { t: 'image', url: url || att.previewUrl || '', name: att.file.name || '' };
    // 客户端专用标记, 真发送时不带 (气泡里据此画流光方块)
    if (info.pending) img.pending = true;
    return JSON.stringify(img);
  }
  const payload = {
    t: 'file',
    url: url || '',
    name: att.file.name || '文件',
    size: att.file.size || 0,
    id: info.id || att.resourceId || null
  };
  // pending = 「这条还在上传」的客户端标记; 服务端存的是原始 body, 塞进去的键会原样进库
  if (info.pending) payload.pending = true;
  return JSON.stringify(payload);
}

/* 文件名按字符实际宽度截断 */
// 真把尾巴切掉留前一截 + 省略号, 阈值 = 屏宽 2/3 减卡片内边距
// 量宽要用页面里算出来的真字体 (借隐藏探针吃 CSS 级联), 写死 '12px sans-serif' 会量歪
let fileNameProbe = null;

// 取文件卡片那条规则的字体串
function fileCardFont() {
  if (!fileNameProbe) {
    fileNameProbe = document.createElement('span');
    fileNameProbe.className = 'chat-file-card';
    fileNameProbe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;padding:0;border:0;';
    document.body.appendChild(fileNameProbe);
  }
  const cs = getComputedStyle(fileNameProbe);
  return cs.font || (cs.fontSize + ' ' + cs.fontFamily);
}

// 按屏幕宽度截断文件名
function fitFileName(name) {
  const text = String(name || '');
  if (!text) return '';
  const canvas = fitFileName.canvas || (fitFileName.canvas = document.createElement('canvas'));
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return text;
  ctx.font = fileCardFont();
  const limit = Math.max(60, Math.round(window.innerWidth * 2 / 3) - 30);
  if (ctx.measureText(text).width <= limit) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(text.slice(0, cut) + '…').width > limit) cut -= 1;
  return text.slice(0, cut) + '…';
}

// 画气泡里那点内容: 纯文字 / 一张图 / 一个文件卡片 / 一段引用
// 图片和文件给气泡加 .is-media (CSS 去掉底色/内边距/描边); 文件优先走 /api/resource/download?id=…
function fillChatBubble(bubble, body) {
  if (!bubble) return;
  bubble.innerHTML = '';
  bubble.classList.remove('is-media');
  const att = parseChatAttach(body);
  if (!att) {
    bubble.textContent = body;
    return;
  }
  // 引用: 气泡上沿挂一小块引用条, 下面才是自己说的话; 不能加 .is-media (它要气泡框)
  if (att.t === 'quote') {
    const quote = el('div', 'chat-quote');
    quote.appendChild(el('span', 'chat-quote-name', att.name ? att.name + '：' : ''));
    quote.appendChild(el('span', 'chat-quote-text', att.text || ''));
    bubble.appendChild(quote);
    if (att.body) {   // 只引用不写字也是允许的 (那就只显示引用条)
      const said = el('span', 'chat-quote-said');
      said.textContent = att.body;
      bubble.appendChild(said);
    }
    return;
  }
  // 图片和文件都算「媒体」: 气泡本身的底色/内边距/圆角都不要
  bubble.classList.add('is-media');
  if (att.t === 'image') {
    // 还在上传: 不显本地预览, 画一个灰边 + 黑亚克力 + 流光的方块
    if (att.pending) {
      bubble.appendChild(el('span', 'chat-img-pending'));
      return;
    }
    const pic = document.createElement('img');
    pic.className = 'chat-attach-in-bubble';
    // 表情包 (名字固定是 sticker): 画成一小块, 大表情会把聊天刷屏
    if (att.name === 'sticker') pic.classList.add('is-emoji');
    pic.alt = att.name || '图片';
    pic.loading = 'lazy';
    // 长截图会被 max-height 等比缩成一条缝 -> 判比例后加 .is-tall, 交给 CSS 铺满气泡宽
    const isTall = () => {
      if (pic.naturalWidth && pic.naturalHeight / pic.naturalWidth > 1.8) pic.classList.add('is-tall');
    };
    // 图裂 / 资源过期 / 直链 403: 换一行「图片已失效」
    const die = () => {
      bubble.classList.remove('is-media'); // 拿回气泡框, 才装得住一行字
      bubble.innerHTML = '';
      const dead = el('span', 'chat-media-failed', '图片已失效');
      dead.title = att.url || '';
      bubble.appendChild(dead);
    };
    // 监听要先挂再设 src, 否则命中缓存的图不触发 load/error
    pic.addEventListener('load', isTall);
    pic.addEventListener('error', die);
    pic.src = att.url || '';
    bubble.appendChild(pic);
    // 缓存命中的图不会再跑 load, 这里补判一次
    if (pic.complete) {
      if (pic.naturalWidth) isTall();
      else die();
    }
    return;
  }
  const uploading = !!att.pending && !att.id;
  const href = att.id ? '/api/resource/download?id=' + encodeURIComponent(att.id) : (att.url || '');
  const card = document.createElement((href && !uploading) ? 'a' : 'span');
  card.className = 'chat-file-card' + (uploading ? ' is-uploading' : '');
  if (href && !uploading) {
    card.href = href;
    card.download = att.name || ''; // 同源 (走 Worker 代取) → 这个属性真能生效
    if (!att.id) {
      card.target = '_blank';
      card.rel = 'noopener';
    }
    card.title = '点击下载';
  } else if (uploading) {
    // 还没传完: 连不上任何东西, 点了什么也不该发生 (所以不是 <a>)
    card.title = '正在上传…';
    // 水位层在字下面, 所以先放它
    card.appendChild(el('span', 'chat-file-fill'));
  }
  card.appendChild(el('span', 'chat-attach-name', fitFileName(att.name || '文件')));
  const meta = el('span', 'chat-file-meta');
  meta.appendChild(el('span', 'chat-attach-size', formatFileSize(att.size)));
  if (uploading) meta.appendChild(el('span', 'chat-file-state', '上传中'));
  card.appendChild(meta);
  bubble.appendChild(card);
}

/* 上传中那张卡片的两个钩子 (宿主在传的时候调) */

// 进度 0~100 写进 CSS 变量, 水位层自己动画长高
function setChatFileProgress(row, percent) {
  const card = row && row.querySelector ? row.querySelector('.chat-file-card') : null;
  if (!card) return;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  card.style.setProperty('--chat-file-fill', pct + '%');
}

// 传挂了: 水位停在原地, 只把「上传中」改成「上传失败」
function failChatFileUpload(row) {
  const card = row && row.querySelector ? row.querySelector('.chat-file-card') : null;
  if (!card) return;
  card.classList.add('is-upload-error');
  const state = card.querySelector('.chat-file-state');
  if (state) state.textContent = '上传失败';
}

// 输入框上沿那一层: 画出当前附件 (att 为空就收起); onClear = 点 ✕ 时调
function renderChatAttach(sendBox, att, onClear) {
  if (!sendBox) return;
  let layer = sendBox.querySelector('.chat-attach');
  if (!layer) {
    layer = el('div', 'chat-attach');
    layer.hidden = true;
    sendBox.insertBefore(layer, sendBox.firstChild);
  }
  layer.innerHTML = '';
  if (!att) {
    layer.hidden = true;
    layer.classList.remove('is-file');
    return;
  }
  layer.classList.toggle('is-file', att.kind === 'file');
  if (att.kind === 'image') {
    const pic = document.createElement('img');
    pic.className = 'chat-attach-img';
    pic.alt = '';
    pic.src = att.previewUrl || '';
    layer.appendChild(pic);
  } else {
    const bar = el('div', 'chat-attach-file');
    bar.appendChild(el('span', 'chat-attach-name', att.file.name || '文件'));
    bar.appendChild(el('span', 'chat-attach-size', formatFileSize(att.file.size)));
    layer.appendChild(bar);
  }
  const kill = el('button', 'chat-attach-x', '✕');
  kill.type = 'button';
  kill.title = '去掉这个附件';
  kill.onclick = () => { if (onClear) onClear(); };
  layer.appendChild(kill);
  layer.hidden = false;
}

// 上传附件: 图片进 foraine-image, 文件进 foraine-resource; 超过 CHAT_INLINE_MAX 走直传 OSS
// (Worker 中转有请求体上限 + 128MB 内存, 大文件必炸; 直传依赖桶上的 CORS)
const CHAT_INLINE_MAX = 24 * 1024 * 1024;

/* asyfunc 上传附件 */
async function uploadChatAttach(att, onProgress) {
  if (att.kind === 'file' && att.file && att.file.size > CHAT_INLINE_MAX) {
    return await uploadChatAttachDirect(att.file, onProgress);
  }
  const form = new FormData();
  form.append('file', att.file);
  if (att.kind === 'image') {
    form.append('kind', 'chatmsg');
  } else {
    form.append('name', att.file.name || ''); // 资源桶: 先登记再上传
  }
  // 图片用 fetch 就够 (气泡里已有本地预览, 不需要进度条); 文件的进度只有 XHR 的 upload.onprogress 能给
  if (att.kind !== 'image') {
    return await xhrUpload('POST', '/api/resource/upload', form, onProgress);
  }
  const res = await fetch('/api/image', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '上传失败');
  return data;
}

// 带进度的上传 (XHR, fetch 拿不到上传进度); 失败优先用服务端那句中文错误, 拿不到再报 HTTP 码
function xhrUpload(method, url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total) onProgress(Math.round(event.loaded / event.total * 100));
      };
    }
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}') || {}; } catch (err) { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || ('上传失败：HTTP ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('上传失败（网络断了）'));
    xhr.send(body);
  });
}

/* asyfunc 大文件直传: 先要签名 (服务端顺手登记 resource 行), 再由浏览器 PUT 给 OSS */
// extra = 资源中心的附加字段 (scope / title / description / sha256 / expire); 私聊一个都不传
async function uploadChatAttachDirect(file, onProgress, extra) {
  const pre = await apiPost('/api/resource/presign', Object.assign({
    name: file.name || '',
    size: file.size,
    mime: file.type || ''
  }, extra || {}));
  if (!pre.upload_url) throw new Error('直传准备失败');
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', pre.upload_url, true);
    Object.keys(pre.headers || {}).forEach((key) => {
      // 一个头都不能少: OSS 拿它们重算签名, 漏了就是 SignatureDoesNotMatch
      xhr.setRequestHeader(key, pre.headers[key]);
    });
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total) onProgress(Math.round(event.loaded / event.total * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('上传失败：HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('直传失败（桶还没配 CORS 或者网络断了）'));
    xhr.send(file);
  });
  // group_id 要带出去: 多文件上传时后面的文件靠它挂进同一个组
  return { id: pre.id, url: pre.url, key: pre.key, name: pre.name, size: pre.size, group_id: pre.group_id };
}

// 打开系统文件选择器把选中的文件交出去; capture='environment' = 手机直接开相机
// 每次现建一个 input: 同一个文件连选两次不会触发 change
function pickChatFile(options) {
  const opts = options || {};
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.hidden = true;
  picker.accept = opts.kind === 'file' ? CHAT_FILE_ACCEPT : 'image/*';
  if (opts.multiple) picker.multiple = true;
  if (opts.capture) picker.setAttribute('capture', opts.capture);
  picker.addEventListener('change', () => {
    const files = Array.prototype.slice.call(picker.files || []);
    picker.remove();
    if (!files.length) return;
    // onPickMany 是资源中心工作台用的 (一次挑一批); 其余调用方还是一个一个给
    if (opts.onPickMany) opts.onPickMany(files);
    else if (opts.onPick) opts.onPick(files[0]);
  });
  document.body.appendChild(picker);
  picker.click();
}

/* 上传模态框 */
// [上传] 标题 + 左右两个虚线框 (左 文件 / 右 图片), 点的框决定开哪个选择器
// 文件那个 accept 要和 worker 的 RESOURCE_TYPES 对得上, 否则选完才报错
const CHAT_FILE_ACCEPT = '.zip,.rar,.7z,.pdf,.txt,.md,.json,.png,.jpg,.jpeg,.webp,.gif,.mp3,.ogg,.wav,.mp4,.webm,.jar';

function openChatAttachPicker(onPick) {
  const dropIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 16V4"></path><path d="m7.5 8.5 4.5-4.5 4.5 4.5"></path>'
    + '<path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"></path></svg>';

  const choose = (kind) => {
    // 先关弹窗再开选择器 (iOS 上「非用户手势里 open 文件框」会被拦)
    closeModal();
    pickChatFile({ kind: kind, onPick: onPick });
  };

  // 没填邮箱的人不给发资源 -> 直接藏掉「文件」那个框并说清原因 (服务端也会再拦一道)
  const draw = (canResource) => {
    showMessage(
      '<p class="modal-preview-title">上传</p>' +
      '<p class="img-drop-hint">选择上传的类型</p>' +
      '<div class="attach-kinds">' +
        (canResource
          ? '<div class="img-drop attach-kind" data-kind="file">' + dropIcon +
              '<p class="attach-kind-title">文件</p>' +
              '<p class="attach-kind-hint">压缩包 / 文档 / 音视频 · 200 MB 以内</p>' +
            '</div>'
          : '') +
        '<div class="img-drop attach-kind" data-kind="image">' + dropIcon +
          '<p class="attach-kind-title">图片</p>' +
          '<p class="attach-kind-hint">PNG / JPG / WebP / GIF · 20 MB 以内</p>' +
        '</div>' +
      '</div>' +
      (canResource ? '' : '<p class="img-drop-hint">发文件前请先在个人主页「资料」里填写邮箱</p>')
    );
    const box = document.getElementById('modal-content');
    if (box) {
      box.querySelectorAll('.attach-kind').forEach((el_) => {
        el_.addEventListener('click', () => choose(el_.dataset.kind));
      });
    }
  };

  // 先问一下有没有邮箱 (getCurrentUser 带缓存, 不会多打一次接口)
  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : Promise.resolve(null);
  Promise.resolve(user).then((u) => draw(!!(u && u.email))).catch(() => draw(false));
}

// 宿主通用: 把一个 File 变成附件 (校验大小 + 建本地预览 + 重画那层), state = 宿主的 { att: null }
function setChatAttach(state, file, sendBox, onChange) {
  if (!file) return false;
  const isImage = String(file.type || '').indexOf('image/') === 0;
  // 上限与 worker 的 IMG_MAX_BYTES / RES_MAX_BYTES 对齐 (图 20MB / 文件 200MB)
  if (isImage && file.size > 20 * 1024 * 1024) { showToast('图片不能超过 20 MB', 'warn'); return false; }
  if (!isImage && file.size > 200 * 1024 * 1024) { showToast('文件不能超过 200 MB', 'warn'); return false; }
  if (state.att && state.att.previewUrl) URL.revokeObjectURL(state.att.previewUrl);
  state.att = { kind: isImage ? 'image' : 'file', file: file };
  if (isImage) state.att.previewUrl = URL.createObjectURL(file);
  if (onChange) onChange();
  return true;
}

/* 消息右键菜单 */
// 走 document 委派, 两个宿主的 .chat-msg 共用; 菜单项 = 复制 / 引用 / 删除 [/ 另存为 / 撤回]
// 撤回 = 服务端软删 (双方都消失, 限 5 分钟内自己发的); 删除 = 只删自己这边 (localStorage)
// 引用 = 把「引用哪条」记在输入盒上 (sendBox.__chatQuote), 发送时由 chatQuoteBody() 打包
const CHAT_RECALL_MS = 5 * 60 * 1000;
const CHAT_HIDDEN_KEY = 'foraine.chat.hidden';
const CHAT_HIDDEN_MAX = 800; // 本地已删除的记录最多留这么多条

/* 本地删除的名单 (只对自己生效) */
function chatHiddenIds() {
  try {
    const list = JSON.parse(localStorage.getItem(CHAT_HIDDEN_KEY) || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch (err) {
    return [];
  }
}

function isChatMessageHidden(id) {
  if (!id) return false;
  return chatHiddenIds().indexOf(String(id)) >= 0;
}

function hideChatMessage(id) {
  if (!id) return;
  const list = chatHiddenIds().filter((x) => x !== String(id));
  list.push(String(id));
  try {
    localStorage.setItem(CHAT_HIDDEN_KEY, JSON.stringify(list.slice(-CHAT_HIDDEN_MAX)));
  } catch (err) {
    // 存不下就算了, 下次刷新它又冒出来
  }
}

// 宿主可选: 消息被删 / 撤回时通知宿主把它从自己的消息缓存里抹掉 (否则切回来又被画回去)
function notifyChatMessagesDropped(ids) {
  if (typeof window.foraineChatDropped === 'function') {
    try { window.foraineChatDropped(ids); } catch (err) { console.error(err); }
  }
}

// 把这几条从页面上拿掉 (同时通知宿主清缓存)
function dropChatRows(ids) {
  const list = (ids || []).map(String);
  if (!list.length) return;
  document.querySelectorAll('.chat-msg[data-id]').forEach((row) => {
    if (list.indexOf(row.dataset.id) >= 0) row.remove();
  });
  notifyChatMessagesDropped(list);
}

/* 引用: 输入盒上那一小条 */
function currentChatQuote(sendBox) {
  return sendBox && sendBox.__chatQuote ? sendBox.__chatQuote : null;
}

function renderChatQuoteBar(sendBox) {
  if (!sendBox) return;
  let bar = sendBox.querySelector('.chat-quote-bar');
  const quote = sendBox.__chatQuote;
  if (!quote) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = el('div', 'chat-quote-bar');
    // 插在输入框上面: 与附件预览层一个位置逻辑, 但它是静态的一行
    const input = sendBox.querySelector('textarea');
    sendBox.insertBefore(bar, input || sendBox.firstChild);
  }
  bar.innerHTML = '';
  bar.appendChild(el('span', 'chat-quote-bar-name', quote.name ? quote.name + '：' : ''));
  bar.appendChild(el('span', 'chat-quote-bar-text', quote.text || ''));
  const kill = el('button', 'chat-quote-bar-x', '✕');
  kill.type = 'button';
  kill.title = '取消引用';
  kill.onclick = () => { sendBox.__chatQuote = null; renderChatQuoteBar(sendBox); };
  bar.appendChild(kill);
}

// 一条消息 -> 引用快照 (只留文字: 图/文件退化成 [图片] / [文件] 名字)
function chatQuoteSnapshot(row) {
  const body = row.dataset.body || '';
  const att = parseChatAttach(body);
  let text = body;
  if (att) {
    if (att.t === 'image') text = '[图片]';
    else if (att.t === 'file') text = '[文件] ' + (att.name || '');
    else text = att.body || att.text || ''; // 引用里再引用 → 取它自己说的话
  }
  return { name: row.dataset.who || '', text: String(text || '').slice(0, 120) };
}

function startChatQuote(row) {
  const box = document.querySelector('.chat-send-box');
  if (!box) return;
  const snapshot = chatQuoteSnapshot(row);
  box.__chatQuote = snapshot;
  renderChatQuoteBar(box);
  const input = box.querySelector('textarea');
  if (input) input.focus();
  showToast('已引用', 'info');
}

// 发送时取走并清掉; 失败也不回填, 免得覆盖用户新打的字
function takeChatQuote(sendBox) {
  const quote = currentChatQuote(sendBox);
  if (sendBox) {
    sendBox.__chatQuote = null;
    renderChatQuoteBar(sendBox);
  }
  return quote;
}

function chatQuoteBody(text, quote) {
  return JSON.stringify({
    t: 'quote',
    name: (quote && quote.name) || '',
    text: (quote && quote.text) || '',
    body: String(text || '')
  });
}

/* 三个动作: 复制 / 另存为 / 删除 */

/* asyfunc 复制文本到剪贴板 */
async function copyChatText(text, okText) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okText || '已复制', 'ok');
  } catch (err) {
    showToast('复制失败，请手动选中', 'warn');
  }
}

// 跨域图片要先转成 PNG 才能进剪贴板 -> 走一道 canvas
function imageBlobToPng(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob((out) => { URL.revokeObjectURL(url); out ? resolve(out) : reject(new Error('转换失败')); }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片打不开')); };
    img.src = url;
  });
}

/* asyfunc 复制消息: 文字直复; 图片进剪贴板 (不行就退回复制地址); 文件复制下载地址 */
async function copyChatMessage(row) {
  const body = row.dataset.body || '';
  const att = parseChatAttach(body);
  if (!att) return copyChatText(body);
  if (att.t === 'file') return copyChatText(att.url || body, '已复制文件地址');
  if (att.t === 'quote') return copyChatText(att.body || att.text || '');
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('浏览器不支持');
    const res = await fetch('/api/chat/media?id=' + encodeURIComponent(row.dataset.id), { cache: 'no-store' });
    if (!res.ok) throw new Error('取图失败');
    const blob = await res.blob();
    const png = blob.type === 'image/png' ? blob : await imageBlobToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    showToast('图片已复制', 'ok');
  } catch (err) {
    copyChatText(att.url || '', '已复制图片地址');
  }
}

// 另存为: 走 Worker 代理 (跨域的 <a download> 会被浏览器忽略)
function saveChatMessage(row) {
  const att = parseChatAttach(row.dataset.body || '');
  const a = document.createElement('a');
  a.href = '/api/chat/media?id=' + encodeURIComponent(row.dataset.id);
  a.download = (att && att.name) || '图片';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('正在保存…', 'info');
}

function deleteChatMessageLocal(row) {
  // 文案已定死, 别改字
  confirmAction({
    title: '',
    message: '删除后将不会出现在你的消息记录中，确定删除吗？',
    confirmText: '确定'
  }).then((ok) => {
    if (!ok) return;
    // 还没拿到服务端 id 的那条 (还在上传) 没 id 可记, 直接从这一屏拿掉
    if (row.dataset.id) {
      hideChatMessage(row.dataset.id);
      dropChatRows([row.dataset.id]);
    } else {
      row.remove();
    }
    showToast('消息已删除', 'ok');
  });
}

async function recallChatMessage(row) {
  // 文案已定死, 别改字
  const ok = await confirmAction({
    title: '',
    message: '确定要撤回这一条消息吗？',
    confirmText: '确定'
  });
  if (!ok) return;
  try {
    await withLoading(() => apiPost('/api/chat/recall', { id: Number(row.dataset.id) }));
    dropChatRows([row.dataset.id]);
    showToast('已撤回', 'ok');
  } catch (err) {
    showToast(err.message || '撤回失败', 'error');
  }
}

// 右键委派: 消息区空白处把原生菜单也吞掉, 但输入框 / 工具栏 / 头部留着给人粘贴
document.addEventListener('contextmenu', (event) => {
  const row = event.target && event.target.closest ? event.target.closest('.chat-msg') : null;
  if (!row) {
    if (event.target && event.target.closest && event.target.closest('.chat-body')) event.preventDefault();
    return;
  }

  const att = parseChatAttach(row.dataset.body || '');
  const isImage = !!att && att.t === 'image';
  const mine = row.classList.contains('is-mine');
  const at = parseInt(row.dataset.at || '0', 10);
  const canRecall = mine && !!row.dataset.id && at > 0 && (Date.now() - at) <= CHAT_RECALL_MS;

  // 「选择」模式那一条: 长按只用来拖选文字, 不再弹菜单
  if (UI_TOUCH_ONLY && row.querySelector('.chat-bubble.is-selecting')) { event.preventDefault(); return; }

  const items = [
    { label: isImage ? '复制图片' : (att && att.t === 'file' ? '复制文件地址' : '复制'), icon: CTX_ICONS.copy, onClick: () => copyChatMessage(row) },
    { label: '引用', icon: CTX_ICONS.quote, onClick: () => startChatQuote(row) }
  ];
  if (isImage) {
    items.push({ label: '另存为…', icon: CTX_ICONS.download, onClick: () => saveChatMessage(row) });
    // 添加到表情要拿服务端 id 去取图, 乐观发送中的那条不给
    items.push({ label: '添加到表情', icon: CTX_ICONS.sticker, onClick: () => addChatSticker(row) });
  }
  items.push('-');
  items.push({ label: '删除', icon: CTX_ICONS.trash, onClick: () => deleteChatMessageLocal(row) });
  if (canRecall) items.push({ label: '撤回', danger: true, icon: CTX_ICONS.recall, onClick: () => recallChatMessage(row) });
  // 触屏专用: 先点「选择」再长按选字, 松手才弹「复制」
  if (UI_TOUCH_ONLY) items.push({ label: '选择', icon: CTX_ICONS.selectAll, onClick: () => startChatTextSelect(row) });

  event.preventDefault();
  showContextMenu(event, items);
});

// 触屏上的「选择」: 立刻进入选择态 (系统画出两个手柄), 松手在手指旁弹「复制」
// 选完必须马上摘掉 is-selecting, 否则那个气泡会一直能被选
function startChatTextSelect(row) {
  const bubble = row && row.querySelector ? row.querySelector('.chat-bubble') : null;
  if (!bubble) return;
  document.querySelectorAll('.chat-bubble.is-selecting').forEach((b) => b.classList.remove('is-selecting'));
  bubble.classList.add('is-selecting');

  const sel = window.getSelection ? window.getSelection() : null;
  if (sel) {
    sel.removeAllRanges();
    // 先选中一个字, 系统才会画出可拖的手柄; 必须挑文本节点 (setStart 给元素会选整块)
    let node = null;
    const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null);
    while (walk.nextNode()) {
      if (walk.currentNode.nodeValue && walk.currentNode.nodeValue.trim()) { node = walk.currentNode; break; }
    }
    if (node) {
      try {
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(1, node.nodeValue.length));
        sel.addRange(range);
      } catch (err) { /* 选不了就算了 */ }
    }
  }
  showToast('拖动两个手柄选字，松手可以复制', 'info');

  let at = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
  const remember = (event) => {
    const t = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]);
    if (t) at = { x: t.clientX, y: t.clientY };
  };
  const stop = () => {
    document.removeEventListener('touchstart', remember, true);
    document.removeEventListener('touchend', finish, true);
    document.removeEventListener('pointerup', finish, true);
    bubble.classList.remove('is-selecting');
  };
  const finish = () => {
    const live = window.getSelection ? window.getSelection() : null;
    const text = String((live && live.toString()) || '').trim();
    stop();
    if (!text) return;
    showContextMenu({ clientX: at.x, clientY: at.y }, [{
      label: '复制',
      hint: text.length + ' 字',
      icon: CTX_ICONS.copy,
      onClick: () => copyChatText(text)
    }]);
  };
  document.addEventListener('touchstart', remember, true);
  // 延一小会儿再挂「松手弹菜单」: 打开菜单的那次 tap 的 touchend 马上就到, 会立刻把它弹回来
  setTimeout(() => {
    if (bubble.classList.contains('is-selecting')) {
      document.addEventListener('touchend', finish, true);
      document.addEventListener('pointerup', finish, true);
    }
  }, 450);
}

/* 表情包 */
// 存: 服务端落到 img/<用户名>/emoji/… 并登记 emoji 表 (/api/emoji*); 发: 表情就是一条图片消息

// 会话列表那行的预览文案 (客户端版): 必须与服务端 chatPreviewText() 逐字一致
function chatPreviewTextClient(body) {
  const att = parseChatAttach(body);
  if (!att) return String(body || '');
  if (att.t === 'image') return '[图片]';
  if (att.t === 'quote') return '[引用] ' + (att.body || att.text || '');
  return '[文件] ' + (att.name || '未命名');
}

// 表情消息的 body: 与普通图片一样, 只是名字固定 'sticker' (渲染时据此画小一点)
function chatStickerBody(url) {
  return JSON.stringify({ t: 'image', url: url, name: 'sticker' });
}

/* asyfunc 添加到表情: 从这条消息把图取回来 (同源代理, 顺带过权限), 再传进表情库 */
async function addChatSticker(row) {
  if (!row.dataset.id) {
    showToast('这张图还没发出去，等它传完再加', 'warn');
    return;
  }
  const att = parseChatAttach(row.dataset.body || '');
  try {
    showToast('正在添加…', 'info');
    const res = await fetch('/api/chat/media?id=' + encodeURIComponent(row.dataset.id), { cache: 'no-store' });
    if (!res.ok) throw new Error('取图失败');
    const blob = await res.blob();
    const name = ((att && att.name) || 'sticker').replace(/\.[a-z0-9]+$/i, '');
    await uploadStickerBlob(blob, name + '.png');
    showToast('已添加到表情', 'ok');
    // 面板开着的话顺手刷新一份
    const panel = document.querySelector('.chat-sticker-panel');
    if (panel && panel.__reload) panel.__reload();
  } catch (err) {
    showToast(err.message || '添加失败', 'error');
  }
}

/* asyfunc 把一张图 (blob) 传进表情库 —— 「添加到表情」与面板里那个 ＋ 共用 */
async function uploadStickerBlob(blob, name) {
  const form = new FormData();
  form.append('file', new File([blob], name || 'sticker.png', { type: blob.type || 'image/png' }));
  const res = await fetch('/api/emoji', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '添加失败');
  return data.emoji;
}

// 输入盒里的表情面板 (自己一行, 插进 .chat-send-box, flex-basis:100% 让它独占一行)
// 形制照 QQ: 一格一个表情, 第一格是虚线 ＋ (挑本地图片加进来), 没有下排分类按钮
function toggleStickerPanel(sendBox, onPick) {
  if (!sendBox) return;
  const open = sendBox.querySelector('.chat-sticker-panel');
  if (open) {
    open.remove();
    sendBox.classList.remove('is-picking-sticker');
    return;
  }
  const panel = el('div', 'chat-sticker-panel');
  panel.innerHTML = '<p class="chat-sticker-hint">载入中…</p>';
  // 挂在工具行里 (它是 relative 的): 面板 bottom:calc(100%+5px) 正好盖住输入框那一行
  // 弹窗那个宿主没有 .chat-tools, 退回挂在输入盒上
  const host = sendBox.querySelector('.chat-tools') || sendBox;
  host.appendChild(panel);
  sendBox.classList.add('is-picking-sticker');

  const close = () => {
    panel.remove();
    sendBox.classList.remove('is-picking-sticker');
  };
  panel.__reload = () => loadStickers(panel, onPick, close);
  loadStickers(panel, onPick, close);

  // 点面板外面就收起来 (输入框里不算外面 —— 还要打字)
  setTimeout(() => {
    const away = (event) => {
      if (!panel.isConnected) { document.removeEventListener('mousedown', away, true); return; }
      if (sendBox.contains(event.target)) return;
      document.removeEventListener('mousedown', away, true);
      close();
    };
    document.addEventListener('mousedown', away, true);
  }, 0);
}

/* 表情本地缓存 */
// 有缓存就直接画, 只在没缓存或发过 / 改过表情之后才后台同步 (/api/emoji), 面板里另有手动刷新键
// 名字都带 ui 前缀: 跨页面共享的经典脚本, 顶层名字要避开其他内联脚本
const UI_EMOJI_CACHE_KEY = 'foraine.emoji.cache';
let uiEmojiCache = null;
let uiEmojiNeedsSync = false;

function readEmojiCache() {
  if (uiEmojiCache) return uiEmojiCache;
  try {
    const raw = localStorage.getItem(UI_EMOJI_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.list)) uiEmojiCache = parsed;
  } catch (err) { uiEmojiCache = null; }
  return uiEmojiCache;
}

function saveEmojiCache(list) {
  uiEmojiCache = { list: list || [], at: Date.now() };
  try { localStorage.setItem(UI_EMOJI_CACHE_KEY, JSON.stringify(uiEmojiCache)); } catch (err) { /* 无痕模式 */ }
}

async function fetchEmojiList() {
  const res = await fetch('/api/emoji', { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '表情加载失败');
  return data.emoji || [];
}

async function loadStickers(panel, onPick, close) {
  const cached = readEmojiCache();
  let list = cached ? cached.list : null;
  const needSync = !cached || uiEmojiNeedsSync;
  if (!list) {
    // 一张缓存都没有: 只能等一次（第一次用 / 换了浏览器）
    panel.innerHTML = '';
    panel.appendChild(el('p', 'chat-sticker-hint', '加载中…'));
    try {
      list = await fetchEmojiList();
      saveEmojiCache(list);
      uiEmojiNeedsSync = false;
    } catch (err) {
      panel.innerHTML = '';
      panel.appendChild(el('p', 'chat-sticker-hint', '表情加载失败'));
      return;
    }
  } else if (needSync && !panel.__syncing) {
    // 有缓存: 先画出来 (不闪加载中) 再后台对一次, 真有变化才重画
    panel.__syncing = true;
    const snapshot = JSON.stringify(list);
    fetchEmojiList().then((fresh) => {
      saveEmojiCache(fresh);
      uiEmojiNeedsSync = false;
      delete panel.__syncing;
      if (JSON.stringify(fresh) !== snapshot) loadStickers(panel, onPick, close);
    }).catch(() => { delete panel.__syncing; });
  }
  panel.innerHTML = '';

  const grid = el('div', 'chat-sticker-grid');

  // 一行最多 6 格, ＋ 与刷新各占一格 -> 第一行是「＋ 刷新 + 4 个表情」, 后面每行 6 个
  // 一张都没有时给 5 格宽度, 好让那句提示能好好换行
  const slots = (list || []).length + 2;   // ＋ / 刷新 各占一格
  panel.style.setProperty('--chat-sticker-cols', String(list.length ? Math.min(6, slots) : 5));

  // 第一格: 虚线 ＋, 直接选本地图片加进表情库
  const add = el('button', 'chat-sticker is-add');
  add.type = 'button';
  add.title = '添加表情（本地图片）';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
  add.onclick = () => {
    pickChatFile({
      kind: 'image',
      onPick: async (file) => {
        try {
          showToast('正在添加…', 'info');
          await uploadStickerBlob(file, file.name || 'sticker.png');
          uiEmojiNeedsSync = true;   // 加过了 → 下次开面板对一次
          showToast('已添加到表情', 'ok');
          if (panel.__reload) panel.__reload();
        } catch (err) {
          showToast(err.message || '添加失败', 'error');
        }
      }
    });
  };
  grid.appendChild(add);

  // 第二格: 手动刷新（与 ＋ 同款虚线格子）
  const syncCell = el('button', 'chat-sticker is-add is-sync');
  syncCell.type = 'button';
  syncCell.title = '刷新表情';
  syncCell.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>';
  syncCell.onclick = async () => {
    try {
      const fresh = await fetchEmojiList();
      saveEmojiCache(fresh);
      uiEmojiNeedsSync = false;
      loadStickers(panel, onPick, close);
      showToast('表情已同步', 'ok');
    } catch (err) {
      showToast(err.message || '同步失败', 'error');
    }
  };
  grid.appendChild(syncCell);

  (list || []).forEach((item) => {
    const cell = el('button', 'chat-sticker');
    cell.type = 'button';
    cell.title = '点一下直接发出去（右键删除）';
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    img.loading = 'lazy';
    // 对象可能已经不在桶里了 (老布局被清过 / 过期) -> 那种格子直接收起来, 免得一格格碎图
    img.onerror = () => { cell.remove(); };
    cell.appendChild(img);
    // 发出去 = 下次开面板同步一次
    cell.onclick = () => { uiEmojiNeedsSync = true; close(); if (onPick) onPick(item.url); };
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(event, [{
        label: '删除这个表情',
        danger: true,
        icon: CTX_ICONS.trash,
        onClick: () => {
          confirmAction({ title: '', message: '把这个表情删掉吗？', confirmText: '确定' }).then(async (ok) => {
            if (!ok) return;
            try {
              await withLoading(() => apiPost('/api/emoji/delete', { id: item.id }));
              uiEmojiNeedsSync = true;   // 删过了 → 缓存作废
              cell.remove();
              showToast('已删除', 'ok');
            } catch (err) {
              showToast(err.message || '删除失败', 'error');
            }
          });
        }
      }]);
    });
    grid.appendChild(cell);
  });

  panel.appendChild(grid);
  if (!list.length) {
    panel.appendChild(el('p', 'chat-sticker-hint', '还没有表情：点上面的 ＋ 加一张，或在聊天里的图片上右键选「添加到表情」'));
  }
}

/* 消息去重 (乐观发送那行 + 轮询拉回来的那行) */
// 每条消息带一个客户端生成的 cid: 服务端原样存下并在历史里带回, 撞上的 cid 直接回原来那条
// 客户端渲染前先按 cid (再按服务端 id) 查一遍, 已画着的只补属性
// cid 只由本地生成, 所以两台设备各发一条也不会互撞

// 生成一条客户端消息 id
function newChatCid() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 找页面上已画出来的某条 (先按 cid, 乐观那条还没服务端 id; 再按服务端 id)
function findChatRow(msg) {
  if (!msg) return null;
  const box = document.querySelector('.chat-body');
  if (!box) return null;
  if (msg.cid) {
    const byCid = box.querySelector('.chat-msg[data-cid="' + msg.cid + '"]');
    if (byCid) return byCid;
  }
  if (msg.id) return box.querySelector('.chat-msg[data-id="' + String(msg.id) + '"]');
  return null;
}

// 服务端确认了 -> 补齐行上的属性 (cid 留着, 下次还认得)
function patchChatRow(row, msg) {
  if (!row || !msg) return;
  if (msg.id) row.dataset.id = String(msg.id);
  if (msg.created_at) row.dataset.at = String(msg.created_at);
  if (msg.body !== undefined) row.dataset.body = String(msg.body || '');
  row.classList.remove('is-new');
}

// 关闭当前弹窗
function closeModal() {
  if (modalLocked) return; // 发布中…这类弹窗只能由代码自己关
  const overlay = document.getElementById('modal-overlay');
  const hook = modalCloseHook;
  modalCloseHook = null;
  if (hook) hook();
  overlay?.classList.remove('show');
  // is-plain 是开弹窗时自己设的, 关的时候必须抹掉, 否则下一个弹窗会跟着变成无框
  overlay?.classList.remove('is-plain');
  scheduleModalReset();
}

// 关掉后等淡出跑完再清内容 (当场清会看成「字先消失、空框再滑下去」)
// 清之前要确认它还关着: 这 260ms 里可能又开了下一个弹窗
const MODAL_RESET_MS = 260;
let modalResetTimer = 0;
function cancelModalReset() {
  if (!modalResetTimer) return;
  clearTimeout(modalResetTimer);
  modalResetTimer = 0;
}
function scheduleModalReset() {
  cancelModalReset();
  modalResetTimer = setTimeout(() => {
    modalResetTimer = 0;
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.classList.contains('show')) return;   // 已经换成新弹窗了, 不动它
    const content = document.getElementById('modal-content');
    if (content) content.innerHTML = '<span class="modal-placeholder">...</span>';
  }, MODAL_RESET_MS);
}

// 不可关闭的「处理中」弹窗, 返回 { close() }; opts.plain = 只要一个转圈, 不要框体与文字
function showBusyModal(options) {
  const opts = options || {};
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay || !content) return { close() {} };

  // 无框那个也走 is-plain (.modal-overlay.is-plain 去掉面板底色/描边)
  overlay.classList.toggle('is-plain', !!opts.plain);
  const box = document.createElement('div');
  box.className = 'modal-busy' + (opts.plain ? ' is-plain' : '');
  box.appendChild(el('div', 'busy-spinner'));
  if (!opts.plain) box.appendChild(el('p', 'confirm-message', opts.message || '处理中…'));

  cancelModalReset();
  modalCloseHook = null;   // 忙等弹窗只能由代码自己关, 不接 Esc / 点遮罩那套
  content.innerHTML = '';
  content.appendChild(box);
  overlay.classList.add('show');
  // 用计数式锁定: 它自己关掉时不能把别人的锁 (比如还在上传的工作台) 一并解开
  lockModal();

  return {
    close() {
      unlockModal();
      overlay.classList.remove('show');
      overlay.classList.remove('is-plain');
      scheduleModalReset();
    }
  };
}

/* 右下角的「Foraine」小牌子 (foraine-toast, 雨猫 2026-09-21 定) */
// 两种用法: 等接口时用它代替转圈 (options.block = true 封住全站信号), 或当一条不挡事的提示 (不传就不封)
// 与普通 Toast 的区别: 透明底、右下角、可以一直挂着直到 close(); 每句文案都由调用方传进来
let foraineToastEl = null;
// 短提示挂多久自己收 (不封信号的那些)
const FORAINE_TOAST_TIP_MS = 1500;
function showForaineToast(options) {
  const opts = options || {};
  if (foraineToastEl && foraineToastEl.box.isConnected) foraineToastEl.close();

  const box = document.createElement('div');
  box.className = 'foraine-toast' + (opts.block ? ' is-block' : '');
  box.setAttribute('role', 'status');
  box.appendChild(el('span', 'foraine-toast-text', opts.text || ''));
  // 图标在文字右边
  const icon = document.createElement('img');
  icon.className = 'foraine-toast-icon';
  icon.alt = '';
  icon.src = '/assets/Icon/foraine-icon-v2.png';
  box.appendChild(icon);

  let swallow = null;
  let stopScroll = null;
  let entryResizeObserver = null;
  /* 没有 duration 的牌子 = 「正在做一件事」, 一直挂到 close(): 这期间关标签页要拦一下。
     带 duration 的是自动消失的短提示 (保存中 / Foraine 会记住的..), 不拦 */
  const holdPage = !opts.duration;
  if (holdPage) window.addEventListener('beforeunload', beforeUnloadGuard);
  if (opts.block) {
    // 封住所有信号: 捕获阶段就吞掉, 连页面上自己的监听也掷不到
    swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    EVENTS_BLOCKED.forEach((name) => document.addEventListener(name, swallow, true));
    stopScroll = (event) => event.preventDefault();
    window.addEventListener('wheel', stopScroll, { passive: false, capture: true });
    window.addEventListener('touchmove', stopScroll, { passive: false, capture: true });
  }

  document.body.appendChild(box);
  void box.offsetWidth;      // 先算过样式再挂类, 入场那 0.2s 才会播
  box.classList.add('is-in');
  /* 避开右下角那块牌子: 量出它的高度写进 --foraine-toast-h, .toast-stack 靠它抬上去。
     盯 ResizeObserver 而不是只量一次 —— 文字换了 / 翻译完了高度都会变 */
  syncForaineToastGap();
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => syncForaineToastGap());
    ro.observe(box);
    entryResizeObserver = ro;
  }
  // 视口一变就要重算: 桌面 ↔ 移动的窄屏断点会让牌子换边 (右下角 ↔ 右上角)
  window.addEventListener('resize', syncForaineToastGap);

  let timer = 0;
  const entry = { box, close };
  function close() {
    if (foraineToastEl === entry) foraineToastEl = null;
    clearTimeout(timer);
    if (entryResizeObserver) { entryResizeObserver.disconnect(); entryResizeObserver = null; }
    window.removeEventListener('resize', syncForaineToastGap);
    if (holdPage) window.removeEventListener('beforeunload', beforeUnloadGuard);
    if (swallow) EVENTS_BLOCKED.forEach((name) => document.removeEventListener(name, swallow, true));
    if (stopScroll) {
      window.removeEventListener('wheel', stopScroll, { capture: true });
      window.removeEventListener('touchmove', stopScroll, { capture: true });
    }
    box.classList.remove('is-in');
    setTimeout(() => {
      box.remove();
      // 牌子不在 (或换了一个) 就重量一次: 新牌子的高度可能与刚那个不同
      syncForaineToastGap();
    }, 220);
  }
  // duration: 到点自己收 (不传就一直挂到 close())
  if (opts.duration) timer = setTimeout(close, opts.duration);

  foraineToastEl = entry;
  return entry;
}

/* asyfunc 用「加载中」牌子包住一次提交 (模态里点完按钮、弹窗已经关掉的那次请求)
   牌子只是临时顶掉外层那块, close 只看自己那一个, 不会误关别人的 */
async function withLoading(task) {
  const busy = showForaineToast({ text: I18N.t('foraine-toast.loading'), block: true });
  try {
    return await task();
  } finally {
    busy.close();
  }
}

/* 跳转前松手: 「加载中」牌子留下的关标签页提示不该拦下一次跳转 (不松的话离开时会弹原生框)。
   ⚠️ 只收牌子; 上传工作台那种 lockModal() 的锁要留着 —— 那是有活在做, 点导航就该拦一下 */
function dismissForaineToast() {
  if (foraineToastEl) foraineToastEl.close();
}
window.__dismissForaineToast = dismissForaineToast;

// asyfunc 把避让高度写进 --foraine-toast-h: 桌面端牌子在右下角 → 要抬「牌子的高 + 一点间距」;
// 移动端牌子在右上角 (page-foraine-toast.css 的窄屏规则) → 底部居中的 Toast 跟它碰不到, 抬 0
// ⚠️ 不能在 close() 之前就写 0: 下一帧它会补回来, 但中间那一帧 toast 会先滑下去再弹回来
function syncForaineToastGap() {
  const box = foraineToastEl && foraineToastEl.box;
  requestAnimationFrame(() => {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const h = box && box.isConnected && !narrow ? box.getBoundingClientRect().height : 0;
    // 16 = 牌子顶边到 Toast 底边的实际间距 (两边 bottom 基准差 8px 已经算进去了)
    document.documentElement.style.setProperty('--foraine-toast-h', h ? Math.round(h + 10) + 'px' : '0px');
  });
}

// 封信号要拦的事件名
const EVENTS_BLOCKED = ['pointerdown', 'pointerup', 'click', 'contextmenu', 'submit', 'touchstart', 'wheel', 'keydown'];

/* 「点两次」的二次确认 */
// 第一次点只把按钮文字换成「确定？」, 再点一次才真动手; 不要再弹确认框
// (会盖住正在做的事, 而且共用 #modal-content 会把工作台内容换掉)
// 返回 { reset, disarm }, 自己超时复原
function armTwoStep(button, options) {
  const opts = options || {};
  const label = opts.label || button.textContent;
  const armedLabel = opts.armedLabel || '确定？';
  let armed = false;
  let timer = 0;
  // 中间态也要锁弹窗 (停在「确定？」上被 Esc 关掉会以为已经确认过); 第二下执行前先解锁
  let guard = null;

  const disarm = () => {
    armed = false;
    clearTimeout(timer);
    button.classList.remove('is-armed');
    button.textContent = label;
    if (guard) { guard.release(); guard = null; }
  };

  button.addEventListener('click', () => {
    if (button.disabled) return;
    if (!armed) {
      armed = true;
      button.classList.add('is-armed');
      button.textContent = armedLabel;
      timer = setTimeout(disarm, opts.windowMs || 5000);
      guard = lockModal();
      return;
    }
    disarm();
    if (typeof opts.onConfirm === 'function') opts.onConfirm();
  });

  return {
    disarm,
    // 任何会改变「即将执行的内容」的操作 (增删文件 / 改标题 / 换排序) 都要调它
    reset() { if (armed) disarm(); },
    get armed() { return armed; }
  };
}

// 标签当 placeholder 用 (这里不再渲染标签)
function wrapFieldLabel(box, field, label) {
  if (label && !field.getAttribute('placeholder')) field.setAttribute('placeholder', label);
  box.appendChild(field);
}

/* 通用「确认执行」弹窗 */
// 取代原生 confirm() / alert(), 返回 Promise<boolean>
// options: title / message / messageHtml / confirmText / danger / warning (不传时 danger 默认补「此操作不可撤销」,
//   传空串则不显示) / requireText (+ requireTextIgnoreCase) / password / inputLabel / fields[] / liveCheck / lock / leftCancel
// actions[]: 两个平级选择 (如「删除评论并下架 / 创建新草稿」), 传了就不渲染取消+确认, resolve 出 { id }
//   这种框没有取消键, 只能点遮罩 / Esc 退出
// onConfirm(values, api): 返回 false 就留在弹窗里, 可用 api.setError('…') 报错 (会弹成 Toast)
function confirmAction(options) {
  const opts = options || {};
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');

  // 没有弹窗容器时退回原生 confirm, 至少别让操作卡死
  if (!overlay || !content) {
    return Promise.resolve(window.confirm(opts.message || '确定要继续吗？'));
  }
  // 有任务锁着（上传中这类）: 不当掉锁, 也不开新弹窗
  if (modalLockDepth > 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    overlay.classList.remove('is-plain');
    const finish = (result) => {
      if (modalCloseHook === myHook) modalCloseHook = null;
      if (flowLock) flowLock.release();
      overlay.classList.remove('show');
      overlay.classList.remove('is-plain');
      // 内容等淡出跑完再清 (见 scheduleModalReset)
      scheduleModalReset();
      resolve(result);
    };
    /* 凡是要写内容的模态一律上锁 (雨猫 2026-09-21 定): 有输入框 / 打用户名 / 填密码的,
       一律锁住 —— 于是它也会拿到一个取消键当唯一出口 */
    if (!opts.lock && (opts.requireText || opts.password
      || (Array.isArray(opts.fields) && opts.fields.length))) opts.lock = true;

    // lock: true = 从打开起不许 Esc / 点空白关, 关标签页也拦一下; finish 里必须解锁
    // 必须排在那句「modalLocked = false」之后, 反了的话刚上的锁当场被抹掉
    modalLocked = false;
    const flowLock = opts.lock ? lockModal() : null;

    // Esc / 点遮罩关掉它时也要把 Promise 落地成 false, 否则调用方一直 await 着
    const myHook = () => finish(false);
    modalCloseHook = myHook;
    cancelModalReset();  // 撤掉上一个弹窗的「淡出后清空」定时器
    const box = document.createElement('div');
    box.className = 'confirm-dialog';

    if (opts.title) {
      const title = document.createElement('p');
      title.className = 'confirm-title';
      title.textContent = opts.title;
      box.appendChild(title);
    }

    // message 传空串 = 只显示标题 (比如「确定要退出登录吗？」不需要正文)
    const messageText = opts.message === undefined ? '确定要继续吗？' : opts.message;
    if (messageText || opts.messageHtml) {
      const message = document.createElement('p');
      message.className = 'confirm-message';
      // messageHtml: 需要在弹窗里摊开一段等宽内容时用它代替 message (D1 控制台要贴一遍 SQL)
      if (opts.messageHtml) message.innerHTML = opts.messageHtml;
      else message.textContent = messageText;
      box.appendChild(message);
    }

    // danger 默认补一句警告; warning 传了就以它为准 (空串 = 不要警告)
    const warnText = opts.warning !== undefined ? opts.warning
      : (opts.danger ? I18N.t('modal.warning.CannotbeUndone', '此操作不可撤销') : '');
    if (warnText) {
      const warn = document.createElement('p');
      warn.className = 'confirm-warning';
      warn.textContent = warnText;
      box.appendChild(warn);
    }

    // 自定义按钮组 (actions) 的组装在下面 fields 之后: 两套要能共存 (既填理由又选按钮)

    /* 弹窗里有两族按钮: confirmBtn (普通路径) 与 actionButtons (actions 路径)。
       门槛 (打字确认 / 必填项) 要同时管住两族 —— 只写 confirmBtn.disabled 的话, actions 模式下它根本不进 DOM, 按钮就永远亮着 (注销第三屏的「我意已决」就是这么来的) */
    const actionButtons = [];
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = opts.danger ? 'btn-danger' : 'btn';
    confirmBtn.textContent = opts.confirmText || I18N.t('opt.confirm', '确认');

    // leftCancel: 取消键放最左边 (走流程的弹窗里它是唯一出口); actions 模式本来没有取消键, 这里补一个
    const addLeftCancel = (row) => {
      if (!opts.leftCancel) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-outline confirm-cancel-left';
      btn.textContent = opts.leftCancelText || I18N.t('opt.cancel', '取消');
      btn.onclick = () => finish(false);
      row.insertBefore(btn, row.firstChild);
    };

    /* 门槛: 打字确认要完全对上 (requireTextIgnoreCase 放宽大小写), 密码框非空即可, 必填项不能空
       必填项没填完 → 所有按钮都锁; 打字确认没对上 → 只锁危险按钮 (「留下」这类退出动作不能跟着被锁, 不然人只能按 Esc 跑) */
    const typedOk = () => {
      if (opts.requireText) {
        const typed = input ? input.value.trim() : '';
        return opts.requireTextIgnoreCase
          ? typed.toLowerCase() === String(opts.requireText).toLowerCase()
          : typed === opts.requireText;
      }
      if (opts.password) return !!(input && input.value);
      return true;
    };
    const fieldsOk = () => !Array.from(fieldInputs.values())
      .some((f) => f.required && !String(f.field.value).trim());
    function refreshGates() {
      const fieldsBlank = !fieldsOk();
      const textOk = typedOk();
      confirmBtn.disabled = fieldsBlank || !textOk;
      actionButtons.forEach((btn) => {
        btn.disabled = fieldsBlank || (btn.dataset.gated === '1' && !textOk) || btn.dataset.hard === '1';
      });
    }

    // 传了 confirmArmedText 才启用「点两次」: 第一次只把按钮文字换成它
    let confirmArmed = false;
    let confirmArmTimer = 0;
    // 「点两次」的中间态同样锁弹窗
    let confirmArmLock = null;
    const disarmConfirm = () => {
      if (!confirmArmed) return;
      confirmArmed = false;
      clearTimeout(confirmArmTimer);
      confirmBtn.classList.remove('is-armed');
      confirmBtn.textContent = opts.confirmText || '确认';
      if (confirmArmLock) { confirmArmLock.release(); confirmArmLock = null; }
    };

    // liveCheck 那行提示
    const liveHint = document.createElement('p');
    liveHint.className = 'confirm-hint';
    liveHint.hidden = true;
    if (opts.liveCheckIdle) {
      liveHint.textContent = opts.liveCheckIdle;
      liveHint.hidden = false;
    }

    let input = null;
    if (opts.requireText || opts.password) {
      input = document.createElement('input');
      input.type = opts.password ? 'password' : 'text';
      input.className = 'confirm-input';
      // 关掉浏览器的自动填入 / 历史下拉 (core.js 的 hardenField 按类型分别处理)
      if (typeof hardenField === 'function') hardenField(input);
      else input.autocomplete = 'off';
      if (opts.requireText) input.placeholder = opts.requireText;
      // 标签当 placeholder 用 (这里不再渲染标签)
      wrapFieldLabel(box, input, opts.inputLabel || (opts.password ? '密码' : '用户名'));

      confirmBtn.disabled = true;
      input.addEventListener('input', refreshGates);
    }

    // 多字段表单 (「封禁」要同时填理由和天数): 值会打包成对象交给 onConfirm
    const fieldInputs = new Map();
    if (!input && Array.isArray(opts.fields) && opts.fields.length) {
      opts.fields.forEach((spec) => {
        // type: 'select' → 下拉框 (收信人这种「从一列里挑一个」的场景)
        const isSelect = spec.type === 'select';
        const field = document.createElement(isSelect ? 'select' : (spec.multiline ? 'textarea' : 'input'));
        if (!isSelect && !spec.multiline) field.type = spec.type || 'text';
        // 多行框基础两行, 能写就长 (超过 growLines 行转内部滚动), 不再用固定高
        if (spec.multiline) field.rows = spec.rows || 2;
        field.className = 'confirm-input';
        if (isSelect) {
          // 没选之前要有个占位项, 否则浏览器默认选中第一项 = 静默替你选了个人
          if (spec.placeholder) {
            const blank = document.createElement('option');
            blank.value = '';
            blank.textContent = spec.placeholder;
            blank.disabled = true;
            blank.selected = true;
            field.appendChild(blank);
          }
          (spec.options || []).forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label != null ? opt.label : opt.value;
            field.appendChild(o);
          });
        } else {
          field.placeholder = spec.placeholder || '';
          if (spec.maxlength) field.maxLength = spec.maxlength;
          if (spec.value != null) field.value = spec.value;   // 预填 (D1 改值那种)
        }
        if (typeof hardenField === 'function') hardenField(field);
        else field.autocomplete = 'off';

        // 标签当 placeholder 用 (这里不再渲染标签)
        wrapFieldLabel(box, field, spec.label);
        fieldInputs.set(spec.name, { field, required: !!spec.required });
        // 多行框: 基础 spec.rows 行, 输入时一行一行长
        if (spec.multiline) bindAutoGrow(field, spec.growLines || 10, spec.rows || 2);

        if (spec.required) confirmBtn.disabled = true;
        // select 用 change, 其它用 input
        field.addEventListener(isSelect ? 'change' : 'input', refreshGates);
      });
      // 上面每个 required 字段都会无条件锁确认键 -> 有预填值时按实际内容重算一次
      refreshGates();

      // liveCheck(values) 要回 { ok, hint }: ok 才放行确认键, hint 写在那行小字里
      // 用序号挡竞态: 慢的那次回来时若不是最后一次输入, 结果直接丢掉
      if (typeof opts.liveCheck === 'function') {
        let liveSeq = 0;
        const runLiveCheck = async () => {
          liveSeq += 1;
          const seq = liveSeq;
          disarmConfirm();
          const values = collectValues();
          const blank = !Object.values(values || {}).some((v) => String(v || '').trim());
          confirmBtn.disabled = true;
          if (blank) {
            liveHint.className = 'confirm-hint';
            liveHint.textContent = opts.liveCheckIdle || '';
            liveHint.hidden = !liveHint.textContent;
            return;
          }
          liveHint.className = 'confirm-hint';
          liveHint.textContent = '正在验证…';
          liveHint.hidden = false;
          let result = null;
          try { result = await opts.liveCheck(values); } catch (err) { result = { ok: false, hint: '' }; }
          if (seq !== liveSeq) return;
          const ok = !!(result && result.ok);
          liveHint.textContent = (result && result.hint) || '';
          liveHint.hidden = !liveHint.textContent;
          liveHint.className = 'confirm-hint' + (ok ? ' is-ok' : (liveHint.textContent ? ' is-bad' : ''));
          confirmBtn.disabled = !ok;
        };
        fieldInputs.forEach((f) => f.field.addEventListener('input', runLiveCheck));
      }
    }

    // 取值 (fields 给对象, 单个输入框给字符串, 都没有给 undefined)
    const collectValues = () => (input
      ? input.value
      : (fieldInputs.size
        ? Object.fromEntries(Array.from(fieldInputs, ([name, f]) => [name, String(f.field.value).trim()]))
        : undefined));

    // 两个平级的选择 (如「下架 / 删除」): 有它就到此为止, 没有取消键, 只能选一个或关掉
    // 可以和 fields 共存 (先填理由再选按钮), 那时 resolve 出的是 { id, values }
    if (Array.isArray(opts.actions) && opts.actions.length) {
      const row = document.createElement('div');
      row.className = 'confirm-actions';

      opts.actions.forEach((spec) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = spec.danger ? 'btn-danger' : 'btn';
        btn.textContent = spec.text || spec.id;
        /* hard = 这按钮本身就不该能点; gated = 受「打字确认」管 (默认只有危险按钮算) */
        btn.dataset.hard = spec.disabled ? '1' : '0';
        btn.dataset.gated = (spec.gated === undefined ? !!spec.danger : !!spec.gated) ? '1' : '0';
        // spec.disabled: 置灰但不隐藏 —— 让人看得见「还有这条路, 只是你还没开」
        if (spec.disabled) btn.title = spec.disabledHint || '当前不可用';
        btn.onclick = async () => {
          const values = collectValues();
          if (typeof opts.onConfirm === 'function') {
            btn.disabled = true;
            // 提交期间挂「加载中」: 锁定的选择框里等接口时页面上什么都没有在动
            const busy = showForaineToast({ text: I18N.t('foraine-toast.loading'), block: true });
            try {
              const ok = await opts.onConfirm(values, { setErrorLike: null, action: spec.id });
              if (ok === false) { btn.disabled = false; return; }
            } catch (err) {
              showToast((err && err.message) || '操作失败，请稍后再试', 'error');
              btn.disabled = false;
              return;
            } finally {
              busy.close();
            }
          }
          finish(fieldInputs.size ? { id: spec.id, values } : { id: spec.id });
        };
        actionButtons.push(btn);
        row.appendChild(btn);
      });
      addLeftCancel(row);
      refreshGates();   // 打字确认 / 必填项满足之前, 这些按钮一个都不给点

      box.appendChild(liveHint);
      box.appendChild(row);
      // 回车 = 第一个不危险的按钮; textarea 里回车要换行, 所以只管单行输入框
      box.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (UI_TOUCH_ONLY) return;                                  // 手机: 回车就是换行
        // 多行框在多按钮弹窗里只负责「交棒」, 绝不替用户选一个按钮
        if ((event.target.tagName || '').toUpperCase() === 'TEXTAREA') {
          event.preventDefault();
          event.target.blur();
          return;
        }
        if ((event.target.tagName || '').toUpperCase() !== 'INPUT') return;
        if (!String(event.target.value || '').trim()) return;
        const safe = actionButtons.find((b) => !b.classList.contains('btn-danger') && !b.disabled);
        if (!safe) return;
        event.preventDefault();
        safe.click();
      });
      content.innerHTML = '';
      content.appendChild(box);
      overlay.classList.add('show');
      setTimeout(() => row.firstElementChild?.focus(), 50);
      return;
    }

    // 弹窗里的错误一律弹 Toast (弹窗留在原地还能改输入); setError 这名字留着给老调用点
    const setError = (text) => {
      if (!text) return;
      showToast(text, 'error');
    };

    const row = document.createElement('div');
    row.className = 'confirm-actions';

    /* 取消键只给锁定的弹窗: 锁定后 Esc 与点空白都关不掉, 这时它才是唯一出口;
       没锁的弹窗不留取消键 —— 点背景 / 按 Esc 就是取消 (雨猫 2026-09-21 定的) */
    if (opts.lock) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-outline' + (opts.leftCancel ? ' confirm-cancel-left' : '');
      cancelBtn.textContent = I18N.t('opt.cancel', '取消');
      cancelBtn.onclick = () => finish(false);
      row.appendChild(cancelBtn);
    }
    row.appendChild(confirmBtn);

    // 确认动作可异步 (如先向服务端验密码): 返回 false 就留在弹窗里
    confirmBtn.onclick = async () => {
      // confirmArmedText = 点两次, 第一次只把文字换成它
      if (opts.confirmArmedText && !confirmArmed) {
        confirmArmed = true;
        confirmBtn.classList.add('is-armed');
        confirmBtn.textContent = opts.confirmArmedText;
        confirmArmTimer = setTimeout(disarmConfirm, opts.confirmArmMs || 5000);
        confirmArmLock = lockModal();
        return;
      }
      disarmConfirm();
      if (typeof opts.onConfirm === 'function') {
        confirmBtn.disabled = true;
        // 取值: fields 给对象, 单个输入框给字符串, 都没有给 undefined
        const value = collectValues();
        /* 提交期间挂「加载中」牌子: 锁定框里等接口时, 页面上什么都没有在动
           (牌子会临时顶掉外层那块, 关掉时只看自己那一个, 不会误关别人) */
        const busy = showForaineToast({ text: I18N.t('foraine-toast.loading'), block: true });
        try {
          const ok = await opts.onConfirm(value, { setError });
          if (ok === false) {
            confirmBtn.disabled = false;
            return;
          }
        } catch (err) {
          setError((err && err.message) || '操作失败，请稍后再试');
          confirmBtn.disabled = false;
          return;
        } finally {
          busy.close();
        }
      }
      finish(true);
    };

    row.appendChild(confirmBtn);
    box.appendChild(liveHint);
    box.appendChild(row);

    // 回车规矩: 单行框有内容 + 按钮不超过 2 个才确认; 多行框只有一个时 Enter 确认,
    //   多个输入框时 Enter 只交棒 (失焦), 移动端一律换行
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (UI_TOUCH_ONLY) return;
      const tag = (event.target.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') {
        const boxes = box.querySelectorAll('input:not([type="file"]), textarea, select');
        event.preventDefault();
        if (boxes.length <= 1) {
          if (!confirmBtn.disabled) confirmBtn.click();
        } else {
          event.target.blur();   // 多个输入框: Enter 交棒, 不提交
        }
        return;
      }
      if (tag !== 'INPUT') return;
      if (!String(event.target.value || '').trim()) return;
      if (box.querySelectorAll('button').length > 2) return;
      event.preventDefault();
      if (!confirmBtn.disabled) confirmBtn.click();
    });

    content.innerHTML = '';
    content.appendChild(box);
    overlay.classList.add('show');

    // 有输入框就先聚焦输入框, 否则聚焦确认按钮 (回车即可确认)
    const firstField = input || (fieldInputs.size ? fieldInputs.values().next().value.field : null);
    setTimeout(() => {
      (firstField || confirmBtn).focus();
      // 已挂进文档, 这里按真实字号给多行框重量一次 (挂文档前 getComputedStyle 拿不到行高)
      fieldInputs.forEach((f) => {
        if ((f.field.tagName || '').toUpperCase() === 'TEXTAREA') f.field.dispatchEvent(new Event('input'));
      });
    }, 50);
  });
}

/* 空状态 / 加载中 */
// 页面正中一块「话」: 图标 + 大字主句 + 小字副句 (样式在 main.css 的 .page-state)
const STATE_ICONS = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"></path><path d="M13.7 20a2 2 0 0 1-3.4 0"></path></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.7 6.3.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.6l6.3-.9z"></path></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.6-3.6"></path></svg>'
};

// 空状态
function emptyState(options) {
  const opts = options || {};
  const box = el('div', 'page-state');
  const icon = el('div', 'page-state-icon');
  // 调用方可以传 svg 字符串, 也可以传 STATE_ICONS 里的键名
  const svg = opts.icon && STATE_ICONS[opts.icon] ? STATE_ICONS[opts.icon] : opts.icon;
  if (svg) icon.innerHTML = svg;
  else icon.hidden = true;
  box.appendChild(icon);
  box.appendChild(el('p', 'page-state-title', opts.title || '一片虚无'));
  if (opts.text !== '') box.appendChild(el('p', 'page-state-text', opts.text || '有待星空来填充此地'));
  return box;
}

// 加载中
function loadingState(text) {
  const box = el('div', 'page-state page-state-loading');
  box.appendChild(el('div', 'page-state-spinner'));
  box.appendChild(el('p', 'page-state-text', text || '直达星辰..'));
  return box;
}

/* 右键菜单 */
// showContextMenu(鼠标事件, [{ label, danger, disabled, hint, icon, arrow, onClick }, '-'])
// 布局四栏: 图标 | 标签 | 快捷键 | 展开箭头; 点什么后 / 点别处 / Esc / 滚动 / 缩放窗口都会关掉
// 有任一项给了 icon 才给所有项留出图标列 (否则白白缩进一截)
let contextMenuEl = null;
// 收起时要通知的回调 (下拉框靠它把箭头翻回去), 只认当前这一个菜单
let contextMenuOnClose = null;

// 收起并清掉菜单
function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
  if (typeof contextMenuOnClose === 'function') {
    const cb = contextMenuOnClose;
    contextMenuOnClose = null; // 先清再调: 回调里如果又开了一个菜单, 不会被这次清掉
    cb();
  }
}

// 右键菜单图标
const CTX_ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 8H7a4 4 0 0 0 0 8h1"/><path d="M18 8h-3a4 4 0 0 0 0 8h1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  recall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 10h10a4 4 0 0 1 0 8h-5"/><path d="m8 6-3 4 3 4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 1 0-6l2-2a4 4 0 0 1 6 6l-1 1"/><path d="M14 10a4 4 0 0 1 0 6l-2 2a4 4 0 0 1-6-6l1-1"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20V9"/><path d="m7 13 5-5 5 5"/><path d="M5 5h14"/></svg>',
  sticker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 10h.01M15 10h.01M9.5 15h5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h12l4 4v10H4z"/><path d="M9 12h6M9 16h6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m12 4 2.4 5.1 5.6.7-4 3.9 1 5.5-5-2.8-5 2.8 1-5.5-4-3.9 5.6-.7z"/></svg>',
  starOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m12 4 2.4 5.1 5.6.7-4 3.9 1 5.5-5-2.8-5 2.8 1-5.5-4-3.9 5.6-.7z"/><path d="M4 20 20 4"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-3.2-.6L3.5 21l1.7-4.6A8.3 8.3 0 0 1 4 11.5a8.4 8.4 0 0 1 8.5-8.4A8.4 8.4 0 0 1 21 11.5z"/></svg>',
  ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 12 5 5L19 7"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="16" r="4"/><path d="m11 13 8-8 2 2-2 2 2 2-3 3-2-2-1 1"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/></svg>',
  userX: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 9-5"/><path d="m16 15 5 5M21 15l-5 5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4h6v3H9z"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>',
  selectAll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M8 20H6a2 2 0 0 1-2-2v-2M16 20h2a2 2 0 0 0 2-2v-2"/></svg>'
};

function showContextMenu(evt, items, options) {
  hideContextMenu();
  const opts = options || {};
  const list = items || [];
  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const hasIcon = list.some((i) => i && i.icon);
  const hasHint = list.some((i) => i && i.hint);
  const hasArrow = list.some((i) => i && i.arrow);
  if (hasIcon) menu.classList.add('has-icons');
  if (hasHint) menu.classList.add('has-hints');
  if (hasArrow) menu.classList.add('has-arrows');

  list.forEach((item) => {
    if (item === '-' || (item && item.separator)) {
      menu.appendChild(el('div', 'context-menu-sep'));
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    if (item.danger) btn.classList.add('is-danger');
    if (item.disabled) btn.disabled = true;

    const icon = el('span', 'ctx-icon');
    if (item.icon) icon.innerHTML = item.icon;
    btn.appendChild(icon);
    btn.appendChild(el('span', 'ctx-label', item.label));

    const hint = el('span', 'ctx-hint', item.hint || '');
    // 按键提示 (⌘C / ⌥⌘V 这种) 要跟前面的文本多拉开一点
    if (item.hint && /^[⌘⌥⇧⌃]/.test(item.hint.trim())) hint.classList.add('is-key');
    btn.appendChild(hint);
    const arrow = el('span', 'ctx-arrow', item.arrow ? '›' : '');
    btn.appendChild(arrow);

    btn.onclick = () => {
      hideContextMenu();
      if (typeof item.onClick === 'function') item.onClick();
    };
    menu.appendChild(btn);
  });

  if (!menu.childElementCount) return;
  document.body.appendChild(menu);
  contextMenuEl = menu;
  // 收起时通知调用方; 必须在 append 之后设, 否则回调会挂在「菜单没开成」的那一次上
  contextMenuOnClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  // 长菜单: 最多露 N 项 (必须挂进文档后再量, 游离元素 offsetHeight 是 0; 也要在定位前夹好)
  if (opts.maxItems) {
    const count = list.filter((i) => i !== '-' && !(i && i.separator)).length;
    const first = menu.querySelector('button');
    const h = first ? first.offsetHeight : 0;
    if (count > opts.maxItems && h) {
      menu.style.maxHeight = Math.round(h * opts.maxItems + 8) + 'px';
    }
  }

  // 贴着鼠标放, 但别越出视口 (右键点在屏幕边上时会被推回来)
  const rect = menu.getBoundingClientRect();
  const x = Math.max(8, Math.min(evt.clientX, window.innerWidth - rect.width - 8));
  const y = Math.max(8, Math.min(evt.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

document.addEventListener('mousedown', (e) => {
  if (contextMenuEl && !contextMenuEl.contains(e.target)) hideContextMenu();
}, true);

// 滚动要关菜单, 监听必须是捕获阶段 (菜单自己的滚动不冒泡到 window); 菜单内部滚的要排掉
// (不排的话下拉框一滑就消失); resize 不排 (菜单是 fixed, 视口一变位置就废了)
window.addEventListener('scroll', (event) => {
  if (contextMenuEl && event.target && contextMenuEl.contains(event.target)) return;
  hideContextMenu();
}, true);
window.addEventListener('resize', hideContextMenu);

/* 全局接替右键 (个性化里那个开关, 存在 localStorage, 不跨设备) */
// 打开后所有右键都不出现原生菜单 (有专属菜单的地方照旧弹自己的), 输入框 / 可编辑区不接管
const CTX_CAPTURE_KEY = 'foraine.contextmenu.capture';

function ctxCaptureOn() {
  try { return localStorage.getItem(CTX_CAPTURE_KEY) === '1'; } catch (err) { return false; }
}

function setCtxCapture(on) {
  try { localStorage.setItem(CTX_CAPTURE_KEY, on ? '1' : '0'); } catch (err) { /* 无痕模式就算了 */ }
}

// capture 阶段先吃掉默认行为; 元素自己的 contextmenu handler 在后面照旧触发
document.addEventListener('contextmenu', (event) => {
  if (!ctxCaptureOn()) return;
  const t = event.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
  event.preventDefault();
}, true);

/* 输入框自己的右键菜单: 复制 / 粘贴 / 全选; 不看上面那个「全局接替右键」开关, 任何时候都生效 */
const INPUT_MENU_SELECTOR = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="submit"]):not([type="button"]), textarea';

function inputMenuPaste(field) {
  navigator.clipboard.readText().then((text) => {
    if (!text) { showToast('剪贴板是空的', 'warn'); return; }
    const start = field.selectionStart === null ? field.value.length : field.selectionStart;
    const end = field.selectionEnd === null ? field.value.length : field.selectionEnd;
    field.focus();
    field.setRangeText(text, start, end, 'end');
    // 手动补一个 input 事件: 自动长高 / 髒检查 / 按钮启用都是听它的
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }).catch(() => showToast('读不到剪贴板（浏览器需要授权）', 'error'));
}

document.addEventListener('contextmenu', (event) => {
  const field = event.target;
  if (!field || !field.matches || !field.matches(INPUT_MENU_SELECTOR)) return;
  event.preventDefault();
  const locked = !!field.disabled || !!field.readOnly;
  const hasSelection = field.selectionStart !== null && field.selectionStart !== field.selectionEnd;
  showContextMenu(event, [
    {
      label: '复制',
      hint: '⌘ C',
      icon: CTX_ICONS.copy,
      disabled: locked || !hasSelection,
      onClick: () => {
        const text = field.value.slice(field.selectionStart, field.selectionEnd);
        navigator.clipboard.writeText(text)
          .then(() => showToast('已复制', 'ok'))
          .catch(() => showToast('复制失败', 'error'));
      }
    },
    { label: '粘贴', hint: '⌘ V', icon: CTX_ICONS.paste, disabled: locked, onClick: () => inputMenuPaste(field) },
    { label: '全选', hint: '⌘ A', icon: CTX_ICONS.selectAll, onClick: () => { field.focus(); field.select(); } }
  ]);
});

/* 下拉框改造 */
// 原生 select 的展开层是操作系统的, 这里换成「黑亚克力按钮 + 复用右键菜单的展开层」
// 原生 select 仍留在 DOM 里 (只是看不见), 读 .value / 听 change 的老代码不用改
function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced === '1' || sel.multiple) return;
  sel.dataset.enhanced = '1';
  const wrap = document.createElement('span');
  wrap.className = 'ui-select';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ui-select-btn';
  const label = document.createElement('span');
  label.className = 'ui-select-label';
  const arrow = document.createElement('span');
  arrow.className = 'ui-select-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  btn.appendChild(label);
  btn.appendChild(arrow);
  wrap.appendChild(btn);
  sel.parentNode.insertBefore(wrap, sel);
  sel.classList.add('is-enhanced');

  const current = () => (sel.options[sel.selectedIndex] || {}).textContent || '';
  const sync = () => { label.textContent = current(); wrap.classList.toggle('is-empty', !sel.value); };
  const syncDisabled = () => { wrap.classList.toggle('is-disabled', !!sel.disabled); };

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (sel.disabled) return;
    // 箭头翻个身; 翻回去要等菜单真的收起 (onClose), 自己 setTimeout 会「翻上去又立刻翻回来」
    wrap.classList.add('is-open');
    showContextMenu(event, Array.from(sel.options).map((opt, i) => ({
      label: opt.textContent,
      hint: i === sel.selectedIndex ? '✓' : '',
      disabled: !!opt.disabled,
      onClick: () => {
        if (sel.selectedIndex !== i) {
          sel.selectedIndex = i;
          sync();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    })), {
      maxItems: 6,
      onClose: () => wrap.classList.remove('is-open')
    });
  });
  sel.addEventListener('change', sync);
  // 代码里直接赋值 sel.value / selectedIndex / disabled 时也要跟上: 在这个实例上包一层 setter
  // (不碰原型也不挂定时器 —— 常驻 timer 只为了换一个标签文字不值得)
  ['value', 'selectedIndex', 'disabled'].forEach((key) => {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), key);
    if (!desc || !desc.get || !desc.set) return;
    Object.defineProperty(sel, key, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(next) { desc.set.call(this, next); sync(); syncDisabled(); }
    });
  });
  sync();
  syncDisabled();
}

function enhanceSelects(root) {
  const scope = (root && root.querySelectorAll) ? root : document;
  scope.querySelectorAll('select:not([data-enhanced])').forEach(enhanceSelect);
}

// 以后新加的下拉框 (弹窗里的) 也自动换皮
document.addEventListener('DOMContentLoaded', () => {
  enhanceSelects(document);
  if (!window.MutationObserver) return;
  new MutationObserver((records) => {
    records.forEach((record) => {
      Array.prototype.forEach.call(record.addedNodes, (node) => {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'SELECT') enhanceSelect(node);
        else enhanceSelects(node);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
});

/* 敏感操作的「验证身份」弹窗 */
// [验证] + 三个按钮 [密码][令牌][邮箱]; 没启用令牌 / 没验邮箱的置灰 (不藏起来)
// 邮箱走 6 位码: /api/verify/email/send 下发, /api/verify/email/check 校验
// 返回值是对象 { method, password?, totp?, code? } 而不是 true (注销流程要原样转给 /api/account/delete)
let identityFlags = null;

/* asyfunc 取「有没有令牌 / 有没有验过邮箱」, 带缓存; 第一次真要请求时挂「加载中」牌子 ——
   这正是「点下去 → 锁定框弹出来」之间那段没反馈的等待 */
async function loadIdentityFlags() {
  if (identityFlags) return identityFlags;
  const busy = showForaineToast({ text: I18N.t('foraine-toast.loading'), block: true });
  try {
    const res = await fetch('/api/me', { cache: 'no-store' });
    const data = await res.json();
    const u = data.user || {};
    identityFlags = { hasTotp: !!u.totp_enabled, hasEmail: !!(u.email_verified && u.mail_ready) };
  } catch (err) {
    identityFlags = { hasTotp: false, hasEmail: false };
  } finally {
    busy.close();
  }
  return identityFlags;
}

/* asyfunc 验证身份 */
async function verifyIdentity(opts) {
  const options = opts || {};
  // lock -> 验证期间锁住弹窗; leftCancel -> 取消键放左下
  const flowOpts = { lock: !!options.lock, leftCancel: !!options.leftCancel };
  const wanted = Array.isArray(options.methods) && options.methods.length
    ? options.methods
    : ['password', 'totp', 'email'];
  const flags = await loadIdentityFlags();
  /* beforeWait: 调用方在这一刻收掉自己的「加载中」牌子 —— 也要把封住的信号放开,
     不然下面那个 confirmAction 的按钮点不动 */
  if (typeof options.beforeWait === 'function') options.beforeWait();
  const offered = [
    { id: 'password', text: I18N.t('name.password'), ready: true },
    { id: 'totp', text: I18N.t('name.token'), ready: flags.hasTotp, why: I18N.t('hint.2FANotEnabled') },
    { id: 'email', text: I18N.t('name.email'), ready: flags.hasEmail, why: I18N.t('hint.emailNotVerified') }
  ].filter((a) => wanted.indexOf(a.id) >= 0);

  let method = '';
  if (!offered.length) { showToast(I18N.t('toast.verifyIdentity.warn-MethodNotAvailable'), 'warn'); return false; }
  if (offered.length === 1) {
    if (!offered[0].ready) { showToast('这个方式需要「' + offered[0].text + '」：' + offered[0].why, 'warn'); return false; }
    method = offered[0].id;
  } else {
    const pick = await confirmAction({
      title: I18N.t('opt.verify'),
      message: I18N.t('ops.verifyIdentity.title'),
      warning: '',
      lock: flowOpts.lock,
      leftCancel: flowOpts.leftCancel,
      actions: offered.map((a) => ({ id: a.id, text: a.text, disabled: !a.ready, disabledHint: a.why }))
    });
    if (!pick || !pick.id) return false;
    method = pick.id;
  }

  // 一步: 弹一个小框收一串字符, 校验交给 submit, 不对就留在原地
  // spec.type = 'password' 才打码 (验证码打码反而不好输)
  const ask = async (spec) => {
    let done = false;
    await confirmAction({
      title: spec.title,
      message: spec.hint,
      warning: '',
      confirmText: I18N.t('opt.confirm'),
      lock: flowOpts.lock,
      leftCancel: flowOpts.leftCancel,
      fields: [{ name: 'v', type: spec.type || 'text', placeholder: spec.placeholder, required: true, maxlength: spec.maxlength }],
      onConfirm: async (values) => {
        const value = String((values || {}).v || '').trim();
        if (!spec.check.test(value)) { showToast('格式不对', 'warn'); return false; }
        const ok = await spec.submit(value);
        if (ok) { done = true; return true; }
        return false;   // 留在弹窗里重来
      }
    });
    return done;
  };

  // asyfunc 发一步验证请求: 成功回响应体 (里面有一次性通行证 pass), 失败回 null
  const postOk = async (url, body, badMsg) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || badMsg, 'error');
        return null;
      }
      return await res.json().catch(() => ({}));
    } catch (err) {
      showToast('验证失败，请稍后再试', 'error');
      return null;
    }
  };

  // 验过之后服务端会给一张 5 分钟的一次性通行证, 敏感操作凭它放行
  let pass = '';

  if (method === 'password') {
    let password = '';
    const ok = await ask({
      title: I18N.t('opt.verify') + ' · ' + I18N.t('name.password'),
      hint: I18N.t('ops.verifyIdentity.password.ctn'),
      placeholder: I18N.t('name.password'),
      type: 'password',   // 打码
      check: /^.+$/,
      submit: async (v) => {
        const r = await postOk('/api/account/verify', { password: v }, I18N.t('toast.error-WrongPassword'));
        if (r) { password = v; pass = r.pass || ''; }
        return !!r;
      }
    });
    return ok ? { method: 'password', password: password, pass: pass } : false;
  }

  // TOTP特别的处理方式
  if (method === 'totp') {
    let code = '';
    let code_length = 6;
    const ok = await ask({
      title: I18N.t('opt.verify') + ' · ' + I18N.t('name.token'),
      hint: I18N.t('ops.verifyIdentity.token.ctn', {value: code_length}),
      placeholder: I18N.t('value.digit', {value: code_length}),
      maxlength: code_length,
      check: /^\d{6}$/,
      submit: async (v) => { const r = await postOk('/api/totp/verify', { code: v }, I18N.t('toast.error-WrongCode')); if (r) { code = v; pass = r.pass || ''; } return !!r; }
    });
    return ok ? { method: 'totp', totp: code, pass: pass } : false;
  }

  // 发送验证码
  const sent = await withLoading(() => postOk('/api/verify/email/send', {}, I18N.t('email.error-NoService')));
  if (!sent) return false;
  showToast(I18N.t('target.emailSent', { target: sent.email || '', value: sent.ttl_minutes || 10 }), 'ok');
  let code = '';
  let code_length = 6;
  const ok = await ask({
    title: I18N.t('opt.verify') + ' · ' + I18N.t('name.email'),
    hint: I18N.t('ops.verifyIdentity.email.ctn', {value: code_length}),
    placeholder: I18N.t('value.digit', {value: code_length}),
    maxlength: code_length,
    check: /^\d{6}$/,
    submit: async (v) => { const r = await postOk('/api/verify/email/check', { code: v }, I18N.t('toast.error-WrongCode')); if (r) { code = v; pass = r.pass || ''; } return !!r; }
  });
  return ok ? { method: 'email', code: code, pass: pass } : false;
}

// 旧名字, D1 / R2 的老调用点用 (它就是上面的验证身份)
function verifyOwnerPassword(opts) {
  return verifyIdentity(opts);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
}, true);

// 初始化: 监听遮罩点击与Esc关闭
function initModal() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;

  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    // 锁着的时候点遮罩不能关窗, 但也不能像没反应一样: 右下角挂一句短提示
    if (modalLocked) {
      showForaineToast({
        text: I18N.t('foraine-toast.processing', '操作进行中...'),
        duration: FORAINE_TOAST_TIP_MS
      });
      return;
    }
    closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}
// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
  initModal();
});
