/**
 * proc-probes — /proc 系统探测单出口（零子进程，ops/monitor 共用）
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDiskUsage, readMemoryUsage, readLoadAvgRaw, countZombieProcesses, readProcessCmdline, countProcessesByCmdline, listPidsByCmdline, listZombieProcesses } from '../proc-probes.js';

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
    // 注入固定 statfs 快照：真实 fs 的 bavail 在并发写负载下逐块（4096B）漂移，
    // 对活盘做两次独立 statfsSync 比较会偶发不等——本用例校验字段映射与取整
    // 公式（used=total-bavail），而非实时盘空闲恒定。
    // bsize=4096, blocks=1000, bavail=313 → total=4_096_000, avail=1_282_048,
    // used=2_813_952, used/total=68.7% → round=69（覆盖取整边界）
    const snapshot = {
      type: 0xef51, bsize: 4096, blocks: 1000, bfree: 400, bavail: 313, files: 0, ffree: 0,
    } as unknown as fs.StatsFs;
    const usage = readDiskUsage('/', () => snapshot);
    expect(usage).not.toBeNull();
    expect(usage!.totalBytes).toBe(4_096_000);
    expect(usage!.availBytes).toBe(1_282_048);
    expect(usage!.usedBytes).toBe(2_813_952);
    expect(usage!.usePercent).toBe(69);
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

describe('readProcessCmdline', () => {
  it('NUL 分段以空格连接（ps aux 渲染口径），空/缺失 → null', () => {
    const procDir = makeTmp('proc-probes-cmdline-');
    const write = (pid: string, content: string | null) => {
      fs.mkdirSync(path.join(procDir, pid), { recursive: true });
      if (content !== null) fs.writeFileSync(path.join(procDir, pid, 'cmdline'), content);
    };
    write('10', 'cloudflared\0tunnel\0--url\0http://localhost:13001\0');
    write('11', '');        // 僵尸：空 cmdline
    write('12', null);      // 内核线程：无 cmdline
    expect(readProcessCmdline(procDir, '10')).toBe('cloudflared tunnel --url http://localhost:13001');
    expect(readProcessCmdline(procDir, '11')).toBeNull();
    expect(readProcessCmdline(procDir, '12')).toBeNull();
  });
});

describe('countProcessesByCmdline', () => {
  it('子串命中整条渲染命令行即计数，忽略非数字目录/无 cmdline 项', () => {
    const procDir = makeTmp('proc-probes-count-');
    const write = (pid: string, cmdline: string) => {
      fs.mkdirSync(path.join(procDir, pid), { recursive: true });
      fs.writeFileSync(path.join(procDir, pid, 'cmdline'), cmdline);
    };
    write('20', 'cloudflared\0tunnel\0--url\0x');
    write('21', 'tail\0-f\0/tmp/cloudflared.log');
    write('22', 'claude\0--print\0hi');
    write('23', 'node\0/root/x/claude-harness/main.js');
    write('24', 'sleep\0100');
    fs.mkdirSync(path.join(procDir, '25'));   // cmdline 缺失 → 忽略
    fs.mkdirSync(path.join(procDir, 'acpi')); // 非数字 → 忽略
    expect(countProcessesByCmdline('cloudflared', procDir)).toBe(2);
    expect(countProcessesByCmdline('claude', procDir)).toBe(2);
    expect(countProcessesByCmdline('not-running-xyz', procDir)).toBe(0);
  });

  it('procDir 不存在 → 0；默认参数直读真实 /proc', () => {
    expect(countProcessesByCmdline('x', path.join(makeTmp('proc-probes-count2-'), 'absent'))).toBe(0);
    expect(countProcessesByCmdline('definitely-not-a-process-418')).toBeGreaterThanOrEqual(0);
  });
});

describe('listPidsByCmdline', () => {
  it('多 pattern 正则（含 .* 元字符）任一命中即列 pid，与原 grep BRE 口径一致', () => {
    const procDir = makeTmp('proc-probes-pids-');
    const write = (pid: string, cmdline: string) => {
      fs.mkdirSync(path.join(procDir, pid), { recursive: true });
      fs.writeFileSync(path.join(procDir, pid, 'cmdline'), cmdline);
    };
    write('30', 'node\0dist/index.js\0--port\013001');
    write('31', 'tsx\0apps/api/src/main.ts');
    write('32', 'cloudflared\0tunnel');
    write('33', 'vim\0notes.txt');
    expect(listPidsByCmdline(['tsx', 'node.*index', 'cloudflared'], procDir)).toEqual(['30', '31', '32']);
  });

  it('非法 pattern 跳过不炸；无命中 → []', () => {
    const procDir = makeTmp('proc-probes-pids2-');
    fs.mkdirSync(path.join(procDir, '40'), { recursive: true });
    fs.writeFileSync(path.join(procDir, '40', 'cmdline'), 'sleep\0100');
    expect(listPidsByCmdline(['[', 'sleep'], procDir)).toEqual(['40']);
    expect(listPidsByCmdline(['zzz-xyz'], procDir)).toEqual([]);
    expect(listPidsByCmdline(['['], path.join(makeTmp('proc-probes-pids3-'), 'absent'))).toEqual([]);
  });
});

describe('listZombieProcesses', () => {
  it('state=Z 列 pid+comm（comm 含 ")" 取段正确），非 Z 不列', () => {
    const procDir = makeTmp('proc-probes-zl-');
    const write = (pid: string, stat: string) => {
      fs.mkdirSync(path.join(procDir, pid), { recursive: true });
      fs.writeFileSync(path.join(procDir, pid, 'stat'), stat);
    };
    write('50', '50 (node) Z 1 1 0 0 -1 0');
    write('51', '51 (bash) S 1 1 0 0 -1 0');
    write('52', '52 (chrome:Renderer) Z 1 1 0 0 -1 0');
    write('53', '53 (weird ) proc) Z 1 1 0 0 -1 0');
    expect(listZombieProcesses(procDir)).toEqual([
      { pid: '50', comm: 'node' },
      { pid: '52', comm: 'chrome:Renderer' },
      { pid: '53', comm: 'weird ) proc' },
    ]);
  });

  it('procDir 不存在 → []', () => {
    expect(listZombieProcesses(path.join(makeTmp('proc-probes-zl2-'), 'absent'))).toEqual([]);
  });
});
