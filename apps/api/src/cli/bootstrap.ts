/**
 * bootstrap — studio run web / studio up 共用的数据目录与密钥自举（#571）
 *
 * 自 server.ts studioUp 内联逻辑提取，语义不变：
 * - 密钥自举必须先于 .env 加载（.env 中的占位值不得覆盖已生成密钥）；
 * - env 已显式配置 > .daemon/ 文件 > 生成并落盘。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** run web / up 启动所需的数据根子目录（布局契约：docs/architecture/data-directory-contract.md §2） */
const DATA_SUBDIRS = ['data', '.analyst', '.daemon', 'knowledge', 'worktrees'] as const;

/** 创建数据根及子目录，幂等 */
export function ensureDataDirs(studioDirPath: string): void {
  for (const d of DATA_SUBDIRS) {
    const dir = path.join(studioDirPath, d);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export interface DaemonSecretsResult {
  /** env = 环境变量已配置；loaded = 自 .daemon/ 文件读入；generated = 新生成并落盘 */
  jwt: 'env' | 'loaded' | 'generated';
  encryption: 'env' | 'loaded' | 'generated';
}

function ensureSecret(daemonDir: string, fileName: string, envKey: 'JWT_SECRET' | 'ENCRYPTION_KEY', env: NodeJS.ProcessEnv): 'env' | 'loaded' | 'generated' {
  if (env[envKey]) return 'env';
  const file = path.join(daemonDir, fileName);
  if (fs.existsSync(file)) {
    env[envKey] = fs.readFileSync(file, 'utf-8').trim();
    return 'loaded';
  }
  fs.mkdirSync(daemonDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, 'utf-8');
  env[envKey] = secret;
  console.log(`Generated ${envKey} (stored in ${file})`);
  return 'generated';
}

/** 数据目录可写探针：写后即删，失败抛错（preflight storage 检查，契约 §7 首启链路） */
export function probeStorageWritable(dataDir: string): void {
  const probe = path.join(dataDir, '_health_probe');
  fs.writeFileSync(probe, Date.now().toString());
  fs.unlinkSync(probe);
}

/** 自举 JWT_SECRET / ENCRYPTION_KEY（程序独占区 .daemon/，契约 §3） */
export function ensureDaemonSecrets(daemonDir: string, env: NodeJS.ProcessEnv = process.env): DaemonSecretsResult {
  return {
    jwt: ensureSecret(daemonDir, 'jwt-secret', 'JWT_SECRET', env),
    encryption: ensureSecret(daemonDir, 'encryption-key', 'ENCRYPTION_KEY', env),
  };
}
