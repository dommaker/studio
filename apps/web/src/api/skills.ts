// Skills API — #278（决策 #250 D2）：retract_confirm 卡退役决策
// 契约驱动迁移（2026-10 批次 3/7）：SkillManifestEntry 手抄删除改 contract import；
// retractDecide 响应类型改契约 Skill 投影（{ data } 壳原已带，解包不变）。
import type { Skill, SkillManifestEntry } from '@dommaker/studio-contract';
import { api } from './index';

export type { SkillManifestEntry };

export const skillsApi = {
  /** retract_confirm 卡决策：confirm → deprecated、reject → 恢复 published；
   *  messageId 用于同步回写卡片状态；channelId（#524 P1-1）让回写按频道直查免全频道扇出 */
  retractDecide: (skillId: string, decision: 'confirm' | 'reject', messageId?: string, channelId?: string) =>
    api.post<{ data: Pick<Skill, 'id' | 'status'> }>(
      `/skills/${skillId}/retract/decide`,
      { decision, ...(messageId ? { messageId } : {}), ...(channelId ? { channelId } : {}) }
    ),

  /** #462: skills MANIFEST 只读清单（角色编辑 UI 的 skill 多选数据源） */
  listManifest: () => api.get<{ data: SkillManifestEntry[] }>('/skills/manifest'),
};
