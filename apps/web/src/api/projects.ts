// Projects API — #266（决策 #258）：工程发现候选 + 归属候选排除清单管理
// （排除清单服务端持久化到 ~/.studio/projects-exclude.json，保存后服务端主动 invalidateCache）
import { api } from './index';
import type { LocalProject } from './channel';

export type { LocalProject };

export const projectsApi = {
  /** 扫描发现的工程候选（已应用排除清单 + PMO 绑定排序） */
  discover: () => api.get<{ success: boolean; data: LocalProject[] }>('/projects/discover'),

  /** 读取归属候选排除清单 */
  getExclude: () => api.get<{ success: boolean; data: { exclude: string[] } }>('/projects/exclude'),

  /** 全量保存排除清单（设置页标记/取消「不再作为候选」） */
  saveExclude: (exclude: string[]) =>
    api.put<{ success: boolean; data: { exclude: string[] } }>('/projects/exclude', { exclude }),
};
