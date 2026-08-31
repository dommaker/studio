// #272（决策 #251 Q6）：顶栏「当前 PMO」chip。
// 派生概念不落库：GET /channels/:id/current-pmo（最近挂接 REQ 所属 PMO / 杂务 PMO 反推）。
// #403：数据面上移 channelDataStore（同端点多组件订阅共享一份拉取）；REQ 变更的失效在页面事件接线。
// 点击跳项目页；多仓 PMO 只显名称，hover tooltip 列 gitRepos；派生为 null 不渲染。
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannelDataStore } from '../../stores/channelDataStore';

interface ChannelCurrentPmoChipProps {
  channelId: string;
}

export const ChannelCurrentPmoChip: React.FC<ChannelCurrentPmoChipProps> = ({ channelId }) => {
  // 缺键（未拉到，含失败）与 null（后端派生为空）都渲染 null——订阅值随频道切换自动跟随
  const pmo = useChannelDataStore((s) => s.currentPmo[channelId] ?? null);
  const navigate = useNavigate();

  useEffect(() => {
    void useChannelDataStore.getState().ensureCurrentPmo(channelId);
  }, [channelId]);

  if (!pmo) return null;

  const tooltip = pmo.gitRepos.length > 0
    ? `${pmo.title}\n${pmo.gitRepos.join('\n')}`
    : pmo.title;

  return (
    <button
      type="button"
      className="mc-btn mc-pmo-chip"
      title={tooltip}
      onClick={() => navigate(`/pmo/project/${pmo.id}`)}
    >
      PMO · {pmo.title}
    </button>
  );
};
