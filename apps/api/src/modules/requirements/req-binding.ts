/**
 * REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。
 *
 * 优先级：显式 reqId > 消息文本 #REQ-XXXX token（存在性校验）> 自动新建。
 * 本函数不做 best-effort 兜底 —— 调用方负责 try/catch（log + 不带 reqId 继续），
 * 保证 WorkUnit 创建不被 REQ 绑定失败阻断。
 */
import { formatRequirementId, logger, type FileStore } from '@dommaker/studio-shared';
import { RequirementService } from './requirement.service.js';

/** 消息文本中的 #REQ-XXXX token（大小写不敏感，序号至少 1 位） */
const REQ_TOKEN_RE = /#REQ-(\d+)/i;

/** 解析消息文本中的 #REQ-XXXX token，返回规范化 id；无 token 返回 null */
export function parseReqToken(content: string): string | null {
  const m = content.match(REQ_TOKEN_RE);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  return Number.isInteger(seq) && seq > 0 ? formatRequirementId(seq) : null;
}

/** 规范化 REQ id 输入（'REQ-42' / 'req-0042' → 'REQ-0042'）；无法解析返回 null */
export function normalizeReqId(raw: string): string | null {
  const m = raw.trim().match(/^REQ-(\d+)$/i);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  return Number.isInteger(seq) && seq > 0 ? formatRequirementId(seq) : null;
}

export interface ResolveReqIdInput {
  /** 消息 API body 显式指定的 reqId（最高优先级，需已存在） */
  explicitReqId?: string | null;
  /** 派发消息原文（token 解析 + 自动新建标题来源） */
  content: string;
  /** 自动新建时落档的 channelId */
  channelId: string | null;
  /** 自动新建时落档的 createdBy（mention | convert） */
  createdBy: string;
  fileStore?: FileStore;
}

/**
 * 解析本次派发应绑定的 REQ id。
 * 显式 reqId 存在 → 用之；否则 #REQ-XXXX token 存在 → 用之；否则自动新建
 * （status=in-progress，channelId 落档，title 取消息前 ~80 字符）。
 * @throws 存储层失败时抛错（调用方 best-effort 兜底）
 */
export async function resolveReqIdForDispatch(input: ResolveReqIdInput): Promise<string | null> {
  const service = new RequirementService(input.fileStore);

  // 1. 显式 reqId（存在性校验；不存在则降级到下一优先级）
  if (input.explicitReqId) {
    const normalized = normalizeReqId(input.explicitReqId);
    if (normalized && (await service.get(normalized))) return normalized;
    logger.warn('[Requirement] Explicit reqId not found, falling through', { reqId: input.explicitReqId });
  }

  // 2. 消息文本 #REQ-XXXX token（存在性校验）
  const tokenId = parseReqToken(input.content);
  if (tokenId && (await service.get(tokenId))) return tokenId;

  // 3. 自动新建
  const requirement = await service.createFromDispatch(input.content, input.channelId, input.createdBy);
  return requirement.id;
}
