// 浏览器原生通知（#523 P0-3 人闸催办/认领滞留 tier1 出声面之一，零配置保底）。
// 权限三态：granted → 直接 new Notification；default → 不主动弹权限请求（浏览器要求
// 用户手势），由调用方在既有手势（首次点开铃铛面板）里调 requestBrowserNotificationPermission；
// denied / 环境无 Notification → 静默跳过。抽成 util 便于单测（mock global Notification）。

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

/** 当前权限；环境无 Notification API（老浏览器/非安全上下文）→ 'unsupported' */
export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** granted 时弹一条系统级通知；其余一律静默。返回是否已弹。构造异常同样静默（部分平台限制） */
export function showBrowserNotification(title: string, body: string): boolean {
  if (getBrowserNotificationPermission() !== 'granted') return false;
  try {
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** default 时请求权限——必须在用户手势回调内调用（否则浏览器直接拒绝/忽略） */
export function requestBrowserNotificationPermission(): void {
  if (getBrowserNotificationPermission() !== 'default') return;
  // 权限请求失败（用户关闭弹窗等）不影响主流程
  void Notification.requestPermission().catch(() => { /* 静默 */ });
}
