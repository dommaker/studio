/**
 * Config - TypeScript 配置管理
 * ============================================================================
 * 功能: 替代 config.sh，提供统一的配置管理
 *
 * 配置优先级:
 *   1. 环境变量（最高，.env 覆盖）
 *   2. ~/.studio/config.env（统一配置文件）
 *   3. 默认值
 */

import * as path from 'path';
import * as fs from 'fs';
import { studioDir, warnIfNonProdUsesProdRoot } from './studio-dir';

/**
 * 加载 config.env 到 process.env（仅当 env 未设置时）
 */
export function loadConfigEnv(): void {
  const configPath = path.join(studioDir(), 'config.env');
  if (!fs.existsSync(configPath)) return;

  const content = fs.readFileSync(configPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // 仅当环境变量未设置时才加载（env 优先级更高）
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// 启动时自动加载 config.env
loadConfigEnv();

// 软护栏：非 production 指向生产缺省根时启动落 warning（每进程一次）
warnIfNonProdUsesProdRoot();

// CWD 陷阱修复：固定数据目录绝对路径，防止 claude CLI 子进程（HOME=agentHome）
// 里 FileStore baseDir 随 os.homedir() 漂移到嵌套路径（~/.studio/data/agents/<id>/.studio/data）。
// ??= 不覆盖子进程继承到的父进程值（buildSessionEnv 经 ...process.env 透传）。
// 必须早于任何 FileStore 实例化。
process.env.STUDIO_DATA_DIR ??= path.join(studioDir(), 'data');

/**
 * 按 provider 获取 API Key（统一入口，禁止直接 process.env）
 */
export type LlmProvider = 'deepseek' | 'anthropic' | 'openai' | 'coding';