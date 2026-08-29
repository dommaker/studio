// #393 全站详情页统一返回按钮（spec §4.4）：左上「← 返回」（14px / 6×12 padding）
// 有站内历史 navigate(-1)，直开/书签回落默认列表页（fallback）
// 注：14px / 6×12 为 spec §4.4 显式定值，优先于 style-guide 字号/间距档（style-guide 随改版落地同步，spec §1 关系声明）
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
      style={{ fontSize: 14, padding: '6px 12px' }}
    >
      ← 返回
    </button>
  );
}
