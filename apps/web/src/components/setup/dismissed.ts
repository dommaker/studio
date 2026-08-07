// 角色配置引导弹框的会话级 dismiss 标记（sessionStorage key 与检查函数；
// 从 StudioRoleSetupModal / FirstRoleSetupModal 拆出，弹框组件写标记、App 读标记共用同一 key）

export const STUDIO_ROLE_SETUP_SESSION_KEY = 'studio-role-setup-dismissed';
export const FIRST_ROLE_SETUP_SESSION_KEY = 'first-role-setup-dismissed';

/** 检查本次会话是否已dismiss */
export function isStudioRoleSetupDismissed(): boolean {
  try { return sessionStorage.getItem(STUDIO_ROLE_SETUP_SESSION_KEY) === '1'; } catch { return false; }
}

export function isFirstRoleSetupDismissed(): boolean {
  try { return sessionStorage.getItem(FIRST_ROLE_SETUP_SESSION_KEY) === '1'; } catch { return false; }
}
