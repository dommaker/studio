/**
 * #179（#66 决议 2）优雅关闭：stopAllProcessGroups —— SIGTERM 杀全部在飞 CLI 进程组、
 * 清空 runningProcesses 注册表；current=null / 已死 pid 容错不抛（best-effort）。
 * 用真实 detached sleep 进程组验证杀组语义（child.pid 即组长，同 execSh killProcessGroup 形态）。
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { AgentRunner } from '../agent-runner.js';

interface RunnerInternals {
  runningProcesses: Map<string, { current: ChildProcess | null }>;
}

function spawnDetachedSleep(seconds = 60): ChildProcess {
  const child = spawn('sleep', [String(seconds)], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('#179: AgentRunner.stopAllProcessGroups（优雅关闭杀全部在飞进程组）', () => {
  it('SIGTERM 杀全部注册进程组并清空注册表，返回杀组数', async () => {
    const runner = new AgentRunner();
    const internals = runner as unknown as RunnerInternals;
    const c1 = spawnDetachedSleep();
    const c2 = spawnDetachedSleep();
    internals.runningProcesses.set('exec-1', { current: c1 });
    internals.runningProcesses.set('exec-2', { current: c2 });
    expect(groupAlive(c1.pid!)).toBe(true);

    const killed = await runner.stopAllProcessGroups();

    expect(killed).toBe(2);
    expect(internals.runningProcesses.size).toBe(0);
    await sleep(150); // 等 SIGTERM 生效
    expect(groupAlive(c1.pid!)).toBe(false);
    expect(groupAlive(c2.pid!)).toBe(false);
  });

  it('current=null 与已死 pid 容错：清理注册表、不抛错、不计数', async () => {
    const runner = new AgentRunner();
    const internals = runner as unknown as RunnerInternals;
    internals.runningProcesses.set('exec-null', { current: null });
    const dead = spawnDetachedSleep(0); // 立即退出
    await sleep(150);
    internals.runningProcesses.set('exec-dead', { current: dead });

    await expect(runner.stopAllProcessGroups()).resolves.toBe(0);
    expect(internals.runningProcesses.size).toBe(0);
  });
});
