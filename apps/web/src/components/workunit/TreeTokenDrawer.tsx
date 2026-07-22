// TreeTokenDrawer - 树级 token 开销展示（AC-5.4 ~ AC-5.7）
// 展示协作树内每 WU 的 token 开销 + 树总耗 + 预算剩余
import { useEffect, useState } from 'react';
import { workunitApi, type TreeTokenReport } from '../../api/workunit';

function formatTokens(n: number | null): string {
  if (n === null) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface Props {
  workUnitId: string;
  onClose: () => void;
}

export function TreeTokenDrawer({ workUnitId, onClose }: Props) {
  const [report, setReport] = useState<TreeTokenReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workunitApi
      .getTreeTokens(workUnitId)
      .then((res) => {
        if (!cancelled) {
          setReport(res.data);
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
    <div className="tree-token-drawer" aria-label="树级 token 开销">
      <div className="tree-token-drawer-head">
        <h4>树级 Token 开销</h4>
        <button className="tree-token-drawer-close" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className="tree-token-drawer-body">
        {loading && <p>加载中...</p>}
        {error && <p className="tree-token-error">加载失败: {error}</p>}
        {report && (
          <>
            <div className="tree-token-summary">
              <span>树总耗: <strong>{formatTokens(report.rootTotal)}</strong></span>
              <span>预算剩余: <strong>{formatTokens(report.budgetRemaining)}</strong></span>
            </div>
            <table className="tree-token-table">
              <thead>
                <tr>
                  <th>WorkUnit</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>注入</th>
                  <th>执行</th>
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {report.nodes.map((node) => (
                  <tr key={node.workUnitId}>
                    <td title={node.workUnitId}>{node.workUnitId.slice(0, 12)}</td>
                    <td>{node.profileName ?? '-'}</td>
                    <td>{node.status}</td>
                    <td>{formatTokens(node.injectedTokens)}</td>
                    <td>{formatTokens(node.executionTokens)}</td>
                    <td>{formatTokens(node.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
