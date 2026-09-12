// 浏览器原生通知（#523 P0-3 人闸催办/认领滞留 tier1 出声面之一，零配置保底）。
// 权限三态：granted → 直接 new Notification；default → 不主动弹权限请求（浏览器要求
// 用户手势），由调用方在既有手势（首次点开铃铛面板）里调 requestBrowserNotificationPermission；
// denied / 环境无 Notification → 静默跳过。抽成 util 便于单测（mock global Notification）。

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

// #525 P2-6：浏览器通知总开关（设置页「通知渠道」区读写；localStorage 持久化，缺省开）
const ENABLED_KEY = 'studio:browser-notifications-enabled';

/** 是否启用浏览器通知（缺省开；localStorage 不可用/读取失败视为开，不阻断既有通知路径） */
export function isBrowserNotificationEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** 持久化开关状态；写入失败（隐私模式等）静默，仅本次会话不生效 */
export function setBrowserNotificationEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
  } catch { /* 静默 */ }
}

/** 当前权限；环境无 Notification API（老浏览器/非安全上下文）→ 'unsupported' */
export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** granted 时弹一条系统级通知；其余一律静默。返回是否已弹。构造异常同样静默（部分平台限制） */
export function showBrowserNotification(title: string, body: string): boolean {
  if (!isBrowserNotificationEnabled()) return false; // #525 P2-6 总开关关闭 → 静默
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
