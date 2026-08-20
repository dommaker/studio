// 复制文本到剪贴板：navigator.clipboard 优先，execCommand 降级；
// 都不可用则静默（调用方各自决定反馈 UI）。（#271 从 FileRefChip 提取共用）
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 走 execCommand 降级
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    // 剪贴板不可用时静默
  }
}
