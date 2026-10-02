// ChannelTopbar — 频道页顶栏（P3-b 自 ChannelDetailPage 切出）：
// 频道名/类型标识 + 「当前 PMO」chip（#474）+ NEED_INPUT 待办 chip（#279/#468，E1 起顶栏唯一
// 待办信号位）+ ⋯ 菜单（E1 收敛：成员管理/默认工程/频道动态入口）。
// 纯装配组件：数据与回调全部由页面注入，自身零 store 订阅。
import { formatChannelName } from '@dommaker/studio-shared/web';
import { ChannelCurrentPmoChip } from './ChannelCurrentPmoChip';
import { ChannelNeedInputChip, type NeedInputTodo } from './ChannelNeedInputChip';
import { ChannelTopbarMenu } from './ChannelTopbarMenu';

interface ChannelTopbarProps {
  channelId: string;
  /** 频道记录（缺省未拉到时名称回退 id 短显） */
  channel: { name?: string; type?: string; defaultPath?: string | null } | null;
  /** NEED_INPUT 待办投影（行动中心 stateItems 本频道 reply 项） */
  waitingWus: NeedInputTodo[];
  /** 点待办条目：定位该 WU 当前提问消息（messageId 缺省 fail-closed 由页面兜底） */
  onLocateWaiting: (wuId: string) => void;
  /** <1024 打开频道动态覆盖抽屉（菜单内入口） */
  onOpenActivity: () => void;
}

export function ChannelTopbar({ channelId, channel, waitingWus, onLocateWaiting, onOpenActivity }: ChannelTopbarProps) {
  return (
    <div className="mc-topbar">
      <h1 className="mc-topbar-name">{formatChannelName(channel?.name || channelId.slice(0, 8))}</h1>
      <span className="mc-topbar-type">
        {channel?.type === 'rnd' ? '研发频道' : channel?.type === 'decision' ? '决策频道' : '系统频道'}
      </span>
      <div className="mc-topbar-actions">
        {/* #474：「当前 PMO」提升为顶栏可见位（原藏 ⋯ 菜单）——频道上下文标识与待办信号同排可见 */}
        <ChannelCurrentPmoChip channelId={channelId} />
        {/* #279（决策 #250 D4）/ #468：NEED_INPUT 待办 chip——数据源 = 行动中心 stateItems 投影
            （本频道 reply 项）；E1 起为顶栏唯一待办信号位（消息头 badge 已删，见 ChannelMessageItem） */}
        <ChannelNeedInputChip items={waitingWus} onLocate={onLocateWaiting} />
        {/* E1（2026-09 页面重设计）：顶栏收敛 ⋯ 菜单——成员管理/默认工程/频道动态入口（<1024）
            收纳进菜单；主行动点保持输入框「发送」唯一 accent */}
        <ChannelTopbarMenu
          channelId={channelId}
          defaultPath={channel?.defaultPath}
          onOpenActivity={onOpenActivity}
        />
      </div>
    </div>
  );
}
