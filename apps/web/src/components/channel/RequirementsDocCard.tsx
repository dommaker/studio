// RequirementsDoc inline card — B1-001/B1-003, M2 quality gate
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘
// #278（决策 #250 D2）：requirements_doc 产卡链已删（历史卡）→ 按钮区整区隐藏 + 卡底淡注
// 「该确认入口已下线」；质量门弹窗随「开始执行」按钮一并移除（已无可达入口）。
// 2026-08（SSE 负载加深 决策 7）：删 5s 轮询 + executing 进度分支——死代码
// （#278 后无任何后端代码写 meta.status='executing'，轮询对新卡从不触发）；
// executing 遗产卡只保留状态 chip 静态渲染。
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  onAction: (messageId: string, action: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  ready: '待确认',
  executing: '执行中',
  needs_revision: '待修改',
  done: '已完成',
  error: '失败',
};

/** 状态 → mc-status chip 修饰类 */
function statusClass(status: string): string {
  if (status === 'executing') return 'mc-status mc-status-running';
  if (status === 'done') return 'mc-status mc-status-done';
  if (status === 'error') return 'mc-status mc-status-error';
  if (status === 'ready') return 'mc-status mc-status-need';
  return 'mc-status mc-status-pending';
}

export function RequirementsDocCard({ message, meta }: Props) {
  const status = meta.status || 'ready';
  const isIdle = status === 'ready';

  return (
    <div className="mc-card" data-card-type="requirements_doc">
      {/* Status badge */}
      <div className="mc-card-head">
        <span className="mc-card-label">需求文档</span>
        <span className={statusClass(status)}>
          {status === 'executing' ? <span className="mc-dot" /> : null}
          {STATUS_LABELS[status] || status}
        </span>
      </div>

      {/* Content（#155：SDD 写侧已退役，卡片只读展示） */}
      <div className="mc-card-body" style={{ marginBottom: 8 }}>
        {message.content}
      </div>

      {/* #278（决策 #250 D2）：历史卡只读化——按钮区整区隐藏 + 卡底淡注 */}
      {isIdle && (
        <div className="mc-card-foot mc-card-dim" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          该确认入口已下线
        </div>
      )}

      {/* Other states（executing 遗产卡无底部区块：状态 chip 已足以标识，决策 7 删除进度区） */}
      {!isIdle && status !== 'executing' && (
        <div className="mc-card-foot" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          {status === 'needs_revision' && '等待修改反馈...'}
          {status === 'done' && '需求已完成'}
          {status === 'error' && `错误: ${meta.error || '未知'}`}
        </div>
      )}
    </div>
  );
}
