// PlanDirectionDialog — #567：方向锁定结构化选定表单（复用 #467/#463 范式：人闸的价值是判断不是录入）。
// 数据源 = metadata.planDirections（agent 方向锁定 NEED_INPUT 携 DIRECTION 行落档）：
//   候选方向卡片并排，每卡 name/summary/tradeoffs/impact，推荐卡带徽标；单选（默认选中推荐项）+
//   可选补充说明；主键动态标签「锁定推荐方向」/「锁定所选方向」；「都不合适」= onCancel
//   （关窗转自由文本回复，走通用复活路径，agent 收文本后重出方向或直接裁决轮）。
// 提交载荷 = PlanDirectionPayload（后端 pmo/plan-direction.ts 落探路台账 + 复活同会话），
// 人永远不接触 DIRECTION 魔法行。提交失败弹窗保持打开 + 内联错误（批次A 项7 同款）。
// 入口：BlockedActions（plan-direction 挂起的 blocked 处置区；接力卡「去选定」经 autoDirection 打开即弹）。
// 公共骨架（submitting/取消键/关窗屏蔽/错误行）走 ui/ApproveDialogShell（Step 3 收敛）。
import { useState } from 'react';
import { ApproveDialogShell, Button } from '../ui';
import type { PlanDirectionPayload } from '../../api/workunit';

/** 方向锁定候选（metadata.planDirections.options 条目镜像） */
export interface PlanDirectionOption {
  name: string;
  summary: string;
  tradeoffs: string;
  impact: string;
  recommended: boolean;
}

/** 方向锁定待选集（metadata.planDirections 镜像；question = 抉择点） */
export interface PlanDirections {
  question: string;
  options: PlanDirectionOption[];
}

interface PlanDirectionDialogProps {
  /** 待选方向集（抉择点 + 候选；推荐项预选中） */
  directions: PlanDirections;
  /** 提交选定（choice = 方向名，note 可选）；reject 时弹窗保持打开并内联错误 */
  onSubmit: (pick: PlanDirectionPayload) => void | Promise<unknown>;
  onCancel: () => void;
}

export function PlanDirectionDialog({ directions, onSubmit, onCancel }: PlanDirectionDialogProps) {
  const [selected, setSelected] = useState(
    directions.options.find(o => o.recommended)?.name ?? directions.options[0]?.name ?? '',
  );
  const [note, setNote] = useState('');

  const selectedRecommended = directions.options.find(o => o.name === selected)?.recommended === true;

  return (
    <ApproveDialogShell
      maxWidth="48rem"
      title="方向锁定：选定本票方向"
      onCancel={onCancel}
      actions={({ submitting, run }) => (
        <>
          <button
            className="btn btn-secondary"
            disabled={submitting}
            title="候选都不合适：关闭弹窗，在下方回复框自由文本说明（走通用复活路径）"
            onClick={onCancel}
          >
            都不合适
          </button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => void run(() => {
              const trimmed = note.trim();
              return onSubmit({ choice: selected, ...(trimmed ? { note: trimmed } : {}) });
            })}
          >
            {selectedRecommended ? '锁定推荐方向' : '锁定所选方向'}
          </Button>
        </>
      )}
    >
      <p className="text-sm mb-2">{directions.question}</p>
      <p className="text-xs u-text-2 mb-2">
        逐卡比较候选方向的取舍与影响面（推荐项已预选，可改选）；选定后方向结论落探路台账，
        规划会话继续（裁决轮 → spec 成文 → 拆任务清单）。
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {directions.options.map(o => (
          <label
            key={o.name}
            className="flex flex-col gap-1"
            style={{
              border: `1px solid ${selected === o.name ? 'var(--accent-primary)' : 'var(--border-default)'}`,
              borderRadius: 6,
              padding: 8,
              cursor: 'pointer',
            }}
          >
            <span className="flex gap-1 items-center">
              <input
                type="radio"
                name="plan-direction"
                checked={selected === o.name}
                onChange={() => setSelected(o.name)}
                aria-label={`方向：${o.name}`}
              />
              <span className="text-sm font-semibold">{o.name}</span>
              {o.recommended && <span className="mc-status mc-status-running">推荐</span>}
            </span>
            <span className="text-xs u-text-2">{o.summary}</span>
            <span className="text-xs u-text-3">取舍：{o.tradeoffs}</span>
            <span className="text-xs u-text-3">影响：{o.impact}</span>
          </label>
        ))}
      </div>
      <textarea
        className="input w-full"
        rows={2}
        style={{ marginTop: 8 }}
        placeholder="补充说明（可选）——随选定一并注入会话"
        value={note}
        onChange={e => setNote(e.target.value)}
        aria-label="补充说明"
      />
    </ApproveDialogShell>
  );
}
