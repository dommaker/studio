/** AgentLoop 各段的窄依赖端口（ARCH-05）。运行状态由对应段 owner 持有。 */
import type { AgentProfileData, FileStore } from '@dommaker/studio-shared';
import type { WorkUnitService, WorkUnitData, ExecutionJournal } from '../../workunit/index.js';
import type { MessageMeta } from '../../channels/index.js';
import type { Executor } from '../executor.js';
import type { RuntimeInstanceRow } from '../agent-loop.types.js';

export type LoopWorkUnitPort = Pick<
  WorkUnitService,
  'create' | 'getById' | 'update' | 'claim' | 'transitionStatus' | 'blockForAllUnfit'
>;

export interface DiscussionPort {
  postToDiscussionSpace(
    workUnitId: string,
    content: string,
    milestoneWu?: WorkUnitData,
    extraMeta?: MessageMeta,
  ): Promise<void>;
}

export interface LeasePort {
  ensure(wu: WorkUnitData): void;
  stop(): void;
  stillHolds(wuId: string): Promise<boolean>;
  handleLost(wuId: string, reason: 'lost' | 'missing'): Promise<void>;
  transitionIfHeld(wuId: string, status: string): Promise<boolean>;
  releaseIfForfeited(wuId: string): Promise<void>;
}

export interface LifecycleDeps {
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  readonly executor: Executor;
  runLoop(): Promise<void>;
  onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void;
  onWorkUnitClaimable(payload: unknown): void;
  wakeIdle(): void;
  stopLease(): void;
  getCurrentExecutionId(): string | null;
}

export interface ObserverDeps {
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  getInstance(): RuntimeInstanceRow | null;
  isAlive(): boolean;
}

export interface ClaimDeps {
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  readonly workUnits: LoopWorkUnitPort;
  getInstance(): RuntimeInstanceRow | null;
  readonly discussion: DiscussionPort;
}

export interface StepDeps {
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  readonly workUnits: LoopWorkUnitPort;
  readonly executionJournal: ExecutionJournal;
  readonly executor: Executor;
  readonly acceptedTypes: string[];
  readonly discussion: DiscussionPort;
  onAssignment(assignmentId: string, wu: WorkUnitData): void;
}

export interface ResultRecorderDeps {
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  readonly workUnits: LoopWorkUnitPort;
  readonly executionJournal: ExecutionJournal;
  readonly lease: LeasePort;
}
