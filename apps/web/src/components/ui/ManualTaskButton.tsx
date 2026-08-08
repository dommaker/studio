// ManualTaskButton — 「手动任务」按钮：点击执行 → loading → toast 反馈
// 可附带近 30 天 token 成本小字（成本数据来自 maintenanceApi.getCosts）
import { useState } from 'react';
import { toast } from '../../utils/toast';

/** k/M 缩写（与 TreeTokenDrawer 的 formatTokens 同款，多一档 M） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  label: string;
  /** 执行任务；resolve 的字符串作为成功 toast 文案 */
  onRun: () => Promise<string>;
  /** 近 30 天成本（token）；传入时在按钮右侧显示一行弱化小字 */
  costTokens?: number;
  /** 自定义成本文案（优先于 costTokens；用于 token 记账缺失只能展示调用次数的场景，如 system:tokens usage 为 null 的 F1 维护） */
  costNote?: string;
  className?: string;
}

export function ManualTaskButton({ label, onRun, costTokens, costNote, className = 'btn btn-secondary text-sm' }: Props) {
  const [running, setRunning] = useState(false);

  const handleClick = async () => {
    if (running) return;
    setRunning(true);
    try {
      const message = await onRun();
      toast.success(message);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message ?? '执行失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={handleClick} disabled={running} className={className}>
        {running ? '运行中…' : label}
      </button>
      {costNote != null ? (
        <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
          {costNote}
        </span>
      ) : costTokens != null && (
        <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
          近 30 天 ≈{formatTokens(costTokens)} tokens
        </span>
      )}
    </span>
  );
}
