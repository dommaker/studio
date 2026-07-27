// ── 服务管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio up / dev / status / stop / restart / logs / db

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR, DATA_DIR, ensureDir } from './shared.js';

export function checkPrerequisites() {
  const missing: string[] = [];
  try { execSync('git --version', { stdio: 'pipe' }); } catch { missing.push('git'); }
  try {
    const out = execSync('claude --version 2>&1 || echo "NOT_FOUND"', { encoding: 'utf-8', stdio: 'pipe' });
    if (out.includes('NOT_FOUND')) missing.push('claude CLI');
  } catch { missing.push('claude CLI'); }
  if (missing.length > 0) {
    console.error(`Missing prerequisites: ${missing.join(', ')}`);
    console.error('Install them before running studio up.');
  }
}

export async function studioUp(configPath?: string) {
  console.log('Studio starting...');

  // 1. 确保数据目录
  ensureDir(STUDIO_DIR);
  ensureDir(DATA_DIR);
  const ANALYST_DIR = path.join(STUDIO_DIR, '.analyst');
  const DAEMON_DIR = path.join(STUDIO_DIR, '.daemon');
  const KNOWLEDGE_DIR = path.join(STUDIO_DIR, 'knowledge');
  const EVENTS_DIR = path.join(STUDIO_DIR, 'events');
  const WORKTREES_DIR = path.join(STUDIO_DIR, 'worktrees');
  ensureDir(ANALYST_DIR);
  ensureDir(DAEMON_DIR);
  ensureDir(KNOWLEDGE_DIR);
  ensureDir(EVENTS_DIR);
  ensureDir(WORKTREES_DIR);

  // 2. 自动生成密钥（必须在加载 .env 之前，避免 .env 中的占位值覆盖生成的密钥）
  if (!process.env.JWT_SECRET) {
    const jwtFile = path.join(DAEMON_DIR, 'jwt-secret');
    if (fs.existsSync(jwtFile)) {
      process.env.JWT_SECRET = fs.readFileSync(jwtFile, 'utf-8').trim();
    } else {
      const secret = require('crypto').randomBytes(32).toString('hex');
      fs.writeFileSync(jwtFile, secret, 'utf-8');
      process.env.JWT_SECRET = secret;
      console.log('Generated JWT_SECRET (stored in ~/.studio/.daemon/jwt-secret)');
    }
  }
  if (!process.env.ENCRYPTION_KEY) {
    const encFile = path.join(DAEMON_DIR, 'encryption-key');
    if (fs.existsSync(encFile)) {
      process.env.ENCRYPTION_KEY = fs.readFileSync(encFile, 'utf-8').trim();
    } else {
      const encKey = require('crypto').randomBytes(32).toString('hex');
      fs.writeFileSync(encFile, encKey, 'utf-8');
      process.env.ENCRYPTION_KEY = encKey;
      console.log('Generated ENCRYPTION_KEY (stored in ~/.studio/.daemon/encryption-key)');
    }
  }

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
  if (!process.env.KNOWLEDGE_DIR) process.env.KNOWLEDGE_DIR = KNOWLEDGE_DIR;
  if (!process.env.EVENTS_DIR) process.env.EVENTS_DIR = EVENTS_DIR;
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

  const port = parseInt(process.env.PORT || '3001');

  // ── Ops Pre-flight Guard ──
  // Replace old --accept-data-loss db push + port check with full pre-flight
  try {
    const { createOpsAgent } = await import('../modules/agents/ops-agent.service.js');
    const ops = createOpsAgent(port);
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

  if (!process.env.MODEL_TIER_FAST) process.env.MODEL_TIER_FAST = 'deepseek-v4-flash';
  if (!process.env.MODEL_TIER_STANDARD) process.env.MODEL_TIER_STANDARD = 'deepseek-v4-flash';
  if (!process.env.MODEL_TIER_PREMIUM) process.env.MODEL_TIER_PREMIUM = 'deepseek-v4-pro[1m]';

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

  // 4. Daemon status
  try {
    const { daemon } = await import('../daemon/studio-daemon.js');
    if (daemon.isStarted()) {
      const statuses = daemon.getStatus() as Array<{ name: string; isBusy: boolean; taskCount: number } | null>;
      const active = statuses.filter(s => s).length;
      console.log(`  Daemon:    ✅ (${active} sessions)`);
    } else {
      console.log('  Daemon:    not started');
    }
  } catch (e) {
    console.log('  Daemon:    ❌', String(e).slice(0, 80));
  }

  // 5. G5: Model routing history
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

  // 6. G4: Trajectory eval（D18: 统一事件文件，StudioEvent 形态）
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
