// PMO 项目行 — 编号 / 徽章（状态词 · 杂务 · 交付策略 · WU 完成度）/ 进度 / 发起讨论（从 pages/PMOPage.tsx 抽出）
// #149（2026-08-15）：文档计数徽章随 document-store 退役移除
// #472：状态词 / 交付策略走 projectDisplay 唯一词表（原卡片无状态词、策略裸输出 auto-merge）
// 2026-09-10 第二轮 v2：双列大卡 → 紧凑行（pmo.css .pmo-row）——项目多了也可扫读；
// 左侧 3px 状态色条与状态徽章同语义，编号走 mono 中性 chip（accent 留给主行动，§4.8）。
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
      className="pmo-row"
      data-status={project.status}
      onClick={() => navigate(`/pmo/project/${project.id}`)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/pmo/project/${project.id}`)}
    >
      {/* 主档：行1 = 编号 + 标题 + 状态/杂务徽章；行2 = 描述（截断）+ 交付策略 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="pmo-num">{project.pmoNumber}</span>
          <span className="pmo-title">{project.title}</span>
          {/* #472：状态词上行，词色同源 projectDisplay */}
          <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${PROJECT_STATUS_COLORS[project.status] ?? 'u-surface-2 u-text'}`}>
            {PROJECT_STATUS_LABELS[project.status] ?? project.status}
          </span>
          {/* 🆕 PMO-a: 杂务徽章 */}
          {project.isChore && (
            <span className="text-xs px-1.5 py-0.5 rounded u-warn-dim shrink-0">杂务</span>
          )}
        </div>
        <div className="pmo-desc mt-0.5">
          {project.description || '无描述'}
          {/* 🆕 PMO-a: 交付策略小字标注（#472：走唯一词表，不裸输出策略值） */}
          {project.deliveryPolicy && (
            <span className="ml-1">· {DELIVERY_POLICY_LABELS[project.deliveryPolicy] ?? project.deliveryPolicy}</span>
          )}
        </div>
      </div>

      {/* 右档：任务完成度 / OKR / 进度 / 发起讨论，右对齐成列 */}
      {/* 🆕 AC-6: 任务完成度徽章（#399 §8.3：WU→「任务」；数据缺失/为 0 不显示） */}
      {wuStats[project.id] && wuStats[project.id].total > 0 && (
        <span className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-2 shrink-0">
          任务 {wuStats[project.id].finished}/{wuStats[project.id].total}
        </span>
      )}
      {project.OKR && (
        <span className="text-xs px-2 py-0.5 rounded u-accent-dim shrink-0 max-w-40 truncate">
          {project.OKR.title}
        </span>
      )}
      <div className="pmo-progress">
        <div className="pmo-progress-bar">
          <div className="pmo-progress-fill" style={{ width: `${project.progress}%` }} />
        </div>
        <span className="pmo-progress-num">{project.progress}%</span>
      </div>
      {project.status === 'pending' && (
        <button
          onClick={(e) => handlePublishClick(e, project.id)}
          disabled={channels.length === 0}
          className="btn btn-primary btn-sm shrink-0"
          title={channels.length === 0 ? '无可用 Channel' : '选择频道，发起需求讨论'}
        >
          发起讨论
        </button>
      )}
    </div>
  );
}
