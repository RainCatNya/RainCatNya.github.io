/* d1-console.js D1 控制台 */
/*
  内容: 个人页「D1」页签 (只有站长看得到, 服务端会再验一次权限): 概览 表清单 / 统计 / 表标签 结果网格 / 查询标签
  依赖: core.js(el, escapeHtml) / ui.js(showToast, confirmAction, showContextMenu, verifyOwnerPassword)
*/
(function initD1Console() {
  const HISTORY_KEY = 'foraine.d1.history';
  const HISTORY_MAX = 50;
  // 写操作口令, 服务端也要拿到同一个值才执行
  const WRITE_CONFIRM = 'RUN';

  const state = {
    inited: false,
    loading: false,
    tables: [],        // [{ name, columns: [{name,type,pk}] }]
    openTables: [],    // 打开着的表标签 (概览标签是固定的, 不在这里)
    result: {},        // { tableName: { columns, rows, ... } }  ← 每个表标签各自记住上次的结果
    overview: null,    // 概览标签的结果? (概览不显示网格)
    active: 'overview',
    limit: 50,
    history: [],
    querySeq: 0,       // 「查询 N」的序号 (只增不减)
    labels: {},        // { tabKey: 显示名 }  ← 查询标签的键是内部 id, 不能直接当名字显示
    dirty: {},         // { tabKey: true }  ← 跑过写操作后, 表标签的数据就不新鲜了
    draft: {},         // { tabKey: 'SELECT …' } ← 每个标签输入框里那点草稿 (含空串)
    autoRun: null,     // 已废弃, 只留着防旧引用报错
    pickerOpen: false,
    statsRange: '24h', // 统计卡片的时间窗 (24h / 7d / 30d)
    edits: {},
    ddl: {},
    dels: {},
    rowAdds: {},
    colOps: {},
    sel: {},
    // 有未提交改动时锁住命令行 (saved = 用户本来写的, 取消更改时还原)
    frozen: null
  };

  /* 密文列, 与后端 D1_MASK_COLUMNS 一致: 不给选中不给复制 (只有它特殊, 别按表加锁) */
  const MASKED_COLUMNS = ['password_hash', 'salt', 'token', 'secret', 'password', 'digest'];
  const isMaskedColumn = (name) => MASKED_COLUMNS.includes(String(name).toLowerCase());

  const $ = (id) => document.getElementById(id);
  const sqlInput = () => $('d1-sql');
  const tableByName = (name) => state.tables.find((t) => t.name === name) || null;

  const quoteIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"';
  const defaultSqlFor = (table) => 'SELECT * FROM ' + quoteIdent(table) + ' LIMIT ' + state.limit;

  /* 先抠掉字符串字面量再找写关键字, 否则 WHERE action = 'article.delete' 会被误判 (词表同 worker.js) */
  const WRITE_WORDS = /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|reindex|attach|detach|grant|revoke|begin|commit|rollback)\b/i;
  const stripLiterals = (sql) => String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  const isWriteSql = (sql) => WRITE_WORDS.test(stripLiterals(sql));

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      state.history = Array.isArray(list) ? list.slice(0, HISTORY_MAX) : [];
    } catch (err) {
      state.history = [];
    }
  }

  function pushHistory(sql) {
    const text = String(sql || '').trim();
    if (!text) return;
    state.history = [text].concat(state.history.filter((h) => h !== text)).slice(0, HISTORY_MAX);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch (err) { /* 忽略 */ }
  }

  /* 二级页签栏 */
  function renderTabbar() {
    const list = $('d1-tab-list');
    if (!list) return;
    list.innerHTML = '';

    const addTab = (key, label, closable) => {
      const tab = el('button', 'd1-tab' + (state.active === key ? ' is-active' : ''));
      tab.type = 'button';
      tab.appendChild(el('span', 'd1-tab-label', label));
      if (closable) {
        const close = el('span', 'd1-tab-close', '✕');
        close.title = '关闭这个标签';
        close.onclick = (event) => {
          event.stopPropagation(); // 别顺手把标签也激活了
          closeTab(key);
        };
        tab.appendChild(close);
      }
      tab.onclick = () => activateTab(key);
      list.appendChild(tab);
    };

    addTab('overview', '概览', false);
    addTab('stats', '统计', false);
    state.openTables.forEach((name) => addTab(name, state.labels[name] || name, true));

    const add = $('d1-tab-add');
    if (add) add.classList.toggle('is-open', state.pickerOpen);
  }

  function renderPicker() {
    const picker = $('d1-picker');
    if (!picker) return;
    picker.hidden = !state.pickerOpen;
    if (!state.pickerOpen) return;

    picker.innerHTML = '';
    if (!state.tables.length) {
      picker.appendChild(el('p', 'editor-hint', state.loading ? '读取表清单…' : '读不到表清单'));
      return;
    }
    const head = el('div', 'd1-picker-head');
    head.appendChild(el('span', null, '打开表'));
    head.appendChild(el('span', 'd1-picker-count', state.tables.length + ' 张'));
    picker.appendChild(head);

    const body = el('div', 'd1-picker-body');
    state.tables.forEach((t) => {
      const row = el('button', 'd1-picker-item' + (state.openTables.includes(t.name) ? ' is-open' : ''));
      row.type = 'button';
      row.appendChild(el('span', 'd1-picker-name', t.name));
      row.appendChild(el('span', 'd1-picker-meta', t.columns.length + ' 列'));
      if (state.openTables.includes(t.name)) row.appendChild(el('span', 'd1-picker-dot', '已开'));
      row.onclick = () => {
        openTable(t.name);
        state.pickerOpen = false;
        renderPicker();
        renderTabbar();
      };
      body.appendChild(row);
    });
    picker.appendChild(body);

    const foot = el('div', 'd1-picker-foot');
    const newQuery = el('button', 'd1-picker-new', '新建查询标签');
    newQuery.type = 'button';
    newQuery.onclick = () => {
      state.pickerOpen = false;
      renderPicker();
      newQueryTab();
    };
    foot.appendChild(newQuery);
    picker.appendChild(foot);
  }

  function togglePicker() {
    state.pickerOpen = !state.pickerOpen;
    if (state.pickerOpen && !state.tables.length) loadTables();
    renderPicker();
    renderTabbar();
  }

  /* 标签开关 / 切换 */
  function openTable(name) {
    const first = !state.openTables.includes(name);
    if (first) {
      state.openTables.push(name);
      state.result[name] = null;
      delete state.draft[name];
    }
    activateTab(name);
    if (first) autoRunTab(name);
  }

  function newQueryKey() {
    state.querySeq += 1;
    const key = 'query-' + state.querySeq + '-' + Date.now().toString(36);
    state.labels[key] = '查询 ' + state.querySeq;
    return key;
  }

  // 最近开的查询标签 (概览页跑查询时结果接进它)
  function lastQueryKey() {
    for (let i = state.openTables.length - 1; i >= 0; i -= 1) {
      if (String(state.openTables[i]).startsWith('query-')) return state.openTables[i];
    }
    return null;
  }

  function newQueryTab() {
    const key = newQueryKey();
    state.openTables.push(key);
    state.result[key] = null;
    activateTab(key);
    const input = sqlInput();
    if (input) input.focus();
  }

  function closeTab(key) {
    const i = state.openTables.indexOf(key);
    if (i < 0) return;
    state.openTables.splice(i, 1);
    delete state.result[key];
    delete state.labels[key];
    clearEdits(key);
    clearDdl(key);
    clearDels(key);
    clearRowAdds(key);
    clearColOps(key);
    if (state.active === key) activateTab(state.openTables[i - 1] || state.openTables[0] || 'overview');
    else { renderTabbar(); }
  }

  function activateTab(key) {
    const input = sqlInput();
    const order = ['overview', 'stats'].concat(state.openTables);
    const fromIdx = order.indexOf(state.active);
    // 先存下上一个标签的草稿, 否则切回来会被默认 SQL 盖掉
    if (input && state.active) state.draft[state.active] = input.value;
    state.active = key;
    renderTabbar();
    const table = tableByName(key);
    const stale = !!state.dirty[key];
    if (input) {
      /* 表标签给默认 SELECT, 查询标签留空;
         刚跑过写操作的标签必须回默认 SELECT —— 残留的可能是写语句, 重放就真删了 */
      const remembered = state.result[key] && state.result[key].sql_used;
      const draft = state.draft[key];
      if (stale && table) {
        input.value = defaultSqlFor(key);
      } else if (draft !== undefined) {
        input.value = draft; // 自己写过的 (哪怕是清空) 就照原样恢复
      } else {
        input.value = remembered || (table ? defaultSqlFor(key) : '');
      }
      syncRunTone();
    }
    renderBody();
    if (key === 'stats') refreshStats();   // 统计页签: 切过去才拉一次
    const toIdx = order.indexOf(key);
    const body = $('d1-body');
    if (body && fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
      body.classList.remove('tab-enter-left', 'tab-enter-right');
      void body.offsetWidth;   // 强制回流, 动画才重播
      body.classList.add(toIdx > fromIdx ? 'tab-enter-right' : 'tab-enter-left');
    }
    if (stale && table) {
      delete state.dirty[key];
      run();
    }
  }

  // 跑完写操作: 所有表标签标脏, 但不当场重查 (会冲掉「影响 N 行」那张回执)
  function markTablesDirty() {
    let count = 0;
    state.openTables.forEach((key) => {
      if (tableByName(key)) { state.dirty[key] = true; count += 1; }
    });
    return count;
  }

  /* 结果网格 */
  function cellNode(value) {
    if (value === null || value === undefined) return el('span', 'd1-null', 'NULL');
    if (typeof value === 'number') return el('span', 'd1-num', String(value));
    const text = String(value);
    const span = el('span', 'd1-cell-text', text);
    if (text.length > 40) span.title = text; // 截断的能看到全文
    return span;
  }

  /* 改格子: 右键「编辑」改, 点「运行」才拼 UPDATE (前提 = 表标签 + 有主键, 没主键拼不出 WHERE) */
  function editsOf(key) {
    if (!state.edits[key]) state.edits[key] = {};
    return state.edits[key];
  }

  function editCount(key) {
    const bag = state.edits[key];
    if (!bag) return 0;
    return Object.keys(bag).reduce((n, row) => n + Object.keys(bag[row]).length, 0);
  }

  function pendingCount(key) {
    return editCount(key) + ddlCount(key) + delCount(key) + rowAddCount(key);
  }

  /* 列操作 (表头右键「插入列 / 删除列」): 只记下来, 点「运行」才发 ALTER (ADD COLUMN 只能加到末尾) */
  function ddlOf(key) {
    if (!state.ddl[key]) state.ddl[key] = [];
    return state.ddl[key];
  }

  function ddlCount(key) {
    return (state.ddl[key] || []).length;
  }

  function addDdl(key, sql) {
    ddlOf(key).push(sql);
  }

  function clearDdl(key) {
    if (state.ddl[key]) delete state.ddl[key];
  }

  function buildDdlSql(key) {
    return (state.ddl[key] || []).slice();
  }

  /* 删除行 (排队): 那一行套常量红框并计入「N 处未提交」, 点「运行」才发 DELETE (前提同改格子) */
  function delsOf(key) {
    if (!state.dels[key]) state.dels[key] = {};
    return state.dels[key];
  }

  function delCount(key) {
    return Object.keys(state.dels[key] || {}).length;
  }

  function isRowDeleted(key, rowIdx) {
    const bag = state.dels[key];
    return !!(bag && bag[rowIdx]);
  }

  function clearDels(key) {
    if (state.dels[key]) delete state.dels[key];
  }

  function buildDeleteSql(key) {
    const table = tableByName(key);
    const res = state.result[key];
    const bag = state.dels[key];
    if (!table || !res || !bag) return [];
    const pks = pkNamesOf(table);
    if (!pks.length) return [];
    const out = [];
    Object.keys(bag).forEach((rowIdx) => {
      const row = res.rows[Number(rowIdx)];
      if (!row) return;
      const where = pks.map((name) => {
        const j = res.columns.indexOf(name);
        return quoteIdent(name) + ' = ' + sqlLiteral(j >= 0 ? row[j] : null);
      }).join(' AND ');
      out.push('DELETE FROM ' + quoteIdent(table.name) + '\n WHERE ' + where + ';');
    });
    return out;
  }

  /* 新增行 / 新增列 / 删除列: 列表上先画蓝框红框, 点「运行」才发 INSERT / ALTER */
  function rowAddsOf(key) {
    if (!state.rowAdds[key]) state.rowAdds[key] = [];
    return state.rowAdds[key];
  }
  function rowAddCount(key) { return (state.rowAdds[key] || []).length; }
  function clearRowAdds(key) { if (state.rowAdds[key]) delete state.rowAdds[key]; }

  function colOpsOf(key) {
    if (!state.colOps[key]) state.colOps[key] = { add: [], drop: {} };
    const bag = state.colOps[key];
    if (!bag.add) bag.add = [];
    if (!bag.drop) bag.drop = {};
    return bag;
  }
  function clearColOps(key) { if (state.colOps[key]) delete state.colOps[key]; }
  function isColDropped(key, col) { return !!(state.colOps[key] && state.colOps[key].drop[col]); }
  function addedCols(key) { return (state.colOps[key] && state.colOps[key].add) || []; }

  /* 排队的新增行拼成 INSERT (列名跟着用户填的那几列走) */
  function buildInsertSql(key) {
    const table = tableByName(key);
    const list = state.rowAdds[key];
    if (!table || !list || !list.length) return [];
    return list.map((item) => {
      const cols = item.cols || [];
      return 'INSERT INTO ' + quoteIdent(table.name) + ' (' + cols.map((c) => quoteIdent(c.name)).join(', ') + ')\n VALUES ('
        + cols.map((c) => sqlLiteral(c.value)).join(', ') + ');';
    });
  }

  function pkNamesOf(table) {
    return ((table && table.columns) || []).filter((c) => c.pk).map((c) => c.name);
  }

  function editableGrid() {
    const key = state.active;
    if (key === 'overview') return null;
    const table = tableByName(key);
    const res = state.result[key];
    if (!table || !res || res.error || res.write) return null;
    if (!res.columns || !res.columns.length) return null;
    if (!pkNamesOf(table).length) return null;
    return res;
  }

  function likePk(name) {
    return pkNamesOf(tableByName(state.active)).some((n) => n.toLowerCase() === String(name).toLowerCase());
  }

  function sqlLiteral(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  /* 输入框里的字 → 入库的值: 空 = NULL, 数字列上的数字还是数字, 其余当文本 */
  function coerceEdit(raw, original) {
    const text = String(raw);
    if (text === '') return null;
    if (typeof original === 'number' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  }

  // 把这一批格子改动拼成一条条 UPDATE (一行一条, 模态框里就是多行)
  function buildUpdateSql(key) {
    const table = tableByName(key);
    const res = state.result[key];
    const bag = state.edits[key];
    if (!table || !res || !bag) return [];
    const pks = pkNamesOf(table);
    if (!pks.length) return [];
    const out = [];
    Object.keys(bag).forEach((rowIdx) => {
      const row = res.rows[Number(rowIdx)];
      const cols = bag[rowIdx];
      if (!row || !cols || !Object.keys(cols).length) return;
      if (isRowDeleted(key, rowIdx)) return;   // 整行都要删了, 就别再 UPDATE 它
      const pkLower = pks.map((n) => n.toLowerCase());
      /* 只能设置非主键 (用户 2026-10-01): 主键列只当 WHERE 的依据, 不参与 SET */
      const sets = Object.keys(cols)
        .filter((colIdx) => pkLower.indexOf(String(res.columns[Number(colIdx)]).toLowerCase()) < 0)
        .map((colIdx) => quoteIdent(res.columns[Number(colIdx)]) + ' = ' + sqlLiteral(cols[colIdx]));
      if (!sets.length) return;   // 只动了主键 → 拼不出 SET, 跳过这一行
      const where = pks.map((name) => {
        const j = res.columns.indexOf(name);
        return quoteIdent(name) + ' = ' + sqlLiteral(j >= 0 ? row[j] : null);
      }).join(' AND ');
      out.push('UPDATE ' + quoteIdent(table.name) + '\n   SET ' + sets.join(',\n       ') +
        '\n WHERE ' + where + ';');
    });
    return out;
  }

  /* 改一个格子: 右键「编辑」弹框填新值 (带 fields 的弹窗取值要走 onConfirm, 普通路径只拿到 true) */
  function editCellWithDialog(rowIdx, colIdx) {
    const res = editableGrid();
    if (!res) { showToast('这张表没有主键（或者现在看的是查询结果），不能直接改', 'warn'); return; }
    const colName = res.columns[colIdx];
    if (likePk(colName)) { showToast('主键列不能改（它只当 WHERE 的依据）', 'warn'); return; }
    const original = res.rows[rowIdx][colIdx];
    const isNull = original === null || original === undefined;
    const current = isNull ? '' : String(original);

    const open = () => {
      confirmAction({
        title: '更改数值',
        message: '类型：' + colName,
        confirmText: '确定',
        fields: [{ name: 'value', label: '新值', value: current, placeholder: isNull ? '留空 = NULL' : '' }],
        onConfirm: (values) => {
          const value = coerceEdit((values || {}).value === undefined ? '' : values.value, original);
          const bag = editsOf(state.active);
          const same = value === original || (value === null && isNull);
          if (same) {
            if (bag[rowIdx]) {
              delete bag[rowIdx][colIdx];
              if (!Object.keys(bag[rowIdx]).length) delete bag[rowIdx];
            }
          } else {
            if (!bag[rowIdx]) bag[rowIdx] = {};
            bag[rowIdx][colIdx] = value;
          }
          renderBody();
          syncRunTone();
          return true;
        }
      });
    };

    if (current.length > 50) {
      confirmAction({
        title: '继续？',
        message: '该值的字符过长，确定要更改吗？',
        confirmText: '继续'
      }).then((ok) => { if (ok) open(); });
      return;
    }
    open();
  }

  /* 新建标签页: 只有表卡片开出来的标签自动跑默认查询 (直接 execInto, 与输入框解耦) */
  function autoRunTab(key) {
    const table = tableByName(key);
    if (!table) return;   // 查询标签没有默认语句, 不自动跑
    const sql = defaultSqlFor(table.name);
    const input = sqlInput();
    if (input) { input.value = sql; syncRunTone(); }
    execInto({ sql, write: false, tabKey: key, clearInput: true });
  }

  /* 选中格子 / 复制粘贴 / 列操作: 选中 = 紫框; 行右键立即执行, 表头右键先排队 */
  function selectOf(key) {
    return state.sel[key] || null;
  }

  function currentCell() {
    const mark = selectOf(state.active);
    if (!mark) return null;
    const res = state.result[state.active];
    if (!res || !res.rows || !res.rows[mark.row]) return null;
    return { row: mark.row, col: mark.col, name: res.columns[mark.col], value: res.rows[mark.row][mark.col] };
  }

  function paintSelection() {
    const grid = $('d1-body');
    if (!grid) return;
    const mark = selectOf(state.active);
    grid.querySelectorAll('td.is-selected').forEach((td) => td.classList.remove('is-selected'));
    if (!mark) return;
    const td = grid.querySelector('td[data-r="' + mark.row + '"][data-c="' + mark.col + '"]');
    if (td) td.classList.add('is-selected');
  }

  function selectCell(td, rowIdx, colIdx) {
    if (!td || td.querySelector('input')) return;
    state.sel[state.active] = { row: rowIdx, col: colIdx };
    paintSelection();
  }

  function clearSelection() {
    if (!selectOf(state.active)) return;
    delete state.sel[state.active];
    paintSelection();
  }

  function cellText(row, col) {
    const res = state.result[state.active];
    if (!res || !res.rows[row] || isMaskedColumn(res.columns[col])) return null;
    const bag = state.edits[state.active];
    const value = bag && bag[row] && Object.prototype.hasOwnProperty.call(bag[row], col)
      ? bag[row][col]
      : res.rows[row][col];
    return value === null || value === undefined ? '' : String(value);
  }

  /* 取一个明确指定的格子 (右键菜单传行列号进来; 排队的增删行会让 DOM 行号错位, 不能靠「当前选中格」) */
  function cellAt(row, col) {
    const res = state.result[state.active];
    if (!res || !res.rows || !res.rows[row] || !res.columns[col]) return null;
    return { row: row, col: col, name: res.columns[col], value: res.rows[row][col] };
  }

  async function copyCell(row, col) {
    const cell = (Number.isInteger(row) && Number.isInteger(col)) ? cellAt(row, col) : currentCell();
    if (!cell) { showToast('先点一下要复制的格子', 'warn'); return; }
    const text = cellText(cell.row, cell.col);
    if (text === null) { showToast('这一列是打码内容，不可复制', 'warn'); return; }
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制 ' + cell.name, 'ok');
    } catch (err) {
      showToast('复制失败，请手动选中', 'error');
    }
  }

  async function pasteCell(row, col) {
    const cell = (Number.isInteger(row) && Number.isInteger(col)) ? cellAt(row, col) : currentCell();
    if (!cell) { showToast('先点一下要粘贴到的格子', 'warn'); return; }
    state.sel[state.active] = { row: cell.row, col: cell.col };
    paintSelection();
    if (!editableGrid()) { showToast('这张表没有主键（或者现在看的是查询结果），不能直接改', 'warn'); return; }
    if (likePk(cell.name)) { showToast('主键列不能改（它只当 WHERE 的依据）', 'warn'); return; }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      showToast('读不到剪贴板（浏览器需要授权）', 'error');
      return;
    }
    const original = state.result[state.active].rows[cell.row][cell.col];
    const value = coerceEdit(text, original);
    const bag = editsOf(state.active);
    if (!bag[cell.row]) bag[cell.row] = {};
    bag[cell.row][cell.col] = value;
    renderBody();
    syncRunTone();
    showToast('已粘进 ' + cell.name + '（点「运行」提交）', 'ok');
  }

  // 表头右键 = 列操作 (插入列到列表最后 / 删除这一列)
  function openHeadMenu(event, col) {
    event.preventDefault();
    if (!tableTab()) { showToast('先打开一张表的标签（查询结果不能改结构）', 'warn'); return; }
    showContextMenu(event, [
      {
        label: '插入列',
        hint: '在列表最后',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h9v14H4z"/><path d="M17 9v6M14 12h6"/></svg>',
        onClick: () => promptAddColumn()
      },
      {
        label: '删除列',
        hint: String(col),
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h9v14H4z"/><path d="M14 12h6"/></svg>',
        onClick: () => promptDropColumn(col)
      }
    ]);
  }

  function tableTab() {
    const key = state.active;
    if (key === 'overview') return null;
    const table = tableByName(key);
    const res = state.result[key];
    if (!table || !res || res.error || res.write) return null;
    return table;
  }

  async function promptAddColumn() {
    const table = tableTab();
    if (!table) return;
    const key = state.active;
    await confirmAction({
      title: '插入列',
      message: '新列会加在列表最后（SQLite 只能追加）',
      warning: '',
      confirmText: '插入',
      fields: [{ name: 'name', label: '列名', placeholder: '新列的名字', required: true }],
      onConfirm: (values) => {
        const name = String((values || {}).name || '').trim();
        if (!name) return false;
        const exists = ((table.columns || [])).some((c) => String(c.name).toLowerCase() === name.toLowerCase());
        if (exists) { showToast('已经有这个列了', 'warn'); return false; }
        colOpsOf(key).add.push(name);   // 界面上先长出一列 (蓝框)
        addDdl(key, 'ALTER TABLE ' + quoteIdent(table.name) + ' ADD COLUMN ' + quoteIdent(name) + ' TEXT;');
        renderBody();
        syncRunTone();
        showToast('已排队：新增列 ' + name + '（列表最后 · 蓝框 · 点「运行」提交）', 'ok');
        return true;
      }
    });
  }

  function promptDropColumn(col) {
    const table = tableTab();
    if (!table) return;
    const key = state.active;
    const isPk = pkNamesOf(table).some((n) => n.toLowerCase() === String(col).toLowerCase());
    if (isPk) { showToast('主键列不能删', 'warn'); return; }
    const ops = colOpsOf(key);
    const sql = 'ALTER TABLE ' + quoteIdent(table.name) + ' DROP COLUMN ' + quoteIdent(col) + ';';
    // 再点一次 = 撤销这一列的删除 (标红是可以取消的)
    if (ops.drop[col]) {
      delete ops.drop[col];
      state.ddl[key] = (state.ddl[key] || []).filter((s) => s !== sql);
      renderBody();
      syncRunTone();
      showToast('已撤销删除列 ' + col, 'ok');
      return;
    }
    ops.drop[col] = true;   // 整列套常量红框
    addDdl(key, sql);
    renderBody();
    syncRunTone();
    showToast('已排队：删除列 ' + col + '（整列红框 · 点「运行」提交）', 'ok');
  }

  function openCellMenu(event, td, rowIdx, colIdx) {
    event.preventDefault();
    selectCell(td, rowIdx, colIdx);
    const items = [];
    // 「编辑」只在能改的表上出现 (有主键、看的是表标签), 而且主键列本身不给改
    const canEditGrid = editableGrid();
    if (canEditGrid && !likePk(canEditGrid.columns[colIdx])) {
      items.push({
        label: '编辑',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 5 4 4"/></svg>',
        onClick: () => editCellWithDialog(rowIdx, colIdx)
      });
    }
    items.push(
      {
        label: '复制',
        hint: '⌘ C',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
        onClick: () => copyCell(rowIdx, colIdx)
      },
      {
        label: '粘贴',
        hint: '⌘ V',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4h6v3H9z"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>',
        onClick: () => pasteCell(rowIdx, colIdx)
      },
      '-',
      {
        label: '新增行',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        onClick: () => promptAddRow()
      },
      {
        label: isRowDeleted(state.active, rowIdx) ? '撤销删除' : '删除行',
        hint: '排队',
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
        onClick: () => stageDeleteRow(rowIdx)
      }
    );
    showContextMenu(event, items);
  }

  /* 新增行: 问「主键 + 非空且没默认值的列」的值, 列表上先长一行蓝框
     ⚠️ 以前只问主键**第一列**, 复合主键 / 别的 NOT NULL 列都会当场撞 NOT NULL 报错
     （view_permission.permission 就是这么失败的） */
  async function promptAddRow() {
    const table = tableTab();
    if (!table) { showToast('先打开一张表的标签（查询结果不能加行）', 'warn'); return; }
    const key = state.active;
    const cols = table.columns || [];
    const pks = cols.filter((c) => c.pk);
    if (!pks.length) { showToast('这张表没有主键，加不了行（无法定位唯一一行）', 'warn'); return; }
    // 单个整型主键 = SQLite 的 rowid 别名: 留空让数据库自己发号
    const autoPk = pks.length === 1 && /^\s*integer\s*$/i.test(String(pks[0].type || ''));
    const need = cols.filter((c) => c.pk || (c.notnull && !c.dflt));
    await confirmAction({
      title: '新增一行',
      message: '',
      warning: '',
      confirmText: '确认',
      fields: need.map((c) => ({
        name: 'c:' + c.name,
        // ⚠️ confirmAction 里 label 只在「没写 placeholder」时才当占位字用 ——
        // 列名必须写进 placeholder, 否则两三个框长得一模一样, 根本分不清哪个是哪列
        label: c.name,
        placeholder: c.name + (c.pk ? ' · 主键' : ' · 非空') + ' · '
          + (c.pk && autoPk ? '留空 = 自动编号' : (c.dflt ? '默认 ' + c.dflt : '必填')),
        required: !(c.pk && autoPk)
      })),
      onConfirm: (values) => {
        const picked = [];
        need.forEach((c) => {
          const raw = String((values || {})['c:' + c.name] || '').trim();
          if (raw === '') return;                     // 留空 = 这一列交给数据库 (默认值 / 自增)
          picked.push({ name: c.name, value: coerceNew(raw, c) });
        });
        if (!picked.length) { showToast('至少要填一列的值', 'warn'); return false; }
        const res = state.result[key];
        const firstPk = pks[0].name;
        const head = picked.find((p) => p.name === firstPk);
        let at = res ? res.rows.length : 0;
        if (res && head) {
          const col = res.columns.indexOf(firstPk);
          if (col >= 0) {
            const vals = res.rows.map((r) => r[col]);
            const ascending = vals.every((v, idx) => idx === 0 || String(vals[idx - 1]) <= String(v));
            if (ascending) {
              const hit = vals.findIndex((v) => String(v) > String(head.value));
              at = hit < 0 ? res.rows.length : hit;
            }
          }
        }
        rowAddsOf(key).push({ cols: picked, at });
        renderBody();
        syncRunTone();
        showToast('已排队：新增行（' + picked.map((p) => p.name + '=' + (p.value === null ? 'NULL' : p.value)).join('、')
          + '）· 蓝框 · 点「运行」提交', 'ok');
        return true;
      }
    });
  }

  /* 新行输入框里的字 → 入库的值: 数字列上的数字还是数字, NULL 写 NULL, 其余当文本 */
  function coerceNew(raw, col) {
    if (raw.toUpperCase() === 'NULL') return null;
    if (/int|real|num|dec|double|float/i.test(String(col.type || '')) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }

  /* 右键「删除行」= 排队 (再点一次菜单就撤销这一行) */
  function stageDeleteRow(rowIdx) {
    const key = state.active;
    const res = state.result[key];
    const table = tableByName(key);
    if (!table || !res) return;
    if (!pkNamesOf(table).length) {
      showToast('这张表没有主键，删不了 —— 主键是定位一行的唯一依据', 'warn');
      return;
    }
    const bag = delsOf(key);
    if (bag[rowIdx]) {
      delete bag[rowIdx];
      showToast('已撤销这一行的删除', 'ok');
    } else {
      bag[rowIdx] = true;
      showToast('已标记删除 · 点「运行」提交', 'ok');
    }
    renderBody();
    syncRunTone();
  }

  /* 空表 / 网格空白处的右键: 只给「新增行」—— 没有行可点的时候, 它是唯一的入口。 */
  function openEmptyRowMenu(event) {
    event.preventDefault();
    showContextMenu(event, [{
      label: '新增行',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
      onClick: () => promptAddRow()
    }]);
  }

  /* 打码列右键: 值不给看、不给复制、不给改, 只留「新增行 / 删除行」两个入口 */
  function openMaskedCellMenu(event, rowIdx) {
    event.preventDefault();
    showContextMenu(event, [
      {
        label: '新增行',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        onClick: () => promptAddRow()
      },
      {
        label: isRowDeleted(state.active, rowIdx) ? '撤销删除' : '删除行',
        hint: '排队',
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
        onClick: () => stageDeleteRow(rowIdx)
      }
    ]);
  }

  function resultNode(res) {
    const wrap = el('div', 'd1-grid-wrap');
    /* 网格空白处也右键出同一个菜单; 表格里那格「没有行」(td.d1-empty) 也算 (点在格子 / 表头上时不抢) */
    wrap.addEventListener('contextmenu', (event) => {
      const cell = event.target && event.target.closest ? event.target.closest('td, th') : null;
      if (cell && !cell.classList.contains('d1-empty')) return;
      openEmptyRowMenu(event);
    });
    /* D1 对 0 行结果不回列名: 表标签拿表结构的列名顶上, 查询标签只能给一句提示 */
    if (!res.columns.length) {
      const known = tableByName(state.active);
      if (known && (known.columns || []).length) {
        res = Object.assign({}, res, { columns: known.columns.map((c) => c.name) });
      }
    }
    if (!res.columns.length) {
      const empty = el('p', 'd1-empty', '查询成功，没有返回任何行');
      /* 空表也要能右键 (grid-wrap 挂了同一个菜单, 所以这里要停住冒泡) */
      empty.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
        openEmptyRowMenu(event);
      });
      wrap.appendChild(empty);
      return wrap;
    }
    const canEdit = !!editableGrid();
    const bag = state.edits[state.active] || {};
    const table = el('table', 'd1-grid');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'd1-grid-rownum', '#'));
    res.columns.forEach((col, j) => {
      const th = el('th', null, col);
      th.title = col;
      if (isColDropped(state.active, col)) th.classList.add('is-pending-drop');
      if (!isMaskedColumn(col)) {
        th.oncontextmenu = (event) => openHeadMenu(event, col);
      }
      headRow.appendChild(th);
    });
    addedCols(state.active).forEach((name) => {
      const th = el('th', 'is-pending-col', name);
      th.title = name + '（排队中，点「运行」提交）';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    if (!res.rows.length) {
      const tr = el('tr');
      const td = el('td', 'd1-empty', '没有行');
      td.colSpan = res.columns.length + 1;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    res.rows.forEach((row, i) => {
      const tr = el('tr');
      if (isRowDeleted(state.active, i)) tr.classList.add('is-pending-delete');
      const numTd = el('td', 'd1-grid-rownum', String(i + 1));
      numTd.oncontextmenu = (event) => {
        const first = res.columns.findIndex((c) => !isMaskedColumn(c));
        openCellMenu(event, numTd, i, first < 0 ? 0 : first);
      };
      tr.appendChild(numTd);
      row.forEach((v, j) => {
        const td = el('td');
        const edited = bag[i] && Object.prototype.hasOwnProperty.call(bag[i], j);
        const masked = isMaskedColumn(res.columns[j]);
        td.appendChild(cellNode(edited ? bag[i][j] : v));
        if (edited) {
          td.classList.add('is-edited');
          td.title = '改前: ' + (v === null || v === undefined ? 'NULL' : String(v));
        } else if (canEdit) {
          td.classList.add('is-editable');
        }
        td.dataset.r = String(i);
        td.dataset.c = String(j);
        if (isColDropped(state.active, res.columns[j])) td.classList.add('is-pending-drop');
        if (masked) {
          td.classList.add('is-masked');
          td.title = '打码列, 不能选中';
          td.oncontextmenu = (event) => openMaskedCellMenu(event, i);
        } else {
          td.classList.add('is-selectable');
          td.onclick = () => selectCell(td, i, j);
          td.oncontextmenu = (event) => openCellMenu(event, td, i, j);
        }
        tr.appendChild(td);
      });
      addedCols(state.active).forEach(() => tr.appendChild(el('td', 'is-pending-col', '')));
      tbody.appendChild(tr);
    });
    /* 排队的新增行 → 插一行蓝框 (把填过的列摆在各自的格子里); 它不在 res.rows 里, 不参与数据定位 */
    const stagedRow = (item) => {
      const tr = el('tr', 'is-pending-add');
      tr.appendChild(el('td', 'd1-grid-rownum', '+'));
      const bag = {};
      (item.cols || []).forEach((c) => { bag[c.name] = c.value; });
      res.columns.forEach((col) => tr.appendChild(el('td', null,
        Object.prototype.hasOwnProperty.call(bag, col) ? (bag[col] === null ? 'NULL' : String(bag[col])) : '')));
      addedCols(state.active).forEach(() => tr.appendChild(el('td', 'is-pending-col', '')));
      return tr;
    };
    const adds = state.rowAdds[state.active] || [];
    const stagedByAt = {};
    adds.forEach((item) => {
      const i = Math.max(0, Math.min(Number(item.at) || 0, res.rows.length));
      if (!stagedByAt[i]) stagedByAt[i] = [];
      stagedByAt[i].push(item);
    });
    Object.keys(stagedByAt).forEach((i) => {
      const at = Number(i);
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const before = rows[at];
      stagedByAt[i].forEach((item) => {
        if (before) tbody.insertBefore(stagedRow(item), before);
        else tbody.appendChild(stagedRow(item));
      });
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }

  /* 统计卡片 (Cloudflare GraphQL 分析) */
  function fmtNum(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function statPill(label, value) {
    const p = el('div', 'd1-stat-pill');
    p.appendChild(el('span', 'd1-stat-label', label));
    p.appendChild(el('span', 'd1-stat-value', value));
    return p;
  }

  function statChart(series, lines) {
    const W = 560, H = 130, PAD = 8;
    const max = Math.max(1, ...series.map((s) => Math.max(...lines.map((l) => s[l.key] || 0))));
    const n = series.length;
    const x = (i) => PAD + (n === 1 ? 0 : (i * (W - PAD * 2)) / (n - 1));
    const y = (v) => H - PAD - ((v || 0) / max) * (H - PAD * 2);
    const path = (key) => series.map((s, i) => x(i).toFixed(1) + ',' + y(s[key]).toFixed(1)).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('d1-stats-chart');
    lines.forEach((l) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      p.setAttribute('points', path(l.key));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.classList.add(l.cls);
      svg.appendChild(p);
    });

    const legend = el('div', 'd1-stats-legend');
    lines.forEach((l) => {
      const item = el('span', 'd1-stats-legend-item');
      item.appendChild(el('i', 'dot ' + l.cls));
      item.appendChild(document.createTextNode(l.label));
      legend.appendChild(item);
    });
    const wrap = el('div', 'd1-stats-chart-wrap');
    wrap.appendChild(svg);
    wrap.appendChild(legend);
    return wrap;
  }

  function renderStats(data) {
    const body = document.querySelector('#d1-stats .d1-stats-body');
    if (!body) return;
    body.innerHTML = '';
    if (data.d1_error) {
      body.appendChild(el('p', 'editor-hint', 'D1 用量拿不到：' + data.d1_error));
    } else {
      const totals = data.totals || {};
      const t = el('div', 'd1-stats-totals');
      t.appendChild(statPill('查询', fmtNum(totals.queries)));
      t.appendChild(statPill('读行', fmtNum(totals.rowsRead)));
      t.appendChild(statPill('写行', fmtNum(totals.rowsWritten)));
      body.appendChild(t);
      if ((data.series || []).length) {
        body.appendChild(statChart(data.series, [
          { key: 'rowsRead', cls: 'is-read', label: '读行' },
          { key: 'rowsWritten', cls: 'is-write', label: '写行' }
        ]));
      } else {
        body.appendChild(el('p', 'editor-hint', '这段时间还没有 D1 数据'));
      }
    }

    // 站级独一访问 (Cloudflare zone 数据集; 令牌拿不到就不画, 只留一句为什么)
    const v = data.visitors;
    if (v) {
      const vt = el('div', 'd1-stats-totals');
      vt.appendChild(statPill('独一访问', fmtNum(v.totals && v.totals.uniques)));
      vt.appendChild(statPill('总请求', fmtNum(v.totals && v.totals.requests)));
      body.appendChild(vt);
      if ((v.series || []).length) {
        body.appendChild(statChart(v.series, [{ key: 'uniques', cls: 'is-read', label: '独一访问' }]));
      }
    } else if (data.visitors_error) {
      body.appendChild(el('p', 'editor-hint', '独一访问拿不到：' + data.visitors_error));
    }
  }

  async function refreshStats() {
    const body = document.querySelector('#d1-stats .d1-stats-body');
    if (!body) return;
    body.innerHTML = '';
    body.appendChild(el('p', 'editor-hint', '读取中…'));
    try {
      const response = await fetch('/api/admin/d1/stats?range=' + encodeURIComponent(state.statsRange), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载失败');
      renderStats(data);
    } catch (error) {
      body.innerHTML = '';
      body.appendChild(el('p', 'editor-hint', error.message || '加载失败'));
    }
  }

  function statsCard() {
    const card = el('div', 'd1-stats');
    card.id = 'd1-stats';
    const head = el('div', 'd1-stats-head');
    head.appendChild(el('h3', 'd1-stats-title', '统计'));
    const ranges = el('div', 'd1-stats-ranges');
    [['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']].forEach(([key, label]) => {
      const b = el('button', 'd1-stats-range' + (state.statsRange === key ? ' is-active' : ''), label);
      b.type = 'button';
      b.onclick = () => {
        if (state.statsRange === key) return;
        state.statsRange = key;
        ranges.querySelectorAll('.d1-stats-range').forEach((x) => x.classList.toggle('is-active', x === b));
        refreshStats();
      };
      ranges.appendChild(b);
    });
    head.appendChild(ranges);
    card.appendChild(head);
    const body = el('div', 'd1-stats-body');
    body.appendChild(el('p', 'editor-hint', '读取中…'));
    card.appendChild(body);
    return card;
  }

  function overviewNode() {
    const box = el('div', 'd1-overview');
    const head = el('div', 'd1-overview-head');
    head.appendChild(el('h2', 'd1-overview-title', '表清单'));
    head.appendChild(el('span', 'd1-overview-meta', state.tables.length ? state.tables.length + ' 张表' : ''));
    box.appendChild(head);

    if (!state.tables.length) {
      box.appendChild(el('p', 'editor-hint', state.loading ? '读取中…' : '没有查找到表'));
    } else {
      const grid = el('div', 'd1-table-list');
      state.tables.forEach((t) => {
        const card = el('button', 'd1-table-card');
        card.type = 'button';
        const top = el('div', 'd1-table-card-top');
        top.appendChild(el('span', 'd1-table-name', t.name));
        top.appendChild(el('span', 'd1-table-count', t.columns.length + ' 列'));
        card.appendChild(top);
        const cols = el('div', 'd1-table-cols');
        t.columns.forEach((c, i) => {
          if (i) cols.appendChild(document.createTextNode(' · '));
          cols.appendChild(el('span', c.pk ? 'd1-col is-pk' : 'd1-col', c.name));
        });
        if (!t.columns.length) cols.textContent = '（取不到列）';
        card.appendChild(cols);
        card.onclick = () => openTable(t.name);
        // 右键 = 重命名 / 删除这张表
        card.oncontextmenu = (event) => openCardMenu(event, t.name);
        grid.appendChild(card);
      });
      box.appendChild(grid);
    }

    return box;
  }

  /* 概览卡片右键: 重命名 (ALTER … RENAME TO) / 删除整张表 (DROP, 连数据一起没) / 设定主键
     都走命令行那套: 摊开 SQL 键入 RUN → DROP 再过一道密码 → 服务端要 write:true + 口令, 表名先过本地白名单 */
  const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function openCardMenu(event, tableName) {
    event.preventDefault();
    const table = tableByName(tableName);
    const pk = table ? pkNamesOf(table) : [];
    showContextMenu(event, [
      {
        label: '重命名',
        hint: tableName,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="m14 5 4 4"></path></svg>',
        onClick: () => promptRenameTable(tableName)
      },
      {
        label: '删除这张表',
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"></path></svg>',
        onClick: () => promptDropTable(tableName)
      },
      '-',   // 「设定主键」放最下面, 并用横线隔开
      {
        label: '设定主键',
        hint: pk.length ? '已经有主键' : '选一列',
        disabled: pk.length > 0,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="16" r="4"></circle><path d="m11 13 8-8 2 2-2 2 2 2-3 3-2-2-1 1"></path></svg>',
        onClick: () => promptSetPrimaryKey(tableName)
      }
    ]);
  }

  async function promptRenameTable(tableName) {
    let next = '';
    const ok = await confirmAction({
      title: '重命名这张表',
      message: '把「' + tableName + '」改成：',
      warning: '',
      confirmText: '继续',
      fields: [{ name: 'name', placeholder: '新表名', value: tableName, required: true, maxlength: 64 }],
      onConfirm: (values) => {
        const v = String((values || {}).name || '').trim();
        if (!TABLE_NAME_RE.test(v)) { showToast('表名只能用字母、数字与下划线，且不能以数字开头', 'warn'); return false; }
        if (v === tableName) { showToast('名字没变', 'warn'); return false; }
        if (tableByName(v)) { showToast('已经有一张叫 ' + v + ' 的表了', 'warn'); return false; }
        next = v;
        return true;
      }
    });
    if (!ok || !next) return;
    const sql = 'ALTER TABLE ' + quoteIdent(tableName) + ' RENAME TO ' + quoteIdent(next) + ';';
    if (!(await confirmWrite(sql, { title: '重命名这张表？', confirmText: '重命名' }))) return;
    await applyTableDdl(sql, { done: '已把 ' + tableName + ' 改名为 ' + next, oldName: tableName, newName: next });
  }

  async function promptDropTable(tableName) {
    const sql = 'DROP TABLE ' + quoteIdent(tableName) + ';';
    if (!(await confirmWrite(sql, { title: '删除这张表？', confirmText: '删除' }))) return;
    // 删对象只验密码 (与「删文章 / 删资源」同一档规矩)
    if (!(await verifyOwnerPassword({ methods: ['password'] }))) return;
    await applyTableDdl(sql, { done: '已删除表 ' + tableName, oldName: tableName });
  }

  /* 跑完 DDL 后收尾: 旧标签直接关掉 (列 / 主键 / 缓存全作废), 重命名就打开新表, 其余表标签标脏
     接口一次只吃一条语句, 所以一句一句发 */
  async function applyTableDdl(sql, opts) {
    const options = opts || {};
    const statements = Array.isArray(sql) ? sql : [sql];
    try {
      await withLoading(async () => {
        for (const statement of statements) await execSql(statement, true);
      });
    } catch (error) {
      showToast(error.message || '执行失败', 'error');
      return;
    }
    if (state.openTables.includes(options.oldName)) closeTab(options.oldName);
    await loadTables();
    markTablesDirty();
    if (options.newName) openTable(options.newName);
    else renderBody();
    showToast(options.done || '已执行', 'ok');
  }

  function uniqueTableName(base) {
    let name = base;
    let i = 1;
    while (tableByName(name)) { i += 1; name = base + i; }
    return name;
  }

  /* 设为主键: SQLite 没有「ALTER 加主键」, 只能重建 (建新表 → 抄数据 → 删旧表 → 改名)
     空表直接重建; 有数据的完整 SQL 先摊开看过, 再验一次密码 (这一步真的会 DROP 旧表) */
  async function promptSetPrimaryKey(tableName) {
    const table = tableByName(tableName);
    if (!table) return;
    const existing = pkNamesOf(table);
    if (existing.length) {
      showToast('「' + tableName + '」已经有主键了（' + existing.join(', ') + '）', 'warn');
      return;
    }
    const columns = table.columns || [];
    if (!columns.length) { showToast('读不到这张表的列，先点一下「刷新」', 'warn'); return; }

    let picked = '';
    const ok = await confirmAction({
      title: '设为主键',
      message: '给「' + tableName + '」选一列当主键。\n有主键的表才能在控制台里改行 / 删行。',
      warning: '',
      confirmText: '继续',
      fields: [{
        name: 'col',
        type: 'select',
        placeholder: '选择一列…',
        required: true,
        options: columns.map((c) => ({ value: c.name, label: c.name + (c.type ? '  ·  ' + c.type : '') }))
      }],
      onConfirm: (values) => {
        const v = String((values || {}).col || '').trim();
        if (!v) return false;
        picked = v;
        return true;
      }
    });
    if (!ok || !picked) return;

    // 先看一眼这一列的数据: NULL / 重复都当不了主键 (别等重建到一半才报错)
    let n = 0;
    let nulls = 0;
    let dups = 0;
    try {
      const col = quoteIdent(picked);
      const res = await execSql(
        'SELECT COUNT(*) AS n,'
        + ' SUM(CASE WHEN ' + col + ' IS NULL THEN 1 ELSE 0 END) AS nulls,'
        + ' COUNT(*) - COUNT(DISTINCT ' + col + ') AS dups'
        + ' FROM ' + quoteIdent(tableName), false);
      const row = (res.rows && res.rows[0]) || [];
      const read = (name) => {
        const i = (res.columns || []).indexOf(name);
        return i >= 0 ? (Number(row[i]) || 0) : 0;
      };
      n = read('n');
      nulls = read('nulls');
      dups = read('dups');
    } catch (error) {
      showToast(error.message || '读不出这张表的数据', 'error');
      return;
    }
    if (nulls) { showToast('这一列里有 ' + nulls + ' 行是 NULL —— 主键不能为空，先填上再设', 'warn'); return; }
    if (dups) { showToast('这一列里有 ' + dups + ' 行重复 —— 主键要唯一，先改掉再设', 'warn'); return; }

    const newName = uniqueTableName(tableName + '__pk_new');
    const defs = columns.map((c) => {
      const parts = [quoteIdent(c.name)];
      if (c.type) parts.push(c.type);
      if (c.notnull) parts.push('NOT NULL');
      if (c.dflt !== null && c.dflt !== undefined) parts.push('DEFAULT ' + c.dflt);
      if (c.name === picked) parts.push('PRIMARY KEY');
      return '  ' + parts.join(' ');
    });
    const list = columns.map((c) => quoteIdent(c.name)).join(', ');
    const statements = ['CREATE TABLE ' + quoteIdent(newName) + ' (\n' + defs.join(',\n') + '\n);'];
    if (n > 0) {
      statements.push('INSERT INTO ' + quoteIdent(newName) + ' (' + list + ')'
        + ' SELECT ' + list + ' FROM ' + quoteIdent(tableName) + ';');
    }
    statements.push('DROP TABLE ' + quoteIdent(tableName) + ';');
    statements.push('ALTER TABLE ' + quoteIdent(newName) + ' RENAME TO ' + quoteIdent(tableName) + ';');

    const worked = await confirmWrite(statements.join('\n'), {
      title: n > 0 ? '重建这张表以加上主键？' : '给空表加上主键？',
      confirmText: '重建',
      warning: n > 0
        ? '会新建一张带主键的表、把 ' + n + ' 行抄过去，然后删掉旧表 —— 旧表上的索引 / 触发器会一起没掉（要的话重建后再建）'
        : '空表重建，没有数据会丢'
    });
    if (!worked) return;
    // 有数据 = 真的要 DROP 旧表 → 再过一道密码 (与删表同一档规矩)
    if (n > 0 && !(await verifyOwnerPassword({ methods: ['password'] }))) return;
    await applyTableDdl(statements, {
      done: '已把 ' + picked + ' 设为主键' + (n > 0 ? '（重建了 ' + n + ' 行）' : ''),
      oldName: tableName,
      newName: tableName
    });
  }

  /* 网格每次操作都整个重建 (滚动位置会归零), 所以外面包一层记住 .d1-grid-wrap 的滚动位置 */
  function renderBody() {
    const body = $('d1-body');
    const before = body ? body.querySelector('.d1-grid-wrap') : null;
    const keepTop = before ? before.scrollTop : 0;
    const keepLeft = before ? before.scrollLeft : 0;
    renderBodyInner();
    const after = body ? body.querySelector('.d1-grid-wrap') : null;
    if (after && (keepTop || keepLeft)) {
      after.scrollTop = keepTop;
      after.scrollLeft = keepLeft;
    }
  }

  function renderBodyInner() {
    const body = $('d1-body');
    const status = $('d1-status');
    if (!body) return;
    body.innerHTML = '';
    if (status) { status.textContent = ''; status.className = 'd1-status'; }
    const exportBtn = $('d1-export');
    if (exportBtn) exportBtn.disabled = true;
    const revertBtn = $('d1-revert');
    if (revertBtn) revertBtn.hidden = !(state.active !== 'overview' && pendingCount(state.active) > 0);

    if (state.active === 'overview') {
      body.appendChild(overviewNode());
      return;
    }
    if (state.active === 'stats') {
      body.appendChild(statsCard());
      return;
    }

    const res = state.result[state.active];
    // 还没跑过的标签就留空白 (不要「点「运行」跑一下上面这条 SQL」那种提示)
    if (!res) return;
    if (res.error) {
      const box = el('div', 'd1-error');
      box.appendChild(el('p', 'd1-error-title', '执行失败'));
      box.appendChild(el('pre', 'd1-error-body', res.error));
      body.appendChild(box);
      if (status) { status.textContent = '失败'; status.className = 'd1-status is-error'; }
      return;
    }
    if (res.write) {
      const done = el('div', 'd1-done');
      done.appendChild(el('p', 'd1-done-title', '写操作已提交'));
      done.appendChild(el('p', 'd1-done-body', [
        '影响 ' + (res.changes || 0) + ' 行',
        res.last_row_id ? '最后插入 id ' + res.last_row_id : '',
        res.columns && res.columns.length ? '（下面是 RETURNING 的结果）' : ''
      ].filter(Boolean).join(' · ')));
      const staleCount = state.openTables.filter((k) => tableByName(k) && state.dirty[k]).length;
      if (staleCount) {
        done.appendChild(el('p', 'd1-done-note',
          staleCount + ' 个表标签的数据已过期（切过去了会自动重新查询）'));
      }
      body.appendChild(done);
      if (res.columns && res.columns.length) body.appendChild(resultNode(res));
      if (exportBtn) exportBtn.disabled = !res.rows.length;
      if (status) {
        status.className = 'd1-status';
        status.textContent = '已执行 · 影响 ' + (res.changes || 0) + ' 行 · ' + (res.duration_ms || 0) + ' ms';
      }
      paintPending(status);
      return;
    }
    body.appendChild(resultNode(res));
    paintSelection();
    if (exportBtn) exportBtn.disabled = !res.rows.length;
    if (status) {
      status.className = 'd1-status';
      status.textContent = [
        'ok',
        res.rows.length + ' 行',
        (res.duration_ms || 0) + ' ms',
        res.truncated ? '已截断 · 可能还有更多（把行数调大或加点 WHERE）' : ''
      ].filter(Boolean).join(' · ');
    }
    paintPending(status);
  }

  // 状态行尾巴补一句「N 处未提交」
  function paintPending(status) {
    const pending = state.active === 'overview' ? 0 : pendingCount(state.active);
    if (!status || !pending || !status.textContent) return;
    status.classList.add('is-dirty');
    status.textContent += ' · ' + pending + ' 处未提交的改动（点「运行」提交）';
  }

  /* 运行 */
  /* SQL 高亮 (复用文章页的 highlight.js, 没加载就退回纯文本), 返回每行一段 HTML */
  function sqlHtml(sql) {
    if (typeof highlightLines === 'function') return highlightLines(sql, 'sql').join('\n');
    return escapeHtml(sql);
  }

  /* 要密码的危险语句: DROP TABLE / DATABASE / INDEX / VIEW / TRIGGER (不含 ALTER … DROP COLUMN) */
  function needsOwnerPassword(sql) {
    return /\bdrop\s+(table|database|index|view|trigger)\b/i.test(String(sql || ''));
  }

  // 写操作要像 GitHub 删仓库那样把 RUN 打一遍 (口令服务端也验, 这里只是防误点)
  async function confirmWrite(sql, options) {
    const opts = options || {};
    // 没写 WHERE 的 UPDATE / DELETE = 动整张表, 单独再提醒一句
    const wholeTable = /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(stripLiterals(sql));
    return confirmAction({
      title: opts.title || '执行写操作？',
      message: '',
      // 用 <span> 不用 <pre>: confirmAction 把 messageHtml 塞进 <p>, 块级元素会被浏览器拆开
      messageHtml: '<span class="d1-confirm-sql is-code">' + sqlHtml(sql) + '</span>',
      warning: opts.warning || (wholeTable
        ? '这句没有 WHERE —— 会改动整张表，且无法撤销'
        : '这会真的改动数据库，且无法撤销'),
      confirmText: opts.confirmText || '执行',
      danger: true,
      requireText: WRITE_CONFIRM,
      requireTextIgnoreCase: true,
      inputLabel: '键入 ' + WRITE_CONFIRM + ' 确认'
    });
  }

  /* 改动 → 锁定命令行并填成「将要执行的 SQL」; 取消更改 / 提交完再把用户原本写的还原 */
  function composePendingSql(key) {
    return buildUpdateSql(key).concat(buildDdlSql(key)).join('\n');
  }

  function syncRunTone() {
    const btn = $('d1-run');
    const input = sqlInput();
    const pending = state.active !== 'overview' ? pendingCount(state.active) : 0;
    const write = !!(input && isWriteSql(input.value));
    if (btn) {
      btn.classList.toggle('is-write', !!pending || write);
      btn.title = pending ? '有 ' + pending + ' 处改动还没提交' : '';
    }
    /* 改了格子但没提交 → 锁住命令行, 直到取消更改或提交 (否则命令行与待提交改动会打架) */
    if (input) {
      const locked = !!pending;
      /* readOnly 而不是 disabled: 锁着也要能选中里面的 SQL */
      input.readOnly = locked;
      input.title = locked ? '有未提交的改动 —— 先「取消更改」或点「运行」提交' : '';
      const frozen = state.frozen && state.frozen.key === state.active ? state.frozen : null;
      if (locked && !frozen) {
        state.frozen = { key: state.active, saved: input.value };
        input.value = composePendingSql(state.active);
      } else if (!locked && frozen) {
        input.value = state.frozen.saved;   // 还原用户自己写的
        state.frozen = null;
      }
    }
    const revert = $('d1-revert');
    if (revert) revert.hidden = !pending;
  }

  // 一个 POST 封装 (提交格子改动要连发好几条, 别再抄一遍 fetch)
  async function execSql(sql, write) {
    const response = await fetch('/api/admin/d1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(write
        ? { sql, limit: state.limit, write: true, confirm: WRITE_CONFIRM }
        : { sql, limit: state.limit }),
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }

  async function run() {
    /* 有未提交的改动 → 这一下「运行」先去提交 (要用 pendingCount, 只排了列操作时 editCount 是 0) */
    if (state.active !== 'overview' && pendingCount(state.active)) { commitEdits(); return; }

    const input = sqlInput();
    if (!input) return;
    const sql = input.value.trim();
    if (!sql) { showToast('命令行是空的', 'warn'); return; }

    const write = isWriteSql(sql);
    if (write && !(await confirmWrite(sql))) return;
    // DROP = 要密码 (与「删文章 / 删资源」同一档, 卡片右键的删表走的也是这一套)
    if (needsOwnerPassword(sql) && !(await verifyOwnerPassword({ methods: ['password'] }))) return;

    if (state.active === 'overview' || state.active === 'stats') {
      let target = lastQueryKey();
      if (!target) {
        target = newQueryKey();
        state.openTables.push(target);
        state.result[target] = null;
      }
      state.active = target;
      renderTabbar();
    }

    // 先定下来这次要写进哪个标签: confirmWrite 是异步的, 期间用户可能切走
    const tabKey = state.active;
    await withLoading(() => execInto({ sql, write, tabKey, clearInput: false }));
  }

  /* 跑的时候锁住命令行 (readOnly 不用 disabled, 锁着也要能选中文字) */
  function lockSqlInput(on) {
    const input = sqlInput();
    if (input) input.readOnly = !!on;
  }

  /* 跑 SQL 期间锁住整块面板: 「取消更改」置灰 + 面板不吃点击。
     运行中再改格子/排操作的话, 回来那份待提交清单就与刚执行过的库对不上了 */
  function lockD1Ui(on) {
    const box = document.querySelector('.d1-console');
    if (box) box.classList.toggle('is-running', !!on);
    const revert = $('d1-revert');
    if (revert) {
      revert.disabled = !!on;
      revert.title = on ? '正在执行，请稍候' : '';
    }
  }

  /* 跑一句 SQL 并把结果落进 tabKey (clearInput = 跑完擦掉命令行) */
  async function execInto(job) {
    const btn = $('d1-run');
    if (btn) { btn.disabled = true; btn.textContent = '运行中…'; }
    lockD1Ui(true);
    lockSqlInput(true);
    const status = $('d1-status');
    if (status) { status.className = 'd1-status'; status.textContent = '运行中…'; }
    try {
      const data = await execSql(job.sql, job.write);
      data.sql_used = job.sql;
      data.write = job.write;
      state.result[job.tabKey] = data;
      pushHistory(job.sql);
      if (job.write) {
        showToast('写操作已提交 · 影响 ' + (data.changes || 0) + ' 行', 'ok');
      }
    } catch (error) {
      // 报错也要记住 sql_used: 不然切走再切回来, 输入框里的 SQL 会被重置成默认那句
      state.result[job.tabKey] = {
        error: error.message, columns: [], rows: [], sql_used: job.sql, write: job.write
      };
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '运行'; }
      lockD1Ui(false);
      lockSqlInput(false);   // 解锁; 真要还有未提交的改动, 下面的 syncRunTone 会再锁回去
      if (job.clearInput) {
        const input = sqlInput();
        if (input) input.value = '';
      }
      if (job.write && !(state.result[job.tabKey] || {}).error) {
        markTablesDirty();
        // 建表 / 删表 / 改表 → 概览那份表清单也不准了, 顺手重新拉一遍
        if (/\b(create|drop|alter|reindex|vacuum)\b/i.test(stripLiterals(job.sql))) loadTables();
      }
      syncRunTone();
      renderBody();
    }
  }

  /* 提交改动: 攒下的 UPDATE / DELETE / INSERT / DDL 摊在弹窗里, 确认后一条条发, 发完重跑当前查询 */
  async function commitEdits() {
    const key = state.active;
    const hadDdl = ddlCount(key) > 0;
    const delNow = delCount(key);
    const addNow = rowAddCount(key);
    const statements = buildUpdateSql(key).concat(buildDeleteSql(key))
      .concat(buildInsertSql(key)).concat(buildDdlSql(key));
    if (!statements.length) {
      showToast('这些改动拼不出语句（这张表没有主键？）', 'warn');
      return;
    }
    const batch = statements.join('\n');
    const ok = await confirmWrite(batch, {
      title: '提交 ' + pendingCount(key) + ' 处改动？',
      confirmText: '提交'
    });
    if (!ok) return;

    if (statements.some(needsOwnerPassword) && !(await verifyOwnerPassword())) return;

    const btn = $('d1-run');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    lockD1Ui(true);
    lockSqlInput(true);
    let changes = 0;
    try {
      for (const statement of statements) {
        const data = await execSql(statement, true);
        changes += data.changes || 0;
      }
      clearEdits(key);
      clearDdl(key);
      clearDels(key);
      clearRowAdds(key);
      clearColOps(key);
      const tableNow = tableByName(key);
      const tName = (tableNow && tableNow.name) || '这张表';
      const parts = [];
      if (delNow) parts.push('已删除 ' + tName + ' 的 ' + delNow + ' 行');
      if (addNow) parts.push('已新增 ' + tName + ' 的 ' + addNow + ' 行');
      if (!parts.length) parts.push('已提交 ' + statements.length + ' 条语句 · 影响 ' + changes + ' 行');
      else if (statements.length > delNow + addNow) parts.push('另有 ' + (statements.length - delNow - addNow) + ' 条改动');
      showToast(parts.join(' · '), 'ok');
      markTablesDirty();
      delete state.dirty[key];
      if (hadDdl) {
        // 表结构变了 (列会变) → 重拉表清单再回到这个标签 (不自动重跑, 刚删的列可能就在 SELECT 里)
        await loadTables();
        activateTab(key);
      } else {
        const used = (state.result[key] || {}).sql_used;
        if (used) {
          await execInto({ sql: used, write: false, tabKey: key, clearInput: false });
        } else {
          activateTab(key);
        }
      }
    } catch (error) {
      showToast(error.message || '提交失败', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '运行'; }
      lockD1Ui(false);
      lockSqlInput(false);
      syncRunTone();
      renderBody();
    }
  }

  function clearEdits(key) {
    if (state.edits[key]) delete state.edits[key];
  }

  /* 刷新: 概览页重拉表清单, 别的标签重跑 sql_used 那句 (不看命令行, 别覆盖人写了一半的 SQL);
     上次跑的是写操作就不默默重放 (重放一条 DELETE 是二次事故)
     取消更改: 丢掉改过的格子与排队的列操作 (库里一点没动) */
  async function refresh() {
    if (state.active === 'stats') {
      refreshStats();
      showToast('统计已刷新', 'ok');
      return;
    }
    if (state.active === 'overview') {
      await loadTables();
      renderBody();
      showToast('概览已刷新', 'ok');
      return;
    }
    const res = state.result[state.active];
    const sql = res && res.sql_used;
    if (!sql) { showToast('还没有可以重跑的查询', 'warn'); return; }
    /* 写语句退回默认 SELECT 再查 (就是切页签那套: 标脏 + activateTab) */
    if (res.write) {
      const table = tableByName(state.active);
      if (table) {
        state.dirty[state.active] = true;
        activateTab(state.active);
        showToast('已回到这张表的默认查询', 'ok');
      } else {
        // 查询标签: 把那句写语句从输入框里清掉, 别留着被人手滑重放
        state.draft[state.active] = '';
        const input = sqlInput();
        if (input) input.value = '';
        loadTables();
        showToast('写语句不会重放 —— 输入框已清空', 'ok');
      }
      return;
    }
    await execInto({ sql, write: !!res.write, tabKey: state.active, clearInput: false });
  }

  function revertChanges() {
    const key = state.active;
    if (!pendingCount(key)) return;
    clearEdits(key);
    clearDdl(key);
    clearDels(key);
    clearRowAdds(key);
    clearColOps(key);
    showToast('已取消未提交的改动', 'ok');
    renderBody();
    syncRunTone();
  }

  /* 输入框: 历史与快捷键 */
  let historyCursor = -1;

  function onInputKey(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
      return;
    }
    /* 命令行里直接回车 = 运行 (空的时候不动, 免得误弹一个「先写一句 SQL」) */
    if (event.key === 'Enter' && !event.shiftKey) {
      if (String(event.target.value || '').trim()) {
        event.preventDefault();
        run();
      }
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!state.history.length) return;
    if (event.key === 'ArrowUp') {
      historyCursor = Math.min(state.history.length - 1, historyCursor + 1);
    } else {
      historyCursor = Math.max(-1, historyCursor - 1);
    }
    event.preventDefault();
    event.target.value = historyCursor < 0 ? '' : state.history[historyCursor];
    syncRunTone(); // 翻出来的语句可能是个写操作, 按钮颜色要跟着变
  }

  /* 表清单 */
  async function loadTables() {
    state.loading = true;
    renderPicker();
    try {
      const response = await fetch('/api/admin/d1/tables', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '读取表清单失败');
      state.tables = data.tables || [];
    } catch (error) {
      showToast(error.message, 'error');
      state.tables = [];
    } finally {
      state.loading = false;
      renderPicker();
      if (state.active === 'overview') renderBody();
    }
  }

  /* 初始化 (个人页切到 D1 页签时调) */
  function open() {
    if (state.inited) { renderTabbar(); return; }
    state.inited = true;
    loadHistory();
    const input = sqlInput();
    if (input) {
      input.addEventListener('keydown', onInputKey);
      input.addEventListener('input', syncRunTone);
    }
    const add = $('d1-tab-add');
    if (add) add.onclick = () => togglePicker();
    const runBtn = $('d1-run');
    if (runBtn) runBtn.onclick = () => run();
    const reloadBtn = $('d1-reload');
    if (reloadBtn) reloadBtn.onclick = () => refresh();
    const revertBtn = $('d1-revert');
    if (revertBtn) revertBtn.onclick = () => revertChanges();
    const limitSel = $('d1-limit');
    if (limitSel) {
      limitSel.value = String(state.limit);
      limitSel.onchange = () => {
        state.limit = parseInt(limitSel.value, 10) || 50;
      };
    }
    renderTabbar();
    renderBody();
    syncRunTone();
    loadTables();
  }

  // 点别处关掉「打开表」面板
  document.addEventListener('click', (event) => {
    if (!state.pickerOpen) return;
    const picker = $('d1-picker');
    const add = $('d1-tab-add');
    if (picker && picker.contains(event.target)) return;
    if (add && add.contains(event.target)) return;
    state.pickerOpen = false;
    renderPicker();
    renderTabbar();
  });

  /* 点表格以外的地方取消选中 (用 mousedown 才能连右键、拖拽前的按下都算上) */
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const grid = $('d1-body');
    if (grid && grid.contains(event.target)) return;
    clearSelection();
  });

  /* 格子上的 Ctrl/⌘ + C / V (右键菜单里那两项的快捷键) */
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const grid = $('d1-body');
    if (!grid || !grid.querySelector('td.is-selected')) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'c') { event.preventDefault(); copyCell(); }
    else if (key === 'v') { event.preventDefault(); pasteCell(); }
  });

  window.d1Console = { open };
})();
