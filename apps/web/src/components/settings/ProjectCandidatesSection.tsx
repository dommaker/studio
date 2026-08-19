// 工程候选管理 section（#266，决策 #258）：归属问答候选集排除清单管理。
// 候选工程列表项可标记/取消「不再作为候选」；保存走 PUT /projects/exclude 全量替换，
// 服务端保存后主动 invalidateCache，归属问答即时使用新清单。
// 组件形态仿 CompanySection/ComputeSection。
import { useEffect, useState } from 'react';
import { projectsApi, type LocalProject } from '../../api/projects';
import { toast } from '../../utils/toast';

export function ProjectCandidatesSection() {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([projectsApi.discover(), projectsApi.getExclude()])
      .then(([discoverRes, excludeRes]) => {
        setProjects(discoverRes.data?.data ?? []);
        setExclude(excludeRes.data?.data?.exclude ?? []);
      })
      .catch(err => { console.error('Failed to load project candidates:', err); toast.error('加载工程候选失败'); })
      .finally(() => setLoading(false));
  }, []);

  const save = (next: string[]) => {
    setSaving(true);
    projectsApi.saveExclude(next)
      .then(() => setExclude(next))
      .catch(err => { console.error('Failed to save exclude list:', err); toast.error('保存排除清单失败'); })
      .finally(() => setSaving(false));
  };

  // 候选区只展示未被排除的工程（排除规则按路径精确匹配；名称规则命中的按名称过滤）
  const isExcluded = (p: LocalProject) => exclude.includes(p.path) || exclude.includes(p.name);
  const candidates = projects.filter(p => !isExcluded(p));

  return (
    <section className="space-y-4">
      <h2 className="mc-block-label" style={{ margin: 0 }}>🗂️ 工程候选管理</h2>
      <p className="text-sm u-text-2">
        归属问答的候选工程集。标记「不再作为候选」后该工程不再出现在归属问答候选中
        （已绑定 PMO 的工程自动排在前面）；保存即时生效。
      </p>
      <div className="card p-4 space-y-4">
        {loading ? (
          <p className="text-sm u-text-2">加载中…</p>
        ) : (
          <>
            <div>
              <h3 className="text-sm font-medium mb-2 u-text-2">候选工程</h3>
              {candidates.length === 0 ? (
                <p className="text-sm u-text-2">暂无候选工程</p>
              ) : (
                <ul className="space-y-2">
                  {candidates.map(p => (
                    <li key={p.path} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{p.name}</div>
                        <div className="text-xs u-text-2 truncate">{p.path}</div>
                      </div>
                      <button
                        disabled={saving}
                        onClick={() => save([...exclude, p.path])}
                        className="btn btn-secondary text-sm shrink-0"
                      >不再作为候选</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {exclude.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2 u-text-2">已排除（不作为候选）</h3>
                <ul className="space-y-2">
                  {exclude.map(rule => (
                    <li key={rule} className="flex items-center justify-between gap-3">
                      <div className="text-xs u-text-2 truncate">{rule}</div>
                      <button
                        disabled={saving}
                        onClick={() => save(exclude.filter(r => r !== rule))}
                        className="btn btn-secondary text-sm shrink-0"
                      >恢复候选</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
