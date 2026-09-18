// ── 服务管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio up / dev / status / stop / restart / logs / db

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { STUDIO_DIR } from './shared.js';
import { ensureDataDirs, ensureDaemonSecrets } from './bootstrap.js';
import { defaultKnowledgeDir } from '../utils/runtime-paths.js';
import { scanAllProviders, KNOWN_PROVIDERS, type DetectedRuntime } from '../daemon/cli-scanner.js';
import { resolvePort, explicitPortFromEnv } from './port-probe.js';
import { resolveListenHost } from '../utils/listen-host.js';

// ESM 形态（esbuild bundle / tsc ESNext）无 CJS __dirname，与 app.ts 同法自取
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// #573 漂移修正（摸底 Q5）：agent CLI 检查对齐 provider 注册表扫描（覆盖全部
// 内置 provider），不再硬编码 claude；缺失不阻断，仅警告（契约 §7 语义）。
// providers 可注入以便测试。
export function checkPrerequisites(providers: DetectedRuntime[] = scanAllProviders()) {
  const missing: string[] = [];
  try { execSync('git --version', { stdio: 'pipe' }); } catch { missing.push('git'); }
  if (providers.length === 0) {
    missing.push(`agent CLI（注册表扫描 ${KNOWN_PROVIDERS.join('/')} 均无命中；至少需要一个 agent CLI 才能跑执行）`);
  }
  if (missing.length > 0) {
    console.error(`Missing prerequisites: ${missing.join(', ')}`);
    console.error('Install them before running studio up.');
  }
}

export async function studioUp(configPath?: string) {
  console.log('Studio starting...');

  // 1. 确保数据目录（#571：共用 bootstrap；events/ ensureDir 已随契约 §8 收编移除）
  ensureDataDirs(STUDIO_DIR);
  const ANALYST_DIR = path.join(STUDIO_DIR, '.analyst');
  const DAEMON_DIR = path.join(STUDIO_DIR, '.daemon');
  const WORKTREES_DIR = path.join(STUDIO_DIR, 'worktrees');

  // 2. 自动生成密钥（必须在加载 .env 之前，避免 .env 中的占位值覆盖生成的密钥）
  ensureDaemonSecrets(DAEMON_DIR);

  // 3. 加载配置（--config 参数 或 STUDIO_CONFIG_DIR 环境变量 或 默认路径）
  // 注：密钥先生成再加载 .env — .env 中的 JWT_SECRET 占位值不会覆盖已生成的密钥
  const configDir = configPath || process.env.STUDIO_CONFIG_DIR;
  if (configDir) {
    const envFile = path.resolve(configDir, configDir.endsWith('.env') ? '' : '.env');
    const actualEnv = configDir.endsWith('.env') ? configDir : envFile;
    if (fs.existsSync(actualEnv)) {
      console.log(`Loading config: ${actualEnv}`);
      const envContent = fs.readFileSync(actualEnv, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const raw = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
        const eqIdx = raw.indexOf('=');
        if (eqIdx === -1) continue;
        const key = raw.slice(0, eqIdx).trim();
        const val = raw.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    } else {
      console.log(`Config not found: ${actualEnv}, using defaults`);
    }
  }

  // 4. 设置默认环境变量（不覆盖已配置的值）
  // DATABASE_URL removed (Spec 4 Phase 4) — FileStore only
  if (!process.env.ANALYST_DIR) process.env.ANALYST_DIR = ANALYST_DIR;
  if (!process.env.DAEMON_DIR) process.env.DAEMON_DIR = DAEMON_DIR;
  // KNOWLEDGE_DIR = harness hook 知识目录（非 FileKnowledgeStore 的 data 根 knowledge/），
  // 缺省归数据根 harness-knowledge（#571 / 契约 §8）；events/ 双口径已收编，不再注入 EVENTS_DIR
  if (!process.env.KNOWLEDGE_DIR) process.env.KNOWLEDGE_DIR = defaultKnowledgeDir();
  if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = WORKTREES_DIR;

  console.log(`Data dir: ${STUDIO_DIR}`);

  // 检查前置依赖
  checkPrerequisites();

  // REPO_DIR: 自动推断项目根（从 CWD 向上找包含 package.json 的目录）
  if (!process.env.REPO_DIR) {
    let dir = process.cwd();
    while (dir !== '/') {
      try {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
          process.env.REPO_DIR = dir;
          break;
        }
      } catch (e) {
        console.error('Failed to check package.json:', String(e));
      }
      dir = path.dirname(dir);
    }
    if (!process.env.REPO_DIR) process.env.REPO_DIR = process.cwd();
  }
  console.log(`Project root: ${process.env.REPO_DIR}`);

  // 端口（#573 契约 §7 单口径）：PORT 显式指定占用即拒启；缺省 3001 起动态
  // 顺延（上限 +100），顺延结果在日志标明实际端口。原 ops preflight lsof
  // abort 语义收编为此处分支。
  const host = resolveListenHost(process.env);
  let port: number;
  try {
    const resolved = await resolvePort({ host, explicitPort: explicitPortFromEnv(undefined) });
    port = resolved.port;
    if (resolved.shiftedFrom !== null) {
      console.log(`Port ${resolved.shiftedFrom} in use — shifted to ${port}（动态顺延）`);
    }
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  process.env.PORT = String(port);

  // ── Ops Pre-flight Guard ──
  // 存储/前端产物/进程/磁盘等启动检查；端口检查已收编 cli/port-probe（#573）
  try {
    const { createOpsService } = await import('../modules/agents/ops/ops.service.js');
    const ops = createOpsService(port);
    const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
    const preflight = await ops.preflight(process.env.REPO_DIR, frontendDist);

    if (!preflight.passed) {
      console.error('\nServer start ABORTED. Fix the issues and re-run: studio up\n');
      process.exit(1);
    }

    // FileStore auto-creates directories on first write (Spec 4 Phase 4)

    const defaults = await ops.ensureDefaults();
    console.log(`Defaults: ${defaults.channels} channels, admin ${defaults.admin ? 'exists' : 'created'}`);
  } catch (err: any) {
    console.error('Pre-flight failed:', err.message?.slice(0, 200));
  }

  // 启动服务器（index.ts auto-starts on import）
  console.log('Starting server...');
  await import('../index.js');
}

export async function studioStatus() {
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;

  console.log('Studio Status');
  console.log('━━━━━━━━━━━━━');

  // 1. Server check
  try {
    const serverRes = await fetch(`${baseUrl}/health`);
    if (serverRes.ok) {
      const health = await serverRes.json() as any;
      console.log(`  Server:    ✅ running (port ${port})`);
      console.log(`  Health:    ${health.status || 'ok'}`);
    } else {
      console.log(`  Server:    ❌ returned ${serverRes.status}`);
    }
  } catch {
    console.log(`  Server:    ❌ not reachable (port ${port})`);
    console.log('  Start with: studio up');
    return;
  }

  // 2. Channel check
  try {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ name: string; type: string }> };
    console.log(`  Channels:  ${channels.length} (${channels.map((c: any) => c.type).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(', ')})`);
  } catch {
    console.log('  Channels:  ❌');
  }

  // 3. Agent list
  try {
    const agentResp = await fetch(`${baseUrl}/agents`);
    const { data: agents } = await agentResp.json() as { data: Array<{ type: string; name: string }> };
    console.log(`  Agents:    ${agents.length} (${agents.map((a: any) => a.type).join(', ') || 'none'})`);
  } catch {
    console.log('  Agents:    ❌');
  }

  // 4. G5: Model routing history
  try {
    const r = await fetch(`${baseUrl}/metrics/routing`);
    const { data: routes } = await r.json() as { data: Array<{ time: string; classified: string; final: string; taskType: string }> };
    if (routes.length > 0) {
      console.log(`  Routing:   ${routes.length} recent decisions`);
      for (const rt of routes.slice(-3)) {
        const indicator = rt.classified !== rt.final ? '🔧' : '🤖';
        console.log(`    ${indicator} ${rt.taskType}: auto→${rt.classified}, final→${rt.final}`);
      }
    }
  } catch { /* optional */ }

  // 5. G4: Trajectory eval（D18: 统一事件文件，StudioEvent 形态）
  try {
    const fs = await import('fs');
    const { resolveStudioEventsFile, parseStudioEventPayload } = await import('../utils/studio-events.js');
    const sf = resolveStudioEventsFile();
    if (fs.existsSync(sf)) {
      const lines = fs.readFileSync(sf, 'utf-8').split('\n').filter(Boolean);
      const trajectory = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e: any) => e?.type === 'monitor:trajectory')
        .map((e: any) => ({ ...(parseStudioEventPayload(e) ?? {}), ...e }))
        .pop();
      if (trajectory) {
        const emoji = trajectory.verdict === 'good' ? '✅' : trajectory.verdict === 'degraded' ? '⚠️' : '❌';
        console.log(`  Trajectory: ${emoji} ${trajectory.verdict} (eff: ${trajectory.efficiency}, ${trajectory.totalExecutions} execs)`);
      }
    }
  } catch { /* optional */ }
}

export async function studioStop() {
  const port = parseInt(process.env.PORT || '3001');
  let killed = false;
  try {
    const used = execSync(`lsof -ti:${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
    if (used) {
      console.log(`Stopping server on port ${port} (PIDs: ${used.split('\n').join(', ')})...`);
      for (const pid of used.split('\n')) {
        try { execSync(`kill ${pid} 2>/dev/null`); } catch {}
      }
      killed = true;
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {}
  // Also stop vite dev server
  const webPort = process.env.VITE_PORT || '13000';
  try {
    const webPid = execSync(`lsof -ti:${webPort} 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
    if (webPid) {
      for (const pid of webPid.split('\n')) {
        try { execSync(`kill ${pid} 2>/dev/null`); } catch {}
      }
      killed = true;
    }
  } catch {}
  if (killed) console.log('Server stopped');
  else console.log(`No server found on port ${port}`);
}

export async function studioRestart() {
  await studioStop();
  console.log('');
  await studioUp();
}

export async function studioLogs() {
  const port = parseInt(process.env.PORT || '3001');
  const logFile = `/tmp/studio-api-prod.log`;
  const devLogFile = (process.env.PORT === '13001' ? null : `/tmp/studio-api-dev.log`);
  const checkedFiles = [logFile];
  if (devLogFile) checkedFiles.push(devLogFile);

  let found = false;
  for (const f of checkedFiles) {
    try {
      execSync(`test -f ${f}`); found = true;
      console.log(`=== ${f} (last 30 lines) ===`);
      execSync(`tail -30 ${f}`, { stdio: 'inherit' });
    } catch {}
  }
  if (!found) {
    // Check for our test log
    try { execSync(`test -f /tmp/studio-api-test.log`); found = true;
      execSync(`tail -30 /tmp/studio-api-test.log`, { stdio: 'inherit' });
    } catch {}
    if (!found) console.log('No log files found. Server may not have been started via studio up.');
  }
}

// studio db command removed (Spec 4 Phase 4) — Prisma eliminated, use FileStore
export async function studioDb() {
  console.log('DB commands removed — all data is stored in ~/.studio/ via FileStore.');
}
