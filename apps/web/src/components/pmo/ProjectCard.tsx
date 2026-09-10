// PMO 项目卡片 — 编号 / 徽章（状态词 · 杂务 · 交付策略 · WU 完成度）/ 进度 / 发起讨论（从 pages/PMOPage.tsx 抽出，纯代码移动）
// #149（2026-08-15）：文档计数徽章随 document-store 退役移除
// #472：状态词 / 交付策略走 projectDisplay 唯一词表（原卡片无状态词、策略裸输出 auto-merge）
// 2026-09-10 第二轮重设计：横向行卡 → 竖向网格卡（PMOPage 双列网格消费）——
// 顶行编号+状态徽标、标题、描述 2 行截断、卡底进度条 + 元信息行，视觉层级自上而下递减。
import { useNavigate } from 'react-router-dom';
import type { Channel } from '../../api/channel';
import type { Project } from './types';
import { DELIVERY_POLICY_LABELS, PROJECT_STATUS_COLORS, PROJECT_STATUS_LABELS } from './projectDisplay';

interface ProjectCardProps {
  project: Project;
  wuStats: Record<string, { finished: number; total: number }>;
  channels: Channel[];
  handlePublishClick: (e: React.MouseEvent, projectId: string) => void;
}

export function ProjectCard({ project, wuStats, channels, handlePublishClick }: ProjectCardProps) {
  const navigate = useNavigate();
  return (
    <div
      className="card p-4 cursor-pointer flex flex-col gap-2"
      onClick={() => navigate(`/pmo/project/${project.id}`)}
    >
      {/* 顶行：编号徽标 + 状态词 + 杂务；右侧进度百分比 */}
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 rounded text-xs font-bold u-accent-bg font-mono">
          {project.pmoNumber}
        </span>
        {/* #472：状态词上卡片，词色同源 projectDisplay */}
        <span className={`text-xs px-1.5 py-0.5 rounded ${PROJECT_STATUS_COLORS[project.status] ?? 'u-surface-2 u-text'}`}>
          {PROJECT_STATUS_LABELS[project.status] ?? project.status}
        </span>
        {/* 🆕 PMO-a: 杂务徽章 */}
        {project.isChore && (
          <span className="text-xs px-1.5 py-0.5 rounded u-warn-dim">杂务</span>
        )}
        <span className="ml-auto text-xs u-text-3 font-mono">{project.progress}%</span>
      </div>

      {/* 标题 + 描述（2 行截断） */}
      <div className="font-medium u-text">{project.title}</div>
      <div className="text-xs u-text-2 line-clamp-2">
        {project.description || '无描述'}
        {/* 🆕 PMO-a: 交付策略小字标注（#472：走唯一词表，不裸输出策略值） */}
        {project.deliveryPolicy && (
          <span className="ml-1">· {DELIVERY_POLICY_LABELS[project.deliveryPolicy] ?? project.deliveryPolicy}</span>
        )}
      </div>

      {/* 卡底：全宽进度条 + 元信息行（任务完成度 / OKR / 发起讨论） */}
      <div className="mt-auto">
        <div className="h-1.5 rounded-full u-surface-2">
          <div
            className="h-1.5 rounded-full u-ok-bg"
            style={{ width: `${project.progress}%` }}
          />
        </div>
        <div className="flex items-center gap-2 mt-2">
          {/* 🆕 AC-6: 任务完成度徽章（#399 §8.3：WU→「任务」；数据缺失/为 0 不显示） */}
          {wuStats[project.id] && wuStats[project.id].total > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-2">
              任务 {wuStats[project.id].finished}/{wuStats[project.id].total}
            </span>
          )}
          {project.OKR && (
            <span className="text-xs px-2 py-0.5 rounded u-accent-dim truncate">
              {project.OKR.title}
            </span>
          )}
          {project.status === 'pending' && (
            <button
              onClick={(e) => handlePublishClick(e, project.id)}
              disabled={channels.length === 0}
              className="btn btn-primary btn-sm ml-auto"
              title={channels.length === 0 ? '无可用 Channel' : '选择频道，发起需求讨论'}
            >
              发起讨论
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
