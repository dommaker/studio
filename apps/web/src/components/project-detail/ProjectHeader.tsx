// 项目头部 — 返回/标题/OKR/REQ 别名/原始需求折叠/状态 stepper + 去频道 + 模式识别
// 从 ProjectDetailPage 抽出；PROJECT_STEPS 常量随本区块搬走
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { maintenanceApi } from '../../api/maintenance';
import { PmoNumberBadge } from '../PmoNumberBadge';
import { ManualTaskButton } from '../ui';
import type { Project } from './types';

// 🆕 AC-5: 项目状态 stepper（讨论 → 进行中 → 待验收 → 已交付；delivered 归并到 completed）
const PROJECT_STEPS = [
  { key: 'pending', label: '讨论' },
  { key: 'active', label: '进行中' },
  { key: 'in_review', label: '待验收' },
  { key: 'completed', label: '已交付' },
] as const;

interface Props {
  project: Project;
  projectId: string | undefined;
  requirementExpanded: boolean;
  setRequirementExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}

export function ProjectHeader({ project, projectId, requirementExpanded, setRequirementExpanded }: Props) {
  const navigate = useNavigate();
  return (
    <div className="mb-6">
      <button
        onClick={() => navigate('/pmo')}
        className="btn btn-ghost btn-sm mb-2"
      >
        ← 返回
      </button>
      <div className="flex items-center gap-3 mb-2">
        <PmoNumberBadge pmoNumber={project.pmoNumber} status={project.status as any} size="lg" />
        <h1 className="page-title">{project.title}</h1>
      </div>
      <p className="u-text-2">{project.description || '无描述'}</p>
      {project.OKR && (
        <div className="text-sm u-text-2 mt-1">
          OKR: {project.OKR.title} ({project.OKR.quarter})
        </div>
      )}
      {/* 🆕 PMO-a: REQ 别名 / 分支 / 交付策略（有值才显示） */}
      {(project.reqAlias || project.gitBranch || project.deliveryPolicy) && (
        <div className="text-sm u-text-2 mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {project.reqAlias && <span>REQ 别名: {project.reqAlias}</span>}
          {project.gitBranch && <span>分支: {project.gitBranch}</span>}
          {project.deliveryPolicy && (
            <span>
              交付策略: {project.deliveryPolicy === 'auto-merge' ? '自动合并' : '分支交付'}
            </span>
          )}
        </div>
      )}
      {/* 🆕 AC-5: 原始需求描述（可折叠，>120 字默认收起） */}
      {project.requirement && (
        <div className="mt-2 p-2 rounded u-surface-2">
          <div className="flex items-center justify-between">
            <span className="text-xs u-text-3">原始需求</span>
            {project.requirement.length > 120 && (
              <button
                onClick={() => setRequirementExpanded(v => !v)}
                className="text-xs u-accent"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {requirementExpanded ? '收起' : '展开'}
              </button>
            )}
          </div>
          <p className="text-sm u-text-2 mt-1 whitespace-pre-wrap">
            {requirementExpanded || project.requirement.length <= 120
              ? project.requirement
              : `${project.requirement.slice(0, 120)}…`}
          </p>
        </div>
      )}
      {/* 🆕 AC-5: 项目状态 stepper（当前阶段高亮）+ 去频道 */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {PROJECT_STEPS.map((s, i) => {
          const statusKey = project.status === 'delivered' ? 'completed' : project.status;
          const currentIdx = PROJECT_STEPS.findIndex(x => x.key === statusKey);
          return (
            <React.Fragment key={s.key}>
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  i === currentIdx ? 'u-accent-bg u-on-accent' :
                  currentIdx > i ? 'u-ok-dim u-ok' :
                  'u-surface-2 u-text-3'
                }`}
              >
                {s.label}
              </span>
              {i < PROJECT_STEPS.length - 1 && (
                <span className={`text-xs ${currentIdx > i ? 'u-ok' : 'u-text-3'}`}>→</span>
              )}
            </React.Fragment>
          );
        })}
        {project.status === 'cancelled' && (
          <span className="text-xs px-2 py-1 rounded u-err-dim u-err">已取消</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {project.channelId && (
            <button
              onClick={() => navigate(`/channels/${project.channelId}`)}
              className="btn btn-sm u-accent-dim u-accent u-hover-bg"
            >
              💬 去频道
            </button>
          )}
          <ManualTaskButton
            label="🔍 模式识别"
            onRun={async () => {
              const r = await maintenanceApi.runMesoEvolution(projectId!);
              return `识别完成：发现 ${r.total} 个模式`;
            }}
          />
        </div>
      </div>
    </div>
  );
}
