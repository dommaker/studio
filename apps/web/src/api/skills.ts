// Skills API — #278（决策 #250 D2）：retract_confirm 卡退役决策
import { api } from './index';

/** #462: skills MANIFEST 条目（角色编辑 skill 多选候选；loop-consumer 已被服务端过滤） */
export interface SkillManifestEntry {
  name: string;
  description: string;
  agentTypes: string[];
  triggers: string[];
}

export const skillsApi = {
  /** retract_confirm 卡决策：confirm → deprecated、reject → 恢复 published；
   *  messageId 用于同步回写卡片状态；channelId（#524 P1-1）让回写按频道直查免全频道扇出 */
  retractDecide: (skillId: string, decision: 'confirm' | 'reject', messageId?: string, channelId?: string) =>
    api.post<{ data: { id: string; status: string } }>(
      `/skills/${skillId}/retract/decide`,
      { decision, ...(messageId ? { messageId } : {}), ...(channelId ? { channelId } : {}) }
    ),

  /** #462: skills MANIFEST 只读清单（角色编辑 UI 的 skill 多选数据源） */
  listManifest: () => api.get<{ data: SkillManifestEntry[] }>('/skills/manifest'),
};
