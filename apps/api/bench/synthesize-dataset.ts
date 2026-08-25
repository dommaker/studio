/**
 * #323 阶段一 bench：数据集合成器。
 *
 * 以真实 ~/.studio 为 1x 模板（只读引用，绝不写入），把三个负载维度放大到
 * scale 档输出到 outHome（tmp dir）：
 *   - data/workunits/index.json：条目 ×scale（id/parentId 一致性重映射）
 *   - logs/studio-events.jsonl：行 ×scale
 *   - data/agents/：目录 ×scale（含大量空实例目录，与模板同构）；
 *     state.json 的 id 对齐新目录名、pid 置空（避免扫描器对宿主机 /proc 做存活判定）
 * 不随档位放大（真实系统中这些维度与 WU 量级无关）：channels、knowledge、users 原样复制。
 *
 * 注入 recentExecCount 条近 24h 完成的子执行（status=done, parentId 非空），
 * 让 AuditorService.dailyAudit 越过「零执行早退」走完整读路径（模板数据全部 >24h）。
 * 状态分布/时间戳保持模板原样（模板 = 安静稳态：无 active/blocked/unassigned，
 * 各扫描循环无补救写洪峰；首轮 agent-timeout 会 terminate 陈旧实例，属冷轮行为）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SynthesizeOptions {
  /** 模板根（只读）：含 data/ 与 logs/ */
  templateHome: string;
  /** 输出根：data/ 与 logs/ 落在其下 */
  outHome: string;
  /** 放大倍数（≥1 整数） */
  scale: number;
  /** 注入的近 24h 完成子执行条数（默认 10；auditor 全路径驱动用） */
  recentExecCount?: number;
}

export interface SynthesizeStats {
  templateWorkUnits: number;
  workUnits: number;
  eventLines: number;
  agentDirs: number;
  stateFiles: number;
  profileFiles: number;
  channels: number;
}

function copyDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dst, { recursive: true });
}

export function synthesizeDataset(opts: SynthesizeOptions): SynthesizeStats {
  const { templateHome, outHome, scale } = opts;
  const recentExecCount = opts.recentExecCount ?? 10;
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`scale must be a positive integer, got ${scale}`);

  const outData = path.join(outHome, 'data');
  const outLogs = path.join(outHome, 'logs');
  fs.mkdirSync(outData, { recursive: true });
  fs.mkdirSync(outLogs, { recursive: true });

  // ── WorkUnit index ×scale（id/parentId 一致性重映射）──
  const indexPath = path.join(templateHome, 'data', 'workunits', 'index.json');
  const templateWus: Array<Record<string, any>> = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    : [];
  const outWus: Array<Record<string, any>> = [];
  for (let k = 0; k < scale; k++) {
    const suffix = k === 0 ? '' : `-x${k}`;
    const idMap = new Map<string, string>();
    for (const wu of templateWus) idMap.set(wu.id, `${wu.id}${suffix}`);
    for (const wu of templateWus) {
      const clone = structuredClone(wu);
      clone.id = idMap.get(wu.id)!;
      if (wu.parentId != null && idMap.has(wu.parentId)) clone.parentId = idMap.get(wu.parentId)!;
      outWus.push(clone);
    }
  }
  // 注入近 24h 完成的子执行（auditor 全路径驱动；模板无 <24h 完成记录会早退）
  if (templateWus.length > 0) {
    const parent = outWus[0];
    const now = Date.now();
    for (let i = 0; i < recentExecCount; i++) {
      const completedAt = new Date(now - (i + 1) * 30 * 60_000).toISOString();
      const claimedAt = new Date(now - (i + 1) * 30 * 60_000 - 10 * 60_000).toISOString();
      outWus.push({
        ...structuredClone(templateWus[0]),
        id: `bench-exec-${i}`,
        parentId: parent.id,
        type: 'task',
        status: 'done',
        assigneeId: null,
        timeoutAt: null,
        metadata: JSON.stringify({ title: 'bench injected exec', agentType: 'dev' }),
        createdAt: claimedAt,
        updatedAt: completedAt,
        claimedAt,
        completedAt,
      });
    }
  }
  const outWusDir = path.join(outData, 'workunits');
  fs.mkdirSync(outWusDir, { recursive: true });
  fs.writeFileSync(path.join(outWusDir, 'index.json'), JSON.stringify(outWus, null, 2));

  // ── studio-events.jsonl 行 ×scale ──
  // #335：副本按 -k*12h 偏移时间戳（createdAt ISO / timestamp number|ISO），最旧副本在前——
  // 整段复制会让全局时间非单调，窗口读口（尾部倒读 + 首个窗口外行早停）的前提不成立，
  // 也不符合生产 append-only 单调形态。
  const eventsSrc = path.join(templateHome, 'logs', 'studio-events.jsonl');
  const eventLines = fs.existsSync(eventsSrc)
    ? fs.readFileSync(eventsSrc, 'utf-8').split('\n').filter(l => l.trim().length > 0)
    : [];
  const COPY_SHIFT_MS = 12 * 3600_000;
  const shiftLine = (l: string, shiftMs: number): string => {
    if (shiftMs === 0) return l;
    try {
      const e = JSON.parse(l);
      if (typeof e.createdAt === 'string') {
        const t = Date.parse(e.createdAt);
        if (Number.isFinite(t)) e.createdAt = new Date(t - shiftMs).toISOString();
      }
      if (typeof e.timestamp === 'number') e.timestamp -= shiftMs;
      else if (typeof e.timestamp === 'string') {
        const t = Date.parse(e.timestamp);
        if (Number.isFinite(t)) e.timestamp = new Date(t - shiftMs).toISOString();
      }
      return JSON.stringify(e);
    } catch { return l; } // 损坏行原样保留（与生产容错一致）
  };
  const outLines: string[] = [];
  for (let k = scale - 1; k >= 0; k--) {
    for (const l of eventLines) outLines.push(shiftLine(l, k * COPY_SHIFT_MS));
  }
  fs.writeFileSync(path.join(outLogs, 'studio-events.jsonl'),
    outLines.length > 0 ? outLines.join('\n') + '\n' : '');

  // ── agents 目录 ×scale ──
  const agentsSrc = path.join(templateHome, 'data', 'agents');
  const agentEntries = fs.existsSync(agentsSrc)
    ? fs.readdirSync(agentsSrc, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];
  const outAgentsDir = path.join(outData, 'agents');
  fs.mkdirSync(outAgentsDir, { recursive: true });
  let stateFiles = 0;
  let profileFiles = 0;
  for (let k = 0; k < scale; k++) {
    const suffix = k === 0 ? '' : `-x${k}`;
    for (const name of agentEntries) {
      const newName = `${name}${suffix}`;
      const srcDir = path.join(agentsSrc, name);
      const dstDir = path.join(outAgentsDir, newName);
      fs.mkdirSync(dstDir, { recursive: true });
      const stateSrc = path.join(srcDir, 'state.json');
      if (fs.existsSync(stateSrc)) {
        const state = JSON.parse(fs.readFileSync(stateSrc, 'utf-8'));
        state.id = newName;
        state.pid = null; // 避免扫描器对宿主机 /proc 做 pid 存活判定
        fs.writeFileSync(path.join(dstDir, 'state.json'), JSON.stringify(state, null, 2));
        stateFiles++;
      }
      const profileSrc = path.join(srcDir, 'profile.json');
      if (fs.existsSync(profileSrc)) {
        fs.copyFileSync(profileSrc, path.join(dstDir, 'profile.json'));
        profileFiles++;
      }
    }
  }

  // ── 不放大维度：channels / knowledge / users 原样复制 ──
  copyDir(path.join(templateHome, 'data', 'channels'), path.join(outData, 'channels'));
  copyDir(path.join(templateHome, 'knowledge'), path.join(outHome, 'knowledge'));
  copyDir(path.join(templateHome, 'data', 'users'), path.join(outData, 'users'));
  const channelsDir = path.join(outData, 'channels');
  const channels = fs.existsSync(channelsDir)
    ? fs.readdirSync(channelsDir, { withFileTypes: true }).filter(e => e.isDirectory()).length
    : 0;

  return {
    templateWorkUnits: templateWus.length,
    workUnits: outWus.length,
    eventLines: outLines.length,
    agentDirs: agentEntries.length * scale,
    stateFiles,
    profileFiles,
    channels,
  };
}
