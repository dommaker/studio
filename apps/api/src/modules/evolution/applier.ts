/**
 * E1 约束进化：提案生效器（applier）。
 *
 * 仅在人类批准后由 EvolutionService.decide('approve') 调用 —— 绝不自动生效。
 * 所有写入前先备份目标文件（`<target>.bak-<ts>`），写入失败可人工回滚。
 *
 * 各 targetType 的写入目标（设计决策，见 docs/plans/2026-07-flywheel-repair.md §4 E1）：
 *   - iron-law / guideline → `<repoRoot>/.harness/custom-constraints.yml`
 *       · amend 既有自定义条目：文本级手术替换 `message:` 行（保留文件注释）。
 *       · 内置约束的 message 修改 / 例外追加：文件尾部追加条目（harness
 *         ProjectConfigLoader 的 mergeConstraints 按 id 覆盖内置定义；
 *         extend-only 条目（仅 extend_exceptions）是 loader 原生支持的合并语义）。
 *       · new-entry：文件尾部追加完整条目。
 *       · 结构性变更（adjust_trigger / change_level）不在 v1 生效范围内（生成期已跳过）。
 *   - prompt-template → `~/.studio/prompt-overrides/<templateId>.md`（STUDIO_PROMPT_OVERRIDES_DIR
 *       可覆盖）。prompt 模板是 TS 内联常量，**不改写源码**，构建时经
 *       renderWithOverride/readPromptOverride 读取覆盖文件。
 *   - role-preset → `<repoRoot>/.agents/roles/<name>.yaml`：替换 `persona:` 字段
 *       （文本级块标量替换；写后用 js-yaml 校验，失败则从备份恢复并抛错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { GUIDELINES, IRON_LAWS, PROMPTS } from '@dommaker/harness';
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
  // 0.17.0：TIPS 已退役（deprecated 空表），prompt 层定义为 PROMPTS
  return (IRON_LAWS as Record<string, BuiltinConstraintDef>)[id]
    ?? (GUIDELINES as Record<string, BuiltinConstraintDef>)[id]
    ?? (PROMPTS as Record<string, BuiltinConstraintDef>)[id]
    ?? null;
}

function levelOf(proposal: EvolutionProposalData): string {
  return proposal.targetType === 'iron-law' ? 'iron_law' : 'guideline';
}

/** 读取自定义约束文件（缺失/损坏 → {}）。 */
export function loadCustomConstraints(constraintsFile: string): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(constraintsFile)) return {};
    const loaded = yaml.load(fs.readFileSync(constraintsFile, 'utf-8')) as { custom_constraints?: Record<string, Record<string, unknown>> } | null;
    return loaded?.custom_constraints ?? {};
  } catch {
    return {};
  }
}

/**
 * 文本级手术：替换 custom-constraints.yml 中既有条目的 `message:` 行。
 * 条目定位：`custom_constraints:` 下 2 空格缩进的 `<id>:` 键；条目块到下一个
 * 同级键或文件尾。找不到条目 → null（调用方走追加 shadow 路径）。
 */
export function amendConstraintMessage(content: string, id: string, newMessage: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.trimEnd() === `  ${id}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    if (/^ {4}message:/.test(lines[i])) {
      lines[i] = `    message: ${yamlStr(newMessage)}`;
      return lines.join('\n');
    }
  }
  // 条目无 message 行 → 插到条目首行之后
  lines.splice(start + 1, 0, `    message: ${yamlStr(newMessage)}`);
  return lines.join('\n');
}

/** 文件尾追加一个自定义约束条目（保证 `custom_constraints:` 头存在、单换行结尾）。 */
function appendConstraintEntry(content: string, id: string, entryLines: string[], comment: string): string {
  let base = content;
  if (!/custom_constraints:/m.test(base)) {
    base = `${base.replace(/\s*$/, '')}\n\ncustom_constraints:\n`;
  }
  base = base.replace(/\s*$/, '') + '\n';
  return `${base}\n  # ${comment}\n  ${id}:\n${entryLines.map(l => `    ${l}`).join('\n')}\n`;
}

function applyConstraintChange(proposal: EvolutionProposalData, constraintsFile: string): { detail: string } {
  const { targetId: id, constraintChange } = proposal;
  const custom = loadCustomConstraints(constraintsFile);
  const builtin = findBuiltinConstraint(id);
  const level = levelOf(proposal);
  const comment = `${proposal.id}: ${proposal.rationale.split('\n')[0].slice(0, 80)}`;
  const content = fs.existsSync(constraintsFile) ? fs.readFileSync(constraintsFile, 'utf-8') : '# 自定义约束配置 — Studio 项目专属\n\ncustom_constraints:\n';

  // amend：条目在自定义文件中 → 文本级替换 message 行
  if (proposal.action === 'amend' && custom[id]) {
    const amended = amendConstraintMessage(content, id, proposal.proposedText);
    if (amended !== null) {
      fs.writeFileSync(constraintsFile, amended, 'utf-8');
      return { detail: `amended message of custom constraint '${id}'` };
    }
    // 文本定位失败（异常格式）→ 退化为追加 shadow 条目（loader 按 id 覆盖）
  }

  if (constraintChange === 'exception') {
    // extend-only 条目：ProjectConfigLoader 原生支持的合并语义（仅对内置约束生效，
    // 自定义条目的 exception 追加在生成期已跳过）。
    const next = appendConstraintEntry(content, id, [
      `id: ${id}`,
      `level: ${level}`,
      `extend_exceptions: [${yamlStr(proposal.proposedText)}]`,
    ], comment);
    fs.writeFileSync(constraintsFile, next, 'utf-8');
    return { detail: `appended extend_exceptions entry for '${id}'` };
  }

  if (constraintChange === 'new-entry') {
    const next = appendConstraintEntry(content, id, [
      `id: ${id}`,
      `level: ${level}`,
      `rule: ${yamlStr(id.replace(/_/g, ' ').toUpperCase())}`,
      `message: ${yamlStr(proposal.proposedText)}`,
      `trigger: ["code_implementation"]`,
      `description: ${yamlStr(proposal.rationale.slice(0, 200))}`,
    ], comment);
    fs.writeFileSync(constraintsFile, next, 'utf-8');
    return { detail: `appended new constraint entry '${id}'` };
  }

  // message 修改但条目不在自定义文件 → 追加内置定义的完整 shadow（仅改 message）
  const rule = builtin?.rule ?? id.replace(/_/g, ' ').toUpperCase();
  const trigger = Array.isArray(builtin?.trigger) ? builtin.trigger : [builtin?.trigger ?? 'code_implementation'];
  const next = appendConstraintEntry(content, id, [
    `id: ${id}`,
    `level: ${level}`,
    `rule: ${yamlStr(String(rule))}`,
    `message: ${yamlStr(proposal.proposedText)}`,
    `trigger: [${trigger.map(t => yamlStr(String(t))).join(', ')}]`,
    `description: ${yamlStr(String(builtin?.description ?? proposal.rationale.slice(0, 200)))}`,
  ], comment);
  fs.writeFileSync(constraintsFile, next, 'utf-8');
  return { detail: `appended shadow entry overriding message of builtin '${id}'` };
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
      const targetPath = paths.constraintsFile;
      const backupPath = await backupFile(targetPath);
      const { detail } = applyConstraintChange(proposal, targetPath);
      return { targetPath, backupPath, detail };
    }
    case 'prompt-template':
      return applyPromptTemplate(proposal);
    case 'role-preset':
      return applyRolePreset(proposal, paths.rolesDir);
    default:
      throw new Error(`unknown targetType: ${proposal.targetType}`);
  }
}
