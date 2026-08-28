function Verify_AccessDevice(link="./Html/AccessDenied.html?reason=mobile") {
    /* 检查访问网页的系统 */
    var system = {};
    var p = navigator.platform;
    system.win = p.indexOf("Win") == 0;
    system.mac = p.indexOf("Mac") == 0;
    system.x11 = (p == "X11") || (p.indexOf("Linux") == 0);
    if (system.win || system.mac || system.xll) {} else {  
    window.location.href = link;
    }
}

async function fill_text(id, url, read = 'all', html = true) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`未找到元素：#${id}`);
    return;
  }

  const mode = String(read || 'all').toLowerCase();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const text = await response.text();

    if (mode === 'line') {
      // 按行拆分，过滤空白行
      const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');

      if (lines.length === 0) {
        element.innerHTML = '';
        return;
      }

      const randomIndex = Math.floor(Math.random() * lines.length);
      const content = lines[randomIndex];

      if (html) {
        // 作为 HTML 渲染
        element.innerHTML = content;
      } else {
        // 作为纯文本显示
        element.textContent = content;
      }
      return;
    }

    // all 模式
    if (html) {
      // 作为 HTML 渲染，换行转为 <br>
      element.innerHTML = text.replace(/\r?\n/g, '<br>');
    } else {
      // 作为纯文本显示，换行转为 <br>（先转义再替换换行）
      element.innerHTML = escapeHtml(text).replace(/\r?\n/g, '<br>');
    }
  } catch (error) {
    console.error('加载文件内容失败：', error);
  }
}

// 辅助方法：转义 HTML，避免内容被当作标签执行
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}


function copyToClip(id) {
  // 将id所含文本粘贴到剪贴板
  var copyText = document.getElementById(id);
  copyText.select();
  copyText.setSelectionRange(0, 99999); /* 为移动设备设置 */
  navigator.clipboard.writeText(copyText.value);
}