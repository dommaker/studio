// Projects API — #266（决策 #258）：工程发现候选 + 归属候选排除清单管理
// （排除清单服务端持久化到 ~/.studio/projects-exclude.json，保存后服务端主动 invalidateCache）
// 契约驱动迁移（2026-10 批次 2/7）：LocalProject 类型 import 自 @dommaker/studio-contract
// （原经 api/channel 手抄再 re-export 删除）；响应统一 { data } 壳（原 { success, data } 平铺壳，
// 消费方原本就读 res.data.data，运行时解包不变）。
import type { LocalProject } from '@dommaker/studio-contract';
import { api } from './index';

export type { LocalProject };

export const projectsApi = {
  /** 扫描发现的工程候选（已应用排除清单 + PMO 绑定排序） */
  discover: () => api.get<{ data: LocalProject[] }>('/projects/discover'),

  /** 读取归属候选排除清单 */
  getExclude: () => api.get<{ data: { exclude: string[] } }>('/projects/exclude'),

  /** 全量保存排除清单（设置页标记/取消「不再作为候选」） */
  saveExclude: (exclude: string[]) =>
    api.put<{ data: { exclude: string[] } }>('/projects/exclude', { exclude }),
};
