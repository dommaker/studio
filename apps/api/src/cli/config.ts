// ── 配置域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio config list / set / check / path

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function studioConfig(args: string[]) {
  const CONFIG_PATH = path.join(os.homedir(), '.studio', 'config.env');

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
      config[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
    return config;
  }

  function saveConfig(config: Record<string, string>): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', 'utf-8');
  }

  const subcmd = args[0];

  switch (subcmd) {
    case 'list': {
      const config = loadConfig();
      console.log(`Config: ${CONFIG_PATH}\n`);
      const keys = ['JWT_SECRET', 'ENCRYPTION_KEY', 'DISCORD_DAILY_CHANNEL'];
      for (const key of keys) {
        const envVal = process.env[key];
        const fileVal = config[key];
        const source = envVal ? 'env' : fileVal ? 'config.env' : '-';
        const value = envVal || fileVal;
        if (value) console.log(`${key} = ${maskValue(value)}  (${source})`);
      }
      break;
    }
    case 'set': {
      const kv = args[1];
      if (!kv || !kv.includes('=')) {
        console.error('Usage: studio config set KEY=VALUE');
        process.exit(1);
      }
      const eqIdx = kv.indexOf('=');
      const key = kv.slice(0, eqIdx).trim();
      const value = kv.slice(eqIdx + 1).trim();
      const config = loadConfig();
      config[key] = value;
      saveConfig(config);
      console.log(`Set ${key} = ${maskValue(value)}`);
      console.log(`Saved to ${CONFIG_PATH}`);
      console.log('Restart to apply: systemctl restart studio-api');
      break;
    }
    case 'check': {
      const config = loadConfig();
      for (const [k, v] of Object.entries(config)) {
        if (!process.env[k]) process.env[k] = v;
      }
      const checks = [
        { name: 'JWT Secret', keys: ['JWT_SECRET'] },
        { name: 'Encryption Key', keys: ['ENCRYPTION_KEY'] },
      ];
      let ok = true;
      for (const c of checks) {
        const found = c.keys.some(k => process.env[k]);
        console.log(`  ${found ? '✓' : '✗'} ${c.name}: ${found ? 'configured' : 'MISSING'}`);
        if (!found) ok = false;
      }
      process.exit(ok ? 0 : 1);
    }
    case 'path':
      console.log(CONFIG_PATH);
      break;
    default:
      console.log(`Usage: studio config <command>

Commands:
  list        View current configuration (masked)
  set KEY=VAL Set configuration value
  check       Verify configuration completeness
  path        Show config file path`);
  }
}
