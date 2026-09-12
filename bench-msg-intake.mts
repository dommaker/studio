/**
 * #506 走查①「消息进」bench：POST /:id/messages 请求路径各嫌疑点量化。
 *
 * 用法（主 checkout 只读，数据写 tmp）：
 *   /root/projects/studio/node_modules/.bin/tsx bench-msg-intake.ts
 *
 * 测量分区：
 *   A. git ls-files 子进程成本（嫌疑点⑧核心，file-ref-vocabulary.ts:130-160）
 *   B. validateFileRefs 端到端（真实 ~/.studio 只读；候选集 = #研发 defaultPath=/root/projects/studio）
 *   C. appendMessage 写路径（tmp FileStore：flock + append + 压实评估）
 *   D. commitSnapshot 建单成本（tmp，index 规模对齐真实 49 快照）
 *   E. 附件上传同步 CPU（8MB JSON.parse + 6.7MB base64 decode，事件循环阻塞）
 *   F. getMessageById 全频道扫描（reply 路径，真实数据只读）
 *   G. queryMessages（合并窗口路径，真实数据只读）
 *   H. 鉴权 readJson sessions/users（真实文件只读；sessions.json 592KB/966 条）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR ?? path.join(os.homedir(), '.studio', 'data');

const SHARED = '/root/projects/studio/packages/studio-shared/src';
const CHANNELS = '/root/projects/studio/apps/api/src/modules/channels';

const { FileStore } = await import(`${SHARED}/file-store.ts`);
const { validateFileRefs, computeCandidateRepos, invalidateFileRefVocabularyCache } =
  await import(`${CHANNELS}/file-ref-vocabulary.ts`);

function stats(name: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  console.log(
    `${name}  n=${s.length}  min=${s[0].toFixed(2)}ms  p50=${p(0.5).toFixed(2)}ms  ` +
    `p95=${p(0.95).toFixed(2)}ms  max=${s[s.length - 1].toFixed(2)}ms  mean=${(sum / s.length).toFixed(2)}ms`,
  );
}

async function timeIt(name: string, fn: () => Promise<unknown> | unknown, n: number): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  stats(name, samples);
}

function gitLsFiles(repo: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-files'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean));
    });
  });
}

// ─── A. git ls-files 子进程（嫌疑点⑧） ───
console.log('\n=== A. git ls-files（repo=/root/projects/studio）===');
const files = await gitLsFiles('/root/projects/studio');
console.log(`ls-files 条目数: ${files.length}`);
await timeIt('A git-ls-files warm（OS page cache 热）', () => gitLsFiles('/root/projects/studio'), 30);

// ─── B. validateFileRefs 端到端（真实数据只读） ───
console.log('\n=== B. file-ref 校验（#研发频道，真实 ~/.studio 只读）===');
const CHANNEL_ID = '70668707-e9bc-4da7-8443-c35bd3d84646'; // #研发，defaultPath=/root/projects/studio
invalidateFileRefVocabularyCache();
{
  const t0 = performance.now();
  const repos = await computeCandidateRepos(CHANNEL_ID);
  console.log(`B computeCandidateRepos cold: ${(performance.now() - t0).toFixed(2)}ms  repos=${JSON.stringify(repos)}`);
}
await timeIt('B computeCandidateRepos warm', () => computeCandidateRepos(CHANNEL_ID), 20);
const REF = [{ repo: '/root/projects/studio', path: 'package.json' }];
invalidateFileRefVocabularyCache();
{
  const t0 = performance.now();
  const r = await validateFileRefs(CHANNEL_ID, REF);
  console.log(`B validateFileRefs cold（cache miss → git ls-files 在请求路径）: ${(performance.now() - t0).toFixed(2)}ms  kept=${r.kept.length} dropped=${r.dropped.length}`);
}
await timeIt('B validateFileRefs warm（60s TTL 内）', () => validateFileRefs(CHANNEL_ID, REF), 20);

// ─── C. appendMessage 写路径（tmp） ───
console.log('\n=== C. appendMessage（tmp FileStore）===');
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-intake-c-'));
{
  const fsC = new FileStore(tmpC);
  await fsC.createChannel({ id: 'ch1', name: '#t', type: 'rnd' } as never);
  const mkMsg = (i: number) => ({
    id: `m${i}`, channelId: 'ch1', authorType: 'human', agentName: null,
    content: `bench message ${i}`, replyToId: null, meta: '{}', workUnitId: null,
    createdAt: new Date().toISOString(),
  });
  await timeIt('C appendMessage（flock+append+压实评估）', () => fsC.appendMessage('ch1', mkMsg(Math.random())) as Promise<void>, 200);
}

// ─── D. commitSnapshot 建单成本（index 49 快照对齐真实） ───
console.log('\n=== D. commitSnapshot（tmp，index=49 快照对齐真实 ~/.studio）===');
const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-intake-d-'));
{
  const fsD = new FileStore(tmpD);
  const now = new Date().toISOString();
  const seed = Array.from({ length: 49 }, (_, i) => ({
    id: `wu-seed-${i}`, scope: `seed ${i}`, channelId: 'ch1', type: 'task',
    status: 'active', assigneeId: 'a1', reqId: null, metadata: '{}',
    createdAt: now, updatedAt: now,
  }));
  fs.mkdirSync(path.join(tmpD, 'workunits'), { recursive: true });
  fs.writeFileSync(path.join(tmpD, 'workunits', 'index.json'), JSON.stringify(seed, null, 2));
  await timeIt('D commitSnapshot（flock+appendEvent+全量 index 重写+fsync）', async () => {
    const id = `wu-${Math.random()}`;
    const snap = { id, scope: 'bench', channelId: 'ch1', type: 'task', status: 'unassigned', assigneeId: null, reqId: null, metadata: '{}', createdAt: now, updatedAt: now };
    await fsD.commitSnapshot({ type: 'created', wuId: id, timestamp: now, data: snap as never }, snap as never);
  }, 50);
}

// ─── E. 附件上传同步 CPU（事件循环阻塞量） ───
console.log('\n=== E. 附件上传同步 CPU（5MB 图上界）===');
{
  const raw = Buffer.alloc(5 * 1024 * 1024, 0xab);
  const b64 = raw.toString('base64');
  const body = JSON.stringify({ mime: 'image/png', dataBase64: b64 });
  console.log(`body 大小: ${(body.length / 1024 / 1024).toFixed(2)}MB（json limit 8mb）`);
  await timeIt('E JSON.parse(8MB body)', () => JSON.parse(body), 20);
  await timeIt('E Buffer.from base64 decode（6.7MB→5MB）', () => Buffer.from(b64, 'base64'), 20);
}

// ─── F/G/H. 真实数据只读 ───
console.log('\n=== F/G/H. 真实 ~/.studio 只读 ===');
{
  const fsR = new FileStore(); // STUDIO_DATA_DIR=~/.studio/data
  const bigChannel = 'sys-1785722554417-mnre'; // messages.jsonl 492 行 / 272KB，本机最大频道
  const lastId = '94b05bf9-0d1a-490c-b0da-924d906360f0';
  {
    const t0 = performance.now();
    const r = await fsR.getMessageById(lastId);
    console.log(`F getMessageById cold（扫全部频道 messages.jsonl）: ${(performance.now() - t0).toFixed(2)}ms  found=${!!r}`);
  }
  await timeIt('F getMessageById warm（jsonlCache 命中）', () => fsR.getMessageById(lastId), 20);
  await timeIt('G queryMessages(human,limit=20) 合并窗口读', () => fsR.queryMessages(bigChannel, { authorType: 'human', limit: 20 }), 20);
  const SESSIONS = path.join(os.homedir(), '.studio', 'sessions.json');
  const USERS = path.join(os.homedir(), '.studio', 'users.json');
  {
    const t0 = performance.now();
    await fsR.readJson(SESSIONS);
    console.log(`H readJson sessions.json cold（592KB/966 条）: ${(performance.now() - t0).toFixed(2)}ms`);
  }
  await timeIt('H readJson sessions.json warm（含 structuredClone）', () => fsR.readJson(SESSIONS), 50);
  await timeIt('H readJson users.json warm', () => fsR.readJson(USERS), 50);
}

console.log(`\ntmp roots kept: ${tmpC} ${tmpD}（手工清理）`);
