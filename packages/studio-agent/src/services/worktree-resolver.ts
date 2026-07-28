/**
 * Worktree Resolver — git worktree 创建 + harness 配置传播 + 文件桥 + 依赖缓存
 *
 * P11-02: Extracted from agent-executor.ts
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { FileStore, logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';

const fileStore = new FileStore();

import type { AgentTask } from './session-manager.js';
import { execSync } from 'child_process';

/** 检测仓库默认分支名（不猜 main/master） */
function getDefaultBranch(cwd: string): string {
  try {
    const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return remoteHead.replace('refs/remotes/origin/', '');
  } catch { /* no remote HEAD */ }
  for (const branch of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return branch;
    } catch { /* branch doesn't exist */ }
  }
  return 'master';
}

/**
 * 创建 worktree（真 git worktree add）
 * branchName 显式指定时优先（B3b-i 按 WU 键控的分支名 task/<wuId>）；
 * 缺省保持原行为 task/<basename(worktree)>（含完整 executionId，findTaskBranch 可找到）。
 */
export async function createWorktree(worktree: string, baseBranch: string, repoDir: string, task?: AgentTask, branchName?: string): Promise<void> {
  // Validate repoDir is a git repository
  if (!fsSync.existsSync(path.join(repoDir, '.git'))) {
    throw new Error(`repoDir is not a git repository: ${repoDir}`);
  }

  // 清理已存在的目录
  try {
    await execSh(`git worktree remove --force "${worktree}" 2>/dev/null || true`, {
      cwd: repoDir,
      timeoutMs: 10_000,
    });
  } catch (e) {
    logger.warn('[WorktreeResolver] Failed to remove worktree, continuing', { error: String(e) });
  }

  try {
    await fs.rm(worktree, { recursive: true, force: true });
  } catch (e) {
    logger.warn('[WorktreeResolver] Failed to clean worktree dir, continuing', { error: String(e) });
  }

  // 创建 git worktree — 缺省分支名必须包含完整 executionId，确保 findTaskBranch 能找到
  const branch = branchName ?? `task/${path.basename(worktree)}`;
  try {
    await execSh(
      `git worktree add -b "${branch}" "${worktree}" "${baseBranch}"`,
      { cwd: repoDir, timeoutMs: 30_000 },
    );
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      try {
        await execSh(`git branch -D "${branch}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
        await execSh(`git worktree add -b "${branch}" "${worktree}" "${baseBranch}"`, { cwd: repoDir, timeoutMs: 30_000 });
      } catch (e2: any) { throw new Error(`Worktree creation failed after cleanup: ${e2.message}`); }
    } else { throw e; }
  }
  logger.info('[WorktreeResolver] Git worktree created', { worktree, branch, base: baseBranch, repo: repoDir });
  await writeWorktreeExclude(worktree);
}

// ─── 工具产物 exclude（§10.5 提交守卫误伤修复）───

/**
 * runner 执行期写入 worktree 的工具产物（全部 untracked）——
 * 不写进 exclude 会让 `git status --porcelain` 恒非空，提交守卫把"不改代码的角色"
 * （如 reviewer）的 COMPLETE 永远打回。刻意不含 AGENTS.md：它是内容文件，
 * agent 可能 legit 修改（且 propagateHarnessConfig 覆盖既有 AGENTS.md 是另一已知问题）。
 */
const WORKTREE_EXCLUDE_PATTERNS = ['.claude/', '.studio/', '.daemon/', '.agent.log'] as const;

/**
 * 新建 worktree 后，把工具产物写进仓库级 `.git/info/exclude`（不写 repo 文件）。
 * 注意 git 没有 per-worktree exclude（2.43 实测 `<gitdir>/worktrees/<name>/info/exclude`
 * 不生效，`git rev-parse --git-path info/exclude` 在 worktree 内解析到公共 gitdir）——
 * 写入的是该仓库所有 worktree 共享的 exclude。主 workspace 直接执行的路径不经过
 * createWorktree，不会触发本函数；已有 worktree 复用路径也不经过（只新建时写）。
 * 幂等 + best-effort：已存在的行不重复写，任何失败仅 warn，绝不影响 worktree 创建。
 */
async function writeWorktreeExclude(worktree: string): Promise<void> {
  try {
    const { stdout } = await execSh('git rev-parse --git-path info/exclude', { cwd: worktree, timeoutMs: 5_000 });
    const rawPath = stdout.trim().split('\n')[0];
    if (!rawPath) return;
    const excludePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(worktree, rawPath);

    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf-8');
    } catch { /* exclude 文件不存在 —— 视为空 */ }
    const existingLines = new Set(existing.split('\n').map(l => l.trim()));
    const missing = WORKTREE_EXCLUDE_PATTERNS.filter(p => !existingLines.has(p));
    if (missing.length === 0) return;

    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
    await fs.writeFile(excludePath, `${prefix}# studio-agent tool artifacts (commit-guard fix)\n${missing.join('\n')}\n`, 'utf-8');
    logger.info('[WorktreeResolver] Tool artifacts added to git exclude', { excludePath, patterns: missing });
  } catch (e) {
    logger.warn('[WorktreeResolver] Failed to write git exclude (non-blocking)', { worktree, error: String(e) });
  }
}

// ─── B3b-i: 每 WU 专属 worktree（按 WU id 键控，跨 step 复用）───

export interface WuWorktreeInfo {
  worktreePath: string; // <worktreesDir>/wu-<wuId>
  branch: string;       // task/<wuId>
  baseBranch: string;   // 创建时探测/复用时沿用 metadata 记录
  baseRepo: string;     // 共享 git 仓库根
}

/**
 * B3b-i: 确保 WU 专属 worktree 存在。
 * 目录 <worktreesDir>/wu-<wuId>、分支 task/<wuId>；同一 WU 的多个 step 复用同一 worktree
 * （目录含 .git 即视为已创建，直接复用，不重建）。
 * 创建失败：清理半成品（worktree 注册项 + 目录 + 分支）后抛错——
 * 调用方（agent-loop）走失败分支，绝不允许静默退回共享目录执行。
 */
export async function ensureWuWorktree(opts: {
  wuId: string;
  repoDir: string;
  worktreesDir: string;
  baseBranch?: string;
}): Promise<WuWorktreeInfo> {
  const { wuId, repoDir, worktreesDir } = opts;
  const worktreePath = path.join(worktreesDir, `wu-${wuId}`);
  const branch = `task/${wuId}`;

  if (fsSync.existsSync(path.join(worktreePath, '.git'))) {
    logger.info('[WorktreeResolver] Reusing WU worktree', { worktreePath, wuId });
    return { worktreePath, branch, baseBranch: opts.baseBranch || getDefaultBranch(repoDir), baseRepo: repoDir };
  }

  const baseBranch = opts.baseBranch || getDefaultBranch(repoDir);
  try {
    await createWorktree(worktreePath, baseBranch, repoDir, undefined, branch);
  } catch (e) {
    logger.error('[WorktreeResolver] WU worktree creation failed, cleaning up', { worktreePath, wuId, error: String(e) });
    await cleanupFailedWuWorktree(worktreePath, branch, repoDir);
    throw e;
  }
  logger.info('[WorktreeResolver] WU worktree created', { worktreePath, branch, baseBranch, repo: repoDir, wuId });
  return { worktreePath, branch, baseBranch, baseRepo: repoDir };
}

/** ensureWuWorktree 失败兜底：清掉半成品（best-effort，绝不再抛错掩盖原始错误） */
async function cleanupFailedWuWorktree(worktreePath: string, branch: string, repoDir: string): Promise<void> {
  try {
    await execSh(`git worktree remove --force "${worktreePath}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 10_000 });
  } catch { /* best-effort */ }
  try {
    await fs.rm(worktreePath, { recursive: true, force: true });
  } catch { /* best-effort */ }
  try {
    await execSh(`git branch -D "${branch}" 2>/dev/null || true`, { cwd: repoDir, timeoutMs: 5_000 });
  } catch { /* best-effort */ }
}

/**
 * 3-priority workspace resolution:
 *   1. task.parameters.workspaceRoot (direct path)
 *   2. VPS workspace DB query (prisma.workspace.findFirst) — skipped when hasWorktree=true
 *   3. createWorktree() fallback
 *
 * hasWorktree=true: caller explicitly wants isolated git worktree, skip VPS workspace.
 */
export async function resolveWorkspace(opts: {
  task: AgentTask;
  worktreesDir: string;
  repoDir: string;
}): Promise<string> {
  const { task, worktreesDir, repoDir } = opts;

  // Priority 1: direct from task parameters
  const directRoot = task.parameters?.workspaceRoot as string | undefined;
  if (directRoot && fsSync.existsSync(directRoot)) {
    logger.info('[WorktreeResolver] Using workspaceRoot from task parameters', { workspaceRoot: directRoot });
    return directRoot;
  }

  // Priority 2: DB query for VPS workspace (skip when hasWorktree=true)
  const needsWorktree = task.parameters?.hasWorktree === true;
  if (needsWorktree) {
    logger.info('[WorktreeResolver] hasWorktree=true, skipping VPS workspace, creating git worktree');
  } else {
    try {
      // Look up VPS workspace from FileStore
      let ws: { id: string; workspaceRoot?: string; updatedAt?: string } | null = null;
      try {
        const wsDir = path.join(os.homedir(), '.studio', 'workspaces');
        const entries = await fs.readdir(wsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.json')) continue;
          const data = await fileStore.readJson<any>(path.join(wsDir, e.name));
          if (data && data.name === 'VPS' && !data.tokenId) {
            if (!ws || new Date(data.updatedAt) > new Date(ws.updatedAt)) ws = data;
          }
        }
      } catch { /* no workspace dir */ }
      if (ws?.workspaceRoot && fsSync.existsSync(ws.workspaceRoot)) {
        logger.info('[WorktreeResolver] Using workspace from FileStore', { workspaceId: ws.id, workspaceRoot: ws.workspaceRoot });
        return ws.workspaceRoot;
      }
    } catch (e) {
      logger.warn('[WorktreeResolver] DB workspace query failed, falling back to createWorktree', { error: String(e) });
    }
  }

  // Priority 3: create git worktree
  const worktree = path.join(worktreesDir, task.executionId);
  const projectRepo = (task.parameters?.repoDir as string) || repoDir;
  const baseBranch = (task.parameters?.baseBranch as string) || getDefaultBranch(projectRepo);
  await createWorktree(worktree, baseBranch, projectRepo, task);
  return worktree;
}

/**
 * 传播 harness 约束 + Claude 权限配置到 worktree
 */
export async function propagateHarnessConfig(worktree: string, taskId: string, executionId: string, repoDir?: string): Promise<void> {
  try {
    // FIX #3: 复制 CLAUDE.md 到 worktree，使 buildAgentConstraintPrompt 去重逻辑生效
    // 主 repo CLAUDE.md 含 <!-- HARNESS_CONSTRAINTS_START --> 标记，
    // buildAgentConstraintPrompt 检测到后只注入短引用，避免全量规则重复
    if (repoDir) {
      const claudeMdSrc = path.join(repoDir, 'CLAUDE.md');
      const claudeMdDst = path.join(worktree, 'CLAUDE.md');
      if (!fsSync.existsSync(claudeMdDst) && fsSync.existsSync(claudeMdSrc)) {
        fsSync.copyFileSync(claudeMdSrc, claudeMdDst);
      }
    }

    const harnessDir = path.join(worktree, '.harness');
    if (!fsSync.existsSync(harnessDir)) {
      const templateDir = path.resolve(process.cwd(), '.harness');
      if (fsSync.existsSync(templateDir)) {
        fsSync.mkdirSync(harnessDir, { recursive: true });
        for (const f of ['config.yml', 'checkpoints.yml', 'custom-constraints.yml']) {
          const src = path.join(templateDir, f);
          if (fsSync.existsSync(src)) {
            fsSync.copyFileSync(src, path.join(harnessDir, f));
          }
        }
      } else {
        const harnessPkgDir = path.dirname(require.resolve('@dommaker/harness/package.json'));
        const nodeApiTpl = path.join(harnessPkgDir, 'templates', 'node-api');
        if (fsSync.existsSync(nodeApiTpl)) {
          await execSh(`cp -r "${nodeApiTpl}/.harness" "${harnessDir}" 2>/dev/null || true`, {
            cwd: worktree, timeoutMs: 5000,
          });
        }
      }
    }

    // 写入 .claude/settings.json 使 root daemon 无需 --dangerously-skip-permissions
    const claudeDir = path.join(worktree, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fsSync.existsSync(settingsPath)) {
      fsSync.mkdirSync(claudeDir, { recursive: true });

      // Studio MCP server URL (provides loadSkill, searchKnowledge, etc.)
      const studioMcpUrl = process.env.STUDIO_MCP_URL || 'http://localhost:13101/api/v1/mcp/sse';

      fsSync.writeFileSync(settingsPath, JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
        mcpServers: {
          'studio': {
            type: 'sse',
            url: studioMcpUrl,
          },
          'local-rag': process.env.LOCAL_RAG_BRIDGE_URL
            ? { type: 'sse', url: process.env.LOCAL_RAG_BRIDGE_URL }
            : {
                command: 'mcp-local-rag',
                args: [
                  '--db-path', process.env.LOCAL_RAG_DB_PATH || '/root/.cache/mcp-local-rag/lancedb',
                  '--model-name', process.env.LOCAL_RAG_MODEL || '/root/.cache/huggingface/hub/models--onnx-community--bge-small-zh-v1.5-ONNX/snapshots/main',
                ],
              },
        },
      }, null, 2), 'utf-8');
    }

    // §10 P0: 写 AGENTS.md / CLAUDE.md（skill 索引 + SDD 落盘要求）——
    // codex/kimi/opencode 原生读 AGENTS.md，claude 读 CLAUDE.md，四家 CLI 全覆盖。
    // CLAUDE.md 已存在（如上方从 repoDir 传播的工程级约束）时不覆盖。
    const agentsMd = buildAgentsMdContent();
    if (agentsMd) {
      fsSync.writeFileSync(path.join(worktree, 'AGENTS.md'), agentsMd, 'utf-8');
      const claudeMdPath = path.join(worktree, 'CLAUDE.md');
      if (!fsSync.existsSync(claudeMdPath)) {
        fsSync.writeFileSync(claudeMdPath, agentsMd, 'utf-8');
      }
      copySkillFiles(worktree);
    }
  } catch { logger.warn('[WorktreeResolver] Harness/Claude config init failed (non-blocking)', { taskId, executionId }); }
}

// ─── AGENTS.md 生成（§10 P0）───

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

/**
 * 扫描 skills 目录，解析 SKILL.md frontmatter（name + description）。
 * studio-agent 是独立包，不能 import apps/api 的 manifest-loader —— 此处保留一份
 * 最小解析副本（只取索引所需的两个标量字段）。manifest 读取失败返回 null（静默跳过）。
 */
function readSkillIndex(): Array<{ name: string; description: string }> | null {
  try {
    if (!fsSync.existsSync(SKILLS_DIR)) return [];
    const dirs = fsSync.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills: Array<{ name: string; description: string }> = [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('_')) continue;
      const skillFile = path.join(SKILLS_DIR, dir.name, 'SKILL.md');
      if (!fsSync.existsSync(skillFile)) continue;
      try {
        const content = fsSync.readFileSync(skillFile, 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) continue;
        let name = '';
        let description = '';
        let status = '';
        for (const line of match[1].split('\n')) {
          const kv = line.match(/^(\w+):\s*(.+)$/);
          if (!kv) continue;
          const cleaned = kv[2].replace(/^["']|["']$/g, '');
          if (kv[1] === 'name') name = cleaned;
          if (kv[1] === 'description') description = cleaned;
          if (kv[1] === 'status') status = cleaned;
        }
        // status 缺省 = active；显式非 published 不进索引
        if (!name || (status && status !== 'published')) continue;
        skills.push({ name, description });
      } catch { /* 单个 skill 解析失败跳过 */ }
    }
    return skills;
  } catch {
    return null; // manifest 读取失败 —— 静默跳过，不写 AGENTS.md
  }
}

/**
 * index-on-demand：把活跃 skill 的 SKILL.md 原文（含 frontmatter）复制到
 * `<worktree>/.studio/skills/<name>/SKILL.md`，供 agent 按需阅读。
 * 活跃判定复用 readSkillIndex（status 缺省或 published、非 _ 前缀目录）。
 * 只复制 SKILL.md，不带 evals/ 等其他文件；失败静默（与既有分支口径一致）。
 */
function copySkillFiles(worktree: string): void {
  try {
    const skills = readSkillIndex();
    if (!skills) return;
    for (const skill of skills) {
      const src = path.join(SKILLS_DIR, skill.name, 'SKILL.md');
      if (!fsSync.existsSync(src)) continue;
      const dstDir = path.join(worktree, '.studio', 'skills', skill.name);
      fsSync.mkdirSync(dstDir, { recursive: true });
      fsSync.copyFileSync(src, path.join(dstDir, 'SKILL.md'));
    }
  } catch { /* 复制失败静默跳过 */ }
}

/**
 * 组装 AGENTS.md 内容：可用 skill 索引（name + 一句话 description）+ 全文指针 + SDD 落盘要求。
 * 只放索引行，不放 skill 正文（index-on-demand：全文由 copySkillFiles 落到 .studio/skills/）。
 */
export function buildAgentsMdContent(): string | null {
  const skills = readSkillIndex();
  if (skills === null) return null;

  return [
    '# Studio Agent 工作区指南',
    '',
    '## 可用 Skills（索引）',
    ...(skills.length > 0
      ? skills.map(s => `- **${s.name}** — ${s.description || '（无描述）'}`)
      : ['（当前无已发布的 skill）']),
    ...(skills.length > 0
      ? ['', '各 skill 全文位于 `.studio/skills/<name>/SKILL.md`，与任务相关时按需阅读。']
      : []),
    '',
    '## SDD 落盘要求',
    '- 产出设计文档时：写 `docs/sdd/<slug>/requirement.md`、`docs/sdd/<slug>/design.md`、`docs/sdd/<slug>/task.md`。',
    '- 并在 `docs/sdd/_index.md` 登记该 slug（标题、状态、关联 REQ/任务）。',
    '',
  ].join('\n');
}

/**
 * Build shared cache prefix — byte-identical across all worktrees
 * so DeepSeek's prefix cache matches across pipeline agent sessions.
 */
export function buildCachePrefix(repoDir: string): string {
  // 探测包管理器
  const pkgManager = fsSync.existsSync(path.join(repoDir, 'pnpm-lock.yaml')) ? 'pnpm'
    : fsSync.existsSync(path.join(repoDir, 'yarn.lock')) ? 'yarn' : 'npm';

  const installCmd = pkgManager === 'pnpm' ? 'pnpm install'
    : pkgManager === 'yarn' ? 'yarn install' : 'npm install';
  const testCmd = pkgManager === 'pnpm' ? 'pnpm test'
    : pkgManager === 'yarn' ? 'yarn test' : 'npm test';

  const lines = [
    '<!-- SHARED_CACHE_PREFIX — DO NOT EDIT — identical across all worktrees -->',
    '',
    '# Project Context (shared)',
    '',
    '## 环境',
    `- 包管理器: ${pkgManager}`,
    `- 安装依赖: \`${installCmd}\``,
    `- 运行测试: \`${testCmd}\``,
    '- 类型检查: `npx tsc --noEmit`',
    '- 依赖已预装（node_modules 通过 hardlink 缓存）。',
    '- **禁止自己跑 install**：node_modules 已存在。如果 import 报错，检查是否是自己修改了代码导致的，修复代码而非安装依赖。',
    '',
  ];
  try {
    const claudeMd = fsSync.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8');
    lines.push(claudeMd);
  } catch {}
  lines.push('');
  return lines.join('\n');
}

/**
 * 写入 REQUIREMENTS.md（session 间共享的 AC 上下文）
 */
export async function writeRequirementsMd(
  worktree: string,
  task: AgentTask,
  acGroup?: Record<string, any>,
  testFiles?: string[],
): Promise<void> {
  const acs: string[] = acGroup?.acs || [];
  const files: string[] = acGroup?.files || [];
  const notes: string = acGroup?.implementationNotes || '';
  const patterns: string[] = acGroup?.codePatterns || [];
  const gotchas: string[] = acGroup?.gotchas || [];
  const archCtx = acGroup?.architectureContext as Record<string, any> | undefined;

  const isSimple = files.length <= 1 && acs.length <= 3 && gotchas.length <= 2;

  const sections = [
    '# 需求',
    ...(isSimple ? [
      '> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。',
      '> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json',
      '',
    ] : []),
    `## 任务`,
    task.prompt,
    '',
    '## 你负责的验收标准',
    ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : ['（从任务描述中推断）']),
    '',
    // ── 架构上下文（Analyst 已探索，你不需要重新读 CLAUDE.md）──
    ...(archCtx ? ['## 架构上下文（Analyst 已探索并验证）', '', '**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。', ''] : []),
    ...(archCtx?.functions?.length ? ['### 关键函数', ...archCtx.functions.map((f: string) => `- ${f}`), ''] : []),
    ...(archCtx?.callChain ? ['### 调用链', archCtx.callChain, ''] : []),
    ...(archCtx?.imports?.length ? ['### 需要导入', ...archCtx.imports.map((i: string) => `\`\`\`${i}\`\`\``), ''] : []),
    ...(archCtx?.typesInScope?.length ? ['### 相关类型', ...archCtx.typesInScope.map((t: string) => `- ${t}`), ''] : []),
    ...(archCtx?.dangerZones?.length ? ['### ⚠️ 禁区（不要触碰）', ...archCtx.dangerZones.map((d: string) => `- ${d}`), ''] : []),
    ...(archCtx?.testMock?.length ? ['### 测试 mock 模板', ...archCtx.testMock.map((m: string) => `\`\`\`typescript\n${m}\n\`\`\``), ''] : []),
    ...(archCtx?.verifiedAt ? [`*以上信息验证于 commit ${archCtx.verifiedAt}*`, ''] : []),
    ...(notes ? ['## 实现指南', notes, ''] : []),
    ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
    ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
    ...(files.length > 0 ? ['## 预期改动文件', ...files.map(f => `- ${f}`), ''] : []),
    // SP-004 Step 5: testFiles from SDD task layer (GREEN phase verification)
    ...(testFiles && testFiles.length > 0 ? [
      '## 验证测试文件（GREEN 阶段必须全部通过）',
      ...testFiles.map(f => `- \`${f}\``),
      '',
      `运行命令: \`npx vitest run ${testFiles.join(' ')}\``,
      '',
    ] : []),
    '## 行为约束',
    ...(testFiles && testFiles.length > 0
      ? ['- 完成前必须运行上述指定测试文件 + type check + lint']
      : ['- 完成前必须运行 npm test + type check + lint']),
    '- 禁止模糊声明完成',
    '- 每完成一个步骤后立即更新 .progress.json',
    '- 全部 AC 测试通过后才设置 .progress.json allComplete: true',
    '- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）',
    `- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "${testFiles && testFiles.length > 0 ? `npx vitest run ${testFiles.join(' ')}` : 'npm test'}", evidence: "<测试输出>" }`,
    '- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }',
    '- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节',
  ];

  await fs.writeFile(path.join(worktree, 'REQUIREMENTS.md'), sections.join('\n'), 'utf-8');
}

/**
 * TDD-07: 写入 Analyst 的契约测试到 worktree __tests__/
 *
 * RequirementsDoc.contractTests 包含按 AC 组组织的可执行测试代码。
 * 测试在写入时处于 RED 状态（全部 FAIL），Executor 实现后变为 GREEN。
 */
export async function writeContractTests(
  worktree: string,
  contractTests: Array<{ file: string; content: string }>,
): Promise<void> {
  if (!contractTests?.length) return;

  const testsDir = path.join(worktree, '__tests__');
  await fs.mkdir(testsDir, { recursive: true });

  for (const test of contractTests) {
    const testPath = path.join(worktree, test.file);
    const testDir = path.dirname(testPath);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testPath, test.content, 'utf-8');
    logger.info('[WorktreeResolver] Contract test written', { file: test.file, size: test.content.length });
  }
}

// ─── Dependency Cache ───

/** Extract combined error output from execSh rejection (attaches stdout/stderr to Error). */
function extractExecError(e: unknown): string {
  if (e && typeof e === 'object') {
    const rec = e as Record<string, unknown>;
    const stderr = typeof rec.stderr === 'string' ? rec.stderr : '';
    const stdout = typeof rec.stdout === 'string' ? rec.stdout : '';
    const msg = typeof rec.message === 'string' ? rec.message : '';
    return stderr || stdout || msg;
  }
  return String(e);
}

const DEPS_CACHE_DIR = path.join(os.homedir(), '.cache', 'studio-deps');
const INSTALL_TIMEOUT_MS = 300_000; // 5min
const COPY_TIMEOUT_MS = 60_000; // 1min

/**
 * Compute short hash of lockfile content for cache key.
 * Uses first 16 hex chars of sha256.
 */
function computeLockfileHash(lockfilePath: string): string {
  const content = fsSync.readFileSync(lockfilePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Find lockfile in directory (pnpm-lock.yaml, package-lock.json, yarn.lock).
 */
function findLockfile(dir: string): string | null {
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const p = path.join(dir, name);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

/**
 * Detect package manager from lockfile name.
 */
function detectPackageManager(lockfilePath: string): 'pnpm' | 'npm' | 'yarn' {
  const base = path.basename(lockfilePath);
  if (base.startsWith('pnpm')) return 'pnpm';
  if (base.startsWith('yarn')) return 'yarn';
  return 'npm';
}

/**
 * Ensure node_modules exists in worktree, using dependency cache.
 *
 * Flow:
 *   1. node_modules/.modules.yaml exists → skip (already installed)
 *   2. Compute sha256(lockfile) as cache key
 *   3. Cache hit: cp -al (hardlink copy, <1s for 375MB)
 *   4. Cache miss: pnpm install --frozen-lockfile, then cache result
 *
 * Expected savings: 30-60s per worktree creation (install time).
 * Disk savings: hardlinks share inodes, no extra disk for cached copies.
 */
export async function ensureDeps(worktree: string, repoDir: string): Promise<void> {
  const nodeModulesPath = path.join(worktree, 'node_modules');
  const modulesYaml = path.join(nodeModulesPath, '.modules.yaml');

  // Already installed — skip
  if (fsSync.existsSync(modulesYaml)) {
    logger.info('[WorktreeResolver] Deps cache: node_modules exists, skipping', { worktree });
    return;
  }

  // Find lockfile (prefer worktree, fall back to repoDir)
  const lockfile = findLockfile(worktree) || findLockfile(repoDir);
  if (!lockfile) {
    logger.warn('[WorktreeResolver] Deps cache: no lockfile found, running bare install', { worktree });
    const pkgManager = fsSync.existsSync(path.join(worktree, 'pnpm-lock.yaml')) ? 'pnpm'
      : fsSync.existsSync(path.join(worktree, 'yarn.lock')) ? 'yarn' : 'npm';
    await execSh(`${pkgManager} install`, { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
    return;
  }

  const hash = computeLockfileHash(lockfile);
  const cacheDir = path.join(DEPS_CACHE_DIR, hash);
  const cachedModules = path.join(cacheDir, 'node_modules');
  const pkgManager = detectPackageManager(lockfile);
  const installCmd = pkgManager === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pkgManager === 'yarn' ? 'yarn install --frozen-lockfile'
    : 'npm ci';

  // Cache hit — hardlink copy
  if (fsSync.existsSync(cachedModules)) {
    const startMs = Date.now();
    logger.info('[WorktreeResolver] Deps cache: HIT', { worktree, hash, cacheDir });
    try {
      // cp -al creates hardlinks: <1s for 375MB, zero extra disk
      await execSh(`cp -al "${cachedModules}" "${nodeModulesPath}"`, {
        cwd: worktree, timeoutMs: COPY_TIMEOUT_MS,
      });
      logger.info('[WorktreeResolver] Deps cache: restored from cache', {
        worktree, hash, durationMs: Date.now() - startMs,
      });
      return;
    } catch (e) {
      // Hardlink copy failed (cross-filesystem?) — fall through to install
      logger.warn('[WorktreeResolver] Deps cache: hardlink copy failed, falling back to install', {
        worktree, hash, error: String(e),
      });
    }
  } else {
    logger.info('[WorktreeResolver] Deps cache: MISS', { worktree, hash });
  }

  // Cache miss — install from scratch
  const installStart = Date.now();
  logger.info('[WorktreeResolver] Deps cache: installing', { worktree, command: installCmd });
  try {
    await execSh(installCmd, { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
    logger.info('[WorktreeResolver] Deps cache: install complete', {
      worktree, durationMs: Date.now() - installStart,
    });
  } catch (e: unknown) {
    // Lockfile incompatible — fallback to --force (rewrites lockfile)
    const errMsg = extractExecError(e);
    if (pkgManager === 'pnpm' && errMsg.includes('ERR_PNPM_LOCKFILE_BREAKING_CHANGE')) {
      logger.warn('[WorktreeResolver] Lockfile incompatible, retrying with --force', { worktree });
      await execSh('pnpm install --force', { cwd: worktree, timeoutMs: INSTALL_TIMEOUT_MS });
      logger.info('[WorktreeResolver] Deps cache: --force install complete', {
        worktree, durationMs: Date.now() - installStart,
      });
    } else {
      logger.error('[WorktreeResolver] Deps cache: install failed', { worktree, error: String(e) });
      throw e;
    }
  }

  // Populate cache for future worktrees
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await execSh(`cp -al "${nodeModulesPath}" "${cachedModules}"`, {
      cwd: worktree, timeoutMs: COPY_TIMEOUT_MS,
    });
    logger.info('[WorktreeResolver] Deps cache: populated cache', { worktree, hash, cacheDir });
  } catch (e) {
    // Non-blocking — cache population failure doesn't break the build
    logger.warn('[WorktreeResolver] Deps cache: failed to populate cache', {
      worktree, hash, error: String(e),
    });
  }
}
