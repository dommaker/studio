/**
 * bootstrap/tunnel 测试（P2-a）：#571 冻结语义——默认关，仅 CLOUDFLARED_ENABLED=true 拉起；
 * spawn 参数、stdout URL 解析通知、stopTunnel 杀进程。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const state = vi.hoisted(() => ({
  procs: [] as any[],
  sendText: vi.fn(async () => {}),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    state.procs.push(proc);
    return proc;
  }),
}));
vi.mock('../../utils/discord-notifier.js', () => ({
  discordNotifier: { sendText: state.sendText },
}));

import { spawn } from 'child_process';
import { startTunnelIfEnabled, stopTunnel } from '../tunnel.js';

const spawnMock = vi.mocked(spawn);
const savedFlag = process.env.CLOUDFLARED_ENABLED;

beforeEach(() => {
  state.procs.length = 0;
  state.sendText.mockClear();
  spawnMock.mockClear();
  delete process.env.CLOUDFLARED_ENABLED;
});

afterEach(() => {
  stopTunnel();
  if (savedFlag === undefined) delete process.env.CLOUDFLARED_ENABLED;
  else process.env.CLOUDFLARED_ENABLED = savedFlag;
});

describe('startTunnelIfEnabled', () => {
  it('默认关（#571）：未设置 CLOUDFLARED_ENABLED 不拉起隧道', () => {
    startTunnelIfEnabled(3001);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('CLOUDFLARED_ENABLED=true → spawn cloudflared 守护进程', () => {
    process.env.CLOUDFLARED_ENABLED = 'true';
    startTunnelIfEnabled(3001);
    expect(spawnMock).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://localhost:3001', '--no-autoupdate'],
      { stdio: 'pipe' },
    );
  });

  it('stdout 出现 trycloudflare URL → 通知 Discord', async () => {
    process.env.CLOUDFLARED_ENABLED = 'true';
    startTunnelIfEnabled(3001);
    const proc = state.procs[0];
    proc.stdout.emit('data', Buffer.from('INF | https://abc-123.trycloudflare.com\n'));
    await vi.waitFor(() => expect(state.sendText).toHaveBeenCalled());
    expect(state.sendText.mock.calls[0][1]).toContain('https://abc-123.trycloudflare.com');
  });

  it('stopTunnel 杀掉在飞 cloudflared 进程', () => {
    process.env.CLOUDFLARED_ENABLED = 'true';
    startTunnelIfEnabled(3001);
    const proc = state.procs[0];
    stopTunnel();
    expect(proc.kill).toHaveBeenCalledOnce();
  });
});
