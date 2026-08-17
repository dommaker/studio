// PMO 项目卡片 — 编号 / 徽章（杂务 · 交付策略 · WU 完成度）/ 进度 / 发起讨论（从 pages/PMOPage.tsx 抽出，纯代码移动）
// #149（2026-08-15）：文档计数徽章随 document-store 退役移除
import { useNavigate } from 'react-router-dom';
import type { Channel } from '../../api/channel';
import type { Project } from './types';

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
      className="card p-3 cursor-pointer"
      onClick={() => navigate(`/pmo/project/${project.id}`)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="px-2 py-1 rounded text-sm font-bold u-accent-bg"
          >
            {project.pmoNumber}
          </div>
          <div>
            <div className="font-medium flex items-center gap-2 u-text">
              {project.title}
              {/* 🆕 PMO-a: 杂务徽章 */}
              {project.isChore && (
                <span className="text-xs px-1.5 py-0.5 rounded u-warn-dim">
                  杂务
                </span>
              )}
            </div>
            <div className="text-xs u-text-3">
              {project.description || '无描述'}
              {/* 🆕 PMO-a: 交付策略小字标注 */}
              {project.deliveryPolicy && (
                <span className="ml-2">
                  · {project.deliveryPolicy}
                </span>
              )}
              {/* 🆕 AC-6: WU 完成度徽章（数据缺失/为 0 不显示） */}
              {wuStats[project.id] && wuStats[project.id].total > 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded u-surface-2 u-text-2">
                  WU {wuStats[project.id].finished}/{wuStats[project.id].total}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 h-2 rounded-full u-surface-2">
            <div
              className="h-2 rounded-full u-ok-bg"
              style={{ width: `${project.progress}%` }}
            />
          </div>
          <span className="text-xs u-text-3">
            {project.progress}%
          </span>
          {project.OKR && (
            <span className="text-xs px-2 py-1 rounded u-accent-dim">
              {project.OKR.title}
            </span>
          )}
          {project.status === 'pending' && (
            <button
              onClick={(e) => handlePublishClick(e, project.id)}
              disabled={channels.length === 0}
              className="btn btn-primary btn-sm"
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
