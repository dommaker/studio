// 截图采集配置（#391）：#379 基线 12 页 × 1920/1440/1280 三档默认态
// 依据：#390 决议（半机制）+ docs/specs/ui/redesign-2026-08.md §10.4

/** 带参页面的路径参数名，运行时经 API 发现填值 */
export type PageParam = 'channelId' | 'pmoId' | 'workUnitId' | 'agentProfileId';

export interface PageTarget {
  /** 截图文件名片段，需唯一 */
  name: string;
  /** 路由路径，:param 由 capture 运行时替换 */
  path: string;
  param?: PageParam;
}

export const PAGES: PageTarget[] = [
  { name: 'channels', path: '/channels' },
  { name: 'channel-detail', path: '/channels/:channelId', param: 'channelId' },
  { name: 'pmo', path: '/pmo' },
  { name: 'pmo-project', path: '/pmo/project/:pmoId', param: 'pmoId' },
  { name: 'workunits', path: '/workunits' },
  { name: 'workunit-detail', path: '/workunits/:workUnitId', param: 'workUnitId' },
  { name: 'agents', path: '/agents' },
  { name: 'agent-detail', path: '/agents/:agentProfileId', param: 'agentProfileId' },
  { name: 'monitoring', path: '/monitoring' },
  { name: 'knowledge', path: '/knowledge' },
  { name: 'library', path: '/library' },
  { name: 'settings', path: '/settings' },
];

export const WIDTHS = [1920, 1440, 1280] as const;

/** 截图高度：宽度档对应的常见视口高；1024/768/640/375 为 #395 窄屏走查档（--widths 启用） */
export const HEIGHTS: Record<number, number> = {
  1920: 1080, 1440: 900, 1280: 800,
  1024: 768, 768: 1024, 640: 960, 375: 812,
};

/** 截图 run 输出根（.studio/* 已 gitignore，满足"基线 PNG 不入 git"） */
export const RUNS_DIR = '.studio/visual';

/** diff 报告输出根（入 git 作验收凭据） */
export const REPORTS_DIR = 'docs/visual-reports';

/** 假时钟固定日期：拍前 setFixedTime，让 SSE 当前时刻/相对时间可复现 */
export const FIXED_TIME = '2026-08-28T09:00:00+08:00';

export function shotFileName(pageName: string, width: number): string {
  return `${pageName}-${width}.png`;
}
