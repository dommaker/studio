/**
 * tsc-gate — TypeScript 类型门禁（核心逻辑）
 *
 * Called by bin/tsc-gate.sh. 对目标包逐包跑 tsc，任一错误即拦截。
 * （2026-10 #694：baseline 比对 / surgical 自动更新 / strict 模式删除——
 *  .tsc-baseline.json 的 totalErrors 自 2026-07 起恒为 0，整套机制空转，
 *  实际等价于逐包跑 tsc；本文件即该等价物的直白写法。）
 */

const { execSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; }

const PKGS = [
  'apps/api', 'apps/web',
  'packages/studio-contract', 'packages/studio-shared', 'packages/studio-agent',
  'packages/studio-skill',
];

// solution 风格 tsconfig（files:[] + references，如 apps/web）：
// `tsc --noEmit -p` 对它不检查任何文件（盲转），必须用 `tsc -b` 才与
// CI（apps/web: tsc -b && vite build）等价 —— 2026-08-08 合并产生 4 个类型错误漏检事故
function isSolutionStyleTsconfig(pkg) {
  try {
    const cfg = JSON.parse(fs.readFileSync(`${pkg}/tsconfig.json`, 'utf-8'));
    return Array.isArray(cfg.files) && cfg.files.length === 0 &&
      Array.isArray(cfg.references) && cfg.references.length > 0;
  } catch {
    return false;
  }
}

function runTsc(pkg) {
  const solution = isSolutionStyleTsconfig(pkg);
  try {
    const out = execSync(
      solution
        ? `npx tsc -b "${pkg}/tsconfig.json" --pretty false 2>&1`
        : `npx tsc --noEmit --project "${pkg}/tsconfig.json" --pretty false 2>&1`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: solution ? 120000 : 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    return out;
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

function parseErrors(tscOutput) {
  const errors = [];
  const lines = tscOutput.split('\n');
  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):/);
    if (m) {
      errors.push({ file: m[1], line: parseInt(m[2]), code: m[3] });
    }
  }
  return errors;
}

// ── Check Gate ──

if (flag('--check')) {
  const packages = opt('--packages').split(',').filter(Boolean);
  const targets = packages.length > 0 ? packages : PKGS;
  console.log(`   Packages: ${targets.join(', ')}`);

  const errors = [];
  for (const pkg of targets) {
    if (!fs.existsSync(`${pkg}/tsconfig.json`)) continue;
    for (const e of parseErrors(runTsc(pkg))) {
      errors.push(`${e.file}:${e.line}: ${e.code}`);
    }
  }

  if (errors.length > 0) {
    console.log('');
    console.log('======================================================');
    console.log('  TYPESCRIPT ERRORS DETECTED — COMMIT BLOCKED');
    console.log('======================================================');
    console.log('');
    for (const e of errors.slice(0, 20)) {
      console.log(`  ${e}`);
    }
    if (errors.length > 20) {
      console.log(`  ... and ${errors.length - 20} more`);
    }
    console.log('');
    console.log('  ── Fix instructions ──');
    console.log('  1. Fix the type errors');
    console.log('  2. Re-stage and re-commit');
    console.log('');
    console.log('  ── Emergency skip ──');
    console.log('  TSC_GATE_OFF=1 git commit -m "..."');
    console.log('');
    process.exit(1);
  }

  console.log('✅ tsc-gate: no errors detected');
  process.exit(0);
}

// Fallback: show usage
console.log('Usage: tsc-gate.js --check [--packages <pkgs>]');
process.exit(1);
