// 系统角色身份断言（web 侧，#631）——与服务端 agents/system-role.ts 同口径：
// kind 直读；历史无 kind 字段的记录按 name==='studio' 兜底一次。
import type { AgentProfile } from '../api/channel';

export function isSystemRole(profile: Pick<AgentProfile, 'name' | 'kind'>): boolean {
  return profile.kind === 'system' || (profile.kind === undefined && profile.name === 'studio');
}
