// 知识库页面六类 Gap 明细卡片（2026-08 工单 34 从 pages/KnowledgePage.tsx 抽出，纯展示无逻辑变更）

export function PreferenceCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>👤</span>
        <span className="font-medium u-text">用户偏好</span>
        {item.responseStyle && <span className="text-xs px-2 py-0.5 rounded u-accent-bg">{item.responseStyle}</span>}
        {item.preferredModel && <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.preferredModel}</span>}
        <span className="text-xs ml-auto u-text-3">置信度: {Math.round((item.confidence || 0) * 100)}%</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        {item.activeHours?.length > 0 && <div><span className="u-text-3">活跃时段: </span><span className="u-text">{(item.activeHours || []).join(', ')}点</span></div>}
        {item.avgMessageLength && <div><span className="u-text-3">平均消息长度: </span><span className="u-text">{item.avgMessageLength} 字符</span></div>}
        {item.autoApproveThreshold !== undefined && <div><span className="u-text-3">自动审批阈值: </span><span className="u-text">{Math.round(item.autoApproveThreshold * 100)}%</span></div>}
      </div>
    </div>
  );
}

export function BusinessRuleCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>📏</span>
        <span className="font-medium u-text">{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">v{item.version}</span>
      </div>
      <p className="text-sm mb-1 u-text">{item.description}</p>
      <p className="text-xs u-text-3">
        {item.condition} → {item.action}
        {item.defaultValue && ` (默认: ${item.defaultValue})`}
        {' · '}{item.source}
      </p>
    </div>
  );
}

export function EnvSnapshotCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🖥️</span>
        <span className="font-medium u-text">环境快照</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.nodeEnv}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-sm">
        <div><span className="u-text-3">主机: </span><span className="u-text">{item.hostname}</span></div>
        <div><span className="u-text-3">平台: </span><span className="u-text">{item.platform}</span></div>
        <div><span className="u-text-3">Node: </span><span className="u-text">{item.nodeVersion}</span></div>
        <div><span className="u-text-3">端口: </span><span className="u-text">{item.apiPort}</span></div>
      </div>
      {(item.knownLimitations || []).length > 0 && (
        <div className="mt-2 text-xs u-warn">
          ⚠️ 已知限制: {(item.knownLimitations || []).map((l: any) => l.issue).join('; ')}
        </div>
      )}
      {item.diffFromPrev && <div className="mt-1 text-xs u-text-2">变更: {item.diffFromPrev}</div>}
    </div>
  );
}

export function DecisionChainCard({ item }: { item: any }) {
  const options = typeof item.options === 'string' ? JSON.parse(item.options) : (item.options || []);
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🔗</span>
        <span className="font-medium u-text">{item.topic}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">{item.sourceType}</span>
      </div>
      <p className="text-sm mb-1 u-text-2">{item.context}</p>
      <div className="text-sm">
        <span className="u-text-3">选择: </span>
        <span className="font-medium u-accent">{item.chosen}</span>
        {options.length > 0 && <span className="u-text-3"> (共 {options.length} 个方案)</span>}
      </div>
      <p className="text-xs mt-1 u-text-3">{item.rationale}</p>
      {item.tradeoffs && <p className="text-xs u-warn">权衡: {item.tradeoffs}</p>}
    </div>
  );
}

export function InteractionPatternCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>📊</span>
        <span className="font-medium u-text">{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">
          频次: {item.frequency}/天 · 置信度: {Math.round((item.confidence || 0) * 100)}%
        </span>
      </div>
      <p className="text-sm mb-1 u-text">{item.description}</p>
      {item.insight && <p className="text-sm u-accent">💡 {item.insight}</p>}
      {item.suggestion && <p className="text-xs u-text-2">建议: {item.suggestion}</p>}
    </div>
  );
}

export function ResolutionCard({ item }: { item: any }) {
  const statusClasses: Record<string, string> = {
    pending: 'u-warn-bg',
    verified: 'u-accent-bg',
    canonical: 'u-ok-bg',
    deprecated: 'u-surface-2 u-text-3',
  };
  const layerLabels: Record<string, string> = {
    L3_tool_behavior: 'L3 工具行为',
    L4_env_config: 'L4 环境配置',
    L5_error_fix: 'L5 错误解法',
    L6_causality: 'L6 因果关系',
  };

  let tags: string[] = [];
  try { tags = typeof item.tags === 'string' ? JSON.parse(item.tags) : (item.tags || []); } catch { /* ignore */ }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🔧</span>
        <span className="font-medium u-text">{item.title}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${statusClasses[item.status] || 'u-surface-2 u-text-3'}`}>{item.status}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
          {layerLabels[item.layer] || item.layer}
        </span>
        <span className="text-xs ml-auto u-text-3">
          验证: {item.verifyCount}x
        </span>
      </div>
      <p className="text-xs mb-1 u-text-3">
        模式: <code className="px-1 rounded u-surface-2">{item.pattern}</code>
      </p>
      <p className="text-sm mb-2 u-text">{item.fix}</p>
      {tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {tags.map((t: string) => (
            <span key={t} className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">{t}</span>
          ))}
        </div>
      )}
      {item.errorClass && (
        <div className="text-xs mt-1 u-text-3">
          错误类型: {item.errorClass}
          {item.sourceGoalId && ` · 来源: ${item.sourceGoalId.slice(0, 8)}`}
        </div>
      )}
    </div>
  );
}
