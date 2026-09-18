/**
 * 认领前适任判断（决策 14，docs/adr/2026-08-25-review-independence-trust-model.md 补充段）。
 *
 * 问题：频道角色认领是「代码代抢」——observe（零 LLM）过滤 → resolveTarget（纯代码排序）
 * → claim 抢占，agent 第一次看到 scope 全文是认领后的第一步 prompt，错误认领是结构性必然。
 * 本模块在 resolveTarget 选中 unassigned 候选之后、claimAndAnnounce 之前插一道一次性 LLM
 * 判断：「能否胜任、是否属于你」。只在角色空闲且即将认领时触发（成本与认领次数成正比），
 * 不在 observe 15s 轮询里加 LLM。
 *
 * 治理约束（ADR D2/决策 10）：约束挂 WU 不挂角色身份——不适任结果落档 WU 侧
 * metadata.unfitRoles 名单（{roleId, reason, at}），observe 过滤链据此排除本角色；
 * 不恢复 acceptedTypes 静态类型过滤（那是治理变更）。
 *
 * 从宽哲学：判断调用失败/超时/解析不出 → 视为适任（宁可误抢不可漏抢，错抢还有
 * NEED_INPUT 甩人兜底）。落档失败同口径从宽放行。
 *
 * LLM 调用复用 system-executor（轻量一次性 spawn，无 worktree，与 distill /
 * wu-completion-extraction 同款机制），经 getSystemExecutor() 懒单例；测试注入 run 替代。
 */
import type { AgentProfileData } from '@dommaker/studio-shared';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { UnfitRoleEntry } from '../../workunit/workunit.types.js';
import { getSystemExecutor } from '../system-executor.js';

/** 适任判断输入的 scope 截断上限（字符）——轻量 prompt，控制单次调用规模 */
export const FITNESS_SCOPE_MAX_CHARS = 2_000;
/** 不适任理由截断上限（字符）——落档 unfitRoles.reason 与频道消息共用 */
export const FITNESS_REASON_MAX_CHARS = 120;

export interface FitnessVerdict {
  fit: boolean;
  reason: string;
}

/** 一次性 LLM 调用签名（SystemExecutor.run 的子集；测试注入替代真实 CLI spawn） */
export type FitnessRunner = (
  prompt: string,
  options?: { systemPrompt?: string; eventSource?: string },
) => Promise<{ output: string }>;

/**
 * 适任判断 prompt（单一来源）：候选 WU 的 type + scope 摘要 + role 的
 * persona/description/acceptedTypes，一次性问「能否胜任、是否属于你」。
 * acceptedTypes 在此仅作判断素材（推断），不做静态过滤（决策 10 红线不碰）。
 */
export function buildClaimFitnessPrompt(
  wu: Pick<WorkUnitData, 'type' | 'scope'>,
  role: AgentProfileData,
): string {
  const persona = (role.persona ?? role.description ?? '').trim();
  const accepted = (role.acceptedTypes ?? []).join('、') || '（未声明）';
  const scope = (wu.scope ?? '').length > FITNESS_SCOPE_MAX_CHARS
    ? `${wu.scope.slice(0, FITNESS_SCOPE_MAX_CHARS)}…[truncated]`
    : (wu.scope ?? '');
  return [
    `你是角色「${role.name}」。`,
    persona ? `角色自述：${persona}` : null,
    `角色声明的职能域：${accepted}`,
    '',
    `待认领工单（类型 ${wu.type}）：`,
    scope,
  ].filter(line => line !== null).join('\n');
}

/** 判断系统提示词：输出协议唯一出处（parseFitnessVerdict 据此解析） */
export const CLAIM_FITNESS_SYSTEM_PROMPT = `你是认领前适任判断器。根据角色自述与职能域，判断该角色能否胜任、该工单是否属于它。
拿不准一律视为适任（误抢的代价远小于漏抢）。
只输出一行，协议：FIT: yes|no: 一行理由（不超过 80 字）。不要输出任何其他内容。`;

/**
 * 解析判断输出。容错链：claude --output-format json 信封（{type:'result',result:string}）
 * 先拆封取模型文本 → 逐行找 `FIT: yes|no` → 理由取同行余下部分（截断）。
 * 解析不出 → 从宽 { fit: true }。
 */
export function parseFitnessVerdict(output: string): FitnessVerdict {
  let text = output;
  try {
    const parsed: unknown = JSON.parse(output);
    const result = (parsed as { result?: unknown } | null)?.result;
    if (typeof result === 'string') text = result;
  } catch { /* 非 JSON 信封 → 按裸文本扫 */ }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*FIT:\s*(yes|no)\b\s*:?\s*(.*)$/i);
    if (!m) continue;
    const reason = (m[2] ?? '').trim().slice(0, FITNESS_REASON_MAX_CHARS);
    return { fit: m[1].toLowerCase() === 'yes', reason };
  }
  return { fit: true, reason: '' };
}

/**
 * 一次性适任判断。任何失败（spawn 失败/超时/未配置 studio provider）→ 从宽适任。
 * eventSource='claim-fitness' 走 system:tokens 记账（默认 30s 超时，轻量 prompt 够用）。
 *
 * #579（2026-09-17）：总开关 `STUDIO_CLAIM_FITNESS=false`（默认开），无凭证/
 * fake-provider 环境豁免适任判断——否则每个涌现认领都经 system-executor 起真实
 * CLI 空转（P7/P8 同类治理，STUDIO_AUTO_REVIEW / STUDIO_KNOWLEDGE_EXTRACTION
 * 同风格 `!== 'false'`）。关闭时从宽放行（等同判断失败语义）。
 */
export async function judgeClaimFitness(
  wu: Pick<WorkUnitData, 'type' | 'scope'>,
  role: AgentProfileData,
  run?: FitnessRunner,
): Promise<FitnessVerdict> {
  if (process.env.STUDIO_CLAIM_FITNESS === 'false') {
    return { fit: true, reason: '' }; // #579：fake/无凭证环境豁免，不起真实 CLI
  }
  const call: FitnessRunner = run ?? ((prompt, options) => getSystemExecutor().run(prompt, options));
  try {
    const result = await call(buildClaimFitnessPrompt(wu, role), {
      systemPrompt: CLAIM_FITNESS_SYSTEM_PROMPT,
      eventSource: 'claim-fitness',
    });
    return parseFitnessVerdict(result.output);
  } catch {
    return { fit: true, reason: '' }; // 从宽：判断调用失败视为适任（NEED_INPUT 兜底错抢）
  }
}

/** 安全解析 WU metadata.unfitRoles —— 缺失/损坏/非数组一律 []（不排除），仿 parseExcludeAssignee */
export function parseUnfitRoles(metadata: WorkUnitMetadata | string | null | undefined): UnfitRoleEntry[] {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const v = (m as { unfitRoles?: unknown } | null)?.unfitRoles;
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is UnfitRoleEntry =>
      !!e && typeof e === 'object' && typeof (e as UnfitRoleEntry).roleId === 'string');
  } catch {
    return [];
  }
}

/** observe 第 7 道过滤判据：本角色是否已被判不适任 */
export function isRoleUnfit(metadata: WorkUnitMetadata | string | null | undefined, roleId: string): boolean {
  return parseUnfitRoles(metadata).some(e => e.roleId === roleId);
}
