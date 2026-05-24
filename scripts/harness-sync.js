/**
 * 检测 harness 版本是否与 .harness/config.yml 一致，不一致则自动 init。
 * 由 postinstall + prepare 触发，确保 pnpm install / update / add 后自动同步。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = process.cwd();

function getInstalledVersion() {
  try {
    const pkgPath = path.join(projectRoot, 'node_modules', '@dommaker', 'harness', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return null;
  }
}

function getConfigVersion() {
  try {
    const configPath = path.join(projectRoot, '.harness', 'config.yml');
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/version:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

try {
  const installed = getInstalledVersion();
  if (!installed) return; // harness not installed

  const configVersion = getConfigVersion();

  if (configVersion !== installed) {
    const from = configVersion || '(none)';
    console.log(`harness ${from} -> ${installed}, re-initing...`);
    execSync('npx harness init', { stdio: 'inherit', cwd: projectRoot });
  }
} catch (err) {
  // Silent fail — don't block install
  console.error('harness-sync:', err.message);
}
