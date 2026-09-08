// ── 数据域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio knowledge / channel / task / agent / skill / env / mcp / harness
// ── API helper: all data commands call the HTTP API ──

import { execSync } from 'child_process';
import * as fs from 'fs';
import { getCompanyId, getToken } from './shared.js';

const API_ORIGIN = `http://localhost:${process.env.PORT || 3001}`;
const API = `${API_ORIGIN}/api/v1`;
// 内部端点（无 auth，requireLocalhost）：/api/knowledge，不在 /api/v1 大门内
const KNOWLEDGE_INTERNAL = `${API_ORIGIN}/api/knowledge`;

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
        console.log(`studio ${resource} <list|show|search${resource === 'knowledge' ? '|upsert|sync-status' : ''}>`);
    }
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED') {
      console.error('API server not running. Run: studio up');
    } else {
      console.error(`API error: ${e}`);
    }
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    }
  }
  return flags;
}

/**
 * studio knowledge 入口：upsert / sync-status 走内部端点（harness#110 前置①，
 * 替代 harness 侧 knowledgeUpsert/knowledgeSyncStatus），其余子命令委托 apiCommand。
 */
export async function studioKnowledge(args: string[]) {
  const sub = args[0];
  try {
    await getToken();
    switch (sub) {
      case 'upsert': {
        const flags = parseFlags(args.slice(1));
        let content = flags.content || '';
        if (flags.file && !content) {
          try {
            content = fs.readFileSync(flags.file, 'utf-8');
          } catch (e: any) {
            console.error(`Failed to read file: ${flags.file}`);
            console.error(String(e));
            return;
          }
        }
        if (!flags.scope || !flags.title || !content) {
          console.error('Usage: studio knowledge upsert --scope <scope> --title <title> (--content <text> | --file <path>) [--type architecture|process|guideline] [--source <source>]');
          return;
        }
        const r = await fetch(`${KNOWLEDGE_INTERNAL}/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: flags.scope,
            title: flags.title,
            content,
            type: flags.type || 'architecture',
            source: flags.source || 'cli',
          }),
        });
        if (!r.ok) {
          const err: any = await r.json().catch(() => ({ error: r.statusText }));
          console.error(`API error ${r.status}: ${err.error || r.statusText}`);
          return;
        }
        console.log(JSON.stringify(await r.json(), null, 2));
        break;
      }
      case 'sync-status': {
        const r = await fetch(`${KNOWLEDGE_INTERNAL}/sync-status`);
        if (!r.ok) {
          const err: any = await r.json().catch(() => ({ error: r.statusText }));
          console.error(`API error ${r.status}: ${err.error || r.statusText}`);
          return;
        }
        console.log(JSON.stringify(await r.json(), null, 2));
        break;
      }
      default:
        await apiCommand('knowledge', args);
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
