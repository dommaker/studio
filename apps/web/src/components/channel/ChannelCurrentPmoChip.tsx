// #272（决策 #251 Q6）：顶栏「当前 PMO」chip。
// 派生概念不落库：GET /channels/:id/current-pmo（最近挂接 REQ 所属 PMO / 杂务 PMO 反推）。
// 点击跳项目页；多仓 PMO 只显名称，hover tooltip 列 gitRepos；派生为 null 不渲染。
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { channelApi, type ChannelCurrentPmo } from '../../api/channel';

interface ChannelCurrentPmoChipProps {
  channelId: string;
}

export const ChannelCurrentPmoChip: React.FC<ChannelCurrentPmoChipProps> = ({ channelId }) => {
  const [pmo, setPmo] = useState<ChannelCurrentPmo | null>(null);
  const navigate = useNavigate();
  // 频道切换时清旧 chip——渲染期间调整（免 effect 内同步 setState 级联渲染）
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (channelId !== prevChannelId) {
    setPrevChannelId(channelId);
    setPmo(null);
  }

  useEffect(() => {
    let alive = true;
    channelApi.getCurrentPmo(channelId)
      .then(res => { if (alive) setPmo(res.data.data ?? null); })
      .catch(() => {});
    return () => { alive = false; };
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
