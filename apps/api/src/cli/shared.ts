// ── CLI 共享常量与助手（2026-07-20 自 studio-cli.ts 按命令域拆分）──

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const STUDIO_DIR = path.join(os.homedir(), '.studio');
export const DATA_DIR = path.join(STUDIO_DIR, 'data');

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── CLI helpers ──

export function getCompanyId(): string {
  const activeFile = path.join(STUDIO_DIR, 'active-project');
  if (fs.existsSync(activeFile)) {
    return fs.readFileSync(activeFile, 'utf-8').trim();
  }
  // Fallback: try to read from company config
  const companyFile = path.join(STUDIO_DIR, 'company.json');
  if (fs.existsSync(companyFile)) {
    try {
      const company = JSON.parse(fs.readFileSync(companyFile, 'utf-8'));
      return company.id || '';
    } catch {}
  }
  return '';
}

export async function getToken(): Promise<string> {
  const tokenFile = path.join(STUDIO_DIR, '.daemon', 'session-token');
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf-8').trim();
  }
  // No token file — API calls may work without auth for localhost
  return '';
}

export function extractConfigFlag(rawArgs: string[]): { configPath?: string; args: string[] } {
  const idx = rawArgs.indexOf('--config');
  if (idx !== -1 && idx + 1 < rawArgs.length) {
    const configPath = rawArgs[idx + 1];
    return { configPath, args: rawArgs.filter((_, i) => i !== idx && i !== idx + 1) };
  }
  return { args: rawArgs };
}
