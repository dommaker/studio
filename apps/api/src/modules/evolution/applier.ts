/**
 * E1 约束进化：提案生效器（applier）。
 *
 * 仅在人类批准后由 EvolutionService.decide('approve') 调用 —— 绝不自动生效。
 * 所有写入前先备份目标文件（`<target>.bak-<ts>`），写入失败可人工回滚。
 *
 * 各 targetType 的写入目标：
 *   - iron-law / guideline → **#602 D1 新落点：`<repoRoot>/.harness/config.yml`**
 *       （harness 约束唯一真实生效形态，`getEffectiveConstraints` 读它覆盖内置集）。
 *       仅支持 constraintChange='retire'：写 `constraints.<id>.enabled=false` + retired
 *       墓碑（at/reason/stats），格式对齐 `harness constraints retire`；写后用
 *       getEffectiveConstraints 验证生效集已缩小，失败回滚备份。
 *       message/new-entry/exception 在 harness 1.10.0（ADR-0029 文本层关停）无生效
 *       落点，落笔前拒绝（service 层保持 approved 可重试）。
 *       · 历史落点：`<repoRoot>/.harness/custom-constraints.yml`（#606 起 harness 不再读取）。
 *         `retireConstraintEntry` 文本手术暂留——distill 草案渲染复用。
 *   - prompt-template → `~/.studio/prompt-overrides/<templateId>.md`（STUDIO_PROMPT_OVERRIDES_DIR
 *       可覆盖）。prompt 模板是 TS 内联常量，**不改写源码**，构建时经
 *       renderWithOverride/readPromptOverride 读取覆盖文件（#602 D3 已接生产读者）。
 *   - role-preset → `<repoRoot>/.agents/roles/<name>.yaml`：替换 `persona:` 字段
 *       （文本级块标量替换；写后用 js-yaml 校验，失败则从备份恢复并抛错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { CONSTRAINTS, getEffectiveConstraints } from '@dommaker/harness';
import {
  resolvePromptOverridesDir,
  type EvolutionProposalData,
} from '@dommaker/studio-shared';
import type { EvolutionPaths } from './signals.js';

export interface ApplyResult {
  targetPath: string;
  backupPath: string | null;
  detail: string;
}

/** 写入前备份。目标不存在（新建文件）→ 无需备份，返回 null。 */
async function backupFile(targetPath: string): Promise<string | null> {
  if (!fs.existsSync(targetPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${targetPath}.bak-${ts}`;
  await fs.promises.copyFile(targetPath, backupPath);
  return backupPath;
}

/** YAML 安全双引号标量（JSON 字符串是合法 YAML flow scalar）。 */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

interface BuiltinConstraintDef {
  id?: string;
  level?: string;
  rule?: string;
  message?: string;
  trigger?: unknown;
  description?: string;
}

function findBuiltinConstraint(id: string): BuiltinConstraintDef | null {
  // harness 1.10.0（ADR-0029）：IRON_LAWS/GUIDELINES/PROMPTS 三桶合并为 CONSTRAINTS 单桶
  return (CONSTRAINTS as Record<string, BuiltinConstraintDef>)[id] ?? null;
}

/**
 * #602 D1：retire 提案落点 —— `<repoRoot>/.harness/config.yml` 写
 * `constraints.<id>.enabled=false` + retired 墓碑（at/reason/stats），格式对齐
 * `harness constraints retire`（恢复 = 删 config.yml 中该段）。写后以
 * getEffectiveConstraints 验证生效集已缩小，验证失败回滚备份并抛错。
 * 幂等：已 disabled → detail 报 already retired，不重写。
 */
async function applyConstraintRetire(
  proposal: EvolutionProposalData,
  paths: EvolutionPaths,
): Promise<{ targetPath: string; backupPath: string | null; detail: string }> {
  const id = proposal.targetId;
  if (!findBuiltinConstraint(id)) {
    throw new Error(`cannot retire unknown constraint '${id}': 非内置约束（E1 retire 只处理 harness 内置 check 约束）`);
  }
  const targetPath = path.join(paths.repoRoot, '.harness', 'config.yml');
  const raw = fs.existsSync(targetPath)
    ? (yaml.load(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown> | null) ?? {}
    : {};
  const constraints = { ...((raw.constraints ?? {}) as Record<string, Record<string, unknown>>) };
  const prev = constraints[id] ?? {};
  if (prev.enabled === false) {
    return { targetPath, backupPath: null, detail: `constraint '${id}' already retired (config.yml enabled:false)` };
  }

  const counts = proposal.evidence?.eventCounts ?? {};
  constraints[id] = {
    ...prev,
    enabled: false,
    retired: {
      at: new Date().toISOString(),
      reason: proposal.proposedText || proposal.rationale.split('\n')[0],
      stats: {
        total: counts.total ?? 0,
        fail: counts.fail ?? 0,
        failRate: counts.failRate ?? 0,
      },
    },
  };
  const next = { ...raw, constraints };

  const backupPath = await backupFile(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, yaml.dump(next, { lineWidth: 120 }), 'utf-8');

  // 写后验证：生效集必须已不含该约束（防格式写错假「已生效」）；失败回滚
  try {
    if (getEffectiveConstraints(paths.repoRoot).some(c => c.id === id)) {
      throw new Error('constraint still present in effective set after retire');
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    else fs.rmSync(targetPath, { force: true });
    throw new Error(`constraint retire failed verification, restored backup: ${String(err)}`);
  }
  return { targetPath, backupPath, detail: `retired builtin constraint '${id}' via config.yml` };
}

/**
 * 文本级手术：在 custom-constraints.yml 既有条目内追加 retired 元数据段
 * （#82 D6 统一落点，保留规则原文）。条目不存在 / 已含 retired 段 → null。
 *
 * 注：custom-constraints.yml 已随 #606 退役（harness 1.10.0 不再读取），本函数
 * 仅被 distill 草案渲染复用（distill-landings 的 retire 草案 diff 文本）。
 */
export function retireConstraintEntry(content: string, id: string, retired: { at: string; reason: string }): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.trimEnd() === `  ${id}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < end; i++) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);
  if (block.some(l => /^ {4}retired:/.test(l))) return null; // 已退役
  lines.splice(start + 1, 0,
    `    retired:`,
    `      at: ${yamlStr(retired.at)}`,
    `      reason: ${yamlStr(retired.reason)}`,
  );
  return lines.join('\n');
}

/**
 * 替换 role yaml 的 `persona:` 字段（文本级）。
 * 覆盖三种形态：块标量（`persona: |`）、行内值、缺失（尾部追加）。
 * 写入统一用 `persona: |-`（strip 模式）——加载后 persona 与 proposedText 精确相等，
 * 不带块标量默认保留的尾部换行。
 * 导出以便测试。
 */
export function replacePersonaBlock(content: string, newPersona: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => /^persona:/.test(l));
  const block = newPersona.replace(/\s+$/, '').split('\n').map(l => (l.length ? `  ${l}` : ''));
  if (idx === -1) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('', 'persona: |-', ...block, '');
    return out.join('\n');
  }
  if (/^persona:\s*[|>]/.test(lines[idx])) {
    // 块标量：吞掉后续缩进行/空行，头部归一为 |-
    let end = idx + 1;
    while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end++;
    lines.splice(idx, end - idx, 'persona: |-', ...block);
    return lines.join('\n');
  }
  // 行内形态 → 转为块标量
  lines.splice(idx, 1, 'persona: |-', ...block);
  return lines.join('\n');
}

async function applyRolePreset(proposal: EvolutionProposalData, rolesDir: string): Promise<{ targetPath: string; backupPath: string | null; detail: string }> {
  if (/[/\\]/.test(proposal.targetId) || proposal.targetId.includes('..')) {
    throw new Error(`invalid role id: ${proposal.targetId}`);
  }
  const targetPath = path.join(rolesDir, `${proposal.targetId}.yaml`);
  if (!fs.existsSync(targetPath)) throw new Error(`role preset not found: ${targetPath}`);
  const backupPath = await backupFile(targetPath);
  const content = fs.readFileSync(targetPath, 'utf-8');
  const next = replacePersonaBlock(content, proposal.proposedText);
  fs.writeFileSync(targetPath, next, 'utf-8');
  // 写后校验：YAML 可解析且 persona 生效；失败则恢复备份
  try {
    const parsed = yaml.load(fs.readFileSync(targetPath, 'utf-8')) as { persona?: string } | null;
    if (!parsed || typeof parsed.persona !== 'string' || !parsed.persona.includes(proposal.proposedText.trim().split('\n')[0])) {
      throw new Error('persona verification mismatch');
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    throw new Error(`role preset apply failed verification, restored backup: ${String(err)}`);
  }
  return { targetPath, backupPath, detail: `replaced persona of role '${proposal.targetId}'` };
}

async function applyPromptTemplate(proposal: EvolutionProposalData): Promise<{ targetPath: string; backupPath: string | null; detail: string }> {
  if (/[/\\]/.test(proposal.targetId) || proposal.targetId.includes('..')) {
    throw new Error(`invalid template id: ${proposal.targetId}`);
  }
  const dir = resolvePromptOverridesDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, `${proposal.targetId}.md`);
  const backupPath = await backupFile(targetPath);
  await fs.promises.writeFile(targetPath, proposal.proposedText, 'utf-8');
  return { targetPath, backupPath, detail: `wrote prompt override for '${proposal.targetId}'` };
}

/** 生效一个已批准的提案。抛出即失败（service 层保持 status='approved' 供重试）。 */
export async function applyProposal(
  proposal: EvolutionProposalData,
  paths: EvolutionPaths,
): Promise<ApplyResult> {
  switch (proposal.targetType) {
    case 'iron-law':
    case 'guideline': {
      // #602 D1：retire 落点 = .harness/config.yml（enabled:false + retired 墓碑）。
      if (proposal.constraintChange === 'retire') {
        return applyConstraintRetire(proposal, paths);
      }
      // message/new-entry/exception：harness 1.10.0（ADR-0029 决策 4）关停文本注入层后
      // 无生效落点——落笔前拒绝，service 层保持 status='approved' + APPLY_FAILED 可重试。
      throw new Error(
        `约束类提案（${proposal.targetType}/${proposal.constraintChange ?? 'message'}）落点已退役：` +
        `harness 1.10.0 起仅 retire 有真实落点（config.yml），文案类变更无消费端。`,
      );
    }
    case 'prompt-template':
      return applyPromptTemplate(proposal);
    case 'role-preset':
      return applyRolePreset(proposal, paths.rolesDir);
    default:
      throw new Error(`unknown targetType: ${proposal.targetType}`);
  }
}
