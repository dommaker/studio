// SkillPanel.tsx - 技能面板组件（深色主题）
import { useEffect } from 'react';
import { useWorkflowEditorStore, type Skill } from '../stores/workflowEditorStore';

interface ToolStdPanelProps {
  onAddNode: (skill: Skill) => void;
}

export function ToolStdPanel({ onAddNode }: ToolStdPanelProps) {
  const { skills, skillsLoading, skillsError, loadSkills } = useWorkflowEditorStore();

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  if (skillsLoading) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>技能列表</h3>
        <div className="flex items-center justify-center py-8">
          <div className="loading-spinner"></div>
        </div>
      </div>
    );
  }

  if (skillsError) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>技能列表</h3>
        <div className="card p-3" style={{ borderColor: 'rgba(239, 68, 68, 0.3)', color: 'var(--error)' }}>
          {skillsError}
        </div>
        <button onClick={loadSkills} className="btn btn-primary w-full mt-3">重试</button>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>技能列表</h3>
        <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>暂无可用技能</div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>技能列表</h3>
      
      <div className="mb-4 p-3 rounded-lg text-xs" style={{ background: 'rgba(0, 212, 255, 0.08)', color: 'var(--accent-primary)' }}>
        💡 点击技能添加到画布
      </div>
      
      <div className="space-y-2">
        {skills.map((skill) => (
          <button
            key={skill.id}
            onClick={() => onAddNode(skill)}
            className="w-full p-3 rounded-lg text-left transition-all"
            style={{ 
              background: 'var(--bg-tertiary)', 
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            <div className="font-medium text-sm">{skill.name}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{skill.description}</div>
            {skill.agent && (
              <div className="text-xs mt-1" style={{ color: 'var(--accent-primary)' }}>
                {skill.agent === 'codex' ? '🤖 Codex' : '🧠 Claude'}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ToolStdPanel;
