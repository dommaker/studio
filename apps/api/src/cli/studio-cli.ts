#!/usr/bin/env node
// Studio CLI — 统一入口（2026-05-09: Docker/tmux 已移除）
// studio up / studio project add / studio workon
// 2026-07-20: 按命令域拆分子模块（shared/server/dev/workflow/data/config/admin），本文件保留入口/分发/门面

import { extractConfigFlag } from './shared.js';
import { studioUp, studioStatus, studioStop, studioRestart, studioLogs, studioDb } from './server.js';
import { studioTest, studioBuild } from './dev.js';
import { studioRun, studioApprove, studioReject } from './workflow.js';
import { apiCommand, studioEnv, studioMcp, studioHarnessCli } from './data.js';
import { studioConfig } from './config.js';
import { studioDaemonStart, studioDaemonStatus, studioProject, studioWorkon } from './admin.js';

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
      // FileStore auto-creates directories — no DB needed
      await studioUp(configPath);
      break;
    case 'project':
      studioProject(args.slice(1));
      break;
    case 'workon':
      studioWorkon(args[1]);
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
      if (args[1] === 'start') {
        await studioDaemonStart();
      } else if (args[1] === 'status') {
        await studioDaemonStatus();
      } else {
        console.log('Studio Daemon');
        console.log('  studio daemon start       Register workspace with server');
        console.log('  studio daemon status      Show daemon session status');
      }
      break;
    case 'run':
      await studioRun();
      break;
    case 'status':
      await studioStatus();
      break;
    case 'test':
      await studioTest();
      break;
    case 'approve':
      await studioApprove();
      break;
    case 'reject':
      await studioReject();
      break;
    case 'knowledge':
      await apiCommand('knowledge', args.slice(1));
      break;
    case 'channel':
      await apiCommand('channels', args.slice(1));
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
      console.log('');
      console.log('  执行:');
      console.log('    studio run <requirement>   Submit to #研发 (@Analyst)');
      console.log('');
      console.log('  数据:');
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
      console.log('    studio daemon start       Register workspace with server');
      console.log('    studio daemon status      Daemon session status');
      break;
  }
}

main().catch((err) => {
  console.error('Studio CLI error:', err);
  process.exit(1);
});
