#!/usr/bin/env tsx
/**
 * studio-config — 配置管理 CLI
 *
 * Usage:
 *   studio config list                    # 查看当前配置（masked）
 *   studio config set KEY=VALUE           # 设置配置项
 *   studio config check                   # 验证配置完整性
 *   studio config path                    # 显示配置文件路径
 */

import * as fs from 'fs';
import * as path from 'path';
import { studioPath } from '../packages/studio-shared/src/config/studio-dir';

const CONFIG_PATH = studioPath('config.env');

// 需要管理的配置项
const MANAGED_KEYS = [
  '# LLM API Keys',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY_1',
  'ANTHROPIC_API_KEY_2',
  'OPENAI_API_KEY',
  'LLM_API_KEY',
  'CODING_API_KEY_1',
  'CODING_API_KEY_2',
  '',
  '# Discord',
  'DISCORD_BOT_TOKEN',
  'DISCORD_APPLICATION_ID',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_CHANNEL_ID',
  'DISCORD_DAILY_CHANNEL',
  '',
  '# Security',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  '',
  '# Proxy',
  'ANTHROPIC_BASE_URL',
];

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

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    config[key] = value;
  }
  return config;
}

function saveConfig(config: Record<string, string>): void {
  // 确保目录存在
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 构建内容（保持结构化）
  const lines: string[] = [];
  const written = new Set<string>();

  for (const item of MANAGED_KEYS) {
    if (!item || item.startsWith('#')) {
      lines.push(item);
      continue;
    }

    if (written.has(item)) continue;
    written.add(item);

    const value = config[item];
    if (value) {
      lines.push(`${item}=${value}`);
    }
  }

  // 追加未在 MANAGED_KEYS 中的配置
  for (const [key, value] of Object.entries(config)) {
    if (!written.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', 'utf-8');
}

function cmdList(): void {
  const config = loadConfig();
  const envConfig: Record<string, string> = {};

  // 也检查环境变量中已设置的
  const allKeys = [
    'DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1',
    'JWT_SECRET', 'ENCRYPTION_KEY',
    'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  ];

  console.log(`Config file: ${CONFIG_PATH}\n`);
  console.log('Current configuration:');
  console.log('─'.repeat(60));

  for (const key of allKeys) {
    const fileValue = config[key];
    const envValue = process.env[key];
    const source = envValue ? 'env' : fileValue ? 'config.env' : '-';
    const value = envValue || fileValue;

    if (value) {
      console.log(`${key} = ${maskValue(value)}  (${source})`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`\nTotal configured: ${Object.keys(config).length} keys in config.env`);
}

function cmdSet(args: string[]): void {
  if (args.length === 0) {
    console.error('Usage: studio config set KEY=VALUE');
    process.exit(1);
  }

  const config = loadConfig();

  for (const arg of args) {
    const eqIndex = arg.indexOf('=');
    if (eqIndex === -1) {
      console.error(`Invalid format: ${arg} (expected KEY=VALUE)`);
      process.exit(1);
    }

    const key = arg.slice(0, eqIndex).trim();
    const value = arg.slice(eqIndex + 1).trim();

    if (!key) {
      console.error('Key cannot be empty');
      process.exit(1);
    }

    config[key] = value;
    console.log(`Set ${key} = ${maskValue(value)}`);
  }

  saveConfig(config);
  console.log(`\nSaved to ${CONFIG_PATH}`);
  console.log('Restart services to apply: systemctl restart studio-api');
}

function cmdCheck(): void {
  // 加载 config.env 到 process.env
  const config = loadConfig();
  for (const [key, value] of Object.entries(config)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  const checks = [
    { name: 'LLM API Key', keys: ['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1'] },
    { name: 'JWT Secret', keys: ['JWT_SECRET'] },
    { name: 'Encryption Key', keys: ['ENCRYPTION_KEY'] },
  ];

  console.log('Configuration check:\n');
  let allValid = true;

  for (const check of checks) {
    const found = check.keys.some(k => process.env[k]);
    const status = found ? '✓' : '✗';
    console.log(`  ${status} ${check.name}: ${found ? 'configured' : 'MISSING'}`);
    if (!found) allValid = false;
  }

  console.log('\n' + '─'.repeat(40));
  console.log(allValid ? 'All checks passed' : 'Some checks failed');
  process.exit(allValid ? 0 : 1);
}

function cmdPath(): void {
  console.log(CONFIG_PATH);
}

// Main
const [,, command, ...args] = process.argv;

switch (command) {
  case 'list':
    cmdList();
    break;
  case 'set':
    cmdSet(args);
    break;
  case 'check':
    cmdCheck();
    break;
  case 'path':
    cmdPath();
    break;
  default:
    console.log(`Usage: studio config <command>

Commands:
  list        View current configuration (masked)
  set KEY=VAL Set configuration value
  check       Verify configuration completeness
  path        Show config file path`);
    break;
}
