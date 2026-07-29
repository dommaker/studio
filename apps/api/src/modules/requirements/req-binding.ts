/**
 * REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。
 *
 * 优先级：显式 reqId > 消息文本 #REQ-XXXX / #PMO-n token（存在性校验）> 自动新建。
 * 决策 4（PMO-a）：#PMO-n / #PM-n token 经别名层解析为统一编号 PMO 的 REQ 别名——
 * 频道里 @角色 #PMO-42 显式派活，归属零解析（分析文档 §7 路径 1）。
 * 本函数不做 best-effort 兜底 —— 调用方负责 try/catch（log + 不带 reqId 继续），
 * 保证 WorkUnit 创建不被 REQ 绑定失败阻断。
 */
import { formatRequirementId, logger, type FileStore } from '@dommaker/studio-shared';
import { RequirementService, type RequirementServiceDeps } from './requirement.service.js';

/** 消息文本中的 #REQ-XXXX token（大小写不敏感，序号至少 1 位） */
const REQ_TOKEN_RE = /#REQ-(\d+)/i;
/** 消息文本中的 #PMO-n / #PM-n token（决策 4 别名层；大小写不敏感） */
const PMO_TOKEN_RE = /#(PMO?-\d+)/i;

/** 解析消息文本中的 #REQ-XXXX token，返回规范化 id；无 token 返回 null */
export function parseReqToken(content: string): string | null {
  const m = content.match(REQ_TOKEN_RE);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  return Number.isInteger(seq) && seq > 0 ? formatRequirementId(seq) : null;
}

/** 解析消息文本中的 #PMO-n / #PM-n token，返回规范化 PMO 号；无 token 返回 null */
export function parsePmoToken(content: string): string | null {
  const m = content.match(PMO_TOKEN_RE);
  return m ? m[1].toUpperCase() : null;
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
  /** 测试注入：RequirementService 依赖桩（别名/杂务/PMO token 解析） */
  deps?: RequirementServiceDeps;
}

/**
 * 解析本次派发应绑定的 REQ id。
 * 显式 reqId 存在 → 用之；否则 #REQ-XXXX token 存在 → 用之；否则 #PMO-n token
 * 经别名层解析命中 → 用之；否则自动新建
 * （status=in-progress，channelId 落档，title 取消息前 ~80 字符）。
 * @throws 存储层失败时抛错（调用方 best-effort 兜底）
 */
export async function resolveReqIdForDispatch(input: ResolveReqIdInput): Promise<string | null> {
  const service = new RequirementService(input.fileStore, input.deps);

  // 1. 显式 reqId（存在性校验；不存在则降级到下一优先级）
  if (input.explicitReqId) {
    const normalized = normalizeReqId(input.explicitReqId);
    if (normalized && (await service.get(normalized))) return normalized;
    logger.warn('[Requirement] Explicit reqId not found, falling through', { reqId: input.explicitReqId });
  }

  // 2. 消息文本 #REQ-XXXX token（存在性校验）
  const tokenId = parseReqToken(input.content);
  if (tokenId && (await service.get(tokenId))) return tokenId;

  // 2b. 决策 4：#PMO-n / #PM-n token → 别名层解析（命中有 reqAlias 的统一编号 PMO 才绑；
  // 存量无别名 legacy 项目不绑——编号重叠期拒绝歧义，降级到下一优先级）
  const pmoToken = parsePmoToken(input.content);
  if (pmoToken) {
    const alias = await service.resolveReqAliasByPmoNumber(pmoToken);
    if (alias) return alias;
    logger.warn('[Requirement] PMO token did not resolve to a unified project, falling through', { pmoToken });
  }

  // 3. 自动新建（频道已登记杂务 PMO 时归集到杂务别名，见 createFromDispatch）
  const requirement = await service.createFromDispatch(input.content, input.channelId, input.createdBy);
  return requirement.id;
}
