/**
 * 系统角色身份断言（#631）——「是不是系统角色」的唯一判定点。
 *
 * 此前靠 `name === 'studio'` 字符串比较散在 6+ 处（service 过滤/保留名/禁停用/禁删、
 * message-routing、rosterStore、RoleCard、App、default-provider），新增系统角色要改一片。
 * 现在身份由 AgentProfileData.kind 承载（'system' | 'user'），本模块收口判定：
 * kind 直读；历史无 kind 字段的记录按 name==='studio' 兜底一次。
 *
 * P2-c 自 modules/agents/system-role.ts 下沉 core/：纯原语（常量 + 判定函数），
 * agents 与 channels 双方消费——跨模块共享叶子不该挂在一个域模块里（会拉成互耦对）。
 * agents 内部各消费方经 modules/agents/system-role.ts 门面转介，路径不变。
 */

import type { AgentProfileData } from '@dommaker/studio-shared';

/** 保留角色名：系统内置 studio 角色专用，用户不可创建/改名为此 */
export const STUDIO_ROLE_NAME = 'studio';

/** 系统角色判定：kind='system' → true；历史无 kind 记录按 name==='studio' 兜底 */
export function isSystemRole(profile: Pick<AgentProfileData, 'name'> & { kind?: AgentProfileData['kind'] }): boolean {
  return profile.kind === 'system' || (profile.kind === undefined && profile.name === STUDIO_ROLE_NAME);
}
