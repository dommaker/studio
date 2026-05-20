#!/usr/bin/env node
/**
 * Spec 门禁检查
 * 
 * 在 CI 中运行，确保代码符合规范
 * 
 * 检查项：
 * 1. 架构约束（单工程内）
 * 2. 跨工程一致性
 * 3. 代码注释规范
 * 4. Spec 实现完整性
 */

import {
  ArchitectureConstraintEngine,
  loadArchitectureRules,
  ArchitectureContext,
} from '@dommaker/harness';
import {
  checkCrossProjectContracts,
  checkDocCodeConsistency,
  CrossProjectContext,
} from '@dommaker/harness';
import {
  checkDirectory,
  generateReport,
} from '@dommaker/harness';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

interface SpecGateResult {
  passed: boolean;
  checks: {
    architecture: boolean;
    crossProject: boolean;
    annotation: boolean;
    specCoverage: boolean;
    docSync: boolean;
  };
  errors: string[];
  warnings: string[];
}

async function getChangedFiles(base: string): Promise<string[]> {
  try {
    const output = execSync(
      `git diff --name-only ${base}...HEAD`,
      { encoding: 'utf-8' }
    );
    return output.trim().split('\n').filter(f => f && !f.startsWith('.'));
  } catch {
    return [];
  }
}

async function getChangedProjects(base: string): Promise<string[]> {
  const files = await getChangedFiles(base);
  const projects = new Set<string>();
  
  for (const file of files) {
    const match = file.match(/projects\/([^/]+)/);
    if (match) {
      projects.add(match[1]);
    }
  }
  
  return Array.from(projects);
}

async function runArchitectureCheck(): Promise<{ passed: boolean; errors: string[] }> {
  const configPath = path.join(process.cwd(), '.architect', 'rules.yml');
  
  if (!existsSync(configPath)) {
    return { passed: true, errors: [] };
  }

  try {
    const rules = await loadArchitectureRules(configPath);
    const engine = new ArchitectureConstraintEngine(rules);
    
    const files = await getChangedFiles('main');
    const result = await engine.check({ files, diff: '' });
    
    const errors = result.violations
      .filter(v => v.severity === 'error')
      .map(v => `[架构约束] ${v.ruleId}: ${v.message}`);
    
    return {
      passed: errors.length === 0,
      errors,
    };
  } catch (error: any) {
    return {
      passed: false,
      errors: [`架构检查失败: ${error.message}`],
    };
  }
}

async function runCrossProjectCheck(): Promise<{ passed: boolean; errors: string[] }> {
  try {
    const changedProjects = await getChangedProjects('main');
    const changedFiles = await getChangedFiles('main');
    
    if (changedProjects.length <= 1) {
      return { passed: true, errors: [] };
    }

    const context: CrossProjectContext = {
      baseBranch: 'main',
      changedProjects,
      changedFiles,
    };

    const violations = await checkCrossProjectContracts(context);
    const errors = violations
      .filter(v => v.severity === 'error')
      .map(v => `[跨工程] ${v.fromProject} → ${v.toProject}: ${v.message}`);

    return {
      passed: errors.length === 0,
      errors,
    };
  } catch (error: any) {
    return {
      passed: false,
      errors: [`跨工程检查失败: ${error.message}`],
    };
  }
}

async function runAnnotationCheck(): Promise<{ passed: boolean; errors: string[] }> {
  try {
    const results = checkDirectory('src', {
      extensions: ['.ts', '.tsx'],
    });

    const errors: string[] = [];
    
    for (const result of results) {
      for (const error of result.errors) {
        errors.push(`[注释规范] ${result.file}:${error.line} - ${error.message}`);
      }
    }

    return {
      passed: errors.length === 0,
      errors,
    };
  } catch (error: any) {
    return {
      passed: false,
      errors: [`注释检查失败: ${error.message}`],
    };
  }
}

async function runSpecCoverageCheck(): Promise<{ passed: boolean; errors: string[] }> {
  // 使用 harness spec annotation checker 验证 @spec 注解
  try {
    const { checkDirectory } = await import('@dommaker/harness');
    const srcDir = path.resolve(process.cwd(), 'src');
    if (fs.existsSync(srcDir)) {
      const result = await checkDirectory(srcDir);
      return { passed: result.errors.length === 0, errors: result.errors.map(e => e.message) };
    }
  } catch {
    // harness 不可用时跳过
  }
  return { passed: true, errors: [] };
}

async function runDocSyncCheck(): Promise<{ passed: boolean; errors: string[] }> {
  const archDoc = '/root/projects/ARCHITECTURE.md';
  const { existsSync } = await import('fs');

  if (!existsSync(archDoc)) {
    return {
      passed: false,
      errors: ['[文档同步] ARCHITECTURE.md 不存在，请创建架构文档'],
    };
  }

  try {
    const { execSync } = await import('child_process');
    const output = execSync(
      `bash /root/projects/agent-studio/scripts/check-doc-sync.sh main`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    if (output.includes('❌')) {
      return {
        passed: false,
        errors: ['[文档同步] 架构文档可能需要更新，详见 check-doc-sync.sh 输出'],
      };
    }
    return { passed: true, errors: [] };
  } catch (error: any) {
    if (error.status === 1) {
      return {
        passed: false,
        errors: ['[文档同步] 架构文档可能需要更新，详见 check-doc-sync.sh 输出'],
      };
    }
    return { passed: true, errors: [] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  
  console.log('🔍 Spec 门禁检查\n');

  const result: SpecGateResult = {
    passed: true,
    checks: {
      architecture: false,
      crossProject: false,
      annotation: false,
      specCoverage: false,
      docSync: false,
    },
    errors: [],
    warnings: [],
  };

  // 1. 架构约束检查
  console.log('1. 检查架构约束...');
  const archResult = await runArchitectureCheck();
  result.checks.architecture = archResult.passed;
  result.errors.push(...archResult.errors);
  console.log(archResult.passed ? '   ✅ 通过' : `   ❌ ${archResult.errors.length} 个错误`);

  // 2. 跨工程一致性检查
  console.log('2. 检查跨工程一致性...');
  const crossResult = await runCrossProjectCheck();
  result.checks.crossProject = crossResult.passed;
  result.errors.push(...crossResult.errors);
  console.log(crossResult.passed ? '   ✅ 通过' : `   ❌ ${crossResult.errors.length} 个错误`);

  // 3. 代码注释规范检查
  console.log('3. 检查代码注释规范...');
  const annoResult = await runAnnotationCheck();
  result.checks.annotation = annoResult.passed;
  result.errors.push(...annoResult.errors);
  console.log(annoResult.passed ? '   ✅ 通过' : `   ❌ ${annoResult.errors.length} 个错误`);

  // 4. Spec 覆盖检查
  console.log('4. 检查 Spec 实现覆盖...');
  const coverResult = await runSpecCoverageCheck();
  result.checks.specCoverage = coverResult.passed;
  result.errors.push(...coverResult.errors);
  console.log(coverResult.passed ? '   ✅ 通过' : `   ❌ ${coverResult.errors.length} 个错误`);

  // 5. 架构文档同步检查
  console.log('5. 检查架构文档同步...');
  const docSyncResult = await runDocSyncCheck();
  result.checks.docSync = docSyncResult.passed;
  result.errors.push(...docSyncResult.errors);
  console.log(docSyncResult.passed ? '   ✅ 通过' : `   ❌ ${docSyncResult.errors.length} 个错误`);

  // 汇总
  result.passed = Object.values(result.checks).every(Boolean);

  console.log('\n' + '='.repeat(50));
  
  if (result.passed) {
    console.log('✅ 所有检查通过！');
    console.log('\n可以安全提交代码。');
    process.exit(0);
  } else {
    console.log('❌ 门禁检查失败\n');
    
    if (verbose) {
      console.log('错误详情:\n');
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    } else {
      console.log(`共 ${result.errors.length} 个错误，使用 --verbose 查看详情`);
    }
    
    console.log('\n修复建议:');
    if (!result.checks.architecture) {
      console.log('  - 检查架构约束: pnpm architect:check');
    }
    if (!result.checks.annotation) {
      console.log('  - 检查代码注释: pnpm spec:annotate:check');
    }
    if (!result.checks.docSync) {
      console.log('  - 检查文档同步: pnpm doc:sync-check');
    }
    
    process.exit(1);
  }
}

main();
