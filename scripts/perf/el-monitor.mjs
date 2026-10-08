// 事件循环阻塞监控 preload（#678 固化为常驻工具，原 #675 一次性诊断 .scratch/675/el-monitor.mjs）。
// 用法（--import 须绝对路径）：
//   NODE_OPTIONS="--import /abs/path/scripts/perf/el-monitor.mjs" node node_modules/tsx/dist/cli.mjs apps/api/src/index.ts
// 每个采样窗口报告一次 monitorEventLoopDelay 直方图，只在窗口 max 超阈值时输出，
// 便于关联 warmup/阻塞窗口。窗口与阈值可用环境变量调：
//   EL_MONITOR_INTERVAL_MS（默认 500）  EL_MONITOR_THRESHOLD_MS（默认 100）
import { monitorEventLoopDelay } from 'node:perf_hooks';

const intervalMs = Number(process.env.EL_MONITOR_INTERVAL_MS ?? 500);
const thresholdMs = Number(process.env.EL_MONITOR_THRESHOLD_MS ?? 100);

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
const t0 = Date.now();
setInterval(() => {
  const maxMs = h.max / 1e6;
  if (maxMs > thresholdMs) {
    const p99 = h.percentile(99) / 1e6;
    const mean = h.mean / 1e6;
    console.error(`[EL] t=${((Date.now() - t0) / 1000).toFixed(1)}s max=${maxMs.toFixed(0)}ms p99=${p99.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
  }
  h.reset();
}, intervalMs).unref();
