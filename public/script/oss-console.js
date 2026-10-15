/* oss-console.js R2 页签 */
/*
  内容: 概览四卡 / 桶标签 / 前缀工具行 / 对象表格 / 右键菜单 / 上传与删除
  依赖: core.js(el/apiPost) / ui.js(showToast/confirmAction/showContextMenu/CTX_ICONS/verifyOwnerPassword)
*/
(function initOssConsole() {
  // 与后端 OSS_ADMIN_UPLOAD_MAX 一致
  const OSS_UPLOAD_MAX = 50 * 1024 * 1024;

  const state = {
    inited: false,
    loading: false,
    configured: true,
    buckets: [],
    active: null,
    prefix: '',
    token: '',        // 分页继续令牌
    folders: [],
    objects: [],
    truncated: false,
    nextToken: null,
    style: '',
    diag: null,       // 列桶失败时的诊断
    overview: null
  };
  // 「概览」是假桶键, 与真桶 key 不撞 ('image' / 'resource')
  const OVERVIEW = '概览';

  // 拉平列表 → 下一级目录分组 (不给 OSS 传 delimiter=/ , 查询串带上 %2F 会让 V4 签名对不上)
  // 0 字节的 `/` 结尾占位对象不当文件列, 但要参与分组, 否则空文件夹会立刻从列表里消失
  function groupObjects(prefix, list) {
    const folders = new Map();
    const files = [];
    list.forEach((obj) => {
      const rel = obj.key.slice(prefix.length);
      if (!rel) return;                                   // 当前前缀自己的占位对象
      const isMarker = /\/$/.test(rel) && !Number(obj.size);
      const cut = rel.indexOf('/');
      if (cut >= 0) {
        const name = rel.slice(0, cut + 1);
        if (!folders.has(name)) folders.set(name, { name, prefix: prefix + name, count: 0 });
        if (!isMarker) folders.get(name).count += 1;
      } else {
        files.push(obj);
      }
    });
    return {
      folders: Array.from(folders.values()).sort((a, b) => (a.name < b.name ? -1 : 1)),
      files
    };
  }

  const $ = (id) => document.getElementById(id);

  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
  }

  function timeText(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function activeBucket() {
    return state.buckets.find((b) => b.key === state.active) || null;
  }

  function setStatus(text, isError) {
    const node = $('r2-status');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'd1-status' + (isError ? ' is-error' : '');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制', 'ok');
    } catch (err) {
      showToast('复制失败，请手动选中', 'error');
    }
  }

  /* ==================== 二级标签卡 (两个桶) ==================== */
  function renderTabs() {
    const list = $('r2-tab-list');
    if (!list) return;
    list.innerHTML = '';
    const over = el('button', 'd1-tab' + (state.active === OVERVIEW ? ' is-active' : ''));
    over.type = 'button';
    over.title = '存储概览';
    over.appendChild(el('span', 'd1-tab-label', OVERVIEW));
    over.onclick = () => selectBucket(OVERVIEW);
    list.appendChild(over);
    state.buckets.forEach((bucket) => {
      const tab = el('button', 'd1-tab' + (state.active === bucket.key ? ' is-active' : ''));
      tab.type = 'button';
      tab.title = bucket.bucket + ' · ' + (bucket.about || '');
      tab.appendChild(el('span', 'd1-tab-label', bucket.key));
      tab.onclick = () => selectBucket(bucket.key);
      list.appendChild(tab);
    });
  }

  /* ==================== 概览 (四张数字卡) ==================== */
  function overviewNode() {
    const data = state.overview;
    const box = el('div', 'r2-overview');
    if (!data) { box.appendChild(el('p', 'editor-hint', '读取中…')); return box; }
    if (data.error) { box.appendChild(el('p', 'editor-hint', data.error)); return box; }
    const cards = [
      ['总容量', sizeText(data.total_bytes)],
      ['文件数', String(data.file_count)],
      ['资源组', String(data.group_count)],
      ['本周新增', sizeText(data.week_bytes)]
    ];
    const grid = el('div', 'r2-overview-grid');
    cards.forEach(([label, value]) => {
      const card = el('div', 'r2-overview-card');
      card.appendChild(el('span', 'r2-overview-label', label));
      card.appendChild(el('span', 'r2-overview-value', value));
      grid.appendChild(card);
    });
    box.appendChild(grid);
    return box;
  }

  async function loadOverview() {
    state.loading = true;
    renderBody();
    try {
      const response = await fetch('/api/storage/overview', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      state.overview = response.ok ? data : { error: data.error || '读取概览失败' };
    } catch (err) {
      state.overview = { error: '读取概览失败，请稍后再试' };
    } finally {
      state.loading = false;
      renderBody();
    }
  }

  /* ==================== 诊断卡片 ==================== */
  function diagText() {
    const d = state.diag || {};
    const bucket = activeBucket();
    return [
      'bucket: ' + ((bucket && bucket.bucket) || ''),
      'error: ' + (d.error || ''),
      'oss_status: ' + (d.status === undefined ? '' : d.status),
      'tried_style: ' + (d.style === undefined ? '' : d.style),
      'learned: ' + (d.learned || false),
      'url: ' + (d.url || ''),
      '',
      'canonical_ours:',
      d.canonical || '(空)',
      '',
      'canonical_oss_echo:',
      d.echo ? (d.echo.uri + '\n' + d.echo.query) : '(响应里没有回显 CanonicalRequest)',
      '',
      'oss_raw:',
      d.raw || '(空)'
    ].join('\n');
  }

  function diagNode() {
    const box = el('div', 'r2-diag');
    box.appendChild(el('p', 'r2-diag-title', '列对象失败：' + ((state.diag && state.diag.error) || '未知错误')));
    const text = diagText();
    box.appendChild(el('pre', 'r2-diag-pre', text));
    const copy = el('button', 'btn-outline r2-diag-copy', '复制诊断信息');
    copy.type = 'button';
    copy.onclick = () => copyText(text);
    box.appendChild(copy);
    box.appendChild(el('p', 'r2-diag-hint', '这一块里没有密钥，直接发给开发者就能定位问题'));
    return box;
  }

  /* ==================== 右键菜单 ==================== */
  function openRowMenu(event, obj) {
    event.preventDefault();
    showContextMenu(event, [
      { label: '下载', icon: CTX_ICONS.download, onClick: () => downloadObject(obj) },
      { label: '复制链接', icon: CTX_ICONS.link, onClick: () => copyText(obj.url) },
      { label: '删除', danger: true, icon: CTX_ICONS.trash, onClick: () => removeObject(obj) }
    ]);
  }

  function openHeadMenu(event) {
    event.preventDefault();
    showContextMenu(event, [
      { label: '新建文件夹…', icon: CTX_ICONS.folder, onClick: () => newFolder() },
      { label: '上传文件…', icon: CTX_ICONS.upload, onClick: () => uploadFile() }
    ]);
  }

  function openFolderMenu(event, folder) {
    event.preventDefault();
    showContextMenu(event, [
      { label: '打开', icon: CTX_ICONS.folder, onClick: () => go(folder.prefix) },
      { label: '复制路径', icon: CTX_ICONS.link, onClick: () => copyText(folder.prefix) },
      '-',
      { label: '新建文件夹…', icon: CTX_ICONS.folder, onClick: () => newFolder(folder.prefix) },
      { label: '上传到这里…', icon: CTX_ICONS.upload, onClick: () => uploadFile(folder.prefix) },
      '-',
      { label: '删除文件夹…', danger: true, icon: CTX_ICONS.trash, onClick: () => removeFolder(folder) }
    ]);
  }

  // 根目录下的文件夹 = 前缀只有一层 (例如 avatar/), 删它要站主密码
  function isRootFolder(prefix) {
    return String(prefix).replace(/\/$/, '').indexOf('/') < 0;
  }

  // asyfunc 递归删文件夹 (后端一次只删一小批: Workers 子请求有上限)
  async function removeFolder(folder) {
    const bucket = activeBucket();
    const ok = await confirmAction({
      title: '删除文件夹？',
      message: folder.prefix + '\n里面的东西会一起删掉',
      warning: '删了就没了，引用它的地方会变裂图',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    if (isRootFolder(folder.prefix) && !(await verifyOwnerPassword({ methods: ['password'] }))) return;

    let total = 0;
    let round = 0;
    try {
      await withLoading(async () => {
        for (;;) {
          const data = await apiPost('/api/admin/oss/delete-folder', { bucket: bucket.key, prefix: folder.prefix });
          round += 1;
          total += data.deleted || 0;
          setStatus('正在删除 ' + folder.name + ' … 已删 ' + total + ' 个');
          if (data.done) break;
          if (!data.deleted && !data.failed) break;   // 没进展, 别死循环
          if (round > 2000) break;                    // 兜底
        }
      });
      setStatus('');
      showToast('已删除文件夹 ' + folder.name + '（' + total + ' 个对象）', 'ok');
      state.token = '';
      loadObjects(state.prefix, '', true);
    } catch (error) {
      setStatus('');
      showToast(error.message || '删除失败', 'error');
    }
  }

  // asyfunc 文件夹的「个数 / 总大小」单独拉 (塞进主列表会给每个子目录再列一次, 很慢)
  async function loadFolderSizes() {
    const bucket = activeBucket();
    const rows = Array.prototype.slice.call(document.querySelectorAll('#r2-body tr.r2-folder'));
    if (!bucket || !rows.length) return;
    try {
      const res = await fetch('/api/admin/oss/folders?bucket=' + encodeURIComponent(bucket.key)
        + '&prefix=' + encodeURIComponent(state.prefix), { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const byName = {};
      (data.folders || []).forEach((f) => { byName[f.name] = f; });
      rows.forEach((tr) => {
        const info = byName[tr.dataset.folder];
        const cell = tr.querySelector('.r2-folder-size');
        if (!info || !cell) return;
        cell.textContent = info.count + ' 个 / ' + sizeText(info.size);
      });
    } catch (err) { /* 拿不到就算了 */ }
  }

  // 下载: 资源桶私有读, 直链 403 → 走 Worker 代取 (同源 + 强制 attachment)
  function downloadObject(obj) {
    const bucket = activeBucket();
    const a = document.createElement('a');
    a.href = '/api/admin/oss/media?bucket=' + encodeURIComponent(bucket.key) + '&key=' + encodeURIComponent(obj.key);
    a.download = obj.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('正在下载 ' + obj.name, 'info');
  }

  async function newFolder(atPrefix) {
    const base = atPrefix === undefined ? state.prefix : atPrefix;
    const bucket = activeBucket();
    await confirmAction({
      title: '新建文件夹',
      message: base ? '建在 ' + base + ' 下' : '建在桶根目录下',
      confirmText: '创建',
      fields: [{ name: 'name', label: '文件夹名', placeholder: '比如 covers', required: true }],
      // 带 fields 的弹窗必须走 onConfirm (普通路径 resolve 出 true, 拿不到字段值)
      onConfirm: async (values) => {
        const name = String((values || {}).name || '').trim();
        if (!name) return false;
        try {
          await apiPost('/api/admin/oss/folder', { bucket: bucket.key, prefix: base, name: name });
          showToast('已创建 ' + name, 'ok');
          loadObjects(state.prefix, '', false);
          return true;
        } catch (error) {
          showToast(error.message || '创建失败', 'error');
          return false;
        }
      }
    });
  }

  function uploadFile(atPrefix) {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > OSS_UPLOAD_MAX) {
        showToast('这个入口单个文件最多 50 MB（大文件走站内资源上传那条直传链路）', 'warn');
        return;
      }
      const bucket = activeBucket();
      const form = new FormData();
      form.append('file', file);
      form.append('bucket', bucket.key);
      form.append('prefix', atPrefix === undefined ? state.prefix : atPrefix);
      showToast('正在上传 ' + file.name + '…', 'info');
      try {
        const res = await fetch('/api/admin/oss/upload', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        showToast('已上传 ' + file.name, 'ok');
        loadObjects(state.prefix, '', false);
      } catch (error) {
        showToast(error.message || '上传失败', 'error');
      }
    };
    input.click();
  }

  function renderBody() {
    const body = $('r2-body');
    if (!body) return;
    body.innerHTML = '';

    // 概览页不吃桶与工具行, 先把工具行收起来
    const toolbar = document.querySelector('#tab-r2 .d1-toolbar');
    if (toolbar) toolbar.hidden = state.active === OVERVIEW;
    if (state.active === OVERVIEW) {
      body.appendChild(overviewNode());
      return;
    }

    const bucket = activeBucket();

    if (!state.inited || state.loading) {
      body.appendChild(el('p', 'editor-hint', '读取中…'));
      return;
    }
    if (!state.configured) {
      body.appendChild(el('p', 'editor-hint', 'OSS 未正确配置'));
      return;
    }
    if (!bucket) {
      body.appendChild(el('p', 'editor-hint', '加载中…'));
      return;
    }
    // 上一次列对象是失败的 → 先把诊断摊出来 (别的什么都不画)
    if (state.diag) {
      body.appendChild(diagNode());
      return;
    }

    const grouped = groupObjects(state.prefix, state.objects);
    const folders = grouped.folders;
    const files = grouped.files;
    state.folders = folders;

    // 无论有没有文件都画表格: 空目录只留表头, 右键表头照样能新建 / 上传
    const wrap = el('div', 'd1-grid-wrap');
    const table = el('table', 'd1-grid');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'd1-grid-rownum', '#'));
    ['名称', '大小', '最后修改'].forEach((t) => headRow.appendChild(el('th', null, t)));
    headRow.oncontextmenu = (event) => openHeadMenu(event);
    thead.appendChild(headRow);
    table.appendChild(thead);
    table.oncontextmenu = (event) => {
      if (event.target.closest('tr')) return;   // 行 / 表头自己管
      openHeadMenu(event);
    };

    const tbody = el('tbody');
    let i = 0;
    folders.forEach((folder) => {
      i += 1;
      const tr = el('tr', 'r2-folder');
      tr.appendChild(el('td', 'd1-grid-rownum', String(i)));
      const nameTd = el('td');
      const open = el('button', 'r2-link', '📁 ' + folder.name);
      open.type = 'button';
      open.title = folder.prefix + '（' + folder.count + ' 个对象）';
      open.onclick = () => go(folder.prefix);
      nameTd.appendChild(open);
      tr.appendChild(nameTd);
      tr.dataset.folder = folder.name;
      tr.appendChild(el('td', 'd1-null r2-folder-size', folder.count + ' 个 / …'));
      tr.appendChild(el('td', 'd1-null', '—'));
      tr.oncontextmenu = (event) => openFolderMenu(event, folder);
      tbody.appendChild(tr);
    });

    files.forEach((obj) => {
      i += 1;
      const tr = el('tr');
      tr.appendChild(el('td', 'd1-grid-rownum', String(i)));

      const nameTd = el('td');
      const isImage = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(obj.name);
      const name = el(isImage ? 'button' : 'span', isImage ? 'r2-link' : 'd1-cell-text', obj.name);
      if (isImage) {
        name.type = 'button';
        name.title = obj.key + '（点一下看大图）';
        name.onclick = () => window.open(obj.url, '_blank', 'noopener');
      } else {
        name.title = obj.key;
      }
      nameTd.appendChild(name);
      tr.appendChild(nameTd);

      tr.appendChild(el('td', 'd1-num', sizeText(obj.size)));
      tr.appendChild(el('td', 'd1-cell-text', timeText(obj.last_modified)));

      tr.oncontextmenu = (event) => openRowMenu(event, obj);
      tbody.appendChild(tr);
    });

    // 不做「什么都没有」提示: 留一行全空白占位行, 右键它 = 右键表头
    if (!folders.length && !files.length) {
      const blank = el('tr', 'r2-blank-row');
      [null, 'd1-cell-text', 'd1-cell-text', 'd1-cell-text'].forEach((cls) => {
        blank.appendChild(el('td', cls, ''));
      });
      blank.oncontextmenu = (event) => openHeadMenu(event);
      tbody.appendChild(blank);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    if (state.truncated && state.nextToken) {
      const more = el('button', 'btn-outline r2-more', '加载更多（这一页已满 1000 个）');
      more.type = 'button';
      more.onclick = () => loadObjects(state.prefix, state.nextToken, true);
      body.appendChild(more);
    }

    if (folders.length) loadFolderSizes();
  }

  /* ==================== 取数 ==================== */
  async function loadBuckets() {
    try {
      const response = await fetch('/api/admin/oss/buckets', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '读取桶清单失败');
      state.buckets = data.buckets || [];
      state.configured = data.configured !== false;
      if (!state.active) state.active = OVERVIEW;
      renderTabs();
      if (state.active === OVERVIEW) { await loadOverview(); return; }
      await loadObjects('', '', false);
    } catch (error) {
      state.configured = false;
      renderTabs();
      renderBody();
      setStatus(error.message, true);
    }
  }

  async function loadObjects(prefix, token, append) {
    const bucket = activeBucket();
    if (!bucket) return;
    state.loading = true;
    state.prefix = prefix;
    // 用 readOnly 不是 disabled: 锁着也要能选中里面的路径
    const lockInput = $('r2-prefix');
    if (lockInput) lockInput.readOnly = true;
    if (!append) { state.objects = []; }
    renderBody();
    setStatus('');   // 「读取中」只写在 body 里

    try {
      const params = new URLSearchParams({ bucket: bucket.key, prefix: prefix });
      if (token) params.set('token', token);
      const response = await fetch('/api/admin/oss/list?' + params.toString(), { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 失败时把后端给的那套诊断信息整块留下 (renderBody → diagNode)
        state.diag = {
          error: data.error || ('HTTP ' + response.status),
          status: data.oss_status,
          raw: data.oss_raw || '',
          canonical: data.oss_canonical || '',
          echo: data.oss_echo || null,
          url: data.oss_url || '',
          style: data.oss_style,
          learned: data.oss_learned
        };
        throw new Error(state.diag.error);
      }
      state.diag = null;
      state.style = data.oss_style || '';
      state.objects = append ? state.objects.concat(data.objects || []) : (data.objects || []);
      state.truncated = !!data.truncated;
      state.nextToken = data.next_token || null;
      const grouped = groupObjects(prefix, state.objects);
      setStatus([
        grouped.folders.length ? grouped.folders.length + ' 个文件夹' : '',
        grouped.files.length + ' 个对象',
        // 「列表共 N 个」只在有下一页时才提 (平时对象都分在子文件夹里, 报出来跟「0 个对象」打架)
        state.truncated ? '（已拉回 ' + state.objects.length + ' 项）' : '',
        prefix ? '路径 ' + prefix : '桶根目录'
      ].filter(Boolean).join(' · '));
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      state.loading = false;
      renderBody();
      const input = $('r2-prefix');
      if (input) { input.value = state.prefix; input.readOnly = false; }
    }
  }

  async function selectBucket(key) {
    if (state.active === key) return;
    const order = state.buckets.map((b) => b.key);
    const fromIdx = order.indexOf(state.active);
    const toIdx = order.indexOf(key);
    state.active = key;
    state.token = '';
    renderTabs();
    if (key === OVERVIEW) {
      await loadOverview();
    } else {
      await loadObjects('', '', false);
    }
    // 切桶渐入: 方向 = 新桶在旧桶哪边
    const body = $('r2-body');
    if (body && fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
      body.classList.remove('tab-enter-left', 'tab-enter-right');
      void body.offsetWidth;   // 强制回流, 动画才重播
      body.classList.add(toIdx > fromIdx ? 'tab-enter-right' : 'tab-enter-left');
    }
  }

  /* ==================== 操作 ==================== */
  function go(prefix) {
    loadObjects(String(prefix || ''), '', false);
  }

  function up() {
    const p = state.prefix;
    if (!p) { showToast('已经在桶的根目录了', 'warn'); return; }
    const trimmed = p.replace(/\/$/, '');
    const cut = trimmed.lastIndexOf('/');
    go(cut < 0 ? '' : trimmed.slice(0, cut + 1));
  }

  async function removeObject(obj) {
    const ok = await confirmAction({
      title: '删除这个对象？',
      message: obj.key,
      warning: '桶里的对象删掉就没了。要是它还被文章正文 / 头像 / 聊天引用着，那边会变成裂图',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    // 删资源只验站主密码
    if (!(await verifyOwnerPassword({ methods: ['password'] }))) return;
    const bucket = activeBucket();
    try {
      const data = await withLoading(() => apiPost('/api/admin/oss/delete', { bucket: bucket ? bucket.key : 'image', key: obj.key }));
      if (data && data.error) throw new Error(data.error);
      showToast('已删除 ' + obj.name, 'ok');
      loadObjects(state.prefix, '', false);
    } catch (error) {
      showToast(error.message || '删除失败', 'error');
    }
  }

  // 「上一级」那颗方形按钮的尺寸全由 CSS 定 (page-d1.css 的 .d1-icon-btn): 测量写回会变反馈环

  /* ==================== 初始化 (切到 R2 页签时调) ==================== */
  function open() {
    if (state.inited) return;
    state.inited = true;
    const goBtn = $('r2-go');
    if (goBtn) {
      goBtn.onclick = () => {
        const input = $('r2-prefix');
        go(input ? input.value.trim() : '');
      };
    }
    const upBtn = $('r2-up');
    if (upBtn) upBtn.onclick = () => up();
    const refreshBtn = $('r2-refresh');
    if (refreshBtn) refreshBtn.onclick = () => {
      state.diag = null;   // 上一轮失败的诊断卡片要能重试掉
      if (state.active === OVERVIEW) { loadOverview(); return; }
      loadObjects(state.prefix, '', false);
    };
    renderTabs();
    renderBody();
    loadBuckets();
  }

  window.r2Console = {
    open,
    go: () => {
      const input = $('r2-prefix');
      go(input ? input.value.trim() : '');
    },
    up
  };
})();
