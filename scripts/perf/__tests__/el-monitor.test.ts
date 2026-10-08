import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('../el-monitor.mjs', import.meta.url));

function runChild(script: string, env: Record<string, string> = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_OPTIONS;
  return spawnSync(process.execPath, ['--import', preload, '-e', script], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('el-monitor preload（#678 固化，原 #675 诊断工具）', () => {
  it('事件循环阻塞超阈值 → stderr 输出 [EL] 直方图行', () => {
    // 阻塞经 setTimeout 进事件循环（主脚本同步阻塞发生在直方图监控生效前采不到）；
    // 起点 130ms 刻意不对齐 50ms 采样窗口——与 tick 对齐（如 100ms）的阻塞会被采样竞态吞掉
    const res = runChild('setTimeout(()=>{const s=Date.now();while(Date.now()-s<250){}},130);setTimeout(()=>{},700)', {
      EL_MONITOR_INTERVAL_MS: '50',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/\[EL\] t=\d+\.\d+s max=\d+ms p99=\d+\.\d+ms mean=\d+\.\d+ms/);
  });

  it('无阻塞 → 无 [EL] 输出', () => {
    const res = runChild('setTimeout(()=>{},200)', { EL_MONITOR_INTERVAL_MS: '50' });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('[EL]');
  });

  it('EL_MONITOR_THRESHOLD_MS 可调阈值', () => {
    const res = runChild('setTimeout(()=>{const s=Date.now();while(Date.now()-s<60){}},130);setTimeout(()=>{},500)', {
      EL_MONITOR_INTERVAL_MS: '50',
      EL_MONITOR_THRESHOLD_MS: '30',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[EL]');
  });

  it('env 非正数 → 启动即报错退出（防笔误 setInterval(NaN) 高频刷输出，#680）', () => {
    const res = runChild('setTimeout(()=>{},100)', { EL_MONITOR_INTERVAL_MS: 'abc' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/EL_MONITOR_INTERVAL_MS 须为正数毫秒/);

    const res2 = runChild('setTimeout(()=>{},100)', { EL_MONITOR_THRESHOLD_MS: '-5' });
    expect(res2.status).not.toBe(0);
    expect(res2.stderr).toMatch(/EL_MONITOR_THRESHOLD_MS 须为正数毫秒/);
  });
});
