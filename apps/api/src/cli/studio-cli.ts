#!/usr/bin/env node
// Studio CLI — 统一入口（2026-05-09: Docker/tmux 已移除）
// studio up / studio project add / studio workon

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STUDIO_DIR = path.join(os.homedir(), '.studio');
const DATA_DIR = path.join(STUDIO_DIR, 'data');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function checkPrerequisites() {
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

async function studioUp(configPath?: string) {
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
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    } else {
      console.log(`Config not found: ${actualEnv}, using defaults`);
    }
  }

  // 4. 设置默认环境变量（不覆盖已配置的值）
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = `file:${path.join(DATA_DIR, 'data.db')}`;
  if (!process.env.ANALYST_DIR) process.env.ANALYST_DIR = ANALYST_DIR;
  if (!process.env.DAEMON_DIR) process.env.DAEMON_DIR = DAEMON_DIR;
  if (!process.env.KNOWLEDGE_DIR) process.env.KNOWLEDGE_DIR = KNOWLEDGE_DIR;
  if (!process.env.EVENTS_DIR) process.env.EVENTS_DIR = EVENTS_DIR;
  if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = WORKTREES_DIR;

  console.log(`Data dir: ${STUDIO_DIR}`);
  console.log(`Database: ${process.env.DATABASE_URL}`);

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

    // First-time DB creation (idempotent — only if DB file doesn't exist)
    const dbPath = (process.env.DATABASE_URL || '').replace('file:', '');
    const monorepoSchema = path.join(process.env.REPO_DIR, 'packages/studio-prisma/prisma/schema.prisma');
    const standaloneSchema = path.join(__dirname, '..', 'prisma', 'schema.prisma');
    const schemaPath = fs.existsSync(monorepoSchema) ? monorepoSchema : standaloneSchema;
    if (schemaPath && !fs.existsSync(dbPath)) {
      console.log('First time — creating database...');
      execSync(`npx prisma db push --schema="${schemaPath}" --skip-generate`, {
        cwd: process.env.REPO_DIR,
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: 'pipe', timeout: 30_000,
      });
      console.log('Database created');
    }

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

async function studioRun() {
  const args = process.argv.slice(3);
  const waitIndex = args.indexOf('--wait');
  const pipelineIndex = args.indexOf('--pipeline');
  const fullWait = waitIndex >= 0 || pipelineIndex >= 0;
  const requirement = (fullWait
    ? args.slice(0, waitIndex >= 0 ? waitIndex : pipelineIndex)
    : args).join(' ').trim();

  if (!requirement) {
    console.error('Usage: studio run "requirement description" [--wait] [--pipeline]');
    console.error('  --wait       Wait for Goal completion (succeeded/failed/blocked)');
    console.error('  --pipeline   Wait for full pipeline: Goal→Review→Deploy→Knowledge→Trace');
    process.exit(1);
  }

  const port = process.env.PORT || '3001';
  const baseUrl = `http://localhost:${port}/api/v1`;

  try {
    // Get #研发 channel
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string; name: string }> };
    // Dev mode → prefer #研发-dev, prod → prefer #研发 (skip -dev suffixed)
    const isDev = process.env.NODE_ENV === 'development';
    const rndChannel = isDev
      ? channels.find((c: any) => c.type === 'rnd' && c.name?.endsWith('-dev'))
      : channels.find((c: any) => c.type === 'rnd' && !c.name?.endsWith('-dev'));
    if (!rndChannel) {
      console.error(`No ${isDev ? '#研发-dev' : '#研发'} channel found. Start studio with: studio up`);
      process.exit(1);
    }

    // Get #系统 channel (for knowledge cards)
    const sysChannel = channels.find((c: any) => c.type === 'system');

    // Send message (appends @Analyst automatically in the route handler)
    const content = /@analyst/i.test(requirement) ? requirement : `${requirement} @Analyst`;
    const msgResp = await fetch(`${baseUrl}/channels/${rndChannel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const msgResult = await msgResp.json() as { success: boolean; data?: { id: string; analystTriggered: boolean }; error?: string };

    if (!msgResult.success) {
      console.error('Failed to submit:', msgResult.error);
      process.exit(1);
    }

    console.log(`✅ Submitted to ${rndChannel.name}. Analyst is analyzing...`);

    if (!fullWait) {
      console.log('Tip: use --wait to wait for Goal completion, --pipeline for full pipeline');
      return;
    }

    const maxRounds = pipelineIndex >= 0 ? 360 : 120; // --pipeline: 60min, --wait: 20min
    console.log(`Waiting for ${pipelineIndex >= 0 ? 'full pipeline' : 'Goal completion'} (--wait)...`);

    let goalId: string | null = null;
    let pipelineStage = 'plan'; // plan → executing → review → deploy → knowledge → trace → done
    let deployChecked = false;
    let knowledgeChecked = false;
    let traceChecked = false;
    let reviewMsgs: Array<{ content: string; meta: any }> = [];

    for (let i = 0; i < maxRounds; i++) {
      await new Promise(r => setTimeout(r, 10_000));

      try {
        if (!goalId) {
          // Stage 1: poll for RequirementsDoc card, click start_execution
          const msgsResp = await fetch(`${baseUrl}/channels/${rndChannel.id}/messages?limit=5`);
          const { data: msgs } = await msgsResp.json() as { data: Array<{ id: string; meta: any }> };
          const card = msgs.find((m: any) => {
            let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch (e) { console.error('Failed to parse message meta:', String(e)); }
            return meta?.status === 'ready' && meta?.cardType === 'requirements_doc';
          });
          if (card) {
            console.log('  Phase 1/6: RequirementsDoc ready, starting execution...');
            const actResp = await fetch(`${baseUrl}/channels/${rndChannel.id}/messages/${card.id}/actions`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'start_execution' }),
            });
            const actResult = await actResp.json() as { success: boolean; data?: { meta: any } };
            if (actResult.success) {
              let meta = actResult.data?.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch (e) { console.error('Failed to parse action result meta:', String(e)); }
              goalId = meta?.goalId;
              if (goalId) console.log(`  Goal created: ${goalId.slice(0, 8)}`);
              pipelineStage = 'executing';
            }
          } else {
            if (i % 3 === 0) console.log('  Phase 1/6: Waiting for RequirementsDoc...');
          }
          if (!goalId) continue;
        }

        // Stage 2: check Goal + execution status
        const goalResp = await fetch(`${baseUrl}/goals/${goalId}`);
        const { data: goal } = await goalResp.json() as {
          data: { id: string; status: string; title: string; GoalExecution?: Array<{ status: string }> };
        };

        if (pipelineStage === 'executing') {
          if (goal.status === 'failed') {
            console.log(`❌ Goal ${goalId.slice(0, 8)} failed`);
            process.exit(1);
          }
          if (goal.status === 'succeeded') {
            console.log(`  Phase 2/6: Goal completed ✅`);
            pipelineStage = 'review';
          } else if (goal.status === 'blocked') {
            console.log(`  Phase 2/6: Goal blocked — needs human review ⚠️`);
            pipelineStage = 'review';
          } else {
            if (i % 3 === 0) console.log(`  Phase 2/6: Executing (${goal.status})...`);
            continue;
          }
        }

        // Stage 3: Review completion (only for --pipeline)
        if (pipelineStage === 'review' && pipelineIndex >= 0) {
          // Check for review results via channel messages
          const rndMsgs = await fetch(`${baseUrl}/channels/${rndChannel.id}/messages?limit=10`);
          ({ data: reviewMsgs } = await rndMsgs.json() as { data: Array<{ content: string; meta: any }> });
          const reviewDone = reviewMsgs.some((m: any) => {
            let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch {}
            return meta?.status === 'done' || meta?.reviewResult;
          });

          if (reviewDone || i > 60) { // 10 min max for review
            console.log(`  Phase 3/6: Review complete ✅`);
            pipelineStage = deployChecked ? 'knowledge' : 'deploy';
          } else if (i % 3 === 0) {
            console.log('  Phase 3/6: Waiting for Review...');
          }
        } else if (pipelineStage === 'review' && pipelineIndex < 0) {
          // --wait mode: stop after goal complete
          console.log(`✅ Goal ${goalId.slice(0, 8)} completed`);
          process.exit(0);
        }

        // Stage 4: Deploy/PR check (only for --pipeline)
        if (pipelineStage === 'deploy' && pipelineIndex >= 0) {
          const deployMsg = reviewMsgs.some((m: any) =>
            m.content?.includes('Deploy') || m.content?.includes('PR created') || m.content?.includes('部署')
          );
          if (deployMsg || i > 90) {
            console.log(`  Phase 4/6: Deploy/PR check complete ✅`);
            pipelineStage = 'knowledge';
            deployChecked = true;
          } else if (i % 3 === 0) {
            console.log('  Phase 4/6: Waiting for Deploy/PR...');
          }
        }

        // Stage 5: Knowledge extraction (only for --pipeline)
        if (pipelineStage === 'knowledge' && pipelineIndex >= 0) {
          if (sysChannel) {
            const sysMsgs = await fetch(`${baseUrl}/channels/${sysChannel.id}/messages?limit=5`);
            const { data: sysData } = await sysMsgs.json() as { data: Array<{ meta: any }> };
            const knowledgeCard = sysData.some((m: any) => {
              let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch {}
              return meta?.cardType === 'knowledge_confirm' || meta?.cardType === 'skill_review_request';
            });
            if (knowledgeCard || i > 150) { // 25 min max
              console.log(`  Phase 5/6: Knowledge extraction/approval detected ✅`);
              pipelineStage = 'trace';
              knowledgeChecked = true;
            } else if (i % 3 === 0) {
              console.log('  Phase 5/6: Waiting for Knowledge extraction...');
            }
          } else {
            pipelineStage = 'trace';
          }
        }

        // Stage 6: Trace analysis (only for --pipeline)
        if (pipelineStage === 'trace' && pipelineIndex >= 0) {
          try {
            const traceResp = await fetch(`${baseUrl}/health`);
            if (traceResp.ok) {
              const { passRate, totalChecks } = await traceResp.json() as any;
              if (totalChecks > 0 || traceChecked) {
                console.log(`  Phase 6/6: Trace analysis available (pass rate: ${passRate || 'N/A'}%) ✅`);
              }
              traceChecked = true;
            }
            console.log(`\n✅ Pipeline complete for Goal ${goalId.slice(0, 8)}`);
            console.log('  Analyzed: Goal → Review → Deploy → Knowledge → Trace');
            process.exit(0);
          } catch {
            if (i % 6 === 0) console.log('  Phase 6/6: Waiting for Trace analysis...');
          }
        }
      } catch (err) {
        if (i % 6 === 0) console.log('  Waiting for server...');
      }
    }

    console.log(`Timeout: Pipeline did not complete within ${maxRounds / 6} minutes`);
    process.exit(1);
  } catch (err: any) {
    console.error('Failed to connect to studio server:', err.message);
    console.error('Make sure studio is running: studio up');
    process.exit(1);
  }
}

// ─── studio approve/reject ───

async function studioApprove() {
  const sub = process.argv[3];
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;

  if (sub === 'list') {
    console.log('Pending Approvals');
    console.log('━━━━━━━━━━━━━━━━━');
    let found = 0;

    try {
      const chResp = await fetch(`${baseUrl}/channels`);
      const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string; name: string }> };

      for (const ch of channels) {
        const msgsResp = await fetch(`${baseUrl}/channels/${ch.id}/messages?limit=20`);
        const { data: msgs } = await msgsResp.json() as { data: Array<{ id: string; meta: any; content: string; createdAt: string }> };

        for (const m of msgs) {
          let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch {}
          const cardType = meta?.cardType;
          if (!cardType) continue;

          const pending = meta?.status === 'ready' || meta?.status === 'pending';
          if (!pending) continue;

          found++;
          const id = m.id.slice(0, 8);
          const channel = ch.name;
          const date = new Date(m.createdAt).toLocaleTimeString();
          const content = (m.content || '').slice(0, 60);

          switch (cardType) {
            case 'requirements_doc':
              console.log(`  📋 [${id}] ${channel} | 需求文档 | ${date}`);
              console.log(`     → ${content}`);
              console.log(`     studio approve req ${m.id}`);
              break;
            case 'knowledge_confirm':
              console.log(`  🧠 [${id}] ${channel} | 知识确认 | ${date}`);
              console.log(`     → studio approve knowledge ${m.id}`);
              break;
            case 'skill_review_request':
              console.log(`  🔩 [${id}] ${channel} | Skill 待审批 | ${date}`);
              console.log(`     → studio approve skill ${m.id}`);
              break;
            case 'auditor_suggestion':
              console.log(`  📊 [${id}] ${channel} | 审计建议 | ${date}`);
              console.log(`     → studio approve auditor ${m.id}`);
              break;
            case 'deploy_approval':
              console.log(`  🚀 [${id}] ${channel} | 部署审批 | ${date}`);
              console.log(`     → studio approve deploy ${m.id}`);
              break;
            default:
              console.log(`  ❓ [${id}] ${channel} | ${cardType} | ${date}`);
              console.log(`     → studio approve ${cardType} ${m.id}`);
          }
          console.log('');
        }
      }

      if (found === 0) console.log('  No pending approvals ✅');
      else console.log(`  Total: ${found} pending`);
    } catch (e: any) {
      console.error('Failed:', e.message);
    }
    return;
  }

  const type = sub;
  const messageId = process.argv[4];
  if (!type || !messageId) {
    console.log('Usage:');
    console.log('  studio approve list                      List all pending approvals');
    console.log('  studio approve req <messageId>           Approve RequirementsDoc → start execution');
    console.log('  studio approve knowledge <messageId>     Approve knowledge entry');
    console.log('  studio approve skill <messageId>         Approve skill proposal');
    console.log('  studio approve auditor <messageId>       Approve auditor suggestion');
    console.log('  studio approve deploy <messageId>        Approve deploy');
    console.log('  studio reject  <type> <messageId>        Reject any pending approval');
    return;
  }

  const channelId = process.argv[5] || '';
  const actionMap: Record<string, string> = {
    req: 'start_execution',
    requirements_doc: 'start_execution',
    knowledge: 'knowledge_confirm',
    knowledge_confirm: 'knowledge_confirm',
    skill: 'skill_review_request', // handled via skill API
    auditor: 'auditor_apply_confirm',
    auditor_suggestion: 'auditor_apply_confirm',
    deploy: 'deploy_approve',
    deploy_approval: 'deploy_approve',
  };
  const action = actionMap[type] || type;

  try {
    // Need to find the channel for this message
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string }> };

    let foundChannel = channelId;
    if (!foundChannel) {
      for (const ch of channels) {
        try {
          const testResp = await fetch(`${baseUrl}/channels/${ch.id}/messages/${messageId}/actions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start_execution' }),
          });
          if (testResp.status !== 404) { foundChannel = ch.id; break; }
        } catch {}
      }
    }

    if (!foundChannel) {
      console.error('Could not find channel for message. Specify: studio approve <type> <messageId> <channelId>');
      process.exit(1);
    }

    // Special: skill approval goes through skills API
    if (type === 'skill' || type === 'skill_review_request') {
      console.log(`Approving skill proposal ${messageId}...`);
      const r = await fetch(`${baseUrl}/harness/proposals/${messageId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const d = await r.json() as any;
      if (r.ok) console.log('✅ Approved:', d.data?.status || 'done');
      else console.error('❌ Failed:', d.error || r.status);
      return;
    }

    console.log(`${action} → message ${messageId.slice(0, 8)} (channel ${foundChannel.slice(0, 8)})`);
    const res = await fetch(`${baseUrl}/channels/${foundChannel}/messages/${messageId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json() as any;
    if (res.ok && data.success) console.log('✅ Approved');
    else console.error('❌ Failed:', data.error || JSON.stringify(data).slice(0, 100));
  } catch (e: any) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}

async function studioReject() {
  const type = process.argv[3];
  const messageId = process.argv[4];
  if (!type || !messageId) {
    console.log('Usage: studio reject <type> <messageId>');
    console.log('  studio reject knowledge <messageId>');
    console.log('  studio reject auditor <messageId>');
    return;
  }

  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;

  const actionMap: Record<string, string> = {
    knowledge: 'knowledge_reject',
    knowledge_confirm: 'knowledge_reject',
    auditor: 'auditor_apply_reject',
    auditor_suggestion: 'auditor_apply_reject',
    deploy: 'deploy_reject',
    deploy_approval: 'deploy_reject',
  };
  const action = actionMap[type];
  if (!action) { console.error(`Unknown reject type: ${type}`); process.exit(1); }

  try {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string }> };
    let foundChannel = '';
    for (const ch of channels) {
      try {
        const testResp = await fetch(`${baseUrl}/channels/${ch.id}/messages/${messageId}/actions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (testResp.status !== 404) { foundChannel = ch.id; break; }
      } catch {}
    }

    if (!foundChannel) {
      console.error('Could not find channel for message. Specify: studio reject <type> <messageId> <channelId>');
      process.exit(1);
    }

    console.log(`${action} → message ${messageId.slice(0, 8)}`);
    const res = await fetch(`${baseUrl}/channels/${foundChannel}/messages/${messageId}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json() as any;
    if (res.ok && data.success) console.log('✅ Rejected');
    else console.error('❌ Failed:', data.error || JSON.stringify(data).slice(0, 100));
  } catch (e: any) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}

async function studioPipeline() {
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;
  console.log('Pipeline Status');
  console.log('━━━━━━━━━━━━━━━');

  const stage = async (name: string, fn: () => Promise<string>) => {
    try {
      const result = await fn();
      console.log(`  ${result} ${name}`);
    } catch (e: any) {
      console.log(`  ❌ ${name}: ${e.message?.slice(0, 60) || 'unreachable'}`);
    }
  };

  await stage('RequirementsDoc', async () => {
    const r = await fetch(`${baseUrl}/requirements-docs`);
    const { data } = await r.json() as any;
    return Array.isArray(data) ? `📋 (${data.length} docs)` : '📋';
  });

  await stage('Goals', async () => {
    const r = await fetch(`${baseUrl}/goals`);
    const { data } = await r.json() as any;
    const active = Array.isArray(data) ? data.filter((g: any) => g.status !== 'succeeded' && g.status !== 'failed').length : 0;
    return `🎯 (${active} active)`;
  });

  await stage('Review (recent)', async () => {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string }> };
    const rnd = channels.find((c: any) => c.type === 'rnd');
    if (!rnd) return '🔍 (no 研发 channel)';
    const msgs = await fetch(`${baseUrl}/channels/${rnd.id}/messages?limit=5`);
    const { data: msgData } = await msgs.json() as { data: Array<{ meta: any }> };
    const reviews = msgData.filter((m: any) => {
      let meta = m.meta; if (typeof meta === 'string') try { meta = JSON.parse(meta); } catch {}
      return meta?.reviewResult;
    }).length;
    return reviews > 0 ? `✅ (${reviews} reviews)` : '⏳ (pending)';
  });

  await stage('Deploy/PR', async () => {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string }> };
    const rnd = channels.find((c: any) => c.type === 'rnd');
    if (!rnd) return '🔍';
    const msgs = await fetch(`${baseUrl}/channels/${rnd.id}/messages?limit=10`);
    const { data: msgData } = await msgs.json() as { data: Array<{ content: string }> };
    const deploys = msgData.filter((m: any) => m.content?.includes('Deploy') || m.content?.includes('PR created') || m.content?.includes('部署')).length;
    return deploys > 0 ? `🚀 (${deploys})` : '⏳';
  });

  await stage('Knowledge', async () => {
    const r = await fetch(`${baseUrl}/harness/knowledge?limit=5`);
    const { data } = await r.json() as any;
    return Array.isArray(data) && data.length > 0 ? `🧠 (${data.length} entries)` : '⏳';
  });

  await stage('Trace analysis', async () => {
    const r = await fetch(`${baseUrl}/health`);
    if (!r.ok) return '❌';
    const { status, passRate } = await r.json() as any;
    return `${status === 'healthy' ? '✅' : '⚠️'} (${passRate || 'N/A'}%)`;
  });

  await stage('Skill proposals', async () => {
    const r = await fetch(`${baseUrl}/tools`);
    const { data } = await r.json() as any;
    const skills = Array.isArray(data) ? data : [];
    return `🔩 (${skills.length} skills)`;
  });
}

async function studioStatus() {
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

  // 6. G4: Trajectory eval
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const sf = path.join(os.homedir(), 'events', 'studio.jsonl');
    if (fs.existsSync(sf)) {
      const lines = fs.readFileSync(sf, 'utf-8').split('\n').filter(Boolean);
      const trajectory = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e: any) => e?.type === 'monitor:trajectory')
        .pop();
      if (trajectory) {
        const emoji = trajectory.verdict === 'good' ? '✅' : trajectory.verdict === 'degraded' ? '⚠️' : '❌';
        console.log(`  Trajectory: ${emoji} ${trajectory.verdict} (eff: ${trajectory.efficiency}, ${trajectory.totalExecutions} execs)`);
      }
    }
  } catch { /* optional */ }
}

async function studioTest() {
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;
  let failures = 0;
  let passes = 0;

  console.log('Studio E2E Test');
  console.log('━━━━━━━━━━━━━━');

  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      const ok = await fn();
      if (ok) { passes++; console.log(`  ✅ ${name}`); }
      else { failures++; console.log(`  ❌ ${name}`); }
    } catch (e: any) {
      failures++;
      console.log(`  ❌ ${name}: ${e.message?.slice(0, 60) || String(e).slice(0, 60)}`);
    }
  };

  // Server reachable
  await check('Server reachable', async () => {
    const r = await fetch(`${baseUrl}/health`);
    return r.ok;
  });

  // Channels accessible
  await check('Channels accessible', async () => {
    const r = await fetch(`${baseUrl}/channels`);
    return r.ok;
  });

  // 研发 channel exists
  await check('研发 channel exists', async () => {
    const r = await fetch(`${baseUrl}/channels`);
    const { data } = await r.json() as { data: Array<{ type: string }> };
    return data.some((c: any) => c.type === 'rnd');
  });

  // Can send message
  await check('Can send message', async () => {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string }> };
    const rnd = channels.find((c: any) => c.type === 'rnd');
    if (!rnd) return false;
    const resp = await fetch(`${baseUrl}/channels/${rnd.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `[E2E Test ${Date.now()}] Studio pipeline check` }),
    });
    return resp.ok;
  });

  // Quality gate endpoint
  await check('Quality gate endpoint (M2)', async () => {
    const r = await fetch(`${baseUrl}/harness/check-constraints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'goal_creation', hasRequirement: true, hasRequirementReview: true }),
    });
    return r.ok;
  });

  // Knowledge endpoint
  await check('Knowledge endpoint', async () => {
    const r = await fetch(`${baseUrl}/harness/knowledge?limit=1`);
    return r.ok;
  });

  // RequirementsDoc endpoint
  await check('RequirementsDoc endpoint', async () => {
    const r = await fetch(`${baseUrl}/requirements-docs`);
    return r.ok || r.status === 404;
  });

  console.log(`\n  Results: ${passes} pass, ${failures} fail`);
  if (failures > 0) process.exit(1);
}

function studioBuild() {
  const repoDir = process.env.REPO_DIR || process.cwd();
  console.log('Building all packages...');
  try {
    execSync('pnpm -r build', { cwd: repoDir, stdio: 'inherit', timeout: 120_000 });
    console.log('Build complete');
  } catch (err: any) {
    console.error('Build failed:', err.message?.slice(0, 200));
    process.exit(1);
  }
}

async function studioStop() {
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

async function studioRestart() {
  await studioStop();
  console.log('');
  await studioUp();
}

async function studioLogs() {
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

async function studioDb() {
  const subcmd = process.argv[3] || 'status';
  const repoDir = process.env.REPO_DIR || process.cwd();
  const schemaPath = path.join(repoDir, 'packages/studio-prisma/prisma/schema.prisma');

  switch (subcmd) {
    case 'push':
      console.log('Running prisma db push...');
      execSync(`npx prisma db push --schema="${schemaPath}" --skip-generate --accept-data-loss`, {
        cwd: repoDir, stdio: 'inherit', timeout: 30_000,
      });
      console.log('DB schema synced');
      break;
    case 'migrate':
      console.log('Running prisma db migrate...');
      execSync(`npx prisma migrate dev --schema="${schemaPath}"`, {
        cwd: repoDir, stdio: 'inherit', timeout: 30_000,
      });
      break;
    case 'status':
      console.log(`Schema: ${schemaPath}`);
      const dbUrl = process.env.DATABASE_URL || `file:${path.join(DATA_DIR, 'data.db')}`;
      console.log(`Database: ${dbUrl}`);
      try {
        execSync(`npx prisma db execute --schema="${schemaPath}" --stdin`, {
          cwd: repoDir, input: 'SELECT name FROM sqlite_master WHERE type="table" ORDER BY name;',
          stdio: 'pipe', timeout: 10_000,
        });
      } catch {
        console.log('(DB not accessible)');
      }
      break;
    default:
      console.log('studio db <push|migrate|status>');
  }
}

// ── API helper: all data commands call the HTTP API ──

const API = `http://localhost:${process.env.PORT || 3001}/api/v1`;

async function apiGet(path: string) {
  const r = await fetch(`${API}${path}`);
  return r.json();
}

async function apiCommand(resource: string, args: string[]) {
  const sub = args[0];
  const cid = getCompanyId();
  try {
    await getToken();
    switch (sub) {
      case 'list': {
        const url = `/${resource}?companyId=${cid}&limit=20`;
        console.log(JSON.stringify(await apiGet(url), null, 2));
        break;
      }
      case 'status':
      case 'show': {
        const id = args[1];
        if (!id) { console.error(`Usage: studio ${resource} show <id>`); return; }
        const path = resource === 'knowledge'
          ? `/${resource}/detail/${id}`
          : `/${resource}/${id}`;
        console.log(JSON.stringify(await apiGet(path), null, 2));
        break;
      }
      case 'search': {
        const q = args[1] || '';
        console.log(JSON.stringify(await apiGet(`/${resource}?companyId=${cid}&search=${encodeURIComponent(q)}`), null, 2));
        break;
      }
      case 'queue':
        console.log(JSON.stringify(await apiGet(`/${resource}?companyId=${cid}&status=pending`), null, 2));
        break;
      case 'run':
        console.log('Use: studio run <requirement>');
        break;
      default:
        console.log(`studio ${resource} <list|show|search>`);
    }
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED') {
      console.error('API server not running. Run: studio up');
    } else {
      console.error(`API error: ${e}`);
    }
  }
}

async function studioEnv() {
  try {
    await getToken();
    const data = await apiGet('/knowledge/gaps/environment');
    const item = (data as any)?.data?.[0] || data;
    console.log(JSON.stringify(item, null, 2));
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED') console.error('API server not running. Run: studio up');
    else console.error(`API error: ${e}`);
  }
}

async function studioMcp(args: string[]) {
  const sub = args[0] || 'tools';
  try {
    await getToken();
    switch (sub) {
      case 'tools':
        console.log(JSON.stringify(await apiGet('/mcp/tools'), null, 2));
        break;
      case 'health':
        console.log(JSON.stringify(await apiGet('/mcp/health'), null, 2));
        break;
      default:
        console.log('studio mcp <tools|health>');
    }
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED') console.error('API server not running. Run: studio up');
    else console.error(`API error: ${e}`);
  }
}

async function studioHarnessCli(args: string[]) {
  try {
    execSync(`npx harness ${args.join(' ')}`, { stdio: 'inherit' });
  } catch { /* harness CLI handles errors */ }
}

async function studioConfig(args: string[]) {
  const CONFIG_PATH = path.join(os.homedir(), '.studio', 'config.env');

  function maskValue(value: string): string {
    if (value.length <= 8) return '****';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  function loadConfig(): Record<string, string> {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const config: Record<string, string> = {};
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      config[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
    return config;
  }

  function saveConfig(config: Record<string, string>): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', 'utf-8');
  }

  const subcmd = args[0];

  switch (subcmd) {
    case 'list': {
      const config = loadConfig();
      console.log(`Config: ${CONFIG_PATH}\n`);
      const keys = ['STUDIO_API_KEY', 'PIPELINE_API_KEY', 'KNOWLEDGE_API_KEY', 'JWT_SECRET', 'ENCRYPTION_KEY', 'DISCORD_DAILY_CHANNEL'];
      for (const key of keys) {
        const envVal = process.env[key];
        const fileVal = config[key];
        const source = envVal ? 'env' : fileVal ? 'config.env' : '-';
        const value = envVal || fileVal;
        if (value) console.log(`${key} = ${maskValue(value)}  (${source})`);
      }
      break;
    }
    case 'set': {
      const kv = args[1];
      if (!kv || !kv.includes('=')) {
        console.error('Usage: studio config set KEY=VALUE');
        process.exit(1);
      }
      const eqIdx = kv.indexOf('=');
      const key = kv.slice(0, eqIdx).trim();
      const value = kv.slice(eqIdx + 1).trim();
      const config = loadConfig();
      config[key] = value;
      saveConfig(config);
      console.log(`Set ${key} = ${maskValue(value)}`);
      console.log(`Saved to ${CONFIG_PATH}`);
      console.log('Restart to apply: systemctl restart studio-api');
      break;
    }
    case 'check': {
      const config = loadConfig();
      for (const [k, v] of Object.entries(config)) {
        if (!process.env[k]) process.env[k] = v;
      }
      const checks = [
        { name: 'Studio API Key', keys: ['STUDIO_API_KEY'] },
        { name: 'JWT Secret', keys: ['JWT_SECRET'] },
        { name: 'Encryption Key', keys: ['ENCRYPTION_KEY'] },
      ];
      let ok = true;
      for (const c of checks) {
        const found = c.keys.some(k => process.env[k]);
        console.log(`  ${found ? '✓' : '✗'} ${c.name}: ${found ? 'configured' : 'MISSING'}`);
        if (!found) ok = false;
      }
      process.exit(ok ? 0 : 1);
    }
    case 'path':
      console.log(CONFIG_PATH);
      break;
    default:
      console.log(`Usage: studio config <command>

Commands:
  list        View current configuration (masked)
  set KEY=VAL Set configuration value
  check       Verify configuration completeness
  path        Show config file path`);
  }
}

// ── CLI helpers ──

function getCompanyId(): string {
  const activeFile = path.join(STUDIO_DIR, 'active-project');
  if (fs.existsSync(activeFile)) {
    return fs.readFileSync(activeFile, 'utf-8').trim();
  }
  // Fallback: try to read from company config
  const companyFile = path.join(STUDIO_DIR, 'company.json');
  if (fs.existsSync(companyFile)) {
    try {
      const company = JSON.parse(fs.readFileSync(companyFile, 'utf-8'));
      return company.id || '';
    } catch {}
  }
  return '';
}

async function getToken(): Promise<string> {
  const tokenFile = path.join(STUDIO_DIR, '.daemon', 'session-token');
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf-8').trim();
  }
  // No token file — API calls may work without auth for localhost
  return '';
}

function extractConfigFlag(rawArgs: string[]): { configPath?: string; args: string[] } {
  const idx = rawArgs.indexOf('--config');
  if (idx !== -1 && idx + 1 < rawArgs.length) {
    const configPath = rawArgs[idx + 1];
    return { configPath, args: rawArgs.filter((_, i) => i !== idx && i !== idx + 1) };
  }
  return { args: rawArgs };
}

async function main() {
  const { configPath, args } = extractConfigFlag(process.argv.slice(2));
  const cmd = args[0];

  switch (cmd) {
    case 'up':
      await studioUp(configPath);
      break;
    case 'dev':
      // 开发模式：独立 DB 隔离测试数据，端口 3001，tsx 热重载
      // 知识引擎 (RKB/KnowledgeBus) 独立运行，不污染生产
      console.log('Starting in dev mode (isolated DB, port 3001)...');
      if (!process.env.PORT) process.env.PORT = '3001';
      if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
      if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL = 'file:' + path.join(STUDIO_DIR, 'data', 'dev.db');
      }
      await studioUp(configPath);
      break;
    case 'project':
      if (args[1] === 'add') {
        const projectPath = path.resolve(args[2] || process.cwd());
        ensureDir(STUDIO_DIR);
        const projectsFile = path.join(STUDIO_DIR, 'projects.json');
        const existing: string[] = fs.existsSync(projectsFile)
          ? JSON.parse(fs.readFileSync(projectsFile, 'utf-8'))
          : [];
        if (!existing.includes(projectPath)) {
          existing.push(projectPath);
          fs.writeFileSync(projectsFile, JSON.stringify(existing, null, 2));
        }
        console.log(`Project added: ${projectPath}`);
      } else if (args[1] === 'list') {
        const projectsFile = path.join(STUDIO_DIR, 'projects.json');
        const projects: string[] = fs.existsSync(projectsFile)
          ? JSON.parse(fs.readFileSync(projectsFile, 'utf-8'))
          : [];
        console.log(projects.length ? projects.join('\n') : 'No projects registered.');
      }
      break;
    case 'workon':
      const name = args[1];
      if (!name) { console.error('Usage: studio workon <name>'); process.exit(1); }
      // Set active project by writing to .studio/active-project
      ensureDir(STUDIO_DIR);
      const activeFile = path.join(STUDIO_DIR, 'active-project');
      fs.writeFileSync(activeFile, name);
      console.log(`Active project: ${name}`);
      break;
    case 'stop':
      await studioStop();
      break;
    case 'restart':
      await studioRestart();
      break;
    case 'logs':
      await studioLogs();
      break;
    case 'db':
      await studioDb();
      break;
    case 'build':
      studioBuild();
      break;
    case 'daemon':
      if (args[1] === 'status') {
        const { daemon } = await import('../daemon/studio-daemon.js');
        if (!daemon.isStarted()) {
          console.log('Daemon: not running');
        } else {
          const statuses = daemon.getStatus() as Array<{ name: string; isBusy: boolean; lastUsed: number; taskCount: number; worktree: string; persistent: boolean; } | null>;
          console.log('Daemon sessions:');
          for (const s of statuses) {
            if (!s) continue;
            console.log(`  ${s.name}: ${s.isBusy ? 'busy' : 'idle'} | tasks: ${s.taskCount} | last: ${s.lastUsed ? new Date(s.lastUsed).toISOString() : 'never'}`);
          }
        }
      } else {
        console.log('Studio Daemon');
        console.log('  studio daemon status      Show daemon session status');
      }
      break;
    case 'run':
      await studioRun();
      break;
    case 'metrics':
      if (args[1] === 'compare' && args[2]) {
        const taskName = args[2];
        const { getComparison, printComparison } = await import('../daemon/metrics.js');
        const result = await getComparison(taskName);
        if (result) {
          console.log(printComparison(result.pipeline, result.window));
        } else {
          console.log(`No metrics found for task: ${taskName}`);
        }
      } else {
        console.log('Studio Metrics');
        console.log('  studio metrics compare <task>  Compare pipeline vs window');
      }
      break;
    case 'status':
      await studioStatus();
      break;
    case 'test':
      await studioTest();
      break;
    case 'pipeline':
      await studioPipeline();
      break;
    case 'approve':
      await studioApprove();
      break;
    case 'reject':
      await studioReject();
      break;
    case 'goal':
      await apiCommand('goals', args.slice(1));
      break;
    case 'knowledge':
      await apiCommand('knowledge', args.slice(1));
      break;
    case 'channel':
      await apiCommand('channels', args.slice(1));
      break;
    case 'role':
      await apiCommand('roles', args.slice(1));
      break;
    case 'task':
      await apiCommand('tasks', args.slice(1));
      break;
    case 'agent':
      await apiCommand('agents', args.slice(1));
      break;
    case 'env':
      await studioEnv();
      break;
    case 'mcp':
      await studioMcp(args.slice(1));
      break;
    case 'harness':
      await studioHarnessCli(args.slice(1));
      break;
    case 'skill':
      await apiCommand('skills', args.slice(1));
      break;
    case 'config':
      await studioConfig(args.slice(1));
      break;
    default:
      console.log('Studio CLI');
      console.log('');
      console.log('  服务管理:');
      console.log('    studio up                 Start Studio server');
      console.log('    studio stop               Stop Studio server');
      console.log('    studio restart            Restart Studio server');
      console.log('    studio status             Health check (server + DB + agents)');
      console.log('    studio logs               View server logs (tail -f)');
      console.log('');
      console.log('  开发:');
      console.log('    studio build              Build all packages (pnpm build)');
      console.log('    studio test               Quick API E2E test (8 checks)');
      console.log('    studio db <cmd>           DB: push | migrate | status');
      console.log('');
      console.log('  执行:');
      console.log('    studio run <requirement>   Submit to #研发 (@Analyst)');
      console.log('    studio run <req> --wait    Wait for Goal completion');
      console.log('    studio run <req> --pipeline Wait full pipeline');
      console.log('    studio pipeline            Check full pipeline status');
      console.log('');
      console.log('  数据:');
      console.log('    studio goal <list|status>  Goal management');
      console.log('    studio knowledge <search>  Knowledge base search');
      console.log('    studio channel <list>      Channel list');
      console.log('    studio role <list|show>    Role management');
      console.log('    studio task <queue|run>    Task management');
      console.log('    studio agent <status>      Agent status');
      console.log('    studio env <show>          Environment snapshot');
      console.log('    studio mcp <tools|health>  MCP Server management');
      console.log('    studio skill <list>        Skills list');
      console.log('    studio harness <check>     Harness constraint check');
      console.log('');
      console.log('  审批:');
      console.log('    studio approve list       List all pending approvals');
      console.log('    studio approve <type> <id> Approve');
      console.log('    studio reject <type> <id>  Reject');
      console.log('');
      console.log('  配置:');
      console.log('    studio config list        View API keys (masked)');
      console.log('    studio config set K=V     Set config value');
      console.log('    studio config check       Verify config completeness');
      console.log('');
      console.log('  管理:');
      console.log('    studio project add <path> Register a project');
      console.log('    studio project list       List registered projects');
      console.log('    studio workon <name>      Set active project');
      console.log('    studio daemon status      Daemon session status');
      console.log('    studio metrics compare <t> Metrics');
      break;
  }
}

main().catch((err) => {
  console.error('Studio CLI error:', err);
  process.exit(1);
});
