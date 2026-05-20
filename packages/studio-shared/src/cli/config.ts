/**
 * 配置加载器
 * 
 * 加载 .studio/config.yaml 配置文件
 */

import { parse } from 'yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface StudioConfig {
  apiUrl?: string;          // API 地址
  companyId?: number;       // 默认公司
  format?: string;          // 默认输出格式
  timeout?: number;         // 默认超时
}

const DEFAULT_CONFIG: StudioConfig = {
  apiUrl: 'http://localhost:3001',
  format: 'table',
  timeout: 10000,
};

let currentConfig: StudioConfig = DEFAULT_CONFIG;

/**
 * 加载配置文件
 */
export function loadConfig(path?: string): StudioConfig {
  const configPath = path || join(process.cwd(), '.studio', 'config.yaml');

  if (!existsSync(configPath)) {
    currentConfig = DEFAULT_CONFIG;
    return currentConfig;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    
    // 空文件返回默认配置
    if (!content.trim()) {
      currentConfig = DEFAULT_CONFIG;
      return currentConfig;
    }
    
    const parsed = parse(content) as Partial<StudioConfig>;

    currentConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
    };

    // 类型校验
    if (parsed.companyId !== undefined && typeof parsed.companyId !== 'number') {
      // 类型错误，忽略该字段
      currentConfig.companyId = undefined;
    }

    return currentConfig;
  } catch (e) {
    throw new Error(`配置文件解析错误: ${configPath}`);
  }
}

/**
 * 获取当前配置
 */
export function getConfig(): StudioConfig {
  return currentConfig;
}

/**
 * 保存配置文件
 */
export function saveConfig(config: Partial<StudioConfig>, path?: string): void {
  const configPath = path || join(process.cwd(), '.studio', 'config.yaml');

  // 合并现有配置
  const existingConfig = loadConfig(configPath);
  const newConfig = {
    ...existingConfig,
    ...config,
  };

  // 转换为 YAML
  const yamlContent = Object.entries(newConfig)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  writeFileSync(configPath, yamlContent, 'utf-8');
  currentConfig = newConfig;
}