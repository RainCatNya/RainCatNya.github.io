function initModal() {
  // 初始化模态框
  // 识别所有添加了dialog-inf的对象, 在其触发时显示模态框
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay || !content) return;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.querySelectorAll('[dialog]').forEach((el) => {
  el.addEventListener('click', async () => {          
  overlay.classList.add('show');
    });
  });
}
function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('show');
  document.getElementById('modal-content').innerHTML = "<font style='color:#6C6C6C'>..." // 重置文本
}

// 页面加载时方法
document.addEventListener('DOMContentLoaded', () => {
  initModal();
});

async function dialog_setText(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const text = await response.text();
  document.getElementById('modal-content').innerHTML = text
}