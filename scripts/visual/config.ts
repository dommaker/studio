// 截图采集配置（#391）：#379 基线 12 页 × 1920/1440/1280 三档默认态
// 依据：#390 决议（半机制）+ docs/specs/ui/redesign-2026-08.md §10.4

/** 带参页面的路径参数名，运行时经 API 发现填值 */
export type PageParam = 'channelId' | 'pmoId' | 'workUnitId' | 'agentProfileId' | 'libraryDocId' | 'workspaceId';

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
  // #400 补 A 档（spec §10.1 中原 12 页未覆盖的 4 页；无改版前基线，diff 记 missing-a 属预期）
  { name: 'audit-logs', path: '/audit-logs' },
  { name: 'library-doc', path: '/library/:libraryDocId', param: 'libraryDocId' },
  { name: 'workspace', path: '/workspaces/:workspaceId', param: 'workspaceId' },
  { name: 'setup-roles', path: '/setup/roles' },
  // NotFound 在认证壳内（未认证访问未知路径只会撞 guest wall），归 A 档认证页
  { name: 'notfound', path: '/no-such-page-visual-check' },
];

/** §10.2 B 档：未认证页（guest wall 外），登录弹框走 landing 交互态补拍 */
export const B_PAGES: PageTarget[] = [
  { name: 'landing', path: '/' },
  { name: 'forgot-password', path: '/forgot-password' },
  { name: 'reset-password', path: '/reset-password' },
  { name: 'auth-callback', path: '/auth/callback' },
];

export const WIDTHS = [1920, 1440, 1280] as const;

/** §10.2 B 档抽查宽度档（两档） */
export const B_WIDTHS = [1920, 1440] as const;

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
