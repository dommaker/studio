/**
 * /proc 系统探测单出口 — 零子进程（无 execSync，不阻塞事件循环）
 *
 * ops.service 与 monitor-system-probes 共用；新增系统探测先落这里。
 * 原始字段（bytes/kb）直出，格式化（G/M/百分比字符串）由调用方负责。
 */

import * as fs from 'fs';

export interface DiskUsage {
  totalBytes: number;
  availBytes: number;
  usedBytes: number;
  /** total=0 时为 null */
  usePercent: number | null;
}

export function readDiskUsage(root: string = '/'): DiskUsage | null {
  try {
    const s = fs.statfsSync(root);
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

/** 数 state=Z 的僵尸进程（原 ps aux | awk '$8 ~ /Z/' 的 /proc 等价） */
export function countZombieProcesses(procDir: string = '/proc'): number {
  let zombies = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = fs.readFileSync(`${procDir}/${entry.name}/stat`, 'utf-8');
      // comm 可含空格与 ")"，状态字段在最后一个 ")" 之后
      const closeIdx = stat.lastIndexOf(')');
      if (closeIdx === -1) continue;
      if (stat.slice(closeIdx + 1).trim()[0] === 'Z') zombies++;
    } catch { /* 进程瞬时退出 → 跳过 */ }
  }
  return zombies;
}
