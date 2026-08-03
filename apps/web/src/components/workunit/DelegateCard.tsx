// DelegateCard - AC-5.7 delegate 卡片树开销显示
// NEED_INPUT 委派失败时展示树级 token 开销：树开销 X / 400000 tokens
import { useEffect, useState } from 'react';
import { workunitApi } from '../../api/workunit';

const TREE_TOKEN_BUDGET = 400_000;

interface Props {
  workUnitId: string;
}

export function DelegateCard({ workUnitId }: Props) {
  const [treeTotal, setTreeTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workunitApi
      .getTreeTokens(workUnitId)
      .then((res) => {
        if (!cancelled) {
          setTreeTotal(res.data.rootTotal);
          setError('');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workUnitId]);

  return (
    <div className="delegate-card" aria-label="委派树开销">
      {loading && <span className="text-xs u-text-3">加载中...</span>}
      {error && <span className="text-xs u-err">加载失败: {error}</span>}
      {!loading && !error && (
        <span className="text-xs u-text-3">
          树开销 {treeTotal ?? 0} / {TREE_TOKEN_BUDGET} tokens
        </span>
      )}
    </div>
  );
}
