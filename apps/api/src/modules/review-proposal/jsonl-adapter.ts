/**
 * review-proposal/jsonl-adapter — JSONL 存储路径 adapter 工厂（代码库清理 P2.2）
 *
 * 收拢三家同构业务 adapter（agent-auditor #356 / knowledge #355 / skills #354）的
 * 装配样板：register(deps?) 的 fileStore/dataDir 缺省解析（getStore()/studioDir()，
 * register 时解析——勿 import 期捕获，同 core/store.ts 规矩）、get() 自助注册兜底、
 * submit() 补 id/createdAt 走正本 submitProposal（append-only → 发卡 → card-failed 墓碑）。
 * 各域真正不同的只有卡片渲染与 approve/reject 语义，留在各自 config。
 * 存储形态例外域（role-memory #353 per-role draft.jsonl / evolution #623 EP-XXXX.json）
 * 走 registry 自定义 store 路径，不经本工厂。
 */
import { randomUUID } from 'node:crypto';
import type { FileStore } from '@dommaker/studio-shared';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../core/store.js';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from './registry.js';
import { submitProposal } from './service.js';
import type { ReviewProposalBase, ReviewProposalRecord } from './store.js';

/** JSONL 存储路径 adapter 的业务差异面（各域真正不同的只有这些） */
export interface JsonlReviewAdapterConfig<P extends ReviewProposalBase> {
  /** 提案种类（通用端点 /:kind/ 分发键，全局唯一） */
  kind: string;
  /** 前端卡片渲染键（cardType） */
  cardType: string;
  /** store 命名空间：提案文件 = <dataDir>/<storeNamespace>.jsonl */
  storeNamespace: string;
  /** 卡片作者（缺省 'KK'；auditor 卡保持历史作者 'Auditor'，#356） */
  author?: string;
  /** 卡片内容渲染：提案 → 正文 + cardData */
  renderCardContent(proposal: P): { content: string; cardData: Record<string, unknown> };
  /**
   * approve 后动作（唯一必须的业务副作用）；入参为审批前记录（status=pending）。
   * ctx.fileStore = 本次 register 解析出的实例——闭包必须跟注册时的 fileStore 走
   * （auditor onApprove 建工单用），不能模块级捕获。
   */
  onApprove(
    proposal: ReviewProposalRecord<P>,
    ctx: { fileStore: FileStore },
  ): Promise<ApproveOutcome>;
  /** reject 后动作（可选；墓碑由正本落，回调只做业务留痕） */
  onReject?(proposal: ReviewProposalRecord<P>): Promise<void>;
}

/** 工厂产物：注册 / 自取 / 建提案发卡 三件套 */
export interface JsonlReviewAdapterKit<P extends ReviewProposalBase> {
  /**
   * 注册 adapter（运行时装配调用；同 kind 重复注册后者生效，幂等）。
   * deps 缺省 fileStore=getStore() / dataDir=studioDir()。
   */
  register(deps?: { fileStore?: FileStore; dataDir?: string }): ReviewProposalAdapter<P>;
  /** 取 adapter（未注册则自助注册，幂等） */
  get(): ReviewProposalAdapter<P>;
  /**
   * 建提案（补 id/createdAt）+ 发卡（正本 submitProposal：append-only 落 pending →
   * 发卡 → 失败落 card-failed 墓碑）；发卡失败不抛（#101/#143 降级口径）。
   * deps 给时先按 deps 注册再用（auditor submit 旧语义：测试注入 fileStore 即注册）。
   */
  submit(
    input: Omit<P, 'id' | 'createdAt'>,
    deps?: { fileStore?: FileStore; dataDir?: string },
  ): Promise<{ proposalId: string; posted: boolean }>;
}

/**
 * 建 JSONL 存储路径 adapter 三件套。空载荷早退（auditor 空建议 / knowledge 空条目
 * 静默跳过）是各域业务语义，留在各自 submit 包装里，不进工厂。
 */
export function createJsonlReviewAdapter<P extends ReviewProposalBase>(
  config: JsonlReviewAdapterConfig<P>,
): JsonlReviewAdapterKit<P> {
  const register = (deps?: { fileStore?: FileStore; dataDir?: string }): ReviewProposalAdapter<P> => {
    const fileStore = deps?.fileStore ?? getStore();
    return registerReviewProposalAdapter<P>({
      ...config,
      dataDir: deps?.dataDir ?? studioDir(),
      fileStore,
      onApprove: proposal => config.onApprove(proposal, { fileStore }),
    });
  };
  const get = (): ReviewProposalAdapter<P> => getReviewProposalAdapter<P>(config.kind) ?? register();
  const submit = async (
    input: Omit<P, 'id' | 'createdAt'>,
    deps?: { fileStore?: FileStore; dataDir?: string },
  ): Promise<{ proposalId: string; posted: boolean }> => {
    const adapter = deps ? register(deps) : get();
    const proposal = { ...input, id: randomUUID(), createdAt: new Date().toISOString() } as P;
    const { posted } = await submitProposal(adapter, proposal);
    return { proposalId: proposal.id, posted };
  };
  return { register, get, submit };
}
