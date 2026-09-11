// #393 频道首页重定向 — `/` 与 `/channels` 唯一入口（频道列表页已删除，spec §2）
// 落点决策在 utils/lastChannel.resolveChannelHome：最近访问 → rnd 默认 → 首频道；
// 零频道时渲染空态 + CreateChannelForm（无列表页可回，创建即进工作区）
import { Navigate, useNavigate } from 'react-router-dom';
import { useChannelList } from '../hooks/useChannelList';
import { CreateChannelForm } from '../components/channel/CreateChannelForm';
import { SkeletonText } from '../components/ui';
import { loadLastChannelId, resolveChannelHome } from '../utils/lastChannel';

export function ChannelHomeRedirect() {
  const { channels, loading, createChannel } = useChannelList();
  const navigate = useNavigate();

  if (loading) {
    // 批次 F-3：轻量骨架（批次 E-2 ui/Skeleton 正本）
    return (
      <div className="flex items-center justify-center h-full px-6">
        <SkeletonText lines={3} widths={['40%', '70%', '55%']} className="space-y-3 w-full max-w-sm" />
      </div>
    );
  }

  const target = resolveChannelHome(channels, loadLastChannelId());
  if (target) return <Navigate to={target} replace />;

  // 零频道兜底：无列表页可回，原地提供创建入口
  return (
    <div className="flex h-full items-start justify-center u-page-bg">
      <div className="w-full max-w-lg px-6 py-8">
        <h1 className="page-title">暂无频道</h1>
        <p className="page-subtitle">创建第一个频道开始使用</p>
        {/* 批次 G-2：padding:0 为冗余（.card 本无 padding）删除；marginTop/overflow 归 Tailwind */}
        <div className="card mt-4 overflow-hidden">
          <CreateChannelForm
            createChannel={createChannel}
            onCreated={ch => navigate(`/channels/${ch.id}`)}
          />
        </div>
      </div>
    </div>
  );
}
