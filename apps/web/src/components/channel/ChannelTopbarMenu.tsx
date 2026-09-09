// ChannelTopbarMenu — E1（2026-09 页面重设计，docs/plans/2026-09-page-redesign.md）：
// 顶栏收敛 ⋯ 菜单。原 5 动作平铺（频道动态/待回复/PMO/成员/默认工程）→
// 顶栏只留「待回复 · N」chip（唯一待办信号位）+ 本菜单；成员管理/默认工程/频道动态入口/当前 PMO 跳转收进这里。
// 复用既有组件作菜单行（触发器形态经 prop/作用域 CSS 适配），不复制其内部逻辑：
//   - 频道动态：仅 <1024 有意义（≥1024 内联右栏在岗）——外层包 .mc-act-open 沿用既有显隐规则
//   - 当前 PMO：ChannelCurrentPmoChip 原样复用（派生为 null 时该行 :empty 不占位）
//   - 成员管理：ChannelMemberManager 复用，triggerClassName 换菜单行形态，面板仍自弹自管
//   - 默认工程：ChannelDefaultProjectSelect 原样复用（Select 面板 portal 到 body，
//     点选项不算「点外部」，见下方 .select-panel 豁免）
import { useEffect, useRef, useState } from 'react';
import { ChannelCurrentPmoChip } from './ChannelCurrentPmoChip';
import { ChannelMemberManager } from './ChannelMemberManager';
import { ChannelDefaultProjectSelect } from './ChannelDefaultProjectSelect';
import { ChannelRoutingEditor } from './ChannelRoutingEditor';

interface Props {
  channelId: string;
  defaultPath?: string | null;
  /** 「频道动态」入口：打开覆盖抽屉（仅 <1024 可见，承 #395） */
  onOpenActivity: () => void;
}

export function ChannelTopbarMenu({ channelId, defaultPath, onOpenActivity }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击组件外部收起（ChannelNeedInputChip 同款模式）；
  // 例外：默认工程 Select 的选项面板 portal 到 body（.select-panel），点选项不收菜单
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.select-panel')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="mc-topbar-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="mc-btn mc-topbar-menu-btn"
        aria-label="更多操作"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="mc-topbar-menu">
          {/* 频道动态入口：<1024 才显示（.mc-act-open 既有显隐规则，≥1024 内联右栏在岗） */}
          <div className="mc-act-open">
            <button
              type="button"
              className="mc-topbar-menu-item"
              aria-label="打开频道动态"
              onClick={() => { setOpen(false); onOpenActivity(); }}
            >
              频道动态
            </button>
          </div>
          <div className="mc-topbar-menu-row">
            <ChannelCurrentPmoChip channelId={channelId} />
          </div>
          <div className="mc-topbar-menu-row">
            <ChannelMemberManager channelId={channelId} triggerClassName="mc-topbar-menu-item" />
          </div>
          {/* #466：工单路由（阶段→角色）三行下拉，成本结构一屏可见 */}
          <div className="mc-topbar-menu-row">
            <ChannelRoutingEditor channelId={channelId} triggerClassName="mc-topbar-menu-item" />
          </div>
          <div className="mc-topbar-menu-field">
            <span className="mc-topbar-menu-label">默认工程</span>
            <ChannelDefaultProjectSelect channelId={channelId} defaultPath={defaultPath} />
          </div>
        </div>
      )}
    </div>
  );
}
