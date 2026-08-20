// Skills API — #278（决策 #250 D2）：retract_confirm 卡退役决策
import { api } from './index';

export const skillsApi = {
  /** retract_confirm 卡决策：confirm → deprecated、reject → 恢复 published；messageId 用于同步回写卡片状态 */
  retractDecide: (skillId: string, decision: 'confirm' | 'reject', messageId?: string) =>
    api.post<{ data: { id: string; status: string } }>(
      `/skills/${skillId}/retract/decide`,
      { decision, ...(messageId ? { messageId } : {}) }
    ),
};
