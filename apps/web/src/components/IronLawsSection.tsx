/**
 * Iron Laws 展示组件
 * 
 * 显示 Studio 的核心卖点 — 约束驱动
 */
import { useState, useEffect } from 'react';

interface Constraint {
  id: string;
  rule: string;
  message: string;
  level: 'iron_law' | 'guideline' | 'tip';
  description?: string;
  trigger?: string | string[];
  enforcement?: string;
}

interface IronLawsResponse {
  success: boolean;
  data: Constraint[];
  count: number;
  source: string;
}

// 铁律 ID 到序号的映射（确保顺序正确）
const IRON_LAW_ORDER = [
  'no_bypass_checkpoint',
  'no_self_approval',
  'no_completion_without_verification',
  'no_test_simplification',
  'incremental_progress',
  'verify_external_capability',
  'no_implementation_without_requirement_review',  // 🆕 AS-018: Iron Law #7
];

export function IronLawsSection() {
  const [ironLaws, setIronLaws] = useState<Constraint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false); // 默认收起

  useEffect(() => {
    fetchIronLaws();
  }, []);

  async function fetchIronLaws() {
    try {
      const res = await fetch('/api/v1/iron-laws');
      const data: IronLawsResponse = await res.json();

      if (!data.success) {
        throw new Error('API returned error');
      }

      // 只显示 iron_law 层级，按预定义顺序排序
      const laws = data.data
        .filter((c: Constraint) => c.level === 'iron_law')
        .sort((a: Constraint, b: Constraint) => {
          const aIndex = IRON_LAW_ORDER.indexOf(a.id);
          const bIndex = IRON_LAW_ORDER.indexOf(b.id);
          return aIndex - bIndex;
        });

      setIronLaws(laws);
    } catch (err: any) {
      console.error('Failed to fetch iron laws:', err);
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🚨</span>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Iron Laws
          </h2>
        </div>
        <div className="p-4 rounded-xl text-center" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="loading-spinner mx-auto"></div>
          <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
            加载约束...
          </p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🚨</span>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Iron Laws
          </h2>
        </div>
        <div className="p-4 rounded-xl" style={{ background: 'var(--error-dim)', border: '1px solid var(--error-border)' }}>
          <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>
          <button onClick={fetchIronLaws} className="btn btn-secondary text-sm mt-2">
            重试
          </button>
        </div>
      </section>
    );
  }

  if (ironLaws.length === 0) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🚨</span>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Iron Laws
          </h2>
        </div>
        <div className="p-4 rounded-xl" style={{ background: 'var(--bg-tertiary)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            暂无 Iron Laws 数据
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {/* 标题 + 展开/收起按钮 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 p-4 rounded-xl transition-all hover:opacity-80"
        style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-subtle)',
          cursor: 'pointer',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-2xl">🚨</span>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Iron Laws（约束驱动核心）
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
            {ironLaws.length} 条
          </span>
          <span className="text-xl transition-transform" style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            ▼
          </span>
        </div>
      </button>

      {/* 展开内容 */}
      {!expanded && (
        <p className="text-sm px-4" style={{ color: 'var(--text-tertiary)' }}>
          点击展开查看 {ironLaws.length} 条质量铁律 →
        </p>
      )}

      {expanded && (
        <>
          {/* 描述 */}
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Studio 的质量保证系统 — 禁止跳过验证、禁止自评通过、禁止简化测试
          </p>

      {/* Iron Laws 卡片 */}
          <div className="grid gap-3">
            {ironLaws.map((law, index) => (
              <div
                key={law.id}
                className="p-4 rounded-xl transition-all hover:scale-[1.01]"
                style={{
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {/* 标题行 */}
                <div className="flex items-center gap-2 mb-2">
                  <span style={{ color: 'var(--success)' }}>✅</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    #{index + 1} {law.message}
                  </span>
                </div>

                {/* 英文规则 */}
                <div className="text-xs mb-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>
                  {law.rule}
                </div>

                {/* 描述 */}
                {law.description && (
                  <div className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                    {law.description.split('\n')[0]}  {/* 只显示第一行 */}
                  </div>
                )}

                {/* 触发条件（可选显示）*/}
                {law.trigger && (
                  <div className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
                    触发: {Array.isArray(law.trigger) ? law.trigger.join(', ') : law.trigger}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 来源信息 */}
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <span>来源:</span>
            <code className="px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>
              @dommaker/harness
            </code>
            <span>• {ironLaws.length} 条 Iron Laws</span>
          </div>
        </>
      )}
    </section>
  );
}

export default IronLawsSection;