// AgentLoop 类型契约（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）：
// StepResult/Observations/Target/RuntimeInstanceRow。
// 纯类型模块，零运行时依赖；agent-loop.ts re-export 保持对外导出语义不变。
// KnowledgeSearchAnalysis 零生产调用方，工单 43 随 knowledge-search-analysis 一并删除。
import type { WorkUnitMetadata, WorkUnitData } from '../../workunit/workunit.service.js';
import type { ChannelMessageData } from '@dommaker/studio-shared';

/** Agent output action after parsing */
export interface StepResult {
  // 'failed': CLI 执行失败（runner 返回 success:false）的显式分支——记 consecutiveStuck、
  // 不发频道消息，达到 3 次走既有 blocked 路径（W-3 接线，见 agentStep）
  // 'skipped': B2 测试特征 WU 守卫 —— agentStep 已自行关闭 WU，recordResult 直接跳过
  action: 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed' | 'skipped';
  summary: string;
  /** A2A §4.1: DELEGATE 协议解析结果（action='delegate' 时存在） */
  delegate?: { targetName: string; scope: string };
  /** #279（决策 #250 D3）：NEED_INPUT 下一行 OPTIONS: 解析出的结构化选项，
   *  随频道提问消息 meta 发出供前端渲染选项卡；解析失败/缺失时为 undefined */
  options?: { label: string; description?: string; value?: string }[];
  /** §4.2 发言层新鲜度检查：step 开始时捕获的频道版本（agentStep 写入，recordResult 比对） */
  channelVersion?: { lineCount: number; lastMessageId: string | null };
  /** Metadata fields to merge into WorkUnit.metadata (set by agentStep, written atomically by recordResult) */
  metadataUpdates?: Partial<WorkUnitMetadata>;
}

/** Observation collected from DB */
export interface Observations {
  myActive: WorkUnitData[];
  unassigned: WorkUnitData[];
  newReplies: ChannelMessageData[];
}

/** Resolved target for agentStep */
export interface Target {
  workUnit: WorkUnitData;
  newReplies?: ChannelMessageData[];
}

export interface RuntimeInstanceRow {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
  terminatedAt: string | null;
  metadata: string | null;
  lastHeartbeat: string | null;
  /** F2：启动失败原因（与 studio-shared RuntimeStateData 同形，#312 起随 status_changed 负载外发） */
  lastError?: string | null;
  lastErrorAt?: string | null;
}
