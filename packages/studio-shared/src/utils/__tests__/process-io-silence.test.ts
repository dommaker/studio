/**
 * Behavioral test: execSh 三层超时机制（#171 / #54 决议，数值来自 #68 实测）——
 *   1. 静默看门狗：距最后一次输出间隔超 warnMs → onWarn（每段静默恰报一次）；
 *      超 killMs → 杀进程组并 reject（错误标明 silence）
 *   2. killProcessGroup：墙钟/静默杀 = kill(-pid) 杀整组，孙进程不留孤儿
 *      （#68 实测 SIGTERM 只杀直接子进程，孤儿继续烧 token 26s~36min）
 *   3. 有持续输出的健康长命令不被静默看门狗误杀（健康步内静默 p99=215s，输出即续命）
 */
import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSh } from '../process-io';

const baseOpts = { cwd: '/tmp', timeoutMs: 30_000 };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('execSh 静默看门狗（#171）', () => {
  test('静默超 killMs → reject（错误标明 silence），warn 每段静默恰触发一次', async () => {
    const warns: number[] = [];
    const started = Date.now();
    await expect(
      execSh('sleep 30', {
        ...baseOpts,
        killProcessGroup: true,
        silence: { warnMs: 400, killMs: 900, onWarn: (ms) => warns.push(ms) },
      }),
    ).rejects.toThrow(/silence/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(5_000);
    expect(warns.length).toBe(1);
    expect(warns[0]).toBeGreaterThanOrEqual(400);
  });

  test('warn 后恢复输出 → 看门狗复位，下一段静默可再次 warn', async () => {
    const warns: number[] = [];
    // 静默 ~0.6s（触发 warn）→ 输出 → 再静默 ~0.6s（再次 warn）→ 收尾，全程 < killMs 连续静默
    await execSh('sleep 0.6; echo alive; sleep 0.6; echo done', {
      ...baseOpts,
      silence: { warnMs: 400, killMs: 2_000, onWarn: (ms) => warns.push(ms) },
    });
    expect(warns.length).toBe(2);
  });

  test('持续输出的长命令不被误杀（健康长步 > 墙钟旧值语义）', async () => {
    const warns: number[] = [];
    // 总时长 ~1.8s > killMs，但每 0.3s 有输出 —— 永不触发静默杀
    const { stdout } = await execSh('for i in 1 2 3 4 5 6; do echo tick; sleep 0.3; done', {
      ...baseOpts,
      killProcessGroup: true,
      silence: { warnMs: 400, killMs: 900, onWarn: (ms) => warns.push(ms) },
    });
    expect(stdout.match(/tick/g)?.length).toBe(6);
    expect(warns.length).toBe(0);
  });

  test('静默杀 = 杀进程组：孙进程（后台 sleep）一并死亡，不留孤儿', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-sh-silence-')), 'child.pid');
    // bash 起后台孙进程 sleep 并 wait —— 全组无输出 → 触发静默杀
    await expect(
      execSh(`sleep 60 & echo $! > "${pidFile}"; wait`, {
        ...baseOpts,
        killProcessGroup: true,
        silence: { killMs: 700 },
      }),
    ).rejects.toThrow(/silence/);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    expect(grandchildPid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100)); // 死讯落地余量
    expect(isAlive(grandchildPid)).toBe(false);
  });

  test('墙钟 timeout 同样杀进程组（1800s 兜底路径同一杀法）', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-sh-timeout-')), 'child.pid');
    await expect(
      execSh(`sleep 60 & echo $! > "${pidFile}"; wait`, {
        cwd: '/tmp',
        timeoutMs: 600,
        killProcessGroup: true,
      }),
    ).rejects.toThrow(/timed out/);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(grandchildPid)).toBe(false);
  });

  test('不开 silence 选项行为不变（纯墙钟语义，零回归）', async () => {
    const { stdout } = await execSh('echo ok', { cwd: '/tmp', timeoutMs: 5_000 });
    expect(stdout.trim()).toBe('ok');
  });
});
