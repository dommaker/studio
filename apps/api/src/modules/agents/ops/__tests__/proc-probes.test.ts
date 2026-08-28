/**
 * proc-probes — /proc 系统探测单出口（零子进程，ops/monitor 共用）
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDiskUsage, readMemoryUsage, readLoadAvgRaw, countZombieProcesses } from '../proc-probes.js';

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('readMemoryUsage', () => {
  it('parses MemTotal/MemAvailable from meminfo（kb 口径）', () => {
    const meminfo = path.join(makeTmp('proc-probes-mem-'), 'meminfo');
    fs.writeFileSync(meminfo, [
      'MemTotal:       16000000 kB',
      'MemFree:         2000000 kB',
      'Buffers:          300000 kB',
      'Cached:          5000000 kB',
      'MemAvailable:    8000000 kB',
      'SwapTotal:              0 kB',
    ].join('\n'));
    expect(readMemoryUsage(meminfo)).toEqual({
      totalKb: 16000000,
      freeKb: 8000000, // MemAvailable 口径，非 MemFree
      usedKb: 8000000,
    });
  });

  it('缺 MemAvailable → usedKb/freeKb null，totalKb 保留', () => {
    const meminfo = path.join(makeTmp('proc-probes-mem2-'), 'meminfo');
    fs.writeFileSync(meminfo, 'MemTotal:       16000000 kB\n');
    expect(readMemoryUsage(meminfo)).toEqual({ totalKb: 16000000, freeKb: null, usedKb: null });
  });

  it('文件缺失 → 全 null（探测静默降级）', () => {
    const missing = path.join(makeTmp('proc-probes-mem3-'), 'absent');
    expect(readMemoryUsage(missing)).toEqual({ totalKb: null, freeKb: null, usedKb: null });
  });
});

describe('readDiskUsage', () => {
  it('statfs 字段口径：used=total-bavail，usePercent 取整', () => {
    const dir = makeTmp('proc-probes-disk-');
    const usage = readDiskUsage(dir);
    expect(usage).not.toBeNull();
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    expect(usage!.totalBytes).toBe(total);
    expect(usage!.availBytes).toBe(avail);
    expect(usage!.usedBytes).toBe(total - avail);
    expect(usage!.usePercent).toBe(Math.round(((total - avail) / total) * 100));
  });

  it('路径不存在 → null', () => {
    const missing = path.join(makeTmp('proc-probes-disk2-'), 'absent');
    expect(readDiskUsage(missing)).toBeNull();
  });
});

describe('countZombieProcesses', () => {
  it('只数 state=Z 的 pid，忽略非数字目录/无 stat 项', () => {
    const procDir = makeTmp('proc-probes-z-');
    const write = (pid: string, stat: string) => {
      fs.mkdirSync(path.join(procDir, pid), { recursive: true });
      fs.writeFileSync(path.join(procDir, pid, 'stat'), stat);
    };
    write('1', '1 (bash) S 1 1 0 0 -1 4194560 0');
    write('2', '2 (cat) Z 1 1 0 0 -1 4194560 0');
    write('3', '3 (chrome:Renderer) Z 1 1 0 0 -1 0');
    // comm 内含 ")"：状态字段在最后一个 ")" 之后（lastIndexOf 解析）
    write('4', '4 (weird ) proc) S 1 1 0 0 -1 0');
    write('5', '5 (init) Z 1 1 0 0 -1 0');
    fs.mkdirSync(path.join(procDir, '6')); // stat 缺失 → 忽略
    fs.mkdirSync(path.join(procDir, 'acpi')); // 非数字 → 忽略
    expect(countZombieProcesses(procDir)).toBe(3);
  });

  it('procDir 不存在 → 0', () => {
    const missing = path.join(makeTmp('proc-probes-z2-'), 'absent');
    expect(countZombieProcesses(missing)).toBe(0);
  });

  it('默认参数直读真实 /proc（linux 冒烟）', () => {
    expect(readMemoryUsage().totalKb).toBeGreaterThan(0);
    expect(readDiskUsage('/')).not.toBeNull();
    expect(countZombieProcesses()).toBeGreaterThanOrEqual(0);
    expect(readLoadAvgRaw()).toMatch(/^\d/);
  });
});
