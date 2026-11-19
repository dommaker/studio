/** PERF-07 浏览器场景：真实构建产物 + 长历史翻页 + 精确 SSE + 逐详情完成后的长会话内存。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { startServer, stopServer, waitReady, removeTempHome, type ServerHandle } from './lib/server.js';
import { registerUser, startPreview } from './lcp.js';
import { summarize } from './lib/stats.js';
import { scenarioBudgets } from './lib/thresholds.js';
import type { BudgetMetric, CorrectnessResult } from './scale.js';

export interface BrowserMatrix { channels: number; messages: number; sseEvents: number; detailVisits: number }
export interface BrowserReport {
  version: 1;
  matrix: BrowserMatrix;
  correctness: CorrectnessResult[];
  latency: BudgetMetric[];
  soak: BudgetMetric[];
  diagnostics: {
    longTasks: { p50: number; p95: number; max: number };
    droppedFrames: number;
    heapBytes: { start: number; afterGc: number; peak: number };
    /** 0=包内不可读；精确键数由 PERF-06 store 直测，浏览器不虚报。 */
    retainedChannelKeys: number;
    completedChannelVisits: number;
    completedDetailVisits: number;
    historyAnchor: boolean;
  };
}
export interface BrowserOptions {
  repeats: number;
  runs: number;
  matrix: BrowserMatrix;
  out?: string;
  quiet?: boolean;
}

export const DEFAULT_BROWSER_MATRIX: BrowserMatrix = { channels: 100, messages: 2000, sseEvents: 50, detailVisits: 1000 };
const REQUIRED_CORRECTNESS = [
  'long history rendered', 'long history anchor', 'continuous SSE received', 'detail visits completed',
  'heap measurement valid', 'web vitals captured',
] as const;

export function evaluateBrowserReport(report: BrowserReport): { correctness: string[]; latency: string[]; soak: string[] } {
  if (Object.values(report.matrix).some(value => !Number.isInteger(value) || value <= 0)) throw new Error('浏览器规模矩阵必须全非空');
  const correctness: string[] = [];
  const lcp = report.latency.find(row => row.name === 'LCP');
  if (!lcp) correctness.push('missing:LCP');
  else if (lcp.n < lcp.minSamples || lcp.n <= 0) correctness.push('samples:LCP');
  const inp = report.soak.find(row => row.name === 'INP');
  if (!inp) correctness.push('missing:INP');
  else if (inp.n < inp.minSamples || inp.n <= 0) correctness.push('samples:INP');
  const byName = new Map(report.correctness.map(row => [row.name, row.ok]));
  for (const name of REQUIRED_CORRECTNESS) if (!byName.get(name)) correctness.push(name);
  if (!report.diagnostics.historyAnchor && !correctness.includes('long history anchor')) correctness.push('long history anchor');
  if (report.diagnostics.completedChannelVisits !== report.matrix.channels && !correctness.includes('detail visits completed')) correctness.push('detail visits completed');
  if (report.diagnostics.completedDetailVisits !== report.matrix.detailVisits && !correctness.includes('detail visits completed')) correctness.push('detail visits completed');
  const over = (rows: BudgetMetric[]) => rows.filter(row => row.hard !== false && row.n >= row.minSamples && row.n > 0 && (row.p50 > row.budgetP50Ms || row.p95 > row.budgetP95Ms)).map(row => row.name);
  const soak = over(report.soak);
  if (report.diagnostics.retainedChannelKeys > scenarioBudgets.browserRetainedChannelKeys) soak.push('retained channel keys');
  if (report.diagnostics.heapBytes.afterGc - report.diagnostics.heapBytes.start > scenarioBudgets.browserHeapGrowthBytes) soak.push('long-session heap growth');
  return { correctness, latency: over(report.latency), soak };
}

function positive(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} 须为正整数`);
  return value;
}

export function browserSamplePlan(opts: { repeats: number; runs: number }): { fullSoakRounds: 1; lightRounds: number; totalRounds: number } {
  const totalRounds = Math.max(20, opts.repeats * opts.runs);
  return { fullSoakRounds: 1, lightRounds: totalRounds - 1, totalRounds };
}

export function parseBrowserArgs(argv: string[]): BrowserOptions {
  const opts: BrowserOptions = { repeats: 3, runs: 3, matrix: { ...DEFAULT_BROWSER_MATRIX } };
  const keys: Record<string, keyof BrowserMatrix> = { '--channels': 'channels', '--messages': 'messages', '--sse-events': 'sseEvents', '--detail-visits': 'detailVisits' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in keys) opts.matrix[keys[flag]] = positive(argv[++i], flag);
    else if (flag === '--repeats') opts.repeats = positive(argv[++i], flag);
    else if (flag === '--runs') opts.runs = positive(argv[++i], flag);
    else if (flag === '--out') opts.out = argv[++i];
    else if (flag === '--quiet') opts.quiet = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (opts.repeats < 2) throw new Error('--repeats 须 ≥2');
  return opts;
}

function metric(name: string, values: number[], minSamples: number, p50: number, p95: number): BudgetMetric {
  const summary = summarize(values);
  return { name, n: summary.n, minSamples, p50: summary.p50, p95: summary.p95, max: summary.max, budgetP50Ms: p50, budgetP95Ms: p95 };
}

function seedBrowserData(home: string, matrix: BrowserMatrix): void {
  const dataDir = path.join(home, 'data');
  const channelDir = path.join(dataDir, 'channels');
  fs.mkdirSync(channelDir, { recursive: true });
  const now = Date.now();
  const channels = ['perf-long', ...Array.from({ length: matrix.channels - 1 }, (_, i) => `perf-channel-${i}`)];
  for (const id of channels) {
    const dir = path.join(channelDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id, name: `#${id}`, type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    }));
    if (id === 'perf-long') {
      const messages = Array.from({ length: matrix.messages }, (_, i) => ({
        id: `browser-m-${i}`, channelId: id, workUnitId: null, authorType: i % 2 ? 'agent' : 'human',
        agentName: i % 2 ? 'perf' : null, content: `长历史消息 ${i} ${'x'.repeat(200)}`, replyToId: null, meta: '{}',
        createdAt: new Date(now - (matrix.messages - i) * 1000).toISOString(),
      }));
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${messages.map(row => JSON.stringify(row)).join('\n')}\n`);
    }
  }
  const wuDir = path.join(dataDir, 'workunits');
  fs.mkdirSync(wuDir, { recursive: true });
  const snapshots = Array.from({ length: matrix.detailVisits }, (_, i) => ({
    id: `browser-wu-${i}`, parentId: null, type: 'task', scope: `浏览器长会话 ${i}`, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null, channelId: 'perf-long',
    projectPath: null, workspaceId: null, metadata: '{}', createdAt: new Date(now - i * 1000).toISOString(),
    updatedAt: new Date(now - i * 1000).toISOString(), claimedAt: null, completedAt: null,
  }));
  fs.writeFileSync(path.join(wuDir, 'index.json'), `${snapshots.map(row => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(path.join(wuDir, 'events.jsonl'), `${snapshots.map(row => JSON.stringify({ type: 'created', wuId: row.id, timestamp: row.createdAt, data: row })).join('\n')}\n`);
}

interface RoundResult {
  lcpMs: number;
  inpMs: number;
  longTasksMs: number[];
  droppedFrames: number;
  heapBytes: { start: number; afterGc: number; peak: number };
  longHistory: boolean;
  historyAnchor: boolean;
  sseReceived: boolean;
  completedChannelVisits: number;
  completedDetailVisits: number;
}

async function installProbes(context: BrowserContext, storageJson: string, iifeSource: string): Promise<void> {
  await context.addInitScript({ content: `
    window.localStorage.setItem('auth-storage', ${JSON.stringify(storageJson)});
    // 长会话用户已完成首用角色设置；不把一次性弹窗延迟计入持续交互 INP。
    window.sessionStorage.setItem('studio-role-setup-dismissed', '1');
    window.sessionStorage.setItem('first-role-setup-dismissed', '1');
  ` });
  await context.addInitScript({ content: `
    ${iifeSource}
    ;window.__perf = { lcp: 0, inp: 0, longTasks: [], droppedFrames: 0, sseIds: [] };
    webVitals.onLCP(m => { window.__perf.lcp = m.value; }, { reportAllChanges: true });
    webVitals.onINP(m => { window.__perf.inp = Math.max(window.__perf.inp, m.value); }, { reportAllChanges: true });
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__perf.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
    let previous = 0; function frame(t) { if (previous && t - previous > 50) window.__perf.droppedFrames++; previous = t; requestAnimationFrame(frame); } requestAnimationFrame(frame);
    window.addEventListener('DOMContentLoaded', () => {
      const stream = new EventSource('/api/v1/events/stream?topics=channels');
      stream.onmessage = event => { try {
        const parsed = JSON.parse(event.data);
        if (parsed.event_type === 'channel.message_sent') {
          const id = parsed.data?.message?.id ?? parsed.data?.id;
          if (id) window.__perf.sseIds.push(id);
        }
      } catch {} };
    });
  ` });
}

async function heapValue(page: Page, collectGarbage: boolean): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    if (collectGarbage) await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = metrics.find(row => row.name === 'JSHeapUsedSize')?.value ?? 0;
    if (heap <= 0) throw new Error('CDP JSHeapUsedSize 无效（0），拒绝形成内存门禁假绿');
    return heap;
  } finally { await cdp.detach(); }
}

async function spaNavigate(page: Page, route: string, expectedText?: string): Promise<void> {
  // 保持同一 SPA 生命周期与 store，但不制造 1000 条 session-history 原生内存驻留。
  await page.evaluate(pathname => {
    history.replaceState({}, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForURL(url => url.pathname === route, { timeout: 30_000 });
  if (expectedText) await page.getByText(expectedText, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
}

let browserDebugConfigured = false;

async function launchBrowser(home: string, label: string): Promise<{ browser: Browser; log: (message: string) => void }> {
  const logPath = path.join(home, `browser-${label}.log`);
  const log = (message: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  try {
    if (!browserDebugConfigured) {
      // 只开 pw:browser，避免 pw:api 把认证 init-script 写入诊断。
      process.env.DEBUG = 'pw:browser';
      process.env.DEBUG_FILE = logPath;
      browserDebugConfigured = true;
    }
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
    browser.on('disconnected', () => log('[perf-browser] disconnected'));
    return { browser, log };
  } catch (error) {
    log(`[perf-browser] launch failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function measureRound(browser: Browser, baseUrl: string, apiUrl: string, storageJson: string, iifeSource: string, matrix: BrowserMatrix, diagnostic: (message: string) => void): Promise<RoundResult> {
  const context = await browser.newContext();
  try {
    await installProbes(context, storageJson, iifeSource);
    const page = await context.newPage();
    page.on('crash', () => diagnostic('[perf-browser] page crash'));
    const initialResponsePromise = page.waitForResponse(response =>
      response.url().includes('/api/v1/channels/perf-long/messages') && !response.url().includes('before='),
    { timeout: 30_000 });
    await page.goto(`${baseUrl}/channels/perf-long`, { waitUntil: 'domcontentloaded' });
    const initialResponse = await initialResponsePromise;
    const initialBody = await initialResponse.json() as { data?: { messages?: Array<{ id: string }> } };
    const initialOldest = initialBody.data?.messages?.[0]?.id;
    if (!initialOldest) throw new Error('首屏响应缺少真实旧页游标');
    await page.getByRole('button', { name: /^(取消|跳过|稍后)$/ }).first().click({ timeout: 2000 }).catch(() => {});

    let historyAnchor = false;
    let cursor = initialOldest;
    const maxOlderPages = Math.max(2, Math.ceil(matrix.sseEvents / 50) + 1);
    for (let pageNo = 0; pageNo < maxOlderPages && !historyAnchor; pageNo++) {
      const olderResponsePromise = page.waitForResponse(response =>
        response.url().includes('/api/v1/channels/perf-long/messages') && response.url().includes(`before=${cursor}`),
      { timeout: 30_000 });
      await page.getByRole('button', { name: /加载更早/ }).click({ timeout: 30_000 });
      const olderResponse = await olderResponsePromise;
      const olderBody = await olderResponse.json() as { data?: { messages?: Array<{ id: string }>; hasMore?: boolean } };
      const rows = olderBody.data?.messages ?? [];
      historyAnchor = olderResponse.ok() && rows.some(row => /^browser-m-\d+$/.test(row.id));
      if (!olderResponse.ok() || rows.length === 0 || olderBody.data?.hasMore === false) break;
      cursor = rows[0].id;
    }
    // 虚拟列表可能只挂相邻行，必须验证真实旧页响应中的场景锚点。
    const longHistory = Boolean(initialBody.data?.messages?.some(row => /^browser-m-\d+$/.test(row.id))) || historyAnchor;
    const heapStart = await heapValue(page, true);

    const composer = page.locator('textarea').first();
    await composer.click();
    await composer.pressSequentially('perf interaction', { delay: 10 });
    await composer.press('ControlOrMeta+a');
    await composer.press('Backspace');
    const expectedSseIds: string[] = [];
    for (let i = 0; i < matrix.sseEvents; i++) {
      const res = await fetch(`${apiUrl}/api/v1/channels/perf-long/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `browser-sse-${i}`, intent: 'plain' }),
      });
      const body = await res.json() as { data?: { id?: string }; error?: unknown };
      if (!res.ok || !body.data?.id) throw new Error(`浏览器 SSE seed ${i} → ${res.status}: ${JSON.stringify(body)}`);
      expectedSseIds.push(body.data.id);
    }
    await page.waitForFunction(ids => ids.every(id => (window as any).__perf.sseIds.includes(id)), expectedSseIds, { timeout: 30_000 });

    let completedChannelVisits = 0;
    for (let i = 0; i < matrix.channels; i++) {
      const route = i === 0 ? '/channels/perf-long' : `/channels/perf-channel-${i - 1}`;
      await spaNavigate(page, route);
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
      completedChannelVisits++;
    }
    let completedDetailVisits = 0;
    for (let i = 0; i < matrix.detailVisits; i++) {
      if (i % 10 === 0) {
        const progress = `detail ${i}/${matrix.detailVisits} heap=${await heapValue(page, true)} freeMem=${os.freemem()}`;
        console.error(`[perf-browser] ${progress}`);
        diagnostic(`[perf-browser] ${progress}`);
      }
      await spaNavigate(page, `/workunits/browser-wu-${i}`, `浏览器长会话 ${i}`);
      completedDetailVisits++;
    }
    await spaNavigate(page, '/channels/perf-long');
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
    const heapPeak = await heapValue(page, false);
    const heapAfter = await heapValue(page, true);
    const probe = await page.evaluate(() => (window as any).__perf);
    return {
      lcpMs: probe.lcp, inpMs: probe.inp, longTasksMs: probe.longTasks, droppedFrames: probe.droppedFrames,
      heapBytes: { start: heapStart, afterGc: heapAfter, peak: Math.max(heapStart, heapPeak, heapAfter) },
      longHistory, historyAnchor,
      sseReceived: expectedSseIds.every(id => probe.sseIds.includes(id)),
      completedChannelVisits, completedDetailVisits,
    };
  } finally { await context.close(); }
}

interface VitalSample { lcpMs: number; inpMs: number; longTasksMs: number[]; droppedFrames: number }

/** 同一长历史页的真实轻量交互；完整 1000 详情 soak 不在这里重复。 */
async function measureLightRound(browser: Browser, baseUrl: string, storageJson: string, iifeSource: string): Promise<VitalSample> {
  const context = await browser.newContext();
  try {
    await installProbes(context, storageJson, iifeSource);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/channels/perf-long`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^(取消|跳过|稍后)$/ }).first().click({ timeout: 2000 }).catch(() => {});
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.click();
    await composer.pressSequentially('perf interaction', { delay: 10 });
    await composer.press('ControlOrMeta+a');
    await composer.press('Backspace');
    await page.waitForTimeout(300);
    const probe = await page.evaluate(() => (window as any).__perf);
    return { lcpMs: probe.lcp, inpMs: probe.inp, longTasksMs: probe.longTasks, droppedFrames: probe.droppedFrames };
  } finally { await context.close(); }
}

export async function runBrowser(opts: BrowserOptions): Promise<BrowserReport> {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  if (!fs.existsSync(path.join(repoRoot, 'apps/web/dist/assets'))) throw new Error('apps/web/dist 不存在，先跑 pnpm build:web');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-perf-browser-'));
  let api: ServerHandle | null = null;
  let preview: Awaited<ReturnType<typeof startPreview>> | null = null;
  let failed = false;
  const log = (message: string) => { if (!opts.quiet) console.error(`[perf-browser] ${message}`); };
  try {
    seedBrowserData(home, opts.matrix);
    api = await startServer({ studioHome: home, extraEnv: { REGISTER_ENABLED: 'true', STUDIO_AGENT_LOOP_ENABLED: 'false' } });
    await waitReady(api);
    const auth = await registerUser(api.baseUrl);
    preview = await startPreview(api.port);
    const storageJson = JSON.stringify({ state: { token: auth.token, refreshToken: auth.refreshToken ?? null, user: auth.user, session: auth.session, guestId: null }, version: 0 });
    const iifeSource = fs.readFileSync(path.join(repoRoot, 'node_modules/web-vitals/dist/web-vitals.iife.js'), 'utf8');
    const plan = browserSamplePlan(opts);
    log('完整长历史/100频道/1000详情/持续SSE/GC soak（仅一次）');
    const soak = await launchBrowser(home, 'soak');
    const fullRound = await (async () => {
      try { return await measureRound(soak.browser, preview.baseUrl, api.baseUrl, storageJson, iifeSource, opts.matrix, soak.log); }
      finally { await soak.browser.close(); }
    })();
    const lightRounds: VitalSample[] = [];
    for (let i = 0; i < plan.lightRounds; i++) {
      log(`轻量 vitals sample ${i + 1}/${plan.lightRounds}`);
      const light = await launchBrowser(home, `light-${i + 1}`);
      try {
        lightRounds.push(await measureLightRound(light.browser, preview.baseUrl, storageJson, iifeSource));
      } finally {
        await light.browser.close();
      }
    }
    const rounds = [fullRound, ...lightRounds];
    const longTasks = rounds.flatMap(round => round.longTasksMs);
    const longSummary = summarize(longTasks);
    return {
      version: 1, matrix: { ...opts.matrix },
      correctness: [
        { name: 'long history rendered', ok: fullRound.longHistory },
        { name: 'long history anchor', ok: fullRound.historyAnchor },
        { name: 'continuous SSE received', ok: fullRound.sseReceived },
        { name: 'detail visits completed', ok: fullRound.completedChannelVisits === opts.matrix.channels && fullRound.completedDetailVisits === opts.matrix.detailVisits },
        { name: 'heap measurement valid', ok: fullRound.heapBytes.start > 0 && fullRound.heapBytes.afterGc > 0 },
        { name: 'web vitals captured', ok: rounds.every(round => round.lcpMs > 0 && round.inpMs > 0) },
      ],
      latency: [metric('LCP', rounds.map(round => round.lcpMs), plan.totalRounds, scenarioBudgets.lcpP50Ms, scenarioBudgets.lcpP95Ms)],
      soak: [metric('INP', rounds.map(round => round.inpMs), plan.totalRounds, scenarioBudgets.inpP50Ms, scenarioBudgets.inpP95Ms)],
      diagnostics: {
        longTasks: { p50: longSummary.p50, p95: longSummary.p95, max: longSummary.max },
        droppedFrames: rounds.reduce((sum, round) => sum + round.droppedFrames, 0),
        heapBytes: fullRound.heapBytes,
        retainedChannelKeys: 0,
        completedChannelVisits: fullRound.completedChannelVisits,
        completedDetailVisits: fullRound.completedDetailVisits,
        historyAnchor: fullRound.historyAnchor,
      },
    };
  } catch (error) {
    failed = true;
    const failure = {
      version: 1,
      failedAt: new Date().toISOString(),
      matrix: opts.matrix,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
      memoryBytes: { free: os.freemem(), total: os.totalmem(), processRss: process.memoryUsage().rss },
    };
    fs.writeFileSync(path.join(home, 'failure.json'), JSON.stringify(failure, null, 2), { mode: 0o600 });
    console.error(`[perf-browser] 失败诊断保留：${home}`);
    throw error;
  } finally {
    if (preview) preview.proc.kill('SIGTERM');
    if (api) await stopServer(api);
    if (!failed) removeTempHome(home);
  }
}

export function renderBrowserMarkdown(report: BrowserReport): string {
  return [
    '## PERF-07 浏览器长历史/持续 SSE/长会话', '',
    `矩阵：${JSON.stringify(report.matrix)}；完成频道/详情=${report.diagnostics.completedChannelVisits}/${report.diagnostics.completedDetailVisits}；旧页锚点=${report.diagnostics.historyAnchor}`,
    `LCP n=${report.latency[0]?.n ?? 0} p50/p95=${report.latency[0]?.p50}/${report.latency[0]?.p95}ms；INP n=${report.soak[0]?.n ?? 0} p50/p95=${report.soak[0]?.p50}/${report.soak[0]?.p95}ms`,
    `long task p95/max=${report.diagnostics.longTasks.p95}/${report.diagnostics.longTasks.max}ms（诊断）；dropped frames=${report.diagnostics.droppedFrames}`,
    `GC heap start/after=${report.diagnostics.heapBytes.start}/${report.diagnostics.heapBytes.afterGc} bytes；精确驻留键数由 PERF-06 store 测试覆盖`,
  ].join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseBrowserArgs(process.argv.slice(2));
  runBrowser(opts).then(report => {
    console.log(renderBrowserMarkdown(report));
    const out = opts.out ?? path.join(os.tmpdir(), `studio-browser-report-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.error(`[perf-browser] JSON 报告：${out}`);
    const failures = evaluateBrowserReport(report);
    console.error(`[perf-browser] correctness=${failures.correctness.join(',') || '绿'} latency=${failures.latency.join(',') || '绿'} soak=${failures.soak.join(',') || '绿'}`);
    process.exit(Object.values(failures).some(rows => rows.length > 0) ? 1 : 0);
  }).catch(error => { console.error(`[perf-browser] 失败：${error instanceof Error ? error.stack ?? error.message : error}`); process.exit(1); });
}
