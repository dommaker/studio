/**
 * 技能管理页面
 * 
 * 提供界面管理和配置 skills
 */

import React, { useEffect, useState } from 'react';
import { CreateToolStdModal } from '../components/CreateToolStdModal';
import { getApiBase } from '../utils/api';

interface SkillMeta {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  defaultWorkflow?: string;
  openclaw?: {
    userInvocable?: boolean;
    emoji?: string;
    command?: string;
    keywords?: string[];
  };
}

interface SkillsResponse {
  skills: SkillMeta[];
}

export const ToolsStdPage: React.FC = () => {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${getApiBase()}/skills`);
      const data: SkillsResponse = await response.json();
      setSkills(data.skills || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || '加载技能失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSuccess = () => {
    loadSkills();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="u-text-2">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <div className="u-err mb-4">{error}</div>
        <button
          onClick={loadSkills}
          className="px-4 py-2 u-accent-bg u-on-accent rounded u-hover-bg"
        >
          重试
        </button>
      </div>
    );
  }

  const renderSkillCard = (skill: SkillMeta) => (
    <div key={skill.id} className="u-surface border rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-2 mb-2">
        {skill.openclaw?.emoji && (
          <span className="text-xl">{skill.openclaw.emoji}</span>
        )}
        <h3 className="font-semibold">{skill.name}</h3>
        {skill.openclaw?.userInvocable && (
          <span className="text-xs u-ok-dim u-ok px-2 py-0.5 rounded">可调用</span>
        )}
      </div>
      <p className="text-sm u-text-2 mb-3">{skill.description}</p>
      <div className="flex flex-wrap gap-1 text-xs">
        {skill.keywords?.slice(0, 5).map((kw, i) => (
          <span key={i} className="u-surface-2 px-2 py-0.5 rounded">{kw}</span>
        ))}
      </div>
      {skill.openclaw?.command && (
        <div className="mt-2 text-xs u-text-2">
          命令: <code className="u-surface-2 px-1 rounded">{skill.openclaw.command}</code>
        </div>
      )}
    </div>
  );

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">技能管理</h1>
          <p className="u-text-2">
            管理和配置 Skills（用户意图 → 工作流路由）
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 u-accent-bg u-on-accent rounded-lg u-hover-bg flex items-center gap-2"
        >
          <span>🤖</span>
          <span>创建 Skill</span>
        </button>
      </div>

      {/* Stats */}
      <div className="u-accent-dim rounded-lg p-4 mb-6">
        <div className="text-2xl font-bold u-accent">{skills.length}</div>
        <div className="text-sm u-accent">已注册 Skills</div>
      </div>

      {/* Skills Grid */}
      {skills.length === 0 ? (
        <div className="text-center py-12 u-text-2">
          暂无 Skills，点击右上角按钮创建
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {skills.map(renderSkillCard)}
        </div>
      )}

      {/* Create Skill Modal */}
      <CreateToolStdModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
};

export default ToolsStdPage;
