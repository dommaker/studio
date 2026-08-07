/**
 * MCP Tools — DevOps 发布
 *
 * T3 拆分：自 tools.ts 原样提取（publishPackage）。
 */

import type { RegisteredTool } from './tool-registry.js';

// ─── DevOps ───

const publishPackage: RegisteredTool = {
  name: 'publishPackage',
  description: '发布 npm 包到 registry + 创建 GitHub Release。包含完整流水线：tsc 编译 → dist 完整性验证 → npm version patch → git commit+tag → git push → npm publish → gh release create。Agent 应在 harness 源码变更已提交后调用。不可逆操作，执行前应确认。',
  inputSchema: {
    type: 'object',
    properties: {
      packagePath: { type: 'string', description: '包的绝对路径 (如 /root/projects/harness)' },
      bumpType: { type: 'string', description: '版本递增类型', enum: ['patch', 'minor', 'major'], default: 'patch' },
      dryRun: { type: 'string', description: '仅模拟执行不实际发布（跳过 npm publish + git push + gh release）', enum: ['true', 'false'], default: 'false' },
    },
    required: ['packagePath'],
  },
  handler: async (input) => {
    const { execSync } = await import('child_process');
    const pathMod = await import('path');
    const fsMod = await import('fs');
    const steps: Array<{ step: string; status: 'ok' | 'fail' | 'skip'; output?: string }> = [];
    const pkgPath = input.packagePath;
    const dryRun = input.dryRun === 'true';

    // 0. Derive GitHub repo from git remote
    let repoUrl = '';
    try {
      const remoteUrl = execSync('git remote get-url origin', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 }).trim();
      const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
      if (m) repoUrl = `https://github.com/${m[1]}/${m[2]}`;
    } catch { /* no remote */ }

    // 1. 验证路径
    if (!fsMod.existsSync(pathMod.join(pkgPath, 'package.json'))) {
      return { success: false, error: `Not a package: ${pkgPath}`, steps };
    }
    const pkgJson = JSON.parse(fsMod.readFileSync(pathMod.join(pkgPath, 'package.json'), 'utf-8'));
    const pkgName = pkgJson.name;
    const pkgVersion = pkgJson.version;
    steps.push({ step: `package: ${pkgName}@${pkgVersion}`, status: 'ok' });

    // 2. Check uncommitted changes
    try {
      const stat = execSync('git status --porcelain -uno', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      const hasChanges = stat.trim().length > 0;
      if (hasChanges) {
        return { success: false, error: `Uncommitted changes in ${pkgPath}. Commit or stash before publishing.`, steps };
      }
      steps.push({ step: 'git status: clean', status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `Not a git repo: ${pkgPath} (${e.message})`, steps };
    }

    // 3. tsc build
    try {
      execSync('npx tsc', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 60_000 });
      steps.push({ step: 'tsc: build', status: 'ok' });
    } catch (e: any) {
      const errMsg = e.stderr || e.message || String(e);
      steps.push({ step: 'tsc: failed', status: 'fail', output: errMsg.slice(0, 500) });
      return { success: false, error: 'TypeScript compilation failed', steps, compileErrors: errMsg.slice(0, 1000) };
    }

    // 4. Verify dist integrity
    const criticalFiles = ['dist/core/constraints/checker.js', 'dist/knowledge/doctor.js', 'dist/index.js'];
    const missing: string[] = [];
    for (const f of criticalFiles) {
      if (!fsMod.existsSync(pathMod.join(pkgPath, f))) missing.push(f);
    }
    if (missing.length > 0) {
      steps.push({ step: `dist verify: ${missing.length} missing`, status: 'fail', output: missing.join(', ') });
    } else {
      steps.push({ step: 'dist verify: all critical files present', status: 'ok' });
    }

    // 5. Bump version
    const bumpType = input.bumpType || 'patch';
    if (dryRun) {
      const [major, minor, patch] = pkgVersion.split('.').map(Number);
      let newVer: string;
      if (bumpType === 'major') newVer = `${major + 1}.0.0`;
      else if (bumpType === 'minor') newVer = `${major}.${minor + 1}.0`;
      else newVer = `${major}.${minor}.${patch + 1}`;
      steps.push({ step: `version: ${pkgVersion} → ${newVer} (dry-run, would be ${bumpType})`, status: 'skip' });
      steps.push({ step: 'npm publish: skipped (dry-run)', status: 'skip' });
      steps.push({ step: 'git push: skipped (dry-run)', status: 'skip' });
      steps.push({ step: 'gh release: skipped (dry-run)', status: 'skip' });
      return { success: true, dryRun: true, wouldPublish: `${pkgName}@${newVer}`, steps };
    }

    try {
      const newVers = execSync(`npm version ${bumpType} --no-git-tag-version`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
      }).trim();
      steps.push({ step: `version: ${pkgVersion} → ${newVers}`, status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `npm version failed: ${e.message}`, steps };
    }

    // 6. Git commit + tag
    const updatedPkg = JSON.parse(fsMod.readFileSync(pathMod.join(pkgPath, 'package.json'), 'utf-8'));
    const newVersion = updatedPkg.version;
    const tag = `v${newVersion}`;

    try {
      execSync(`git add package.json && git commit -m "release: ${tag}" && git tag ${tag}`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 15_000,
      });
      steps.push({ step: `git: committed + tagged ${tag}`, status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `git commit/tag failed: ${e.message}`, steps };
    }

    // 7. Git push
    try {
      const branch = (() => {
        try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 }).trim(); }
        catch { return 'main'; }
      })();
      execSync(`git push origin ${branch}`, { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
      execSync(`git push origin ${tag}`, { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
      steps.push({ step: 'git push: main + tag', status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `git push failed: ${e.message}`, steps };
    }

    // 8. npm publish
    try {
      const pubOut = execSync('npm publish', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      steps.push({ step: `npm: published ${pkgName}@${newVersion}`, status: 'ok', output: pubOut.trim() });
    } catch (e: any) {
      const errMsg = e.stderr || e.message || String(e);
      if (errMsg.includes('previously published') || errMsg.includes('EPUBLISHCONFLICT')) {
        steps.push({ step: `npm: ${pkgName}@${newVersion} already published`, status: 'ok' });
      } else {
        return { success: false, error: `npm publish failed: ${errMsg.slice(0, 500)}`, steps };
      }
    }

    // 9. GitHub Release
    try {
      const ghOut = execSync(`gh release create ${tag} --generate-notes`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
      });
      steps.push({ step: `gh release: ${tag}`, status: 'ok', output: ghOut.trim() });
    } catch (e: any) {
      steps.push({ step: `gh release: failed (non-fatal)`, status: 'fail', output: String(e.message || e).slice(0, 200) });
    }

    return {
      success: true,
      package: pkgName,
      version: newVersion,
      tag,
      npmUrl: `https://www.npmjs.com/package/${pkgName}/v/${newVersion}`,
      githubRelease: repoUrl ? `${repoUrl}/releases/tag/${tag}` : `tag ${tag} (no remote)`,
      steps,
    };
  },
};

export const devopsTools: RegisteredTool[] = [
  publishPackage,
];
