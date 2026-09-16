// ApproveDialogShell — 审批弹窗公共壳（docs/plans/2026-09-web-ux-optional-fixes.md Step 3，
// 先例 = ReviewProposalCard 六卡合一）：Analysis/Decision/Spec/PlanRuling 四弹窗同构骨架收敛。
// 壳承载：submitting/submitError 状态 + run 提交包装（防重入、失败内联错误弹窗保持打开）+
// ui/Modal 关窗屏蔽语义（提交中遮罩/Escape/✕ 全禁，同批次 I-2 原 disabled 语义）+
// footer 首位固定「取消」键 + body 末尾统一 submitError 行。
// 差异区全在消费方：title/maxWidth/children 直传，取消键之后的动作键经 actions render prop
// 取 { submitting, run } 自渲染（主键 loading、reject 预设理由等仍归各弹窗）。
import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { errorMessage } from '../../utils/errorMessage';

/** actions render prop 的上下文：提交中标志 + 提交包装（按钮 onClick 里 void run(...)） */
export interface ApproveDialogActions {
  /** 提交中：动作键应禁用 / 主键 loading；关窗路径（取消键/遮罩/Escape/✕）已被壳屏蔽 */
  submitting: boolean;
  /** 提交包装：防重入 + await 完成才解锁；reject 时内联错误、弹窗保持打开可重试 */
  run: (fn: () => void | Promise<unknown>) => Promise<void>;
}

export interface ApproveDialogShellProps {
  /** 弹窗标题（Modal header） */
  title: ReactNode;
  /** Modal max-width（缺省走 Modal 默认 600px） */
  maxWidth?: string;
  /** 取消/关窗回调（提交中被壳屏蔽不触发） */
  onCancel: () => void;
  /** 取消键之后的动作键区（各弹窗差异：reject/次要动作/主确认键） */
  actions: (ctx: ApproveDialogActions) => ReactNode;
  /** 表单差异内容（submitError 行由壳统一渲染在其后） */
  children: ReactNode;
}

export function ApproveDialogShell({ title, maxWidth, onCancel, actions, children }: ApproveDialogShellProps) {
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

  return (
    <Modal
      onClose={() => { if (!submitting) onCancel(); }}
      maxWidth={maxWidth}
      title={title}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          {actions({ submitting, run })}
        </>
      }
    >
      {children}
      {/* 提交失败内联错误（弹窗保持打开可重试） */}
      {submitError && <p className="text-xs u-err" style={{ marginTop: 8 }}>{submitError}</p>}
    </Modal>
  );
}
