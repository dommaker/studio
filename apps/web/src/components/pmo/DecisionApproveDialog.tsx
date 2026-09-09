// DecisionApproveDialog — #463 decision 确认弹窗（结构化评审表单，照 AnalysisApproveDialog 范式）
// 预填 agent `## 结论摘要` 段落档的 metadata.decisionSuggestion（buildDecisionConfirmPrefill 产物），
// 人审只判断不录入：未改 = 采纳，改后 = 修改后采纳（同一确认动作，主按钮标签随改动切换）；
// 「转人工讨论」= 打回路径（reviewRejected 预设理由），结论待人工对齐后再确认。
// 确认回传 confirm={kind:'decision', conclusion}——后端原样序列化进 l3.summary（存储契约不变，
// decision-resolution 消费 → map.decisions[]），人永远不接触魔法行。
// 批次A 项7 同款：onConfirm/onReject 可返回 Promise——提交期间禁用 + 失败内联错误保持打开。
import { useState } from 'react';
import { Button } from '../ui';
import { errorMessage } from '../../utils/errorMessage';
import type { ReviewConfirmPayload } from '../../api/workunit';

interface DecisionApproveDialogProps {
  /** 待决问题（decision WU scope 首行，map-opening 建单契约） */
  question: string;
  /** agent 建议结论预填（buildDecisionConfirmPrefill 产物；空串 = agent 没给，人手填） */
  suggestion: string;
  /** 采纳/修改后采纳：结论原文随 confirm 回传（reject 时弹窗保持打开并内联错误） */
  onConfirm: (confirm: ReviewConfirmPayload & { kind: 'decision' }) => void | Promise<unknown>;
  /** 转人工讨论：打回路径（reason 预设， WuGateActions 走 reviewRejected） */
  onReject: (reason: string) => void | Promise<unknown>;
  onCancel: () => void;
}

/** 转人工讨论的预设理由（打回留痕，agent/人据此知道去频道对齐而非闷头返工） */
export const DECISION_DISCUSS_REASON = '转人工讨论：结论待人工对齐，请在频道讨论后重新提交确认';

export function DecisionApproveDialog({ question, suggestion, onConfirm, onReject, onCancel }: DecisionApproveDialogProps) {
  const [text, setText] = useState(suggestion);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const run = async (fn: () => void | Promise<unknown>) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await fn();
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const modified = text.trim() !== suggestion.trim();

  return (
    <div className="modal-overlay" onClick={submitting ? undefined : onCancel}>
      <div className="modal" style={{ maxWidth: '28rem' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">确认决策结论</h3>
          <button className="modal-close" onClick={onCancel} disabled={submitting} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="text-xs u-text-2 mb-2">
            确认后结论将落入探路地图决策时间线；不认请「转人工讨论」。
          </p>
          {question && <p className="text-sm mb-2">{question}</p>}
          <textarea
            className="input w-full"
            rows={4}
            placeholder="一句话结论与理由（agent 未给出建议时请手填）"
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label="决策结论"
          />
          {submitError && <p className="text-xs u-err" style={{ marginTop: 8 }}>{submitError}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button
            className="btn btn-danger"
            disabled={submitting}
            title="打回：结论待人工对齐（频道讨论后重审）"
            onClick={() => void run(() => onReject(DECISION_DISCUSS_REASON))}
          >
            转人工讨论
          </button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={!text.trim()}
            onClick={() => void run(() => onConfirm({ kind: 'decision', conclusion: text.trim() }))}
          >
            {modified ? '修改后采纳' : '采纳结论'}
          </Button>
        </div>
      </div>
    </div>
  );
}
