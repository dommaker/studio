/**
 * review-adapter (#353) — role-memory 人审提案 adapter（接线 review-proposal 正本）
 *
 * ADR 2026-08-25 决策落地：
 * - 决策 2（业务方只做 adapter）：各拷贝间真正不同的只有「卡片内容」（一批 manual 草稿聚合
 *   一张 memory_proposal 卡，cardData 形状同 #101 旧卡：roleId/entries/workUnitId/source）
 *   与「审批后动作」（onApprove→roleMemoryStore.promote / onReject→demote）；
 *   发卡（postReviewProposalCard）、approve/reject/status 生命周期、通用端点全部归正本。
 * - 决策 3（读侧归一）：提案 = 草稿条目（id=draftId），存取仍落 per-role draft.jsonl，
 *   存量历史行不改写；旧 promoted 墓碑读取时归一为 executed（foldDraftRows）。
 * - 决策 4（通用端点）：专有 /role-memory/promote|demote|draft-status 端点随本接线删除。
 *
 * 存储形态例外：正本默认物化 <dataDir>/<namespace>.jsonl 单文件，memory 保留 per-role
 * draft.jsonl（ADR 决策 3），故经 registry config.store 注入 MemoryProposalStore。
 * 条目行即提案行（plain 形态 = pending）；状态墓碑追加 kind:'status' 行。
 */
import fs from 'node:fs';
import * as path from 'node:path';
import { FileStore, logger } from '@dommaker/studio-shared';
import { postReviewProposalCard } from '../review-proposal/card.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/registry.js';
import {
  ReviewProposalStore,
  type ReviewProposalRecord,
  type ReviewProposalStatus,
} from '../review-proposal/store.js';
import {
  foldDraftRows,
  resolveTopicSlug,
  roleMemoryDir,
  roleMemoryRoot,
  roleMemoryStore,
  type AppendDraftInput,
  type MemoryDraftEntry,
  type MemoryDraftLine,
  type MemoryKind,
} from './role-memory.js';

/** kind → 人类可读标签（不暴露 execution-knowledge / preference 等内部分类词） */
const KIND_LABELS: Record<MemoryKind, string> = {
  'execution-knowledge': '经验做法',
  preference: '偏好约定',
};

/** 卡片条目：meta 指向文件 + 段落（供 approve/reject 接线 + 人审阅读）；形状同 #101 旧卡 */
export interface MemoryProposalCardEntry {
  draftId: string;
  roleId: string;
  title: string;
  topicSlug: string;
  /** 拟写入的记忆文件相对路径（topics/<slug>.md，相对 <roleMemory>/<roleId>/） */
  topicPath: string;
  kind: MemoryKind;
}

function toCardEntry(e: MemoryDraftEntry): MemoryProposalCardEntry {
  const topicSlug = resolveTopicSlug(e.title, e.topicSlug);
  return {
    draftId: e.id,
    roleId: e.roleId,
    title: e.title,
    topicSlug,
    topicPath: `topics/${topicSlug}.md`,
    kind: e.kind,
  };
}

/** 聚合卡渲染（自 #101 旧卡原样搬入：content/cardData 形状不变，前端零感知） */
function renderCard(
  cardEntries: MemoryProposalCardEntry[],
  ctx: { workUnitId?: string | null; source: string },
): { content: string; cardData: Record<string, unknown> } {
  const content = [
    '## 🧠 角色记忆提案 — 待确认',
    '',
    '以下内容建议沉淀为该角色的长期记忆（保存到其记忆文件）：',
    '',
    ...cardEntries.map((e, i) => `${i + 1}. **${e.title}**（${KIND_LABELS[e.kind] ?? e.kind}）`),
    '',
    ...cardEntries.map(e => `- ${e.title} → \`${e.topicPath}\``),
    '',
    `来源 WorkUnit: ${ctx.workUnitId ?? 'unknown'}`,
    '确认后写入该角色的记忆文件；丢弃则不写入。',
  ].join('\n');
  return {
    content,
    cardData: {
      roleId: cardEntries[0]?.roleId ?? null,
      entries: cardEntries,
      workUnitId: ctx.workUnitId ?? null,
      source: ctx.source,
    },
  };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

/**
 * memory 提案存取：per-role draft.jsonl（ADR 决策 3 存储正本，正本默认单文件物化不适用）。
 * 读侧归一（foldDraftRows）：旧 promoted/rejected 墓碑 → executed/rejected；kind:'status'
 * 状态行直取。提案 id = 草稿 id（全局唯一 UUID），按 id 定位时扫描全角色目录。
 */
export class MemoryProposalStore extends ReviewProposalStore<MemoryDraftEntry> {
  constructor(private fs: FileStore) {
    // 名义路径：per-role 存储覆盖全部 I/O，本文件永不落盘
    super(fs, path.join(roleMemoryRoot(), 'draft.jsonl'));
  }

  /** 提案行 = 草稿条目行：写路径唯一（appendDraft，kind 白名单 + sanitize 把关） */
  override async appendProposal(proposal: MemoryDraftEntry): Promise<void> {
    await roleMemoryStore.appendDraft(proposal.roleId, proposal);
  }

  /** 状态墓碑行追加到条目所属角色的 draft.jsonl（先按 id 定位角色） */
  override async appendStatus(id: string, status: ReviewProposalStatus): Promise<void> {
    const roleId = await this.locateRole(id);
    if (!roleId) throw new Error(`memory-proposal-not-found:${id}`);
    await this.fs.appendJsonl(path.join(roleMemoryDir(roleId), 'draft.jsonl'), {
      kind: 'status', id, status, at: new Date().toISOString(),
    });
  }

  /** 全角色扫描 + 折叠（读侧归一） */
  override async listProposals(): Promise<ReviewProposalRecord<MemoryDraftEntry>[]> {
    const rows: MemoryDraftLine[] = [];
    for (const roleId of await this.roleIds()) {
      rows.push(...await this.fs.readJsonl<MemoryDraftLine>(path.join(roleMemoryDir(roleId), 'draft.jsonl')));
    }
    return [...foldDraftRows(rows).values()].map(f => ({
      ...f.entry,
      status: f.status,
      statusAt: f.statusAt,
    }));
  }

  /** 记忆根目录下的角色目录清单（根目录不存在 → []） */
  private async roleIds(): Promise<string[]> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(roleMemoryRoot(), { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return [];
      throw err;
    }
    return dirents.filter(d => d.isDirectory()).map(d => d.name);
  }

  /** 按提案 id 定位所属角色（逐角色 draft.jsonl 扫描；未命中 → null） */
  private async locateRole(id: string): Promise<string | null> {
    for (const roleId of await this.roleIds()) {
      const rows = await this.fs.readJsonl<MemoryDraftLine>(path.join(roleMemoryDir(roleId), 'draft.jsonl'));
      if (rows.some(r => r.id === id)) return roleId;
    }
    return null;
  }
}

/**
 * 注册 memory adapter（kind='memory'）。运行时装配（initWuCompletionExtraction）与
 * submitMemoryProposal 自助注册两处调用；同 kind 重复注册后者生效（幂等）。
 */
export function registerMemoryReviewAdapter(deps?: {
  fileStore?: FileStore;
}): ReviewProposalAdapter<MemoryDraftEntry> {
  const fileStore = deps?.fileStore ?? new FileStore();
  return registerReviewProposalAdapter<MemoryDraftEntry>({
    kind: 'memory',
    cardType: 'memory_proposal',
    // 名义命名空间：自定义 store 覆盖默认物化（存取落 per-role draft.jsonl）
    storeNamespace: 'draft',
    dataDir: roleMemoryRoot(),
    fileStore,
    store: new MemoryProposalStore(fileStore),
    // 正本单提案路径的兜底渲染（memory 触发侧走 submitMemoryProposal 聚合一卡）
    renderCardContent: p => renderCard([toCardEntry(p)], { workUnitId: null, source: 'unknown' }),
    onApprove: async (p): Promise<ApproveOutcome> => {
      try {
        const result = await roleMemoryStore.promote(p.roleId, [p.id]);
        return { status: 'executed', data: { promoted: result.promoted, topicsUpdated: result.topicsUpdated } };
      } catch (e) {
        return { status: 'failed', error: getErrorMessage(e) };
      }
    },
    onReject: async p => {
      await roleMemoryStore.demote(p.roleId, [p.id]);
    },
  });
}

/**
 * 一批 manual 草稿 → 逐条落 draft.jsonl（条目行即提案行，pending）→ 聚合一张
 * memory_proposal 卡（正本 postReviewProposalCard 投放）。空批次直返。
 * 草稿写盘失败抛出（调用方兜底：extraction fire-and-forget / distill 回落知识条目）；
 * 发卡失败不抛——逐条落 card-failed 墓碑（#101/#143 降级口径，提取链路绝不被通知阻断）。
 */
export async function submitMemoryProposal(
  roleId: string,
  inputs: AppendDraftInput[],
  ctx: { workUnitId?: string; source: string },
): Promise<MemoryDraftEntry[]> {
  if (inputs.length === 0) return [];
  const adapter = getReviewProposalAdapter<MemoryDraftEntry>('memory') ?? registerMemoryReviewAdapter();

  const entries: MemoryDraftEntry[] = [];
  for (const input of inputs) {
    entries.push(await roleMemoryStore.appendDraft(roleId, input));
  }

  const { content, cardData } = renderCard(entries.map(toCardEntry), ctx);
  const posted = await postReviewProposalCard(
    { cardType: adapter.cardType, content, cardData, logTag: adapter.kind },
    { fileStore: adapter.fileStore },
  );
  if (!posted) {
    for (const e of entries) {
      await adapter.store.appendStatus(e.id, 'card-failed');
    }
    logger.warn('[RoleMemory] memory_proposal card not posted; entries marked card-failed', {
      roleId, entryCount: entries.length, workUnitId: ctx.workUnitId, source: ctx.source,
    });
  }
  return entries;
}
