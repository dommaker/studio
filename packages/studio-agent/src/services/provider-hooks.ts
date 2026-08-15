/**
 * Provider Hook Config Generator — #147 步内前置拦截层（自 research #138）
 *
 * 把 harness CommandGate 落到每个 provider 的可用执法面上（#138 §5.3 结论）：
 *   claude — permissions.deny（--print 下 PreToolUse hook 不触发，deny 已实测生效，2026-08-15）
 *   codex  — 项目级 .codex/hooks.json PreToolUse，exit 2 阻断（exec --json 源码+测试证实生效）
 *   kimi   — KIMI_CODE_HOME per-worktree 隔离 + config.toml [[hooks]] PreToolUse，exit 2 阻断（-p 本机实证）
 *
 * 拦截逻辑复用 @dommaker/harness CommandGate（SEC-006 黑名单，block/warn/audit 三级）；
 * 本模块只生成配置、不改黑名单规则本身（规则变更走 harness 仓，本票明确不做）。
 * 生成产物均为磁盘配置文件，调用方 = worktree-resolver.propagateHarnessConfig。
 */
import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';

/** hook 注入 marker：检测配置/脚本是否已含我们生成的执法段（幂等依据） */
export const HOOK_MARKER = 'harness-command-gate';

/** hook 脚本在 worktree 内的落点（.studio/ 已在 git exclude 清单，不随代码提交） */
export function hookScriptPath(worktree: string): string {
  return path.join(worktree, '.studio', 'command-gate-hook.js');
}

/** 解析 @dommaker/harness 的 CommandGate 编译产物绝对路径（根导出 → dist/gates/command.js） */
export function resolveCommandGatePath(): string {
  const entry = require.resolve('@dommaker/harness');
  return path.join(path.dirname(entry), 'gates', 'command.js');
}

/**
 * hook 脚本内容：stdin 收 provider PreToolUse JSON（tool_name / tool_input.command），
 * CommandGate.isAllowed 判定 block 级黑名单，命中 → stderr 写原因 + exit 2（阻断语义：
 * codex/kimi 均按 exit 2 + stderr 阻断、其余 exit code fail-open，#138 §3.2/§3.4）。
 */
export function buildHookScriptContent(): string {
  const requireArg = JSON.stringify(resolveCommandGatePath());
  return [
    `// ${HOOK_MARKER} PreToolUse 执法脚本 — studio-agent 生成（#147），勿手改。`,
    '// stdin: provider PreToolUse JSON；exit 2 = 阻断（stderr 作为阻断原因回填模型）。',
    'let raw = "";',
    'process.stdin.on("data", (c) => { raw += c; });',
    'process.stdin.on("end", () => {',
    '  let input = {};',
    '  try { input = JSON.parse(raw || "{}"); } catch (e) { /* 非 JSON stdin：放行 */ }',
    '  // fail-open 对齐 provider 语义（#138 §3.2/§3.4：非 exit 2 一律放行）——',
    '  // stdin 格式变化时宁可漏拦也不全体 Bash 秒断；拦截层只是纵深防御的一道。',
    `  const { CommandGate } = require(${requireArg});`,
    '  const command = (input.tool_input && input.tool_input.command) || "";',
    '  const gate = new CommandGate();',
    '  if (!gate.isAllowed(command)) {',
    `    console.error("[${HOOK_MARKER}] blocked: " + command);`,
    '    process.exit(2);',
    '  }',
    '});',
    '',
  ].join('\n');
}

/** 写 hook 脚本到 worktree（幂等：内容一致跳过；不一致/缺失重写 = 自愈） */
export function writeHookScript(worktree: string): void {
  const p = hookScriptPath(worktree);
  const content = buildHookScriptContent();
  if (fsSync.existsSync(p) && fsSync.readFileSync(p, 'utf-8') === content) return;
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, content, 'utf-8');
}

// ─── claude：permissions.deny（P0 方案 A） ───

/** 静态 deny 规则：与仓库级 .claude/settings.json 口径一致（#138 §1.4） */
const STATIC_CLAUDE_DENY = [
  'Bash(rm -rf *)',
  'Bash(git push --force*)',
  'Bash(git reset --hard*)',
];

/**
 * claude permissions.deny 规则（#147 P0）：
 *   3 条静态命令规则 + 越界写路径（~/.studio 数据区 + 主仓库 repoDir）。
 * 主仓库规则仅当 worktree 不在 repoDir 内时追加——worktree 就在 repo 下时（如
 * VPS workspace 直用 repoDir 子目录）追加会误伤合法写，必须跳过。
 * claude 绝对路径规则格式 = `//` 前缀 + 绝对路径（如 Edit(//root/projects/studio/**)）。
 */
export function buildClaudeDenyRules(opts: { worktree: string; repoDir?: string }): string[] {
  const deny = [
    ...STATIC_CLAUDE_DENY,
    'Write(~/.studio/**)',
    'Edit(~/.studio/**)',
  ];
  const repoDir = opts.repoDir ? path.resolve(opts.repoDir) : undefined;
  const worktree = path.resolve(opts.worktree);
  if (repoDir && !worktree.startsWith(repoDir + path.sep)) {
    const abs = repoDir.replace(/^\/+/, '');
    deny.push(`Edit(//${abs}/**)`, `Write(//${abs}/**)`);
  }
  return deny;
}

// ─── codex：项目级 .codex/hooks.json（P1） ───

/** codex hooks.json 载体：{description, hooks}（#138 §3.2，ClaudeHooksEngine 兼容格式） */
export function buildCodexHooksJson(worktree: string): Record<string, unknown> {
  return {
    description: `${HOOK_MARKER} PreToolUse 前置拦截（#147）`,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: `node ${hookScriptPath(worktree)}`, timeout: 10 },
          ],
        },
      ],
    },
  };
}

/** 写 <worktree>/.codex/hooks.json（codex exec cwd=worktree 时项目级发现；幂等） */
export function writeCodexHooks(worktree: string): void {
  const p = path.join(worktree, '.codex', 'hooks.json');
  const content = JSON.stringify(buildCodexHooksJson(worktree), null, 2) + '\n';
  if (fsSync.existsSync(p) && fsSync.readFileSync(p, 'utf-8') === content) return;
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, content, 'utf-8');
}

// ─── kimi：KIMI_CODE_HOME per-worktree 隔离（P1） ───

/** per-worktree kimi home（spawn env KIMI_CODE_HOME 指向它） */
export function kimiCodeHomePath(worktree: string): string {
  return path.join(worktree, '.kimi-code');
}

/** host 全局 kimi home（凭证/配置来源） */
export function hostKimiCodeHome(): string {
  return path.join(os.homedir(), '.kimi-code');
}

/** per-worktree kimi home 是否已生成（= config.toml 存在）——spawn 注入 KIMI_CODE_HOME 的判定谓词 */
export function kimiCodeHomeReady(worktree: string): boolean {
  return fsSync.existsSync(path.join(kimiCodeHomePath(worktree), 'config.toml'));
}

/** kimi config.toml 追加段：[[hooks]] PreToolUse → 共享 hook 脚本，exit 2 阻断 */
function buildKimiHookFragment(worktree: string): string {
  return [
    '',
    `# ${HOOK_MARKER} PreToolUse — studio-agent 生成（#147）：block 级黑名单 exit 2 阻断`,
    '[[hooks]]',
    'event = "PreToolUse"',
    'matcher = "Bash"',
    `command = "node ${hookScriptPath(worktree)}"`,
    'timeout = 10',
    '',
  ].join('\n');
}

/**
 * 生成 per-worktree kimi home（多 WU 隔离，PIT-019 教训：不动 HOME，只动 kimi 自己的 home）：
 *   - 复制 host config.toml（providers/models/oauth 配置）并追加 PreToolUse hook 段；
 *   - credentials/oauth 目录软链复用 host（#138 §3.4 先例：凭证不复制、不散落）；
 *   - device_id 复制（CLI 设备标识）。
 * host 无 config.toml（kimi 未安装/未初始化）→ 直接跳过，不生成。
 * 幂等：config.toml 已含 marker 则不动；缺失/被删 → 重写（自愈）。
 */
export function ensureKimiHookHome(worktree: string): void {
  const hostHome = hostKimiCodeHome();
  const hostConfig = path.join(hostHome, 'config.toml');
  if (!fsSync.existsSync(hostConfig)) return;

  const wtHome = kimiCodeHomePath(worktree);
  fsSync.mkdirSync(wtHome, { recursive: true });

  for (const entry of ['credentials', 'oauth']) {
    const src = path.join(hostHome, entry);
    const dst = path.join(wtHome, entry);
    try {
      if (fsSync.existsSync(src) && !fsSync.existsSync(dst)) {
        fsSync.symlinkSync(src, dst, 'dir');
      }
    } catch (e) {
      // EEXIST（竞态/agent 已建同路径目录）：跳过，绝不影响 worktree 创建
      logger.warn('[ProviderHooks] kimi home symlink failed', { entry, error: String(e) });
    }
  }

  const deviceSrc = path.join(hostHome, 'device_id');
  const deviceDst = path.join(wtHome, 'device_id');
  if (fsSync.existsSync(deviceSrc) && !fsSync.existsSync(deviceDst)) {
    fsSync.copyFileSync(deviceSrc, deviceDst);
  }

  const wtConfig = path.join(wtHome, 'config.toml');
  const needsWrite = !fsSync.existsSync(wtConfig)
    || !fsSync.readFileSync(wtConfig, 'utf-8').includes(HOOK_MARKER);
  if (needsWrite) {
    const base = fsSync.readFileSync(hostConfig, 'utf-8');
    fsSync.writeFileSync(wtConfig, base.trimEnd() + '\n' + buildKimiHookFragment(worktree), 'utf-8');
  }
}

// ─── 汇总入口（propagateHarnessConfig 调用） ───

/**
 * 一次写完各 provider 的执法配置（hook 脚本 + codex hooks.json + kimi home）。
 * 各步骤独立 try——单 provider 生成失败不影响其余（与 writeGitExclude 同口径：
 * 执法配置缺失 ≠ worktree 不可用，绝不断 spawn）。
 */
export function writeProviderEnforcementConfigs(opts: { worktree: string }): void {
  const { worktree } = opts;
  for (const [name, step] of [
    ['hook-script', () => writeHookScript(worktree)],
    ['codex-hooks', () => writeCodexHooks(worktree)],
    ['kimi-home', () => ensureKimiHookHome(worktree)],
  ] as const) {
    try {
      step();
    } catch (e) {
      logger.warn(`[ProviderHooks] ${name} generation failed (non-blocking)`, { worktree, error: String(e) });
    }
  }
}
