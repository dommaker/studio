/**
 * tsc-gate — baseline-aware TypeScript type check (core logic)
 *
 * Called by bin/tsc-gate.sh. Use --update-baseline to rebuild the baseline.
 */

const { execSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; }

const PKGS = [
  'apps/api', 'apps/web',
  'packages/studio-shared', 'packages/studio-agent',
  'packages/studio-skill', 'packages/studio-spec', 'packages/studio-audit',
  'packages/studio-capability', 'packages/studio-notification',
];

// ── Helpers ──

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

function errorKey(e) {
  return `${e.file}:${e.line}:${e.code}`;
}

// ── Update Baseline ──

if (flag('--update-baseline')) {
  const baselineFile = opt('--baseline') || '.tsc-baseline.json';
  const baseline = {};

  for (const pkg of PKGS) {
    const out = runTsc(pkg);
    const errors = parseErrors(out);
    if (errors.length > 0) baseline[pkg] = errors;
  }

  let total = 0;
  for (const v of Object.values(baseline)) total += v.length;

  baseline._meta = {
    generated: new Date().toISOString(),
    totalErrors: total,
    commit: execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(),
  };

  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  const pkgCount = Object.keys(baseline).filter(k => k !== '_meta').length;
  console.log(`✅ Baseline updated: ${total} errors across ${pkgCount} packages`);
  process.exit(0);
}

// ── Check Gate ──

if (flag('--check')) {
  const strict = flag('--strict');
  const baselineFile = opt('--baseline') || '.tsc-baseline.json';
  let packages = opt('--packages').split(',').filter(Boolean);

  if (packages.length === 0) {
    if (!strict) {
      console.log('ℹ️  No packages to check');
      process.exit(0);
    }
    packages = PKGS; // strict 默认全量包
  }

  if (strict) {
    console.log('   ⚡ strict 模式：忽略 baseline，所有现存错误均拦截（合并/大重构后使用）');
  }
  console.log(`   Packages: ${packages.join(', ')}`);

  // Load baseline（strict 模式跳过：baseline 只拦新增错误，会掩盖合并引入的存量错误）
  let baseline = {};
  if (!strict && fs.existsSync(baselineFile)) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  } else if (!strict) {
    console.log('⚠️  No baseline file — treating ALL errors as new');
  }

  let totalNew = 0;
  let totalFixed = 0;
  const newErrors = [];

  for (const pkg of packages) {
    if (!PKGS.includes(pkg)) continue;
    if (!fs.existsSync(`${pkg}/tsconfig.json`)) continue;

    const out = runTsc(pkg);
    const current = parseErrors(out);

    // Build baseline key set for this package
    const baselined = (baseline[pkg] || []).map(e => errorKey(e));
    const baselineSet = new Set(baselined);

    // Find new errors (in current but not in baseline)
    const currentKeys = current.map(e => errorKey(e));
    const newForPkg = currentKeys.filter(k => !baselineSet.has(k));

    // Count fixed (in baseline but not in current)
    const currentSet = new Set(currentKeys);
    const fixedForPkg = baselined.filter(k => !currentSet.has(k)).length;

    if (newForPkg.length > 0) {
      totalNew += newForPkg.length;
      for (const key of newForPkg) {
        const err = current.find(e => errorKey(e) === key);
        newErrors.push(`${err.file}:${err.line}: ${err.code}`);
      }
    }

    if (fixedForPkg > 0) {
      totalFixed += fixedForPkg;
      const blCount = baselined.length;
      const curCount = currentKeys.length;
      console.log(`✅ ${pkg}: ${fixedForPkg} fewer error(s) (${blCount} → ${curCount})`);
    }
  }

  if (totalNew > 0) {
    console.log('');
    console.log('======================================================');
    console.log('  NEW TYPESCRIPT ERRORS DETECTED — COMMIT BLOCKED');
    console.log('======================================================');
    console.log('');
    console.log('  These errors are NOT in .tsc-baseline.json:');
    console.log('');
    for (const e of newErrors.slice(0, 20)) {
      console.log(`  ${e}`);
    }
    if (newErrors.length > 20) {
      console.log(`  ... and ${newErrors.length - 20} more`);
    }
    console.log('');
    console.log('  ── Fix instructions ──');
    console.log('  1. Fix the new type errors');
    console.log('  2. Update baseline: bin/tsc-gate.sh --update-baseline');
    console.log('  3. Re-stage and re-commit');
    console.log('');
    console.log('  ── Emergency skip ──');
    console.log('  TSC_GATE_OFF=1 git commit -m "..."');
    console.log('');
    process.exit(1);
  }

  // Auto-update baseline: surgical per-package update (no full rebuild).
  // Full rebuilds shift line numbers in unrelated packages → false "new" errors.
  if (totalFixed > 0) {
    console.log(`♻️  ${totalFixed} errors fixed — auto-updating baseline...`);

    // Only rebuild packages that were checked (affected by staged files)
    for (const pkg of packages) {
      if (!PKGS.includes(pkg)) continue;
      if (!fs.existsSync(`${pkg}/tsconfig.json`)) continue;

      const out = runTsc(pkg);
      const current = parseErrors(out);
      if (current.length > 0) {
        baseline[pkg] = current;
      } else {
        delete baseline[pkg]; // package is now clean
      }
    }

    // Recalculate _meta totals from existing baseline entries
    let total = 0;
    for (const k of Object.keys(baseline)) {
      if (k === '_meta') continue;
      total += (baseline[k] || []).length;
    }
    baseline._meta = {
      generated: new Date().toISOString(),
      totalErrors: total,
      commit: execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(),
    };

    fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
    try { execSync(`git add "${baselineFile}"`, { stdio: 'pipe' }); } catch {}
    console.log(`✅ Baseline auto-updated: ${total} errors`);
  } else {
    console.log('✅ tsc-gate: no new errors detected');
  }
  process.exit(0);
}

// Fallback: show usage
console.log('Usage: tsc-gate.mjs --update-baseline | --check [--strict] --baseline <file> --packages <pkgs>');
process.exit(1);
