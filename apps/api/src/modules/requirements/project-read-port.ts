/**
 * ARCH-04 Requirements 消费的项目只读端口。接口归调用方，PMO 实现由 bootstrap 装配；
 * 本文件不得 import PMO，也不得用动态 import 隐蔽回退。
 */

export type ProjectDeliveryPolicy = 'auto-merge' | 'branch-only';
export type ProjectDeliveryLegStatus = 'pending' | 'active' | 'in_review' | 'completed' | 'delivered';

export interface ProjectDeliveryLeg {
  gitRepo: string | null;
  branch: string | null;
  status: ProjectDeliveryLegStatus;
  deliveredAt?: string | null;
  deliverCommit?: string | null;
}

/** Requirements 读链所需的最小项目模型；PMO ProjectData 以结构类型满足此端口。 */
export interface ProjectReadData {
  id: string;
  pmoNumber: string;
  reqAlias?: string | null;
  title: string;
  description: string | null;
  requirementsDocId: string | null;
  status: string;
  channelId?: string | null;
  createdAt: string;
  isChore?: boolean;
  gitBranch: string | null;
  gitRepo: string | null;
  deliveredAt?: string | null;
  deliveryPolicy?: ProjectDeliveryPolicy;
  deliveries?: ProjectDeliveryLeg[];
}

export interface ProjectReadPort {
  get(projectId: string): Promise<ProjectReadData | null>;
  getByReqAlias(reqId: string): Promise<ProjectReadData | null>;
  getByPmoNumber(pmoNumber: string): Promise<ProjectReadData | null>;
  findChoreProject(channelId: string): Promise<ProjectReadData | null>;
  list(options?: { limit?: number }): Promise<ProjectReadData[]>;
  resolveDeliveries(project: ProjectReadData): ProjectDeliveryLeg[];
  resolveDeliveryPolicy(project: ProjectReadData): ProjectDeliveryPolicy;
  matchWuToLeg(metadata: string | null | undefined, leg: ProjectDeliveryLeg): boolean;
}

let port: ProjectReadPort | null = null;
type ProjectReadPortLoader = () => Promise<void>;
let loader: ProjectReadPortLoader | null = null;

export function registerProjectReadPort(next: ProjectReadPort): void {
  port = next;
}

/** 测试专用轻量组合加载；生产不注册 loader，组合根缺失必须 fail-fast。 */
export function registerProjectReadPortLoader(next: ProjectReadPortLoader | null): void {
  loader = next;
}

export function resetProjectReadPort(): void {
  port = null;
  loader = null;
}

export async function projectReadPort(): Promise<ProjectReadPort> {
  if (!port && loader) await loader();
  if (!port) throw new Error('ProjectReadPort 未注册（bootstrap/module-sinks 应完成装配）');
  return port;
}
