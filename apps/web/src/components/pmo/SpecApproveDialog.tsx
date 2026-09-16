// SpecApproveDialog — #463 spec 确认弹窗（物化 task 卡片墙，结构化评审表单）
// 预填 agent COMPLETE 落档的 metadata.specTasks（buildSpecConfirmPrefill 产物）：
// 每卡 = 勾选纳入 + 标题行内改 + 展开改 AC（增删改）；blockedBy/leg 人审不编辑但透传。
// 主按钮动态标签：全选=「确认物化(N)」/ 部分=「部分物化(N/M)」/ 全剔=「确认通过（不物化）」
// ——不物化不落物化哨兵，事后补确认可再触发（spec-materialization #463 哨兵语义）。
// 「打回」= reviewRejected 预设理由。确认回传 confirm={kind:'spec', tasks:勾选集}——
// 后端序列化为 TASK 物化行进 l3.summary（存储契约不变），人永远不接触魔法行。
import { useState } from 'react';
import { Button, Modal } from '../ui';
import { errorMessage } from '../../utils/errorMessage';
import type { ReviewConfirmPayload } from '../../api/workunit';
import type { SpecTaskFormItem } from './mapUtils';

interface SpecCardState extends SpecTaskFormItem {
  included: boolean;
  expanded: boolean;
}

interface SpecApproveDialogProps {
  /** 卡片墙预填（buildSpecConfirmPrefill 产物；空 = agent 没拆，可手动加卡） */
  prefill: SpecTaskFormItem[];
  /** 确认物化：勾选集随 confirm 回传（reject 时弹窗保持打开并内联错误） */
  onConfirm: (confirm: ReviewConfirmPayload & { kind: 'spec' }) => void | Promise<unknown>;
  /** 打回：reviewRejected 预设理由 */
  onReject: (reason: string) => void | Promise<unknown>;
  onCancel: () => void;
}

/** 打回预设理由（物化清单需修订，agent 据此重做拆分） */
export const SPEC_REJECT_REASON = '打回：物化清单需修订，请调整拆分后重新提交确认';

export function SpecApproveDialog({ prefill, onConfirm, onReject, onCancel }: SpecApproveDialogProps) {
  const [cards, setCards] = useState<SpecCardState[]>(
    prefill.map(t => ({ ...t, ac: [...t.ac], blockedBy: [...t.blockedBy], included: true, expanded: false })),
  );
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

  const patch = (i: number, p: Partial<SpecCardState>) =>
    setCards(prev => prev.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  const included = cards.filter(c => c.included && c.title.trim());
  const primaryLabel = included.length === 0
    ? '确认通过（不物化）'
    : included.length === cards.length
      ? `确认物化（${included.length}）`
      : `部分物化（${included.length}/${cards.length}）`;

  // 批次 I-2：收编 ui/Modal（§4.3 正本）；提交中屏蔽一切关窗路径（遮罩/Escape/✕ 同原 disabled 语义）
  return (
    <Modal
      onClose={() => { if (!submitting) onCancel(); }}
      maxWidth="36rem"
      title="确认物化清单"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button
            className="btn btn-danger"
            disabled={submitting}
            title="打回：物化清单需修订（agent 重做拆分）"
            onClick={() => void run(() => onReject(SPEC_REJECT_REASON))}
          >
            打回
          </button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => void run(() => onConfirm({
              kind: 'spec',
              tasks: included.map(c => ({
                title: c.title.trim(),
                ac: c.ac.map(s => s.trim()).filter(Boolean),
                ...(c.blockedBy.length > 0 ? { blockedBy: c.blockedBy } : {}),
                ...(c.leg ? { leg: c.leg } : {}),
              })),
            }))}
          >
            {primaryLabel}
          </Button>
        </>
      }
    >
          <p className="text-xs u-text-2 mb-2">
            逐卡评审要拆的任务（勾选纳入、标题可改、展开改验收标准）；确认后按勾选集自动派生任务单。
            全部不勾 = 确认但不物化（事后可补确认再物化）；拆得不对请「打回」。
          </p>
          <div className="flex flex-col gap-2">
            {cards.map((card, i) => (
              <div key={i} className="mc-block-label" style={{ padding: 8 }}>
                <div className="flex gap-2 items-center">
                  <input
                    type="checkbox"
                    checked={card.included}
                    onChange={e => patch(i, { included: e.target.checked })}
                    aria-label={`纳入物化 ${i + 1}`}
                  />
                  <input
                    className="input w-full"
                    value={card.title}
                    placeholder="任务标题"
                    onChange={e => patch(i, { title: e.target.value })}
                    aria-label={`任务标题 ${i + 1}`}
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => patch(i, { expanded: !card.expanded })}
                  >
                    {card.expanded ? '收起' : `验收标准（${card.ac.length}）`}
                  </button>
                </div>
                {card.expanded && (
                  <div className="mt-2 flex flex-col gap-1">
                    {card.ac.map((ac, j) => (
                      <div key={j} className="flex gap-1 items-center">
                        <input
                          className="input w-full"
                          value={ac}
                          placeholder="验收标准"
                          onChange={e => patch(i, { ac: card.ac.map((a, k) => (k === j ? e.target.value : a)) })}
                          aria-label={`验收标准 ${i + 1}-${j + 1}`}
                        />
                        <button
                          className="btn btn-secondary btn-sm"
                          aria-label={`删除验收标准 ${i + 1}-${j + 1}`}
                          onClick={() => patch(i, { ac: card.ac.filter((_, k) => k !== j) })}
                        >
                          删
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => patch(i, { ac: [...card.ac, ''] })}
                    >
                      添加验收标准
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            className="btn btn-secondary btn-sm mt-2"
            onClick={() => setCards(prev => [...prev, { title: '', ac: [], blockedBy: [], included: true, expanded: true }])}
          >
            添加任务
          </button>
          {submitError && <p className="text-xs u-err" style={{ marginTop: 8 }}>{submitError}</p>}
    </Modal>
  );
}
