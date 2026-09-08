// AgentAvatar — #440 Phase 4：per-agent identicon 式确定性头像。
// 5x5 镜像网格 SVG，色源走现有 --chart-1..9 调色板（不新增色板）；图样逻辑全在 utils/avatar 纯函数。
// 消费方：AuthorAvatar（频道消息气泡）/ AgentDetailPage（profile 标题区，传更大 size）。
import { avatarPattern, avatarCellAt } from '../../utils/avatar';

export function AgentAvatar({ name, size = 20 }: { name: string; size?: number }) {
  const pattern = avatarPattern(name);
  const cell = size / 5;
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (avatarCellAt(pattern, r, c)) {
        rects.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} />);
      }
    }
  }
  return (
    <span className="mc-avatar mc-avatar-ident" title={name} role="img" aria-label={name}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill={`var(--chart-${pattern.paletteIndex + 1})`}
        aria-hidden="true"
      >
        {rects}
      </svg>
    </span>
  );
}
