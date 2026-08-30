// TreeTokenChart — #396 WU 详情页 Token 开销图表化（spec §5.4，零图表库手搓）
// 入口 = 左栏关键事实卡 Token 行（mono 总耗 + 迷你预算占比条，整行可点）；
// 面板 = Modal：双 stat（树总耗/预算剩余）+ 预算占比条 + per-node 水平堆叠条图
// （注入=accent / 执行=--chart-2 两段分色，按总耗降序，附图例）。
// 数据 = workunitApi.getTreeTokens，TreeTokenEntry 内拉取一次，事实行与面板共享。
// 头栏「Token 开销」按钮已撤（#396）；TreeTokenDrawer 素表格弹框仍服务频道抽屉。
import { useEffect, useState } from 'react';
import { workunitApi, type TreeTokenReport } from '../../api/workunit';
import { Modal } from '../ui/Modal';
import { formatStepTokens } from '../../utils/executionSteps';

function formatTokens(n: number | null): string {
  if (n === null) return '-';
  return formatStepTokens(n);
}

/** 状态 → 色点（展示用直映射，与生命周期站点语义无关，不过 deriveDisplayState） */
function statusDotColor(status: string): string {
  switch (status) {
    case 'done': return 'var(--accent-primary)';
    case 'in_review': return 'var(--warning)';
    case 'active':
    case 'unassigned': return 'var(--info)';
    case 'blocked': return 'var(--error)';
    default: return 'var(--text-muted)'; // closed 等
  }
}

/** 左栏「关键事实」卡 Token 行：总耗 + 迷你预算占比条，整行可点 */
export function TreeTokenFactRow({ report, onOpen }: { report: TreeTokenReport | null; onOpen: () => void }) {
  const budget = report ? report.rootTotal + report.budgetRemaining : 0;
  const usedPct = report && budget > 0 ? (report.rootTotal / budget) * 100 : 0;
  return (
    <button className="wu-token-fact" onClick={onOpen} title="查看协作树 Token 开销图表">
      <span className="wu-token-fact-v">{report ? formatTokens(report.rootTotal) : '-'}</span>
      {report && budget > 0 && (
        <span className="wu-token-minibar">
          <span className="wu-token-minibar-used" style={{ width: `${usedPct}%` }} />
        </span>
      )}
    </button>
  );
}

/** 图表面板（Modal 内容）：双 stat + 预算用量条 + per-node 堆叠条图 */
export function TreeTokenPanel({ report, onClose }: { report: TreeTokenReport | null; onClose: () => void }) {
  const nodes = report ? [...report.nodes].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0)) : [];
  const maxTotal = nodes.reduce((m, n) => Math.max(m, n.totalTokens ?? 0), 0);
  const budget = report ? report.rootTotal + report.budgetRemaining : 0;
  const usedPct = report && budget > 0 ? (report.rootTotal / budget) * 100 : 0;

  return (
    <Modal open onClose={onClose} maxWidth="640px" title="协作树 Token 开销">
      {!report ? (
        <p className="text-sm u-text-3">加载中...</p>
      ) : (
        <div className="wu-token-panel">
          <div className="wu-exec-stats">
            <div className="wu-exec-stat">
              <span className="wu-exec-stat-k">树总耗</span>
              <span className="wu-exec-stat-num">{formatTokens(report.rootTotal)}</span>
            </div>
            <div className="wu-exec-stat">
              <span className="wu-exec-stat-k">预算剩余</span>
              <span className="wu-exec-stat-num">{formatTokens(report.budgetRemaining)}</span>
            </div>
          </div>
          {budget > 0 && (
            <div className="wu-token-budget">
              <div className="wu-token-budget-bar">
                <span className="wu-token-budget-used" style={{ width: `${usedPct}%` }} />
              </div>
              <div className="wu-token-budget-caption">
                已用 {formatTokens(report.rootTotal)} / 预算 {formatTokens(budget)}（{usedPct.toFixed(0)}%）
              </div>
            </div>
          )}
          <div className="wu-token-rows">
            {nodes.map(n => {
              const total = n.totalTokens ?? 0;
              const widthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
              const injPct = total > 0 ? ((n.injectedTokens ?? 0) / total) * 100 : 0;
              return (
                <div key={n.workUnitId} className="wu-token-row">
                  <span className="wu-token-row-id" title={n.workUnitId}>{n.workUnitId.slice(0, 8)}</span>
                  <span className="wu-token-row-dot" style={{ background: statusDotColor(n.status) }} />
                  <span className="wu-token-row-name">{n.profileName ?? '-'}</span>
                  <span className="wu-token-row-bar">
                    <span className="wu-token-row-fill" style={{ width: `${widthPct}%` }}>
                      <span className="wu-token-seg-inj" style={{ width: `${injPct}%` }} />
                      <span className="wu-token-seg-exec" style={{ width: `${100 - injPct}%` }} />
                    </span>
                  </span>
                  <span className="wu-token-row-v">{formatTokens(n.totalTokens)}</span>
                </div>
              );
            })}
          </div>
          <div className="wu-token-legend">
            <span><span className="wu-token-legend-swatch wu-token-seg-inj" />注入</span>
            <span><span className="wu-token-legend-swatch wu-token-seg-exec" />执行</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 详情页集成入口：拉取一次（事实行与面板共享），渲染事实行 + 按需图表面板 */
export function TreeTokenEntry({ workUnitId }: { workUnitId: string }) {
  const [report, setReport] = useState<TreeTokenReport | null>(null);
  const [showPanel, setShowPanel] = useState(false);

  useEffect(() => {
    let alive = true;
    setReport(null);
    workunitApi.getTreeTokens(workUnitId)
      .then(res => { if (alive) setReport(res.data); })
      .catch(() => { /* best-effort：失败时行内显示 '-'，不阻塞页面 */ });
    return () => { alive = false; };
  }, [workUnitId]);

  return (
    <>
      <TreeTokenFactRow report={report} onOpen={() => setShowPanel(true)} />
      {showPanel && <TreeTokenPanel report={report} onClose={() => setShowPanel(false)} />}
    </>
  );
}
