// PMO 页面共享领域类型 — KR / OKR / Project（从 pages/PMOPage.tsx 抽出，纯代码移动）
export interface KR {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  metricType?: string;
}

export interface OKRObjective {
  id: string;
  title: string;
  description?: string;
}

export interface OKR {
  id: string;
  title: string;
  quarter: string;
  status: string;
  progress: number;
  projectCount: number;
  objectives?: OKRObjective[];
  keyResults?: KR[];
}

export interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description?: string;
  status: string;
  progress: number;
  createdAt: string;
  // 🆕 PMO-a: REQ 只读别名 / 交付策略 / 分支 / 杂务标记
  reqAlias?: string | null;
  deliveryPolicy?: string;
  gitBranch?: string | null;
  isChore?: boolean;
  OKR?: { id: string; title: string };
}
