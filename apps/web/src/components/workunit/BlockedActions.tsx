// BlockedActions — #185（决策 #87 D1/D3/D4/D5）：blocked WU 的 Web 处置组件
// （WorkUnitDrawer 速览档 / WorkUnitDetailPage 全量档共用，同 ExecutionSteps 复用 pattern）。
// 「继续执行」仅卡住型 blocked 显示——NEED_INPUT 型维持展示 waitingQuestion 引导回复
// （复活了 agent 也拿不到答案，只会再挂起）；「关闭任务」全 blocked 类型显示 + ConfirmDialog
// 二次确认（danger）；继续执行不确认（非破坏、可再拦截）。
// 语义与频道回复通道等价（同一复活原语/同一死信关闭路径）：按钮 = 纯授权，回复 = 带指导授权。
// decision/spec 裁剪状态机无 closed → 服务端 409，内联展示错误文案。
import { useState } from 'react';
import axios from 'axios';
import { workunitApi, type WorkUnit } from '../../api/workunit';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { parseWuMeta } from '../../utils/wuMeta';

/** 错误文案提取：优先服务端 error 信封的 message（409 拒绝原因对人可读） */
function errorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (msg) return msg;
  }
  return e instanceof Error ? e.message : String(e);
}

interface Props {
  wu: WorkUnit;
  /** 动作成功后回调（宿主重拉 WU 详情） */
  onChanged?: () => void;
}

export function BlockedActions({ wu, onChanged }: Props) {
  const [pending, setPending] = useState<'resume' | 'close' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState('');

  if (wu.status !== 'blocked') return null;
  const meta = parseWuMeta<{ title?: string; waitingForInput?: boolean }>(wu.metadata);
  const title = meta.title || wu.scope;
  // D3 分类型显示：NEED_INPUT 型只给「关闭任务」，继续执行入口 = 频道回复（带指导授权）
  const needInput = meta.waitingForInput === true;

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
