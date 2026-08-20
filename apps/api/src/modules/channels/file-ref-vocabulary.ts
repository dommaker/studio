/**
 * #281（决策 #249 §1 / #257 D7）：@文件引用词表服务。
 *
 * 候选集 = 「频道相关工程」（UX 划界，非安全边界；安全边界在 agent CLI 权限层）：
 *   频道默认工程（#272：defaultPath=本地 repo 优先；legacy defaultWorkspaceId → workspaceRoot 保留）
 *   ∪ 本频道 REQ 挂接 PMO 的全部工程（Requirement.channelId → projectId → PMO
 *     的 gitRepo + deliveries[].gitRepo，多腿全收）
 *   ∪ 杂务 PMO 工程（isChore + channelId）
 *   去重（尾斜杠归一），频道内最近 WU 涉及过的工程优先（WU metadata.workspaceRoot，
 *   按 updatedAt 新→旧）。全部来自持久化数据实时计算，不动 project-discovery。
 *
 * 词表 = 各仓 `git ls-files` 原样相对路径 + 进程内存缓存（TTL，默认 60s，
 * 同 project-discovery 先例）。单仓失败（非 git 仓/权限/超时）→ 该仓空词表，
 * 不拖垮其他仓；失败同样入缓存防热路径反复 spawn。
 *
 * 校验（路由层存在性校验用）：repo 不在候选集 → not-in-candidate-set；
 * path 不在该仓词表 → not-found。各数据源读取失败仅记日志并跳过该来源，
 * 候选集计算绝不抛出让消息路由失败。
 */
import { execFile } from 'node:child_process';
import { logger, FileStore } from '@dommaker/studio-shared';
import { projectService } from '../pmo/project.service.js';
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from '../workspaces/workspace-store.js';

export interface FileRef {
  /** 工程绝对路径（与 PMO gitRepos 条目同形） */
  repo: string;
  /** 仓内相对路径（git ls-files 原样） */
  path: string;
}

export type FileRefDropReason = 'not-found' | 'not-in-candidate-set' | 'validation-failed';

export interface FileRefDrop extends FileRef {
  reason: FileRefDropReason;
}

/** PMO 工程的最小形状（getProject / findChoreProject 返回值收窄） */
export interface ProjectLike {
  gitRepo?: string | null;
  deliveries?: Array<{ gitRepo?: string | null }>;
}

export interface FileRefVocabularyDeps {
  fileStore?: FileStore;
  /** 默认 projectService.get（读取时合成单腿） */
  getProject?: (projectId: string) => Promise<ProjectLike | null>;
  /** 默认 projectService.findChoreProject（只查不建，热路径零副作用） */
  findChoreProject?: (channelId: string) => Promise<ProjectLike | null>;
  /** 默认 workspaces/workspace-store 的 resolveWorkspaceRoot */
  resolveWorkspaceRoot?: (workspaceId: string) => Promise<string | null>;
  /** 词表来源（默认 git ls-files）；测试注入 */
  listFiles?: (repo: string) => Promise<string[]>;
  /** 词表缓存 TTL（默认 60_000ms） */
  cacheTtlMs?: number;
  now?: () => number;
}

/** 尾斜杠归一（PMO gitRepo 与 workspaceRoot 的写法差不对齐去重键） */
function normalizeRepoPath(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

/** 工程记录 → 仓路径清单（gitRepo + deliveries[].gitRepo，去重保序；#272 当前 PMO chip 复用） */
export function reposOfProject(project: ProjectLike | null): string[] {
  if (!project) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p?: string | null) => {
    if (typeof p !== 'string' || !p) return;
    const key = normalizeRepoPath(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  push(project.gitRepo);
  for (const leg of project.deliveries ?? []) push(leg?.gitRepo);
  return out;
}

// ─── 词表内存缓存（进程级；repo 归一路径为键） ───

const vocabCache = new Map<string, { files: string[]; at: number }>();

/** 测试/运维用：清空词表缓存 */
export function invalidateFileRefVocabularyCache(): void {
  vocabCache.clear();
}

/** 默认词表来源：git ls-files（原样相对路径，一行一条） */
function gitLsFiles(repo: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git', ['ls-files'],
      { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean));
      },
    );
  });
}

async function getRepoFiles(repo: string, deps: FileRefVocabularyDeps): Promise<string[]> {
  const key = normalizeRepoPath(repo);
  const nowMs = (deps.now ?? Date.now)();
  const ttl = deps.cacheTtlMs ?? 60_000;
  const hit = vocabCache.get(key);
  if (hit && nowMs - hit.at < ttl) return hit.files;
  let files: string[] = [];
  try {
    files = await (deps.listFiles ?? gitLsFiles)(key);
  } catch (err) {
    // 单仓失败（非 git 仓等）→ 空词表，不拖垮其他仓；失败同样入缓存
    logger.warn('[FileRefVocabulary] git ls-files failed, empty vocabulary for repo', {
      repo: key, error: String(err),
    });
  }
  vocabCache.set(key, { files, at: nowMs });
  return files;
}

/**
 * 候选集计算：默认工程 ∪ REQ 挂接 PMO ∪ 杂务 PMO，去重，最近 WU 涉及工程优先。
 * 每个来源独立容错：读取失败记日志并跳过该来源。
 */
export async function computeCandidateRepos(
  channelId: string,
  deps: FileRefVocabularyDeps = {},
): Promise<string[]> {
  const fileStore = deps.fileStore ?? new FileStore();
  const getProject = deps.getProject ?? (async (id: string) => projectService.get(id));
  const findChoreProject = deps.findChoreProject ?? (async (id: string) => projectService.findChoreProject(id));
  const resolveRoot = deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot;

  // 基础序：默认工程（#272：defaultPath=本地 repo 优先，defaultWorkspaceId 执行机器根保留）→ REQ 挂接 PMO（含多腿）→ 杂务 PMO
  const base: string[] = [];
  try {
    const channel = await fileStore.getChannel(channelId);
    if (channel?.defaultPath) base.push(channel.defaultPath);
    if (channel?.defaultWorkspaceId) {
      const root = await resolveRoot(channel.defaultWorkspaceId);
      if (root) base.push(root);
    }
  } catch (err) {
    logger.warn('[FileRefVocabulary] Channel default workspace resolution failed, skipped', {
      channelId, error: String(err),
    });
  }
  try {
    const requirements = await fileStore.listRequirements({ channelId });
    for (const req of requirements) {
      const projectId = (req as { projectId?: string | null }).projectId;
      if (!projectId) continue;
      try {
        base.push(...reposOfProject(await getProject(projectId)));
      } catch (err) {
        logger.warn('[FileRefVocabulary] REQ project resolution failed, skipped', {
          channelId, reqId: req.id, projectId, error: String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('[FileRefVocabulary] Requirement listing failed, skipped', { channelId, error: String(err) });
  }
  try {
    base.push(...reposOfProject(await findChoreProject(channelId)));
  } catch (err) {
    logger.warn('[FileRefVocabulary] Chore PMO resolution failed, skipped', { channelId, error: String(err) });
  }

  // 去重（尾斜杠归一为键，输出即归一形态——与 validateFileRefs 落档口径一致）
  const seen = new Set<string>();
  const baseSet = new Set<string>();
  const deduped: string[] = [];
  for (const repo of base) {
    const key = normalizeRepoPath(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    baseSet.add(key);
    deduped.push(key);
  }

  // 最近使用优先：频道内 WU 的 metadata.workspaceRoot，按 updatedAt 新→旧；
  // 仅重排已在候选集内的工程（最近使用是排序信号，不扩张候选集）
  try {
    const index = await fileStore.getIndex();
    const recentKeys: string[] = [];
    const recentSeen = new Set<string>();
    const channelWus = index
      .filter(s => s.channelId === channelId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    for (const wu of channelWus) {
      if (!wu.metadata) continue;
      try {
        const meta = JSON.parse(wu.metadata) as { workspaceRoot?: unknown };
        if (typeof meta.workspaceRoot !== 'string' || !meta.workspaceRoot) continue;
        const key = normalizeRepoPath(meta.workspaceRoot);
        if (!baseSet.has(key) || recentSeen.has(key)) continue;
        recentSeen.add(key);
        recentKeys.push(key);
      } catch { /* 单条 metadata 损坏跳过 */ }
    }
    if (recentKeys.length > 0) {
      const byKey = new Map(deduped.map(r => [normalizeRepoPath(r), r]));
      const recentFirst = recentKeys.map(k => byKey.get(k)!);
      const rest = deduped.filter(r => !recentSeen.has(normalizeRepoPath(r)));
      return [...recentFirst, ...rest];
    }
  } catch (err) {
    logger.warn('[FileRefVocabulary] Recent-WU ordering failed, using base order', {
      channelId, error: String(err),
    });
  }
  return deduped;
}

export interface ChannelFileVocabulary {
  repos: { repo: string; files: string[] }[];
}

/** 只读词表：候选集顺序，各仓 git ls-files（带内存缓存） */
export async function getChannelFileVocabulary(
  channelId: string,
  deps: FileRefVocabularyDeps = {},
): Promise<ChannelFileVocabulary> {
  const repos = await computeCandidateRepos(channelId, deps);
  const out: { repo: string; files: string[] }[] = [];
  for (const repo of repos) {
    out.push({ repo, files: await getRepoFiles(repo, deps) });
  }
  return { repos: out };
}

/**
 * 路由层存在性校验：repo ∈ 候选集 且 path ∈ 该仓词表 → kept；
 * 否则 dropped（reason = not-in-candidate-set / not-found）。
 * kept 的 repo 归一尾斜杠（落档口径一致）。
 */
export async function validateFileRefs(
  channelId: string,
  refs: FileRef[],
  deps: FileRefVocabularyDeps = {},
): Promise<{ kept: FileRef[]; dropped: FileRefDrop[] }> {
  const candidates = await computeCandidateRepos(channelId, deps);
  const candidateKeys = new Set(candidates.map(normalizeRepoPath));
  const kept: FileRef[] = [];
  const dropped: FileRefDrop[] = [];
  for (const ref of refs) {
    const key = normalizeRepoPath(ref.repo);
    if (!candidateKeys.has(key)) {
      dropped.push({ ...ref, reason: 'not-in-candidate-set' });
      continue;
    }
    const files = await getRepoFiles(key, deps);
    if (!files.includes(ref.path)) {
      dropped.push({ ...ref, reason: 'not-found' });
      continue;
    }
    kept.push({ repo: key, path: ref.path });
  }
  return { kept, dropped };
}
