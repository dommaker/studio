/**
 * /proc 系统探测单出口 — 零子进程（无 execSync，不阻塞事件循环）
 *
 * ops.service、monitor-system-probes、triage.service、env-snapper 共用；新增系统探测先落这里。
 * 原始字段（bytes/kb、pid+comm）直出，格式化（G/M/百分比字符串/僵尸列举拼接）由调用方负责；
 * 例外是 readProcessCmdline 的 NUL→空格连接——按 ps aux 渲染口径还原命令行，保证各调用方
 * 的子串/正则匹配与原 grep ps aux 行为同口径。
 */

import * as fs from 'fs';

export interface DiskUsage {
  totalBytes: number;
  availBytes: number;
  usedBytes: number;
  /** total=0 时为 null */
  usePercent: number | null;
}

export function readDiskUsage(
  root: string = '/',
  statfsSync: (path: string) => fs.StatsFs = (p) => fs.statfsSync(p),
): DiskUsage | null {
  try {
    const s = statfsSync(root);
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - avail;
    return {
      totalBytes: total,
      availBytes: avail,
      usedBytes: used,
      usePercent: total > 0 ? Math.round((used / total) * 100) : null,
    };
  } catch {
    return null;
  }
}

export interface MemoryUsage {
  totalKb: number | null;
  /** MemAvailable 口径（非 MemFree） */
  freeKb: number | null;
  /** MemTotal - MemAvailable */
  usedKb: number | null;
}

export function readMemoryUsage(meminfoPath: string = '/proc/meminfo'): MemoryUsage {
  try {
    const meminfo = fs.readFileSync(meminfoPath, 'utf-8');
    const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)/m);
    const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)/m);
    const totalKb = totalMatch ? parseInt(totalMatch[1], 10) : null;
    const availKb = availMatch ? parseInt(availMatch[1], 10) : null;
    return {
      totalKb,
      freeKb: availKb,
      usedKb: totalKb !== null && availKb !== null ? totalKb - availKb : null,
    };
  } catch {
    return { totalKb: null, freeKb: null, usedKb: null };
  }
}

/** /proc/loadavg 原始串（"0.52 0.58 0.59 1/x ..."），读不到时 '?' */
export function readLoadAvgRaw(loadavgPath: string = '/proc/loadavg'): string {
  try {
    return fs.readFileSync(loadavgPath, 'utf-8').trim();
  } catch {
    return '?';
  }
}

/** 遍历 procDir 下的数字 pid 目录名；procDir 读不到时静默为空 */
function* numericPidDirs(procDir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    yield entry.name;
  }
}

/** 数 state=Z 的僵尸进程（原 ps aux | awk '$8 ~ /Z/' 的 /proc 等价） */
export function countZombieProcesses(procDir: string = '/proc'): number {
  return listZombieProcesses(procDir).length;
}

/**
 * 读 /proc/<pid>/cmdline 并按 ps aux 渲染口径还原（NUL 分段以空格连接）。
 * 空文件（僵尸）或读不到（内核线程/瞬时退出）→ null。
 */
export function readProcessCmdline(procDir: string, pid: string): string | null {
  try {
    const rendered = fs.readFileSync(`${procDir}/${pid}/cmdline`, 'utf-8')
      .split('\0').filter(Boolean).join(' ').trim();
    return rendered || null;
  } catch {
    return null;
  }
}

/** 数命令行含子串的进程（原 `ps aux | grep -c '[x]foo'` 的 /proc 等价，子串按 ps aux 渲染口径匹配） */
export function countProcessesByCmdline(substring: string, procDir: string = '/proc'): number {
  let count = 0;
  for (const pid of numericPidDirs(procDir)) {
    const cmdline = readProcessCmdline(procDir, pid);
    if (cmdline?.includes(substring)) count++;
  }
  return count;
}

/**
 * 列命令行命中任一 pattern 的 pid（原 `ps aux | grep 'p1\|p2' | awk '{print $2}'` 的 /proc 等价）。
 * pattern 为正则（rules 里 processes_to_clean 含 `node.*index` 类模式），按 ps aux 渲染后的
 * 整条命令行匹配；非法 pattern 跳过（原 grep 会整体失败返回 0，此处降级为忽略该项）。
 */
export function listPidsByCmdline(patterns: string[], procDir: string = '/proc'): string[] {
  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try { regexes.push(new RegExp(p)); } catch { /* 非法 pattern → 跳过 */ }
  }
  if (regexes.length === 0) return [];
  const pids: string[] = [];
  for (const pid of numericPidDirs(procDir)) {
    const cmdline = readProcessCmdline(procDir, pid);
    if (cmdline && regexes.some(re => re.test(cmdline))) pids.push(pid);
  }
  return pids;
}

/** 列僵尸进程（state=Z）的原始 pid+comm（原 `ps aux | grep -w Z` 的 /proc 等价，截断/格式化由调用方负责） */
export function listZombieProcesses(procDir: string = '/proc'): Array<{ pid: string; comm: string }> {
  const zombies: Array<{ pid: string; comm: string }> = [];
  for (const pid of numericPidDirs(procDir)) {
    try {
      const stat = fs.readFileSync(`${procDir}/${pid}/stat`, 'utf-8');
      const closeIdx = stat.lastIndexOf(')');
      if (closeIdx === -1) continue;
      if (stat.slice(closeIdx + 1).trim()[0] !== 'Z') continue;
      const openIdx = stat.indexOf('(');
      zombies.push({ pid, comm: openIdx !== -1 ? stat.slice(openIdx + 1, closeIdx) : '' });
    } catch { /* 进程瞬时退出 → 跳过 */ }
  }
  return zombies;
}
