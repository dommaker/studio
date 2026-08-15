/**
 * constraint-audit (#146) — 存量约束审计纯函数（#139 退役判据，spec #141 / #83 D3）
 *
 * 触发形态（#139 D1 / #83 D3）：不另设 cron，挂蒸馏事件——蒸馏运行产出新约束
 * （landings.constraint 非空）时顺带审计存量 custom 约束，产出退役建议清单发人审。
 *
 * 统一判据（#139 Notes / D3）：该约束是否还有「可被违反的未来场景」。
 * LLM 负责判断，本模块负责把关——建议必须落在判据白名单内才进人审卡：
 *   - target-gone：作用对象已从代码库消失（如 Prisma schema 已删除且无回归路径）
 *   - reintroduction-sealed：再引入路径已被其他机制封死（如依赖审计/拦截层覆盖）
 * 白名单是「防再引入型不误判退役」的确定性闸门（#139 草案判据）：
 * 技术存量清零 ≠ 风险消失（零违规分不清威慑有效与约束过时，ADR-0001:12），
 * 任何其它理由（tech-absent / zero-violations 等）在 normalize 阶段被丢弃。
 *
 * 审计范围 = custom-constraints.yml 存量条目（#139 动机场景；内置约束生命周期归
 * harness 发版治理）。已退役（含 retired 段）条目不参与审计。
 */
import fs from 'node:fs';
import yaml from 'js-yaml';

/** 单次审计最多进人审卡的建议数（宁缺毋滥，同 MAX_PRODUCTS 精神） */
export const AUDIT_MAX_SUGGESTIONS = 10;

/** 判据白名单（#139 退役判据机读化）；此外一律丢弃 */
export const AUDIT_CATEGORIES = new Set<AuditCategory>(['target-gone', 'reintroduction-sealed']);

export type AuditCategory = 'target-gone' | 'reintroduction-sealed';

/** 人审卡展示用的判据中文标签 */
export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  'target-gone': '作用对象已消失',
  'reintroduction-sealed': '再引入路径已封死',
};

/** 参与审计的存量 custom 约束（active = 无 retired 段） */
export interface CustomConstraintInfo {
  id: string;
  level?: string;
  rule?: string;
  message?: string;
  description?: string;
}

/** 退役建议（人审卡逐条展示判据理由） */
export interface AuditSuggestion {
  constraintId: string;
  category: AuditCategory;
  rationale: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 读 custom-constraints.yml 的 active 条目（含 retired 段的跳过——已退役不复审）。
 * 文件缺失 / 解析失败 / 无 custom_constraints 段 → []。输出按 id 字典序（确定性）。
 */
export function loadActiveCustomConstraints(filePath: string): CustomConstraintInfo[] {
  let raw: Record<string, unknown>;
  try {
    if (!fs.existsSync(filePath)) return [];
    raw = (yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>) ?? {};
  } catch {
    return [];
  }
  const customs = raw.custom_constraints;
  if (!customs || typeof customs !== 'object') return [];
  const out: CustomConstraintInfo[] = [];
  for (const [id, v] of Object.entries(customs as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const entry = v as Record<string, unknown>;
    if (entry.retired) continue; // 已退役（#82 D6 落点）不复审
    out.push({
      id,
      ...(str(entry.level) ? { level: str(entry.level) } : {}),
      ...(str(entry.rule) ? { rule: str(entry.rule) } : {}),
      ...(str(entry.message) ? { message: str(entry.message) } : {}),
      ...(str(entry.description) ? { description: str(entry.description) } : {}),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 读 package.json 依赖名清单（dependencies + devDependencies，排序；缺失/异常 → []） */
export function readPackageDeps(packageJsonPath: string): string[] {
  try {
    if (!fs.existsSync(packageJsonPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    return [...names].sort();
  } catch {
    return [];
  }
}

/**
 * LLM 审计产出 → 退役建议清单。把关规则：
 *   - constraintId 必须在参与审计的 active 集合内（幻觉防护；人判保留集已被调用方剔除出审计输入）
 *   - category 必须在判据白名单内（防再引入型误判的确定性闸门）
 *   - rationale 非空（人审卡逐条附判据理由）
 *   - 同 id 去重（先出优先），总量封顶 AUDIT_MAX_SUGGESTIONS
 */
export function normalizeAuditSuggestions(
  parsed: { suggestions?: unknown },
  auditableIds: Set<string>,
): AuditSuggestion[] {
  const raw = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const seen = new Set<string>();
  const out: AuditSuggestion[] = [];
  for (const item of raw) {
    if (out.length >= AUDIT_MAX_SUGGESTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const constraintId = str(s.constraintId);
    const category = str(s.category) as AuditCategory | undefined;
    const rationale = str(s.rationale);
    if (!constraintId || !auditableIds.has(constraintId)) continue;
    if (!category || !AUDIT_CATEGORIES.has(category)) continue;
    if (!rationale) continue;
    if (seen.has(constraintId)) continue;
    seen.add(constraintId);
    out.push({ constraintId, category, rationale });
  }
  return out;
}

/**
 * 审计 prompt（单一来源）。判据与反例照 #139 Notes/D3 原文精神：
 * 防再引入型保留、长期零违规不是退役理由。判断证据 = 约束清单 + package.json 依赖
 * （技术存量唯一机读信号；「再引入是否封死」最终由人审终审）。
 */
export const CONSTRAINT_AUDIT_SYSTEM_PROMPT = `你是约束生命周期审计专家。输入是一个项目的存量自定义约束清单（.harness/custom-constraints.yml）和 package.json 依赖清单。

统一判据：该约束是否还有「可被违反的未来场景」。只有两类情形可以建议退役：
- category="target-gone"：作用对象已从代码库消失（如约束针对的技术/文件已被彻底移除，且无合理回归路径）
- category="reintroduction-sealed"：再引入路径已被其他机制封死（如依赖审计、拦截层、lint 规则已覆盖同一风险）

反例（不得建议退役）：
- 防再引入型约束：技术存量清零 ≠ 风险消失。例如「禁止引入 Redis」——依赖清单里没有 redis 恰恰说明约束在起作用，AI 未来仍可能重新引入。除非再引入路径已被封死，否则保留
- 长期零违规：零违规分不清「约束过时」与「威慑有效」，不能作为退役理由
- 语义仍适用于未来代码的约束（通用工程纪律、流程规矩）

输出 JSON（不要 markdown 包裹）：
{ "suggestions": [ { "constraintId": "约束id", "category": "target-gone" | "reintroduction-sealed", "rationale": "一句话判据理由" } ] }

没有符合判据的约束就返回空数组，宁缺毋滥。每条建议都要经得起追问：这条约束未来还可不可能被违反？`;

/** 单条约束描述字段进 prompt 的截断（控制单次调用规模，同 MATERIAL_CONTENT_MAX_CHARS 精神） */
const AUDIT_FIELD_MAX_CHARS = 400;

function clip(s: string | undefined): string {
  if (!s) return '';
  return s.length > AUDIT_FIELD_MAX_CHARS ? `${s.slice(0, AUDIT_FIELD_MAX_CHARS)}…[truncated]` : s;
}

/** 存量约束清单 + 依赖清单 → 审计输入文本 */
export function buildConstraintAuditPrompt(
  constraints: CustomConstraintInfo[],
  opts?: { packageDeps?: string[] },
): string {
  const blocks = constraints.map((c, i) => [
    `### 约束 ${i + 1}（id: ${c.id}）`,
    c.level ? `level: ${c.level}` : null,
    c.rule ? `rule: ${clip(c.rule)}` : null,
    c.message ? `message: ${clip(c.message)}` : null,
    c.description ? `description: ${clip(c.description)}` : null,
  ].filter(Boolean).join('\n'));
  const deps = opts?.packageDeps?.length
    ? `\n\npackage.json 依赖清单（技术存量证据）：\n${opts.packageDeps.join(', ')}`
    : '\n\n（package.json 依赖清单不可用，请仅按约束语义保守判断）';
  return `以下是 ${constraints.length} 条存量自定义约束，请按系统提示的判据审计，给出退役建议：\n\n${blocks.join('\n\n')}${deps}`;
}
