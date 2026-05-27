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
  'packages/studio-shared', 'packages/studio-agent', 'packages/studio-prisma',
  'packages/studio-skill', 'packages/studio-spec', 'packages/studio-audit',
  'packages/studio-capability', 'packages/studio-monitor', 'packages/studio-notification',
  'packages/studio-task',
];

// ── Helpers ──

function runTsc(pkg) {
  try {
    const out = execSync(
      `npx tsc --noEmit --project "${pkg}/tsconfig.json" --pretty false 2>&1`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
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
  const baselineFile = opt('--baseline') || '.tsc-baseline.json';
  const packages = opt('--packages').split(',').filter(Boolean);

  if (packages.length === 0) {
    console.log('ℹ️  No packages to check');
    process.exit(0);
  }

  console.log(`   Packages: ${packages.join(', ')}`);

  // Load baseline
  let baseline = {};
  if (fs.existsSync(baselineFile)) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  } else {
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
console.log('Usage: tsc-gate.mjs --update-baseline | --check --baseline <file> --packages <pkgs>');
process.exit(1);
