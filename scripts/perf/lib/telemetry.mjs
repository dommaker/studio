// PERF-07 子进程只读测量 preload：不写业务数据，只向隔离 STUDIO_HOME 落诊断 JSON。
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

// NODE_OPTIONS 会传给 API 派生的 node 子进程；只有首个进程拥有并写诊断文件。
const telemetryOwner = process.env.PERF_TELEMETRY_OWNER_PID;
if (isMainThread && (!telemetryOwner || telemetryOwner === String(process.pid))) {
process.env.PERF_TELEMETRY_OWNER_PID = String(process.pid);
const out = process.env.PERF_TELEMETRY_FILE;
if (!out) throw new Error('PERF_TELEMETRY_FILE 必填');
const intervalMs = Number(process.env.PERF_TELEMETRY_INTERVAL_MS ?? 250);
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('PERF_TELEMETRY_INTERVAL_MS 须为正数');

const startedAt = Date.now();
const rssStart = process.memoryUsage().rss;
let rssPeak = rssStart;
let readBytes = 0;
let parsedLines = 0;
let cacheMisses = 0;
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

function accountBuffer(value) {
  readBytes += Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(String(value));
  cacheMisses += 1;
}
const syncRead = fs.readFileSync;
fs.readFileSync = function (...args) {
  const result = syncRead.apply(this, args);
  accountBuffer(result);
  return result;
};
const asyncRead = fs.promises.readFile.bind(fs.promises);
fs.promises.readFile = async (...args) => {
  const result = await asyncRead(...args);
  accountBuffer(result);
  return result;
};
const asyncOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  const handle = await asyncOpen(...args);
  const read = handle.read.bind(handle);
  Object.defineProperty(handle, 'read', {
    value: async (...readArgs) => {
      const result = await read(...readArgs);
      readBytes += result.bytesRead;
      if (result.bytesRead > 0) cacheMisses += 1;
      return result;
    },
  });
  return handle;
};
const parse = JSON.parse;
JSON.parse = function (text, ...args) {
  if (typeof text === 'string' && text.trimStart().startsWith('{')) parsedLines += 1;
  return parse.call(JSON, text, ...args);
};

let flushSequence = 0;
function flush() {
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  const report = {
    version: 1,
    pid: process.pid,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    readBytes,
    parsedLines,
    cacheMisses,
    eventLoopDelayMs: {
      p50: histogram.percentile(50) / 1e6,
      p95: histogram.percentile(95) / 1e6,
      max: histogram.max / 1e6,
    },
    rssBytes: { start: rssStart, peak: rssPeak, end: process.memoryUsage().rss },
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.${++flushSequence}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, out);
}
const timer = setInterval(flush, intervalMs);
timer.unref();
process.once('beforeExit', flush);
process.on('uncaughtException', error => console.error('[perf-telemetry] uncaughtException', error));
process.on('unhandledRejection', error => console.error('[perf-telemetry] unhandledRejection', error));
process.once('SIGTERM', () => {
  flush();
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, 'SIGTERM');
});
}
