// PlanRulingDialog — #467：裁决轮结构化评审表单（复用 #463 范式：人闸的价值是判断不是录入）。
// 数据源 = metadata.planRulings（agent 裁决轮 NEED_INPUT 携 RULING 行落档）：
//   每题结论预填 agent 建议（行内可改 = 单题修改）；每题可勾「打回重议」（只重调该题，
//   agent 补调研后重新出裁决轮）；「全部采纳」= 全对一键（零编辑按建议结论提交）。
// 提交载荷 = PlanRulingPayload.items（后端 pmo/plan-ruling.ts 批量落探路台账 + 复活同会话），
// 人永远不接触 RULING 魔法行。提交失败弹窗保持打开 + 内联错误（批次A 项7 同款）。
// 入口：BlockedActions（plan-ruling 挂起的 blocked 处置区；接力卡「去裁决」经 autoRuling 打开即弹）。
// 公共骨架（submitting/取消键/关窗屏蔽/错误行）走 ui/ApproveDialogShell（Step 3 收敛）。
import { useState } from 'react';
import { ApproveDialogShell, Button } from '../ui';
import type { PlanRulingPayload } from '../../api/workunit';

/** 裁决轮待裁题（metadata.planRulings 条目镜像；question/suggestion 必填，default 可省） */
export interface PlanRulingRow {
  question: string;
  suggestion: string;
  default?: string;
}

interface PlanRulingDialogProps {
  /** 待裁清单（agent 建议结论预填） */
  rulings: PlanRulingRow[];
  /** 提交裁决（全对/单题修改/打回重议合一载荷）；reject 时弹窗保持打开并内联错误 */
  onSubmit: (items: PlanRulingPayload['items']) => void | Promise<unknown>;
  onCancel: () => void;
}

interface RowState {
  question: string;
  suggestion: string;
  default?: string;
  conclusion: string;
  reopen: boolean;
}

export function PlanRulingDialog({ rulings, onSubmit, onCancel }: PlanRulingDialogProps) {
  const [rows, setRows] = useState<RowState[]>(
    rulings.map(r => ({ ...r, conclusion: r.suggestion, reopen: false })),
  );

  const patchRow = (i: number, patch: Partial<RowState>) =>
    setRows(prev => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <ApproveDialogShell
      maxWidth="40rem"
      title="裁决轮：一次性裁决"
      onCancel={onCancel}
      actions={({ submitting, run }) => (
        <>
          <button
            className="btn btn-secondary"
            disabled={submitting}
            title="全对：不改动，全部以 agent 建议结论采纳"
            onClick={() => void run(() => onSubmit(
              rows.map(r => ({ question: r.question, action: 'accept' as const, conclusion: r.suggestion })),
            ))}
          >
            全部采纳
          </button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => void run(() => onSubmit(
              rows.map(r => r.reopen
                ? { question: r.question, action: 'reopen' as const }
                : { question: r.question, action: 'accept' as const, conclusion: r.conclusion.trim() }),
            ))}
          >
            提交裁决
          </Button>
        </>
      )}
    >
      <p className="text-xs u-text-2 mb-2">
        逐题评审 agent 的建议结论（可直接改）；「打回重议」的题保持待决，agent 只重调该题后重新出裁决。
        提交后结论一次性落入探路台账，规划会话继续（spec 成文 → 拆任务清单）。
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-1" style={{ borderBottom: '1px solid var(--border-default)', paddingBottom: 8 }}>
            <div className="flex gap-2 items-center">
              <span className="text-sm" style={{ flex: 1 }}>{r.question}</span>
              <label className="text-xs u-text-2 flex gap-1 items-center">
                <input
                  type="checkbox"
                  checked={r.reopen}
                  onChange={e => patchRow(i, { reopen: e.target.checked })}
                  aria-label={`打回重议 ${i + 1}`}
                />
                打回重议
              </label>
            </div>
            {r.default && <p className="text-xs u-text-3">默认值（人不答时）：{r.default}</p>}
            <textarea
              className="input w-full"
              rows={2}
              value={r.conclusion}
              disabled={r.reopen}
              onChange={e => patchRow(i, { conclusion: e.target.value })}
              aria-label={`结论 ${i + 1}`}
            />
          </div>
        ))}
      </div>
    </ApproveDialogShell>
  );
}
