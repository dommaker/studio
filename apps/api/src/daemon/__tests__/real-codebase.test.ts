// 真实代码库任务测试 — 在 agent-studio 项目上跑复杂多文件修改
import { describe, it, expect } from 'vitest';
import { daemon } from '../studio-daemon.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

const REPO_DIR = process.env.REPO_DIR || '/root/projects/agent-studio';

describe('真实代码库任务', () => {
  it('多文件重构：提取工具函数 + 添加类型 + 写测试', async () => {
    process.env.REPO_DIR = REPO_DIR;
    daemon.start();

    // 在 executor worktree 中操作真实代码
    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    // 确保是干净状态
    try { execSync('git checkout -- .', { cwd: worktree, stdio: 'pipe' }); } catch {}

    // 任务：创建一个新工具模块
    const result = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：创建 daemon 工具模块',
        '',
        '### 1. 创建 apps/api/src/daemon/utils.ts',
        '```typescript',
        '// Daemon 工具函数',
        '',
        '/** 确保目录存在 */',
        'import * as fs from "fs";',
        '',
        'export function ensureDir(dir: string): void {',
        '  if (!fs.existsSync(dir)) {',
        '    fs.mkdirSync(dir, { recursive: true });',
        '  }',
        '}',
        '',
        '/** 格式化耗时（毫秒 → 可读字符串） */',
        'export function formatDuration(ms: number): string {',
        '  if (ms < 1000) return `${ms}ms`;',
        '  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;',
        '  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;',
        '}',
        '',
        '/** 安全 JSON 解析，失败返回默认值 */',
        'export function safeJsonParse<T>(raw: string, fallback: T): T {',
        '  try { return JSON.parse(raw) as T; } catch { return fallback; }',
        '}',
        '```',
        '',
        '### 2. 检查 apps/api/src/daemon/session-manager.ts 中哪些地方可以用 utils.ts 的函数替换',
        '如果有 fs.mkdirSync 调用，改为用 ensureDir。',
        '如果有 JSON.parse 但没有 try-catch，改为用 safeJsonParse。',
        '',
        '### 3. 在 session-manager.ts 顶部加 `import { ensureDir } from "./utils.js";`',
        '',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'output.txt'),
    });

    console.log('=== 多文件重构结果 ===');
    console.log('success:', result.success);
    console.log('durationMs:', result.durationMs);
    console.log('error:', result.error?.slice(0, 300));

    // 验证产出
    const utilsPath = path.join(worktree, 'apps/api/src/daemon/utils.ts');
    const smPath = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');

    if (fs.existsSync(utilsPath)) {
      const utilsContent = fs.readFileSync(utilsPath, 'utf-8');
      console.log('=== utils.ts 存在 ===');
      console.log('ensureDir:', utilsContent.includes('ensureDir'));
      console.log('formatDuration:', utilsContent.includes('formatDuration'));
      console.log('safeJsonParse:', utilsContent.includes('safeJsonParse'));
      expect(utilsContent).toContain('ensureDir');
      expect(utilsContent).toContain('formatDuration');
      expect(utilsContent).toContain('safeJsonParse');
    }

    if (fs.existsSync(smPath)) {
      const smContent = fs.readFileSync(smPath, 'utf-8');
      console.log('=== session-manager.ts 更新 ===');
      console.log('import utils:', smContent.includes('./utils.js'));
    }

    expect(result.success).toBe(true);
    daemon.stop();
  }, 300_000);

  it('Session 复用跨多个任务（模拟真实开发流）', async () => {
    daemon.start();
    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    // 任务 A: 给 utils.ts 添加新函数
    const rA = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：给 utils.ts 添加 truncate 函数',
        '',
        '在 apps/api/src/daemon/utils.ts 末尾添加：',
        '```typescript',
        '/** 截断字符串到指定长度，超出加 ... */',
        'export function truncate(s: string, maxLen: number): string {',
        '  if (s.length <= maxLen) return s;',
        '  return s.slice(0, maxLen) + "...";',
        '}',
        '```',
        '',
        '检查 utils.ts 是否已经有 ensureDir, formatDuration, safeJsonParse 函数。',
        '如果有就不要重复添加。只在文件末尾追加新函数。',
        '',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'outA.txt'),
    });

    console.log('=== 任务 A ===');
    console.log('success:', rA.success, 'durationMs:', rA.durationMs);

    // 任务 B: 修改 session-manager.ts 使用 truncate
    const rB = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：在 session-manager.ts 中使用 truncate',
        '',
        '1. 在 session-manager.ts 顶部 import 中加 truncate：',
        '   import { ensureDir, truncate } from "./utils.js";',
        '',
        '2. 找到日志中截断字符串的地方（如 `.slice(0, 200)` 或 `.slice(0, 300)` 或 `.slice(0, 80)`），',
        '   将 errorMsg.slice(0, 200) 改为 truncate(errorMsg, 200)',
        '   将 errorMsg.slice(0, 300) 改为 truncate(errorMsg, 300)',
        '',
        '不要改其他逻辑。完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'outB.txt'),
    });

    console.log('\n=== 任务 B ===');
    console.log('success:', rB.success, 'durationMs:', rB.durationMs);

    const utilsPath = path.join(worktree, 'apps/api/src/daemon/utils.ts');
    const smPath = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');

    if (fs.existsSync(utilsPath)) {
      console.log('utils.ts has truncate:', fs.readFileSync(utilsPath, 'utf-8').includes('truncate'));
    }
    if (fs.existsSync(smPath)) {
      console.log('sm.ts imports truncate:', fs.readFileSync(smPath, 'utf-8').includes('truncate'));
    }

    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);
    daemon.stop();
  }, 300_000);
});
