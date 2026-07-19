// ── 数据域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio knowledge / channel / task / agent / skill / env / mcp / harness
// ── API helper: all data commands call the HTTP API ──

import { execSync } from 'child_process';
import { getCompanyId, getToken } from './shared.js';

const API = `http://localhost:${process.env.PORT || 3001}/api/v1`;

async function apiGet(path: string) {
  const r = await fetch(`${API}${path}`);
  return r.json();
}

export async function apiCommand(resource: string, args: string[]) {
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

export async function studioEnv() {
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

export async function studioMcp(args: string[]) {
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

export async function studioHarnessCli(args: string[]) {
  try {
    execSync(`npx harness ${args.join(' ')}`, { stdio: 'inherit' });
  } catch { /* harness CLI handles errors */ }
}
