#!/usr/bin/env tsx
/**
 * 测试配置加载
 */

import * as fs from 'fs';
import { studioPath } from '../packages/studio-shared/src/config/studio-dir';

const CONFIG_PATH = studioPath('config.env');

// 模拟 loadConfigEnv
function loadConfigEnv(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('config.env not found');
    return;
  }

  console.log(`Loading: ${CONFIG_PATH}`);
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let loaded = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!process.env[key] && value) {
      process.env[key] = value;
      loaded++;
    }
  }

  console.log(`Loaded ${loaded} keys`);
}

// 测试
loadConfigEnv();

// 验证
const keys = ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY', 'JWT_SECRET'];
for (const key of keys) {
  const value = process.env[key];
  if (value) {
    const masked = value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : '****';
    console.log(`${key} = ${masked}`);
  }
}
