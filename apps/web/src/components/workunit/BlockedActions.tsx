// BlockedActions — #185（决策 #87 D1/D3/D4/D5）：blocked WU 的 Web 处置组件
// （WorkUnitDrawer 速览档 / WorkUnitDetailPage 全量档共用，同 ExecutionSteps 复用 pattern）。
// 「继续执行」仅卡住型 blocked 显示——NEED_INPUT 型维持展示 waitingQuestion 引导回复
// （复活了 agent 也拿不到答案，只会再挂起）；「关闭任务」全 blocked 类型显示 + ConfirmDialog
// 二次确认（danger）；继续执行不确认（非破坏、可再拦截）。
// #467：plan-ruling 挂起（裁决轮待裁）另出「去裁决」——PlanRulingDialog 结构化表单
// （全对/单题修改/打回重议），提交走 POST /:id/ruling；autoRuling = 接力卡「去裁决」打开即弹。
// 语义与频道回复通道等价（同一复活原语/同一死信关闭路径）：按钮 = 纯授权，回复 = 带指导授权。
// decision/spec 裁剪状态机无 closed → 服务端 409，内联展示错误文案。
import { useState } from 'react';
import { workunitApi, type WorkUnit } from '../../api/workunit';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PlanRulingDialog, type PlanRulingRow } from '../pmo/PlanRulingDialog';
import { parseWuMeta } from '../../utils/wuMeta';
// 批次A 项6：错误文案提取逻辑已收敛为 utils/errorMessage 唯一正本（本组件为原出处）
import { errorMessage } from '../../utils/errorMessage';

interface Props {
  wu: WorkUnit;
  /** 动作成功后回调（宿主重拉 WU 详情） */
  onChanged?: () => void;
  /** #467：裁决轮接力卡「去裁决」——挂载即自动弹 PlanRulingDialog（一次性） */
  autoRuling?: boolean;
}

export function BlockedActions({ wu, onChanged, autoRuling = false }: Props) {
  const [pending, setPending] = useState<'resume' | 'close' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [showRuling, setShowRuling] = useState(false);
  const [error, setError] = useState('');
  // autoRuling 一次性锁（hooks 须在 early return 前）
  const [autoRulingDone, setAutoRulingDone] = useState(false);

  if (wu.status !== 'blocked') return null;
  const meta = parseWuMeta<{ title?: string; waitingForInput?: boolean; waitingReason?: string; planRulings?: PlanRulingRow[] }>(wu.metadata);
  const title = meta.title || wu.scope;
  // D3 分类型显示：NEED_INPUT 型只给「关闭任务」，继续执行入口 = 频道回复（带指导授权）
  const needInput = meta.waitingForInput === true;
  // #467：裁决轮待裁 = waitingReason='plan-ruling' 且 planRulings 非空（卡/弹窗数据源）
  const rulings = meta.waitingReason === 'plan-ruling' && Array.isArray(meta.planRulings) && meta.planRulings.length > 0
    ? meta.planRulings : null;

  // autoRuling（#467）：接力卡「去裁决」打开即弹一次性——渲染期派生（同 WuGateActions autoApprove 模式）
  if (!autoRulingDone && autoRuling && rulings) {
    setAutoRulingDone(true);
    setShowRuling(true);
  }

  const run = async (kind: 'resume' | 'close', action: () => Promise<unknown>) => {
    setPending(kind);
    setError('');
    try {
      await action();
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div style={{ margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {rulings && (
          <Button
            variant="primary"
            title="裁决轮：逐题评审 agent 的建议结论（全对/单题修改/打回重议），提交后规划会话继续"
            onClick={() => setShowRuling(true)}
          >
            去裁决
          </Button>
        )}
        {!needInput && (
          <Button
            variant="secondary"
            loading={pending === 'resume'}
            disabled={pending !== null}
            title="授权 agent 继续执行（等价于在频道回复「继续」；不重置超时计数，非破坏、可再拦截）"
            onClick={() => run('resume', () => workunitApi.resume(wu.id))}
          >
            继续执行
          </Button>
        )}
        <Button
          variant="danger"
          disabled={pending !== null}
          title="显式关闭该任务（状态迁移 + 频道通知；关闭后如需继续需重新派发）"
          onClick={() => setConfirmClose(true)}
        >
          关闭任务
        </Button>
      </div>
      {error && <div className="text-xs u-err" style={{ marginTop: 4 }}>{error}</div>}
      {showRuling && rulings && (
        <PlanRulingDialog
          rulings={rulings}
          onSubmit={async items => {
            // 失败 rethrow 给弹窗内联（弹窗保持打开）；成功关窗 + 通知宿主重拉
            await workunitApi.submitRuling(wu.id, { items });
            setShowRuling(false);
            onChanged?.();
          }}
          onCancel={() => setShowRuling(false)}
        />
      )}
      <ConfirmDialog
        open={confirmClose}
        title="关闭任务"
        danger
        message={`确定关闭任务「${title}」吗？关闭后不可恢复，如需继续需重新派发。`}
        confirmLabel="关闭任务"
        loading={pending === 'close'}
        onConfirm={() => { setConfirmClose(false); run('close', () => workunitApi.close(wu.id)); }}
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  );
}
