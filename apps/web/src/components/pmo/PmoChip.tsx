// #476：PMO 统一标识 chip——频道内三处呈现（顶栏 ChannelCurrentPmoChip / 右栏 ChannelActivityRail badge /
// 消息 footer chip）复用同一视觉语言：ui/icons IconChart（#474 定稿 PMO 图标）+ 文本，样式本体 .pmo-chip。
// 颜色语义（#472）：PMO 是身份不是状态，中性配色、不占 success/warning；零 emoji（#474 图标策略）。
// className 仅作站点布局钩子（如右栏 mc-act-pmo-badge 的字号覆盖），视觉语言不得在各站点改写。
import React from 'react';
import { IconChart } from '../ui/icons';

interface PmoChipProps {
  label: string;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

export const PmoChip: React.FC<PmoChipProps> = ({ label, onClick, title, ariaLabel, className }) => (
  <button
    type="button"
    className={`pmo-chip${className ? ` ${className}` : ''}`}
    onClick={onClick}
    title={title}
    aria-label={ariaLabel}
  >
    <IconChart size={14} />
    <span>{label}</span>
  </button>
);

export default PmoChip;
