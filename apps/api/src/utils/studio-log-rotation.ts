/**
 * #213：泛化 jsonl 保留轮转 + 遗留日志一次性归档清理。
 *
 * 机制 = #173（studio-events-rotation.ts）同构实现泛化为配置驱动：
 * 每个文件声明保留策略（热窗天数 + 超期动作），轮转核心 rotateJsonlLog 复用
 * #173 的并发安全形态（rename 热文件→暂存防丢行、幸存者 append 回写、
 * 月度 gz tmp+rename 原子写、损坏行/无时间行保守保留）。
 *
 * 决议值（2026-08-19 grilling 定案，issue #213 评论）：
 * - incidents.jsonl（信号）：热 30 天 → 月度 gzip 归档只增不删
 * - audit.jsonl（审计）：热 90 天 → 月度 gzip 归档只增不删
 * - notifications.jsonl（噪声）：7 天滚动删除，不留归档
 * - tasks-YYYY-MM-DD.jsonl 一族（data/tasks 已废弃，#181 已删读取方）
 *   + 残留 ~/.studio/events/incidents.jsonl（2026-05 后无写入）：一次性
 *   gzip 归档（archive/*-legacy.jsonl.gz）后删除原文件。
 *
 * 调度：apps/api/src/index.ts 与 #173 同一挂载点，启动后跑一次 + 每 24h 一轮。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { getStudioEventTime } from './studio-events.js';
import { isTestEnv, resolveStudioLogsDir } from './studio-log-path.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 超期动作：archive = 切月度 gzip 冷包只增不删；drop = 滚动删除不留归档 */
export type RetentionAction = 'archive' | 'drop';

export interface RetentionPolicy {
  /** 热保留天数，超期按 action 处置 */
  hotDays: number;
  action: RetentionAction;
}

export interface RotateJsonlLogOptions {
  /** 热文件路径 */
  file: string;
  /** 冷包目录（默认 <热文件目录>/archive） */
  archiveDir?: string;
  /** 判定基准时间（默认 now；测试注入固定时间） */
  now?: Date;
  /** 类别 → 策略。classify 缺省时全部行归 'default' 类 */
  policies: Record<string, RetentionPolicy>;
  /** 行分类（缺省：全部 'default'）。返回的类别须在 policies 中有对应策略 */
  classify?: (record: Record<string, unknown>) => string;
  /** 日志 tag（缺省 '(#213)'；#173 委托方传 '(#173)' 保留既有 grep 线索） */
  tag?: string;
}

export interface JsonlRotationResult {
  /** 是否有热文件参与本轮轮转 */
  rotated: boolean;
  /** 回写热文件的幸存行数 */
  keptHot: number;
  /** 滚动删除的行数（action=drop 超期） */
  dropped: number;
  /** 归档进月度 gz 的行数（action=archive 超期） */
  archived: number;
  /** 本轮触碰的 gz 冷包文件 */
  archiveFiles: string[];
}

/** 追加写 gzip 冷包：已有 gz 解压追加再压回，tmp+rename 原子写（只增不删） */
async function appendGz(gzFile: string, lines: string[]): Promise<void> {
  let existing = '';
  if (fs.existsSync(gzFile)) {
    existing = zlib.gunzipSync(await fs.promises.readFile(gzFile)).toString('utf-8');
    if (existing && !existing.endsWith('\n')) existing += '\n';
  }
  const content = existing + lines.join('\n') + '\n';
  const tmp = `${gzFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.promises.writeFile(tmp, zlib.gzipSync(content));
    await fs.promises.rename(tmp, gzFile);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * 跑一轮单文件保留轮转（#173 同构）。热文件不存在 → no-op。
 * 单轮失败由调用方 catch + logger.warn（index.ts 挂载点已包）。
 */
export async function rotateJsonlLog(opts: RotateJsonlLogOptions): Promise<JsonlRotationResult> {
  const { file, policies } = opts;
  const archiveDir = opts.archiveDir ?? path.join(path.dirname(file), 'archive');
  const now = opts.now ?? new Date();
  const classify = opts.classify ?? (() => 'default');
  const result: JsonlRotationResult = {
    rotated: false,
    keptHot: 0,
    dropped: 0,
    archived: 0,
    archiveFiles: [],
  };
  if (!fs.existsSync(file)) return result;

  // 1. rename 热文件 → 暂存：rename 原子，此后新写入在新热文件重建，轮转窗口不丢行
  const rotating = `${file}.rotating-${process.pid}-${randomUUID()}`;
  await fs.promises.rename(file, rotating);
  result.rotated = true;

  try {
    const lines = (await fs.promises.readFile(rotating, 'utf-8'))
      .split('\n')
      .filter(l => l.trim().length > 0);

    const cutoffs = new Map<string, number>(
      Object.entries(policies).map(([cls, p]) => [cls, now.getTime() - p.hotDays * DAY_MS]),
    );
    const kept: string[] = [];
    const archivedByMonth = new Map<string, string[]>();

    for (const line of lines) {
      let record: Record<string, unknown> | null = null;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        record = null;
      }
      // 损坏行 / 无时间：无法分类计龄 → 保守保留（宁可留，不静默丢数据）
      const t = record ? getStudioEventTime(record) : NaN;
      if (!record || !Number.isFinite(t)) {
        kept.push(line);
        continue;
      }
      const cls = classify(record);
      const key = policies[cls] ? cls : 'default';
      const policy = policies[key];
      if (!policy) {
        // 类别无策略且未配 default → 保守保留
        kept.push(line);
        continue;
      }
      if (t >= cutoffs.get(key)!) {
        kept.push(line);
      } else if (policy.action === 'drop') {
        result.dropped++;
      } else {
        const month = new Date(t).toISOString().slice(0, 7); // UTC YYYY-MM
        const bucket = archivedByMonth.get(month);
        if (bucket) bucket.push(line);
        else archivedByMonth.set(month, [line]);
        result.archived++;
      }
    }

    // 2. 幸存者 append 回热文件（保留原始行文本不重序列化；与并发追加安全交错）
    if (kept.length > 0) {
      await fs.promises.appendFile(file, kept.join('\n') + '\n', 'utf-8');
    }
    result.keptHot = kept.length;

    // 3. 超期行 → 月度 gzip 冷包（永久保留）：文件名取热文件 basename（去 .jsonl）
    if (archivedByMonth.size > 0) {
      await fs.promises.mkdir(archiveDir, { recursive: true });
      const prefix = path.basename(file).replace(/\.jsonl$/, '');
      for (const month of [...archivedByMonth.keys()].sort()) {
        const gzFile = path.join(archiveDir, `${prefix}-${month}.jsonl.gz`);
        await appendGz(gzFile, archivedByMonth.get(month)!);
        result.archiveFiles.push(gzFile);
      }
    }
  } finally {
    await fs.promises.unlink(rotating).catch(() => {});
  }

  logger.info(`[StudioLogRotation] Rotation done ${opts.tag ?? '(#213)'}`, { file, ...result });
  return result;
}

/**
 * #213 决议配置：logs 目录下活日志文件的保留策略。
 * 分类即文件级（每文件一个策略），行分类恒 'default'。
 */
export interface StudioLogFilePolicy {
  fileName: string;
  policy: RetentionPolicy;
}

export const STUDIO_LOG_FILE_POLICIES: StudioLogFilePolicy[] = [
  // 事故信号：比照 studio-events 信号档（热 30 天 → 月度 gzip 只增不删）
  { fileName: 'incidents.jsonl', policy: { hotDays: 30, action: 'archive' } },
  // 审计合规向：热窗放宽到 90 天，归档只增不删
  { fileName: 'audit.jsonl', policy: { hotDays: 90, action: 'archive' } },
  // 噪声级：7 天滚动删除，不留归档
  { fileName: 'notifications.jsonl', policy: { hotDays: 7, action: 'drop' } },
];

export interface RotateStudioLogFilesOptions {
  /** 日志目录（默认 resolveStudioLogsDir()；测试注入隔离目录） */
  logsDir?: string;
  now?: Date;
}

/** 跑一轮 #213 三文件轮转。单文件失败不阻断其余文件。 */
export async function rotateStudioLogFiles(opts?: RotateStudioLogFilesOptions): Promise<JsonlRotationResult[]> {
  const logsDir = opts?.logsDir ?? resolveStudioLogsDir();
  const results: JsonlRotationResult[] = [];
  for (const { fileName, policy } of STUDIO_LOG_FILE_POLICIES) {
    try {
      results.push(await rotateJsonlLog({
        file: path.join(logsDir, fileName),
        now: opts?.now,
        policies: { default: policy },
      }));
    } catch (err) {
      logger.warn('[StudioLogRotation] File rotation failed (#213)', { fileName, error: String(err) });
    }
  }
  return results;
}

export interface LegacyArchiveResult {
  /** 已删除的遗留原文件 */
  deleted: string[];
  /** 本轮触碰的 gz 归档文件 */
  archiveFiles: string[];
}

export interface ArchiveLegacyStudioLogsOptions {
  /** 日志目录（默认 resolveStudioLogsDir()；测试注入隔离目录） */
  logsDir?: string;
  /** 冷包目录（默认 <logsDir>/archive） */
  archiveDir?: string;
  /**
   * 残留死文件全路径清单（默认 [~/.studio/events/incidents.jsonl]，测试期指向
   * 隔离目录；传入显式清单则按传入处理）。已不存在的路径自动跳过。
   */
  residualFiles?: string[];
}

/** 默认残留 incidents 路径（#213 事实核查：2026-05 后无写入的死文件） */
function defaultResidualFiles(): string[] {
  return isTestEnv()
    ? [path.join(resolveStudioLogsDir(), 'events', 'incidents.jsonl')]
    : [studioPath('events', 'incidents.jsonl')];
}

/**
 * 遗留日志一次性归档清理（#213 决议：归档留底后删除，不直接清）。
 * - logsDir 下 tasks-*.jsonl 一族 → archive/tasks-legacy.jsonl.gz
 * - 残留死文件 → archive/incidents-legacy.jsonl.gz
 * 归档包只增不删（可跨轮追加）；无可清理文件 → no-op（不建空归档目录）。
 */
export async function archiveLegacyStudioLogs(opts?: ArchiveLegacyStudioLogsOptions): Promise<LegacyArchiveResult> {
  const logsDir = opts?.logsDir ?? resolveStudioLogsDir();
  const archiveDir = opts?.archiveDir ?? path.join(logsDir, 'archive');
  const residualFiles = (opts?.residualFiles ?? defaultResidualFiles()).filter(f => fs.existsSync(f));
  const result: LegacyArchiveResult = { deleted: [], archiveFiles: [] };

  const taskFiles = fs.existsSync(logsDir)
    ? (await fs.promises.readdir(logsDir))
        .filter(f => /^tasks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .map(f => path.join(logsDir, f))
    : [];

  const groups: Array<{ gzName: string; files: string[] }> = [
    { gzName: 'tasks-legacy.jsonl.gz', files: taskFiles },
    { gzName: 'incidents-legacy.jsonl.gz', files: residualFiles },
  ];

  for (const { gzName, files } of groups) {
    if (files.length === 0) continue;
    const lines: string[] = [];
    for (const file of files) {
      lines.push(
        ...(await fs.promises.readFile(file, 'utf-8')).split('\n').filter(l => l.trim().length > 0),
      );
    }
    if (lines.length === 0) continue;
    await fs.promises.mkdir(archiveDir, { recursive: true });
    const gzFile = path.join(archiveDir, gzName);
    await appendGz(gzFile, lines);
    result.archiveFiles.push(gzFile);
    for (const file of files) {
      await fs.promises.unlink(file);
      result.deleted.push(file);
    }
  }

  if (result.deleted.length > 0) {
    logger.info('[StudioLogRotation] Legacy logs archived & deleted (#213)', { ...result });
  }
  return result;
}
