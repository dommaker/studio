// RequirementsDoc inline card — B1-001/B1-003, M2 quality gate
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；质量门/编辑/进度轮询逻辑零变更
// #278（决策 #250 D2）：requirements_doc 产卡链已删（历史卡）→ 按钮区整区隐藏 + 卡底淡注
// 「该确认入口已下线」；质量门弹窗随「开始执行」按钮一并移除（已无可达入口）。
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { requirementApi } from '../../api/requirements';
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

async function fetchReqProgress(reqId: string) {
  try {
    const res = await requirementApi.getChain(reqId);
    return res.data.data;
  } catch {
    return null;
  }
}

export function RequirementsDocCard({ message, meta }: Props) {
  const status = meta.status || 'ready';
  const isIdle = status === 'ready';
  const navigate = useNavigate();
  const [progress, setProgress] = useState<{ total: number; completed: number } | null>(null);

  // Poll requirement chain progress when executing
  const reqId: string | undefined = meta.requirementId || meta.reqId;
  useEffect(() => {
    if (status !== 'executing' || !reqId) return;
    const poll = () => {
      fetchReqProgress(reqId).then(chain => {
        if (chain) {
          const workunits = chain.workunits || [];
          const total = workunits.length;
          // F6-b：进度 = 所有权口径 workFinished（活干完没），不看信任列（人确认没）
          const completed = workunits.filter(w =>
            deriveDisplayState({ status: w.status, metadata: w.metadata }).workFinished
            || w.status === 'completed' || w.status === 'succeeded'
          ).length;
          setProgress({ total, completed });
        }
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [status, reqId]);

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

      {/* Executing state — show progress */}
      {status === 'executing' && (
        <div className="mc-card-actions" style={{ display: 'block' }}>
          {progress ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                <span className="mc-dim">执行进度</span>
                <span className="mc-dim">{progress.completed}/{progress.total} 完成</span>
              </div>
              <div className="mc-progress">
                <div
                  className="mc-progress-fill"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <button onClick={() => navigate(`/workunits`)} className="mc-wu-link" style={{ marginTop: 6 }}>
                查看 WorkUnits ›
              </button>
            </div>
          ) : (
            <div className="mc-drawer-note">执行已启动，正在初始化...</div>
          )}
        </div>
      )}

      {/* Other states */}
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
