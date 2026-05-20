// Stage Tabs Component - UI-001~003
import React from 'react';

export type Stage = 'plan' | 'develop' | 'verify' | 'deploy' | 'fix' | 'govern';

export const STAGE_CONFIG: Record<Stage, { name: string; icon: string }> = {
  plan: { name: '规划', icon: '📋' },
  develop: { name: '开发', icon: '💻' },
  verify: { name: '验证', icon: '✅' },
  deploy: { name: '部署', icon: '🚀' },
  fix: { name: '修复', icon: '🔧' },
  govern: { name: '治理', icon: '⚖️' },
};

export default function StageTabs({ activeStage, setActiveStage, workflows, stageCategories }: {
  activeStage: Stage | 'all';
  setActiveStage: (stage: Stage | 'all') => void;
  workflows: any[];
  stageCategories: any;
}) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <button
        onClick={() => setActiveStage('all')}
        className="px-3 py-1.5 text-sm font-medium rounded transition-all"
        style={{
          background: activeStage === 'all' ? 'var(--accent-primary)' : 'transparent',
          color: activeStage === 'all' ? 'white' : 'var(--text-secondary)',
        }}
      >
        全部 ({workflows.length})
      </button>
      {(Object.keys(STAGE_CONFIG) as Stage[]).map(stage => {
        const config = STAGE_CONFIG[stage];
        const stageData = stageCategories?.find((s: any) => s.id === stage);
        const count = stageData?.workflows?.length || 0;
        
        return (
          <button
            key={stage}
            onClick={() => setActiveStage(stage)}
            className="px-3 py-1.5 text-sm font-medium rounded transition-all whitespace-nowrap"
            style={{
              background: activeStage === stage ? 'var(--accent-primary)' : 'transparent',
              color: activeStage === stage ? 'white' : 'var(--text-secondary)',
            }}
          >
            {config.icon} {config.name} ({count})
          </button>
        );
      })}
    </div>
  );
}