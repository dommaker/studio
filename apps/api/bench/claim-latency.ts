/**
 * #508 走查③「认领延迟」bench：WU 建成 → loop 拾取 → 首个执行步开始的时延构成实测。
 *
 * 用法（在 apps/api 下）：npx tsx bench/claim-latency.ts [--rounds N]（默认 5 轮）
 *
 * 数据：以真实 ~/.studio 为 1x 模板经 synthesize-dataset 合成到 tmp（模板只读），
 * 全部写落合成副本，不碰生产数据区。
 *
 * Phase A 组件耗时（合成副本上采样）：create / observe 三读口（getIndex + listChannels
 *   + queryAllMessages）/ claim（含 flock + 租约写 + status_changed）。
 * Phase B 真 AgentLoop 端到端（健康探针走真实 `claude --version`；WU scope 带 test
 *   特征词触发 B2 守卫——认领后立即关闭，不起 LLM 会话、不烧 token）：
 *   B1 拾取延迟：建 unassigned WU（指名本 role）→ 轮询 index 拿 claimedAt，N 轮随机相位；
 *      同时记录 getIndex 调用时刻，验证 workunit.created EVENT 触发的 observe 是否带来认领。
 *   B2 事件唤醒延迟：blocked WU（assignee=实例）就绪且 loop 进入 idleSleep 后发人类消息，
 *      测量 message_sent publish → 下一次 observe(getIndex) 的时延。
 *      （2026-09-16 唤醒放宽：不再等 lastActiveWuIds，该派生缓存机制已删——唤醒只放行不裁决）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 数据区隔离必须在任何 studio 模块 import 前生效（ESM 提升 → studio 模块全部走动态 import）；
// 收进 initBenchEnv 只在直跑 main 时执行，vitest import 本模块测纯函数无副作用
function initBenchEnv(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-latency-bench-'));
  process.env.STUDIO_HOME = root;
  process.env.STUDIO_DATA_DIR = path.join(root, 'data');
  process.env.STUDIO_EVENTS_JSONL = path.join(root, 'logs', 'studio-events.jsonl');
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  return root;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): { rounds: number } {
  const i = argv.indexOf('--rounds');
  return { rounds: i >= 0 ? Number(argv[i + 1]) : 5 };
}

export function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function summary(xs: number[]): string {
  return `n=${xs.length} min=${Math.min(...xs)} p50=${pct(xs, 50)} p95=${pct(xs, 95)} max=${Math.max(...xs)} mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`;
}

interface Mark { at: number; note: string }

async function main(): Promise<void> {
  const { rounds: ROUNDS } = parseArgs();
  const benchRoot = initBenchEnv();
  const { synthesizeDataset } = await import('./synthesize-dataset.js');
  const { FileStore, eventBus } = await import('@dommaker/studio-shared');
  const { WorkUnitService } = await import('../src/modules/workunit/workunit.service.js');
  const { ChannelMessageService } = await import('../src/modules/channels/channel-message.service.js');
  const { AgentLoop } = await import('../src/modules/agents/loop/agent-loop.js');

  // ── 合成 1x 数据集（模板 ~/.studio 只读）──
  const templateHome = path.join(os.homedir(), '.studio');
  const stats = synthesizeDataset({ templateHome, outHome: benchRoot, scale: 1, recentExecCount: 0 });
  console.log('[bench] dataset synthesized:', JSON.stringify(stats));

  const dataDir = path.join(benchRoot, 'data');

  // 插桩 FileStore：记录 getIndex 调用时刻（observe 的心跳指纹）
  const getIndexMarks: Mark[] = [];
  class InstrumentedStore extends FileStore {
    override async getIndex(...args: Parameters<FileStore['getIndex']>) {
      getIndexMarks.push({ at: Date.now(), note: 'getIndex' });
      return super.getIndex(...args);
    }
  }
  const fileStore = new InstrumentedStore(dataDir);
  const wuService = new WorkUnitService(fileStore);
  const msgService = new ChannelMessageService(fileStore);

  const channels = await fileStore.listChannels();
  const channelId = channels[0]!.id;
  console.log(`[bench] channel: ${channels[0]!.name} (${channelId})`);

  // ══ Phase A：组件耗时 ══
  console.log('\n══ Phase A: 组件耗时（ms）══');
  const SAMPLES = 30;
  const time = async <T>(fn: () => Promise<T>): Promise<number> => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };

  // observe 三读口
  const getIndexTs: number[] = [];
  const listChannelsTs: number[] = [];
  const queryMsgsTs: number[] = [];
  const someWuIds = (await fileStore.getIndex()).slice(0, 3).map(s => s.id);
  for (let i = 0; i < SAMPLES; i++) {
    getIndexTs.push(await time(() => fileStore.getIndex()));
    listChannelsTs.push(await time(() => fileStore.listChannels()));
    queryMsgsTs.push(await time(() =>
      fileStore.queryAllMessages({ workUnitIds: someWuIds, authorType: 'human', channelIds: [channelId] })));
  }
  console.log(`getIndex:            ${summary(getIndexTs)}`);
  console.log(`listChannels:        ${summary(listChannelsTs)}`);
  console.log(`queryAllMessages:    ${summary(queryMsgsTs)}`);

  // create（commitSnapshot + claimable 解析 + workunit.created 发布）
  const createTs: number[] = [];
  const claimTs: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    let wuId = '';
    createTs.push(await time(async () => {
      const wu = await wuService.create({
        scope: `bench 组件计时 ${i}`, type: 'task', status: 'unassigned', channelId,
      });
      wuId = wu.id;
    }));
    claimTs.push(await time(() => wuService.claim(wuId, 'bench-claimer')));
    await wuService.unclaim(wuId); // 放回池，避免堆积 active
  }
  console.log(`create:              ${summary(createTs)}`);
  console.log(`claim:               ${summary(claimTs)}`);

  // ══ Phase B：真 AgentLoop 端到端 ══
  console.log('\n══ Phase B: 真 AgentLoop 端到端 ══');
  const role = {
    id: 'bench-role-claim-latency',
    name: 'bench-claim-latency',
    description: '#508 bench role',
    provider: 'claude',
    channels: '[]',
    acceptedTypes: [],
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const loop = new AgentLoop(role, fileStore);
  const started = await loop.start();
  if (!started) throw new Error('AgentLoop start failed');
  console.log('[bench] loop started');

  const states = await fileStore.listStates();
  const instanceId = states.find(s => s.roleId === role.id && s.status !== 'terminated')!.id;
  console.log(`[bench] instance: ${instanceId}`);

  // B1：拾取延迟（随机相位建单 → claimedAt）
  console.log('\n── B1: WU 建成 → 认领（随机相位，含 15s idle 地板）──');
  const pickup: Array<{ createdAt: string; claimedAt: string; latencyMs: number; eventObserveGapMs: number | null }> = [];
  for (let r = 0; r < ROUNDS; r++) {
    // 等 loop 回 idle（上轮 WU 关闭 + 簿记完成）
    await new Promise(res => setTimeout(res, 1_000 + Math.floor(Math.random() * 6_000)));
    const marksBefore = getIndexMarks.length;
    const wu = await wuService.create({
      scope: `bench test 拾取延迟 round-${r}`, // test 特征词 → B2 守卫认领后关闭，不起会话
      type: 'task', status: 'unassigned', assigneeId: role.id, channelId,
    });
    const tCreate = Date.now();
    // 轮询等认领（50ms 粒度）
    let claimedAt: string | null = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const snap = (await fileStore.getIndex({ id: wu.id }))[0];
      if (snap && snap.status !== 'unassigned' && snap.claimedAt) { claimedAt = snap.claimedAt; break; }
      await new Promise(res => setTimeout(res, 50));
    }
    if (!claimedAt) { console.log(`round ${r}: TIMEOUT (25s 未认领)`); continue; }
    // EVENT 触发的 observe（建单后第一次额外 getIndex）与认领的间隔：
    // 若 EVENT 能唤醒认领，认领应紧随该 observe；否则认领落在 idle 轮询边界
    const eventObserve = getIndexMarks.slice(marksBefore).find(m => m.at >= tCreate);
    const claimMs = new Date(claimedAt).getTime();
    pickup.push({
      createdAt: wu.createdAt.toISOString(),
      claimedAt,
      latencyMs: claimMs - new Date(wu.createdAt).getTime(),
      eventObserveGapMs: eventObserve ? claimMs - eventObserve.at : null,
    });
    console.log(`round ${r}: latency=${pickup[pickup.length - 1].latencyMs}ms eventObserveGap=${pickup[pickup.length - 1].eventObserveGapMs}ms`);
    // 等 B2 守卫关闭 WU（避免占用 myActive 槽位影响下一轮）
    for (let i = 0; i < 100; i++) {
      const snap = (await fileStore.getIndex({ id: wu.id }))[0];
      if (snap && (snap.status === 'closed' || snap.status === 'done')) break;
      await new Promise(res => setTimeout(res, 200));
    }
  }
  const lat = pickup.map(p => p.latencyMs);
  if (lat.length > 0) console.log(`B1 拾取延迟: ${summary(lat)}`);

  // B2：channel.message_sent 唤醒延迟
  console.log('\n── B2: 人类消息 → 唤醒 idle sleep → 下一次 observe ──');
  // 建 blocked WU 挂本实例。2026-09-16 唤醒放宽后不再等 lastActiveWuIds（机制已删，
  // 唤醒只放行不裁决）——只需等 loop 进入 idleSleep。
  // scope 必须带 test 特征词：唤醒后 loop 会真的拾取该 WU 起会话——B2 守卫拦在
  // prompt 组装前直接关闭，防误烧 token（2026-09-12 首跑教训：无 test 词的 scope
  // 被唤醒的 loop 当真任务 spawn 了真实 CLI 会话）。
  const blockedWu = await wuService.create({
    scope: 'bench test 唤醒挂起任务', type: 'task', status: 'blocked', assigneeId: instanceId, channelId,
    metadata: { waitingForInput: true, waitingSince: new Date().toISOString() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seam = loop as any;
  {
    // 等 loop 确实进入 idleSleep（wakeIdle 挂起）
    const idleDeadline = Date.now() + 20_000;
    while (!seam.wakeIdle && Date.now() < idleDeadline) await new Promise(res => setTimeout(res, 50));
    if (!seam.wakeIdle) {
      console.log('B2 SKIP: loop 20s 未进入 idleSleep');
    } else {
    console.log('[bench] loop 处于 idleSleep');
    const wakeLat: number[] = [];
    for (let i = 0; i < 3; i++) {
      // 等回 idleSleep
      const d = Date.now() + 20_000;
      while (!seam.wakeIdle && Date.now() < d) await new Promise(res => setTimeout(res, 20));
      const marksBefore = getIndexMarks.length;
      const t0 = Date.now();
      await msgService.createHumanMessage(channelId, `bench 唤醒回复 ${i}`, undefined, blockedWu.id);
      const obsDeadline = Date.now() + 5_000;
      let obsAt: number | null = null;
      while (Date.now() < obsDeadline) {
        const m = getIndexMarks.slice(marksBefore)[0];
        if (m) { obsAt = m.at; break; }
        await new Promise(res => setTimeout(res, 5));
      }
      if (obsAt !== null) {
        wakeLat.push(obsAt - t0);
        console.log(`wake round ${i}: publish→observe = ${obsAt - t0}ms`);
      } else {
        console.log(`wake round ${i}: TIMEOUT (5s 无 observe)`);
      }
      // 等这一轮 observe 的后续簿记落定、loop 回 idle
      await new Promise(res => setTimeout(res, 3_000));
    }
    if (wakeLat.length > 0) console.log(`B2 唤醒延迟: ${summary(wakeLat)}`);
    }
  }

  loop.stop();
  await loop.waitForStop();
  eventBus.unsubscribeAll('channel.message_sent');
  eventBus.unsubscribeAll('workunit.created');

  console.log(`\n[bench] done. bench root kept at ${benchRoot}（手工清理）`);
  console.log('[bench] 注意：合成副本数据=生产 1x 规模快照；picked/claimed 时间戳精度 1ms（ISO）');
}

// 仅作为脚本直跑时执行（vitest import 不触发，供 __tests__ 测纯函数）
if (require.main === module) {
  main().catch(err => {
    console.error('[bench] failed:', err);
    process.exit(1);
  });
}
