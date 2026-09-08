/**
 * #323 阶段一 bench 入口：周期循环读口量化测量。
 *
 * 用法：pnpm tsx bench/loop-read-metrics.ts [--rounds N] [--scales 1,10,50]
 *   --rounds  每循环轮数（默认 21 = 1 冷 + 20 暖）
 *   --scales  规模档（默认 1,10,50；以真实 ~/.studio 为 1x 模板）
 * bench tmp 根运行结束保留并打印路径（合成数据全在 tmp，不碰 ~/.studio），手工清理。
 *
 * 流程：synthesize-dataset（只读 ~/.studio → tmp 合成 1x/10x/50x）→ 每档子进程跑
 * loop-read-worker.ts（env 注入 STUDIO_HOME 等，驱动 8 个循环体各 N 轮）→
 * read-metrics-aggregate 聚合 → markdown 报告落盘 bench/report-loop-read-metrics.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { synthesizeDataset, type SynthesizeStats } from './synthesize-dataset.js';
import { summarize, renderMarkdown, loadWorkerResults, type WorkerResult } from './read-metrics-aggregate.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_HOME = path.join(os.homedir(), '.studio');

const GAPS = [
  'monitor 日级窗口已补测（1x/50x 单列 monitor-daily-reflection / monitor-data-lifecycle / monitor-knowledge-decay，窗口条件强制开启）；user-model 更新（npx harness）已纳入 exec 段测量（#411），在 monitor-knowledge-decay 日级窗口轮内实测（bench 为假 npx 桩，记录的是桩壳开销；常态 5min 轮不触发，与生产 24h 门控一致），真实耗时以生产数据为准',
  'ops-round 的 apiResponding=false 分支（自动重启/退出）与 preflight：不属于周期健康轮，未测',
  'auditor 的失败执行分支（eval case 生成 / auto resolution / Triage 升级 / 确认卡片）：合成数据全成功执行，未触发；触发型读口未计入',
  'Triage 升级被记录桩替换（安全闸：升级路径会拉 systemExecutor 跑 LLM 诊断，bench 不可触碰）；触发次数见 worker 输出 triageStubCalls',
];

const MEASUREMENT_CODE = [
  'packages/studio-shared/src/read-metrics.ts（新增：sink + ALS 归因 + readMetricsBegin/emitReadMetric；#411 增段事件 SegmentMetricEvent + runSegmentSpan + wrapWithSegmentSpan）',
  'packages/studio-shared/src/file-store.ts（readJson / readJsonl / readdirCached / readIndexForQuery 四读口内计时埋点；锁内裸读路径未动）',
  'packages/studio-shared/package.json（exports 增 ./read-metrics 子路径）',
  'apps/api/src/modules/agents/monitor/exec-async.ts（#411：execAsync/execFileAsync 内 exec 段计时上报，段名取到首个 flag 前）',
  'apps/api/src/modules/knowledge/knowledge-singletons.ts（#411：装配层包装 rawKnowledgeStore + 五 facade 方法为 harness 段 span，嵌套只记顶层）',
  'apps/api/bench/synthesize-dataset.ts（新增：数据合成器，只读 ~/.studio → tmp 合成 1x/10x/50x）',
  'apps/api/bench/loop-read-worker.ts（新增：单档循环驱动 worker；#411 增段事件采集 + user-model 门控放开）',
  'apps/api/bench/loop-read-metrics.ts（新增：bench 入口，合成 → 子进程驱动 → 聚合出报告；#411 增 git init REPO_DIR + 假 npx 桩）',
  'apps/api/bench/read-metrics-aggregate.ts（新增：轮次聚合 + markdown 渲染纯函数；#411 增分段归因表 + exec 命令明细）',
  'apps/api/bench/__tests__/（新增：上述模块的单测）',
  'apps/api/vitest.config.ts（include 增 bench/**/__tests__/**/*.test.ts）',
];

export function parseArgs(argv: string[] = process.argv.slice(2)): { rounds: number; scales: number[] } {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    rounds: Number(get('--rounds') ?? 21),
    scales: (get('--scales') ?? '1,10,50').split(',').map(Number),
  };
}

function tsxBin(): string {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    path.join(API_ROOT, 'node_modules', '.bin', 'tsx'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('tsx not found');
}

async function main(): Promise<void> {
  const { rounds, scales } = parseArgs();

  // 历史 bench root 收敛：当次结果保留（下方 "bench root kept"），>24h 的旧根清掉
  const tmpRoot = os.tmpdir();
  const staleMs = 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(tmpRoot)) {
    if (!name.startsWith('loop-read-bench-')) continue;
    const p = path.join(tmpRoot, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > staleMs) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 竞态不阻断 */ }
  }

  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-read-bench-'));
  console.log(`[bench] root: ${benchRoot}`);
  console.log(`[bench] template: ${TEMPLATE_HOME} (read-only)`);

  const resultFiles: string[] = [];
  const synthStats: Record<string, SynthesizeStats> = {};

  // 向量库同步隔离：knowledge 写入会 scheduleVectorDbSync → execFile('systemd-run', …) 起
  // mcp-local-rag ingest（写共享生产 lancedb + 30min 子进程吊住 worker 事件 loop；模块内部
  // 直线调用，exports 桩拦不住）。PATH 前置假 systemd-run（立即 exit 0），ingest 物理不发生。
  // #411 再前置假 npx：monitor 轮 user-model 更新（npx harness …）已纳入 exec 段测量，
  // worker 预置 lastUserModelRun=0 每轮触发，桩输出 '{}' 让调用侧静默跳过，只测子进程壳开销。
  const fakeBin = path.join(benchRoot, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'systemd-run'), '#!/bin/sh\n# bench stub: vector-db sync 隔离（#323）\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'npx'), '#!/bin/sh\n# bench stub: npx harness update-user-model 桩（#411 exec 段演示）\necho "{}"\nexit 0\n', { mode: 0o755 });

  for (const scale of scales) {
    const label = `${scale}x`;
    const home = path.join(benchRoot, label);
    console.log(`[bench] synthesizing ${label} ...`);
    const t0 = Date.now();
    synthStats[label] = synthesizeDataset({ templateHome: TEMPLATE_HOME, outHome: home, scale });
    console.log(`[bench] ${label} synthesized in ${Date.now() - t0}ms:`, synthStats[label]);

    const out = path.join(benchRoot, `result-${label}.json`);
    // ops getStatus 探活 stub 端口：39100 段远离生产 3001 / dev 常用端口；+scale 防多档并发互撞
    const port = 39100 + scale;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VITEST: undefined,
      NODE_ENV: undefined,
      STUDIO_HOME: home,
      STUDIO_DATA_DIR: path.join(home, 'data'),
      STUDIO_BENCH_OUT: out,
      STUDIO_BENCH_SCALE: label,
      STUDIO_BENCH_ROUNDS: String(rounds),
      STUDIO_BENCH_OPS_PORT: String(port),
      WORKTREES_DIR: path.join(benchRoot, `wt-${label}`),
      REPO_DIR: path.join(benchRoot, `repo-${label}`),
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    fs.mkdirSync(env.WORKTREES_DIR!, { recursive: true });
    fs.mkdirSync(env.REPO_DIR!, { recursive: true });
    // #411：REPO_DIR 建成真 git 仓，monitor 轮 gcStaleWorktrees 的 git worktree prune
    // （原 existsSync(.git) 守卫直接跳过）得以运行并进 exec 段测量（空仓 prune ~ms 级）
    try {
      execFileSync('git', ['init', '--quiet', env.REPO_DIR!], { stdio: 'ignore' });
    } catch { /* git 缺席则 exec 段少一行命令明细，不阻断 bench */ }

    console.log(`[bench] running worker for ${label} (${rounds} rounds × 8 loops) ...`);
    const t1 = Date.now();
    execFileSync(tsxBin(), [path.join(__dirname, 'loop-read-worker.ts')], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: API_ROOT,
      timeout: 30 * 60_000,
    });
    console.log(`[bench] ${label} worker done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    resultFiles.push(out);
  }

  const results = loadWorkerResults(resultFiles);
  // 合并合成统计（state/profile 文件数）进 meta
  for (const r of results) {
    const s = synthStats[r.scale];
    if (s) {
      r.meta.stateFiles = s.stateFiles;
      r.meta.profileFiles = s.profileFiles;
      r.meta.channels = s.channels;
    }
  }

  const summary = summarize(results as WorkerResult[]);
  const md = renderMarkdown(summary, {
    generatedAt: new Date().toISOString(),
    roundsPerLoop: rounds,
    gaps: GAPS,
    measurementCode: MEASUREMENT_CODE,
    recommendation: '（待人工分析后填写）',
  });

  const reportPath = path.join(__dirname, 'report-loop-read-metrics.md');
  fs.writeFileSync(reportPath, md);
  console.log(`[bench] report: ${reportPath}`);
  console.log(`[bench] raw results: ${resultFiles.join(', ')}`);
  console.log(`[bench] done. bench root kept at ${benchRoot}`);
}

// 仅作为脚本直跑时执行（vitest import 不触发，供 __tests__ 测 parseArgs）
if (require.main === module) {
  main().catch(err => {
    console.error('[bench] failed:', err);
    process.exit(1);
  });
}
