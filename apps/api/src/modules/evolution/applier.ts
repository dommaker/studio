/**
 * E1 约束进化：提案生效器（applier）。
 *
 * 仅在人类批准后由 EvolutionService.decide('approve') 调用 —— 绝不自动生效。
 * 所有写入前先备份目标文件（`<target>.bak-<ts>`），写入失败可人工回滚。
 *
 * 各 targetType 的写入目标：
 *   - iron-law / guideline → **#602 D1 新落点：`<repoRoot>/.harness/config.yml`**
 *       （harness 约束唯一真实生效形态，`getEffectiveConstraints` 读它覆盖内置集）。
 *       动作集已收敛（M3.2），仅两类：
 *       · retire（M3.3）：**复用 harness `constraints retire <id> --yes` CLI**
 *         （studio node_modules 的 harness 1.10.0 barrel 未导出 retireConstraint，
 *         走 CLI 同时天然规避 barrel 冻结闸）。config.yml 墓碑与
 *         `constraint-retired-<id>` 知识条目（飞轮唯一自动入水口）都由 harness 写，
 *         applier 不自写 config.yml 绕开；频道 approve 即执行层人确认，故直达带 --yes。
 *         写后用 getEffectiveConstraints 验证生效集已缩小，失败回滚备份。
 *       · disable：enabled:false 无墓碑（harness 无 disable 子命令/函数，且 disable
 *         无知识条目语义——墓碑与沉淀是 retire 专有），同一验证+回滚纪律。
 *       生效后（M3.5）立即 `git -C <repoRoot> add .harness/config.yml && git commit`
 *       自动留痕：正文带提案号，trailer `Governance-Approved: EP-XXXX`；commit 失败
 *       降级为 warn 日志 + ApplyResult.trail.committed=false，不阻断生效结果。
 *       存量历史词表（message/new-entry/exception）在 harness 1.10.0（ADR-0029 文本层
 *       关停）无生效落点，落笔前拒绝（service 层保持 approved 可重试）。
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
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { CONSTRAINTS, getEffectiveConstraints } from '@dommaker/harness';
import {
  logger,
  resolvePromptOverridesDir,
  type EvolutionProposalData,
} from '@dommaker/studio-shared';
import type { EvolutionPaths } from './signals.js';

/** M3.5 生效留痕结果：commit 失败不阻断生效（config 已生效是事实），经 trail 暴露失败状态 */
export interface CommitTrail {
  committed: boolean;
  sha?: string;
  error?: string;
}

export interface ApplyResult {
  targetPath: string;
  backupPath: string | null;
  detail: string;
  /** M3.5：config.yml 生效后的自动 commit 留痕（仅约束类提案；幂等未写文件时缺省） */
  trail?: CommitTrail;
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

interface CmdResult { code: number; stdout: string; stderr: string }

/** spawn 外部命令，退出码归一化（非零退出不 reject；ENOENT/超时等 spawn 级错误并入 stderr） */
function runCmd(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = typeof (err as { code?: unknown } | null)?.code === 'number'
        ? (err as unknown as { code: number }).code
        : err ? 1 : 0;
      const spawnErr = err && typeof (err as { code?: unknown }).code !== 'number' ? String(err) : '';
      resolve({ code: exitCode, stdout: String(stdout), stderr: [String(stderr).trim(), spawnErr].filter(Boolean).join('\n') });
    });
  });
}

let _harnessBin: string | null = null;
/**
 * harness CLI bin 路径：从本仓依赖解析（main = dist/index.js → ../bin/harness.js），
 * 不走 `npx harness`——repoRoot 是目标项目目录，未必装有 harness，npx 有联网拉取风险。
 * 先例（output-capture 的 npx 用法）是取数场景，生效写路径要求确定性解析。
 */
function resolveHarnessBin(): string {
  if (_harnessBin) return _harnessBin;
  const req = createRequire(import.meta.url);
  const entry = req.resolve('@dommaker/harness');
  _harnessBin = path.join(path.dirname(entry), '..', 'bin', 'harness.js');
  return _harnessBin;
}

/** 读 config.yml 的 constraints 段（不存在 → 空）。 */
function readConfigConstraints(targetPath: string): Record<string, Record<string, unknown>> {
  if (!fs.existsSync(targetPath)) return {};
  const raw = (yaml.load(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown> | null) ?? {};
  return { ...((raw.constraints ?? {}) as Record<string, Record<string, unknown>>) };
}

/**
 * #602 D1 + M3.3：retire 提案落点 —— 复用 harness `constraints retire <id> --yes` CLI
 * （harness 1.10.0 barrel 未导出 retireConstraint，CLI 路径零公共面变更、规避 barrel
 * 冻结闸；频道 approve 即 ADR-0001 决策 2 的执行层人确认，故直达显式 --yes）。
 * config.yml 墓碑与 constraint-retired-<id> 知识条目（consumptionMode:'signal'，飞轮
 * 唯一自动入水口）由 harness 单侧写入——applier 禁止自写 config.yml 绕开。
 * 写后以 getEffectiveConstraints 验证生效集已缩小，验证失败回滚备份并抛错。
 * 幂等：已 disabled → detail 报 already retired，不起子进程。
 */
async function applyConstraintRetire(
  proposal: EvolutionProposalData,
  paths: EvolutionPaths,
): Promise<{ targetPath: string; backupPath: string | null; detail: string; wrote: boolean }> {
  const id = proposal.targetId;
  if (!findBuiltinConstraint(id)) {
    throw new Error(`cannot retire unknown constraint '${id}': 非内置约束（E1 retire 只处理 harness 内置 check 约束）`);
  }
  const targetPath = path.join(paths.repoRoot, '.harness', 'config.yml');
  if (readConfigConstraints(targetPath)[id]?.enabled === false) {
    return { targetPath, backupPath: null, detail: `constraint '${id}' already retired (config.yml enabled:false)`, wrote: false };
  }

  const backupPath = await backupFile(targetPath);
  const reason = proposal.proposedText || proposal.rationale.split('\n')[0];
  const res = await runCmd(process.execPath, [
    resolveHarnessBin(), 'constraints', 'retire', id, '--yes', '--reason', reason, '-p', paths.repoRoot,
  ]);
  if (res.stdout.includes('已处于退役状态')) {
    return { targetPath, backupPath: null, detail: `constraint '${id}' already retired (config.yml enabled:false)`, wrote: false };
  }
  if (res.stdout.includes('约束不存在')) {
    throw new Error(`cannot retire unknown constraint '${id}': harness 判定非内置约束`);
  }
  if (res.code !== 0) {
    throw new Error(`harness constraints retire ${id} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(0, 400)}`);
  }

  // 写后验证：生效集必须已不含该约束（防格式写错假「已生效」）；失败回滚 config.yml
  // （知识条目已沉淀则保留——signal 条目无害，恢复约束 = 删 config.yml 中该段）
  try {
    if (getEffectiveConstraints(paths.repoRoot).some(c => c.id === id)) {
      throw new Error('constraint still present in effective set after retire');
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    else fs.rmSync(targetPath, { force: true });
    throw new Error(`constraint retire failed verification, restored backup: ${String(err)}`);
  }
  return { targetPath, backupPath, detail: `retired builtin constraint '${id}' via harness constraints retire CLI（含 constraint-retired-${id} 知识条目）`, wrote: true };
}

/**
 * M3.2：disable 提案落点 —— config.yml `constraints.<id>.enabled=false`，无 retired
 * 墓碑。harness 无 disable 子命令/函数（墓碑与知识沉淀是 retire 专有语义），此处直写
 * config.yml 不涉绕开飞轮入水口。同一验证+回滚纪律；幂等 already disabled。
 */
async function applyConstraintDisable(
  proposal: EvolutionProposalData,
  paths: EvolutionPaths,
): Promise<{ targetPath: string; backupPath: string | null; detail: string; wrote: boolean }> {
  const id = proposal.targetId;
  if (!findBuiltinConstraint(id)) {
    throw new Error(`cannot disable unknown constraint '${id}': 非内置约束（E1 disable 只处理 harness 内置 check 约束）`);
  }
  const targetPath = path.join(paths.repoRoot, '.harness', 'config.yml');
  const constraints = readConfigConstraints(targetPath);
  const prev = constraints[id] ?? {};
  if (prev.enabled === false) {
    return { targetPath, backupPath: null, detail: `constraint '${id}' already disabled (config.yml enabled:false)`, wrote: false };
  }

  const raw = fs.existsSync(targetPath)
    ? (yaml.load(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown> | null) ?? {}
    : {};
  constraints[id] = { ...prev, enabled: false };
  const next = { ...raw, constraints };

  const backupPath = await backupFile(targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, yaml.dump(next, { lineWidth: 120 }), 'utf-8');

  try {
    if (getEffectiveConstraints(paths.repoRoot).some(c => c.id === id)) {
      throw new Error('constraint still present in effective set after disable');
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    else fs.rmSync(targetPath, { force: true });
    throw new Error(`constraint disable failed verification, restored backup: ${String(err)}`);
  }
  return { targetPath, backupPath, detail: `disabled builtin constraint '${id}' via config.yml (enabled:false，无 retired 墓碑)`, wrote: true };
}

/**
 * M3.5：config.yml 生效留痕 —— 立即自动 commit 直落当前分支（生产即 master）。
 * 只 add `.harness/config.yml` 单文件（绝不 `git add -A`）；message 正文带提案号，
 * trailer `Governance-Approved: EP-XXXX`（词表扩展出处：M3.5 口径，2026-09-21 人闸）。
 * 降级：无 git 环境 / 工作区冲突 / identity 缺失等失败 → warn 日志 + committed:false，
 * 不阻断生效结果（config 已生效是事实）；失败状态经 ApplyResult.trail 暴露给事件流。
 */
async function commitConfigTrail(repoRoot: string, proposal: EvolutionProposalData): Promise<CommitTrail> {
  const relPath = '.harness/config.yml';
  try {
    const add = await runCmd('git', ['-C', repoRoot, 'add', '--', relPath]);
    if (add.code !== 0) throw new Error(`git add ${relPath} failed: ${(add.stderr || add.stdout).slice(0, 300)}`);
    const subject = `chore(evolution): ${proposal.constraintChange} constraint ${proposal.targetId} (${proposal.id})`;
    const body = `飞轮提案自动生效留痕：${proposal.id}（${proposal.constraintChange} ${proposal.targetId}）\n\nGovernance-Approved: ${proposal.id}`;
    const commit = await runCmd('git', ['-C', repoRoot, 'commit', '-m', subject, '-m', body]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).slice(0, 300)}`);
    const head = await runCmd('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
    return { committed: true, ...(head.code === 0 ? { sha: head.stdout.trim() } : {}) };
  } catch (err) {
    logger.warn('[Evolution] config.yml 生效留痕 commit 失败（不阻断生效结果）', { id: proposal.id, error: String(err) });
    return { committed: false, error: String(err) };
  }
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
      // #602 D1：retire/disable 落点 = .harness/config.yml；M3.3 retire 复用 harness CLI。
      const applied = proposal.constraintChange === 'retire'
        ? await applyConstraintRetire(proposal, paths)
        : proposal.constraintChange === 'disable'
          ? await applyConstraintDisable(proposal, paths)
          : null;
      if (applied) {
        // M3.5：生效后立即自动 commit 留痕（幂等未写文件 → 无 commit）；失败降级不阻断
        const trail = applied.wrote ? await commitConfigTrail(paths.repoRoot, proposal) : undefined;
        return { targetPath: applied.targetPath, backupPath: applied.backupPath, detail: applied.detail, ...(trail ? { trail } : {}) };
      }
      // M3.2 动作集收敛：词表只剩 retire/disable；存量历史提案（message/new-entry/
      // exception）在 harness 1.10.0（ADR-0029 决策 4）后无生效落点——落笔前拒绝，
      // service 层保持 status='approved' + APPLY_FAILED 可重试。
      throw new Error(
        `约束类提案（${proposal.targetType}/${String(proposal.constraintChange ?? 'message')}）落点已退役：` +
        `harness 1.10.0 起仅 retire/disable 有真实落点（config.yml），文案/例外类变更无消费端。`,
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
