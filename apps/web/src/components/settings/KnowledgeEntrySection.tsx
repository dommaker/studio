// 公司知识库入口 section（从 pages/Settings.tsx 抽取，工单 35-E3）

export function KnowledgeEntrySection() {
  return (
    <section className="space-y-4">
      <h2 className="mc-block-label" style={{ margin: 0 }}>📚 公司知识库</h2>
      <div className="card p-4">
        <p className="text-sm mb-4 u-text-2">管理公司所有项目的文档资产</p>
        <div className="flex gap-3">
          <button onClick={() => {
            const companyId = localStorage.getItem('companyId') || '';
            window.location.href = `/knowledge?companyId=${companyId}`;
          }} className="btn btn-primary">查看知识库 →</button>
          <button onClick={() => { window.location.href = '/knowledge/import'; }}
            className="btn btn-secondary">
            📥 冷启动导入
          </button>
        </div>
      </div>
    </section>
  );
}
