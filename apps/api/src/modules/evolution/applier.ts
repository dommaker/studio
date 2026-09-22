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
 *         写后双验证（生效集缩小 + retired 墓碑落盘，不依赖 CLI stdout 文案），失败回滚
 *         备份；幂等短路只认 retired 墓碑——裸 disable（enabled:false 无墓碑）走升级
 *         路径摘除 enabled 标记后交 CLI 补退役（详见 applyConstraintRetire 注释）。
 *       · disable：enabled:false 无墓碑（harness 无 disable 子命令/函数，且 disable
 *         无知识条目语义——墓碑与沉淀是 retire 专有），同一验证+回滚纪律。
 *       生效后（M3.5）立即 `git -C <repoRoot> add .harness/config.yml && git commit`
 *       自动留痕：正文带提案号，trailer `Governance-Approved: EP-XXXX`；commit 失败
 *       降级为 warn 日志 + ApplyResult.trail.committed=false，不阻断生效结果。
 *       退休生效后追加两个跟进动作（ADR-0032 决策 6.1/6.2，票 02 断点 1/2）：
 *       · spawn harness CLI 时显式传 `KNOWLEDGE_BASE_DIR=UNIFIED_KNOWLEDGE_DIR`——
 *         退休沉淀落唯一正本 ~/.studio/knowledge，不靠 harness 侧已退役的目录兼容分叉；
 *       · 成功后调 `scheduleVectorDbSync()` 触发向量同步，不等入库事件的顺风车。
 *       存量历史词表（message/new-entry/exception）在 harness 1.10.0（ADR-0029 文本层
 *       关停）无生效落点，落笔前拒绝（service 层保持 approved 可重试）。
 *       · 历史落点：`<repoRoot>/.harness/custom-constraints.yml`（#606 起 harness 不再读取；
 *         配套的 `retireConstraintEntry` 文本手术已随 #617 连同 distill 审计子通道拆除）。
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
import { scheduleVectorDbSync, UNIFIED_KNOWLEDGE_DIR } from '../knowledge/knowledge-singletons.js';

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

/** spawn 外部命令，退出码归一化（非零退出不 reject；ENOENT/超时等 spawn 级错误并入 stderr）；env 增量合并进 process.env */
function runCmd(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
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
 *
 * 幂等短路只看 retired 墓碑（`constraints.<id>.retired`），不看 enabled:false：
 * harness 1.10.0 的 already_retired 保护只认 enabled:false，裸 disable（无墓碑）若
 * 直接 spawn 会被 CLI 幂等吞掉——无墓碑、无知识条目，恰好绕开飞轮唯一自动入水口。
 * 故 disable→retire 升级路径先摘除裸 disable 的 enabled 标记（备份已留，失败回滚；
 * 这不是自写墓碑绕开 CLI，而是清掉会让 CLI 误短路的旧状态），再交 CLI 完成真退役。
 *
 * 结果判定不依赖 CLI stdout 文案（harness 改文案即静默误判，且 retired/already_retired/
 * unknown_id 对外退出码同为 0——bin exitCodeFor 把 skip 也映射 0）：以退出码 + 写后
 * 双验证为准（生效集已缩小 + config.yml 已出现 retired 墓碑），验证失败回滚备份并抛错。
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
  const prevEntry = readConfigConstraints(targetPath)[id];
  // 真已退役 = 有 retired 墓碑（retire 落盘形态：enabled:false + retired:{at,reason,stats}）
  if (prevEntry?.enabled === false && prevEntry?.retired) {
    return { targetPath, backupPath: null, detail: `constraint '${id}' already retired (config.yml retired 墓碑)`, wrote: false };
  }

  const backupPath = await backupFile(targetPath);
  // disable→retire 升级：摘除裸 disable 的 enabled 标记，否则 CLI 的 already_retired
  // 保护（只认 enabled:false）会短路，拿不到墓碑与知识条目
  if (prevEntry?.enabled === false) {
    const raw = (yaml.load(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown> | null) ?? {};
    const constraints = { ...((raw.constraints ?? {}) as Record<string, Record<string, unknown>>) };
    const { enabled: _dropped, ...rest } = constraints[id] ?? {};
    constraints[id] = rest;
    fs.writeFileSync(targetPath, yaml.dump({ ...raw, constraints }, { lineWidth: 120 }), 'utf-8');
  }

  const reason = proposal.proposedText || proposal.rationale.split('\n')[0];
  // KNOWLEDGE_BASE_DIR 显式钉唯一正本（ADR-0034 目录收编，票 02 断点 1）：退休沉淀落
  // ~/.studio/knowledge，不依赖 harness 侧已退役的 legacy 目录兼容；旧版 harness（pre-#177）
  // 写口硬编码 repoRoot 会忽略此 env——无害降级，harness 升级后自动生效。
  const res = await runCmd(process.execPath, [
    resolveHarnessBin(), 'constraints', 'retire', id, '--yes', '--reason', reason, '-p', paths.repoRoot,
  ], { KNOWLEDGE_BASE_DIR: UNIFIED_KNOWLEDGE_DIR });
  if (res.code !== 0) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    else fs.rmSync(targetPath, { force: true });
    throw new Error(`harness constraints retire ${id} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(0, 400)}`);
  }

  // 写后双验证（替代 CLI stdout 文案匹配）：生效集必须已不含该约束，且 config.yml
  // 必须出现 retired 墓碑（墓碑缺失 = CLI 未真正退役，如被其内部保护短路）；
  // 失败回滚 config.yml（知识条目已沉淀则保留——signal 条目无害，恢复约束 = 删
  // config.yml 中该段）
  try {
    if (getEffectiveConstraints(paths.repoRoot).some(c => c.id === id)) {
      throw new Error('constraint still present in effective set after retire');
    }
    if (!readConfigConstraints(targetPath)[id]?.retired) {
      throw new Error(`retired tombstone missing in config.yml after retire (CLI exit 0 但未落墓碑): ${res.stdout.slice(0, 200)}`);
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, targetPath);
    else fs.rmSync(targetPath, { force: true });
    throw new Error(`constraint retire failed verification, restored backup: ${String(err)}`);
  }
  // 票 02 断点 2：退休沉淀由 harness CLI 子进程直写磁盘（不经 ingestWithQualityGate），
  // 现有同步触发点天然漏掉它——退休事件自己触发向量同步，不等顺风车；fire-and-forget，
  // 防抖/互斥/重试都在 scheduleVectorDbSync 内部，失败不阻断退休结果。
  scheduleVectorDbSync();
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
