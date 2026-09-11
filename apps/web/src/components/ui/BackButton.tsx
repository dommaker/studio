// #393 全站详情页统一返回按钮（spec §4.4）：左上「← 返回」
// 有站内历史 navigate(-1)，直开/书签回落默认列表页（fallback）
// 批次 E-1 token 合规：fontSize 14px 归 --fs-base（删内联走 .btn 继承），padding 6px 就近取 --space-2
import { useNavigate } from 'react-router-dom';

interface BackButtonProps {
  /** 无站内历史时的回落地址（各详情页的默认列表页） */
  fallback: string;
}

export function BackButton({ fallback }: BackButtonProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    // react-router 在 history.state.idx 记录站内栈位置；idx>0 = 有站内历史可退
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate(fallback);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="btn btn-ghost"
      style={{ padding: 'var(--space-2) var(--space-3)' }}
    >
      ← 返回
    </button>
  );
}
