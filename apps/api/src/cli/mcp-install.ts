// ── studio mcp install（#566 P3）──
// 把 studio 对外只读 MCP 入口（/api/v1/mcp/external/sse）一键写进本机 agent 的用户级配置。
// 幂等合并且只动 `studio` 一个 key；写前备份 <file>.bak；JSON 解析失败拒写。
//
// agent 支持面（2026-09-16 核查，方案「实施时核查项」结论）：
// - claude   ~/.claude.json                    mcpServers.studio = { type: 'sse', url }（Q4 决策：写用户级）
// - kimi     ~/.kimi-code/mcp.json             mcpServers.studio = { transport: 'sse', url }（官方文档 SSE 支持）
// - opencode ~/.config/opencode/opencode.json  mcp.studio = { type: 'remote', url }（remote 支持 SSE 端点）
// - codex    不支持 SSE transport（仅 streamable HTTP），按 Q2 决策不引入 mcp-remote 桥 → 报错提示

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SERVER_KEY = 'studio';
const HEALTH_URL = 'http://localhost:3001/api/v1/mcp/health';
const DEFAULT_SSE_URL = 'http://localhost:3001/api/v1/mcp/external/sse';
const PROBE_TIMEOUT_MS = 2000;

interface McpAgentAdapter {
  /** 用户级配置文件绝对路径 */
  configPath: () => string;
  /** MCP 段的容器 key（claude/kimi = mcpServers，opencode = mcp） */
  containerKey: string;
  /** studio server 条目（值内 URL 只写 localhost，脱敏纪律） */
  entry: (url: string) => Record<string, unknown>;
}

const ADAPTERS: Record<string, McpAgentAdapter> = {
  claude: {
    configPath: () => path.join(os.homedir(), '.claude.json'),
    containerKey: 'mcpServers',
    entry: (url) => ({ type: 'sse', url }),
  },
  kimi: {
    configPath: () => path.join(os.homedir(), '.kimi-code', 'mcp.json'),
    containerKey: 'mcpServers',
    entry: (url) => ({ transport: 'sse', url }),
  },
  opencode: {
    configPath: () => path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    containerKey: 'mcp',
    entry: (url) => ({ type: 'remote', url }),
  },
};

/** SSE 不支持、按 Q2 不架桥的 agent：install 时报错提示而非静默写错配置 */
const UNSUPPORTED: Record<string, string> = {
  codex: 'codex 不支持 SSE transport（仅 streamable HTTP），本版不引入 mcp-remote 桥（#566 Q2 决策），跳过。',
};

function usage(): void {
  console.log('studio mcp install <agent> [--url <sse-url>] [--print] [--uninstall]');
  console.log(`  支持: ${Object.keys(ADAPTERS).join(' | ')}（不支持: ${Object.keys(UNSUPPORTED).join(' | ')}）`);
}

/** Q3 决策：探测 3001 health，通了用默认 URL；不通报错提示 --url，不顺延猜端口 */
async function resolveUrl(flags: Record<string, string>): Promise<string | null> {
  if (flags.url) return flags.url;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return DEFAULT_SSE_URL;
  } catch { /* fall through to error */ }
  return null;
}

function readConfig(file: string): Record<string, any> | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return null; // 解析失败或非对象 → 拒写
}

function writeConfig(file: string, config: Record<string, any>): void {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

export async function mcpInstall(args: string[]): Promise<void> {
  const agent = args.find(a => !a.startsWith('--'));
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = 'true';
    }
  }

  if (!agent) {
    usage();
    return;
  }
  if (UNSUPPORTED[agent]) {
    console.error(UNSUPPORTED[agent]);
    return;
  }
  const adapter = ADAPTERS[agent];
  if (!adapter) {
    console.error(`未知 agent: ${agent}`);
    usage();
    return;
  }

  const file = adapter.configPath();

  // --uninstall：只删 studio key，既有字段无损
  if (flags.uninstall === 'true') {
    const config = readConfig(file);
    if (config === null) {
      console.error(`配置文件损坏，拒绝修改: ${file}`);
      return;
    }
    const container = config[adapter.containerKey];
    if (!container || container[SERVER_KEY] === undefined) {
      console.log(`未安装（${file} 无 ${adapter.containerKey}.${SERVER_KEY}），无需改动`);
      return;
    }
    delete container[SERVER_KEY];
    writeConfig(file, config);
    console.log(`已卸载 ${SERVER_KEY} MCP 配置: ${file}（备份 ${file}.bak）`);
    return;
  }

  const url = await resolveUrl(flags);
  if (!url) {
    console.error(`Studio API 未运行（探测 ${HEALTH_URL} 失败）。请先 studio up，或用 --url 显式指定 SSE 地址。`);
    return;
  }

  const entry = adapter.entry(url);

  // --print：干跑输出片段不落盘
  if (flags.print === 'true') {
    console.log(`目标文件: ${file}`);
    console.log(JSON.stringify({ [adapter.containerKey]: { [SERVER_KEY]: entry } }, null, 2));
    return;
  }

  const config = readConfig(file);
  if (config === null) {
    console.error(`配置文件 JSON 解析失败，拒绝覆写: ${file}（请手工修复后重试）`);
    return;
  }
  if (!config[adapter.containerKey] || typeof config[adapter.containerKey] !== 'object') {
    config[adapter.containerKey] = {};
  }

  const existing = config[adapter.containerKey][SERVER_KEY];
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) {
    console.log(`已是目标配置，无需改动: ${file}`);
    return;
  }

  config[adapter.containerKey][SERVER_KEY] = entry;
  writeConfig(file, config);
  console.log(`已写入 ${SERVER_KEY} MCP 配置: ${file}（备份 ${file}.bak，重开 ${agent} 会话生效）`);
}
