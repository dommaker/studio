#!/usr/bin/env node
/**
 * 跨工程一致性检查
 * 
 * 检查多工程开发时的接口一致性问题
 * 
 * 用法:
 *   npx tsx scripts/cross-project-check.ts [options]
 * 
 * 选项:
 *   --base <branch>   对比分支 (默认: main)
 *   --doc <path>      检查文档-代码一致性
 */

import { 
  checkCrossProjectContracts, 
  checkDocCodeConsistency,
  CrossProjectContext 
} from '@dommaker/harness';
import { execSync } from 'child_process';

async function getChangedProjects(base: string): Promise<string[]> {
  try {
    const output = execSync(
      `git diff --name-only ${base}...HEAD`,
      { encoding: 'utf-8' }
    );
    
    const files = output.trim().split('\n').filter(f => f);
    const projects = new Set<string>();
    
    for (const file of files) {
      const match = file.match(/(?:packages|apps)\/([^/]+)/);
      if (match) {
        projects.add(match[1]);
      }
    }
    
    return Array.from(projects);
  } catch {
    return [];
  }
}

async function getChangedFiles(base: string): Promise<string[]> {
  try {
    const output = execSync(
      `git diff --name-only ${base}...HEAD`,
      { encoding: 'utf-8' }
    );
    return output.trim().split('\n').filter(f => f);
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const docIndex = args.indexOf('--doc');
  
  const base = baseIndex !== -1 ? args[baseIndex + 1] : 'main';
  const docPath = docIndex !== -1 ? args[docIndex + 1] : null;
  
  console.log('🔍 跨工程一致性检查\n');
  
  const changedProjects = await getChangedProjects(base);
  const changedFiles = await getChangedFiles(base);
  
  if (changedProjects.length === 0) {
    console.log('✅ 没有工程变更');
    return;
  }
  
  console.log(`变更工程: ${changedProjects.join(', ')}`);
  console.log(`变更文件: ${changedFiles.length} 个\n`);
  
  let allViolations: any[] = [];
  
  // 1. 检查跨工程接口一致性
  const context: CrossProjectContext = {
    baseBranch: base,
    changedProjects,
    changedFiles,
  };
  
  console.log('检查跨工程接口一致性...');
  const contractViolations = await checkCrossProjectContracts(context);
  allViolations.push(...contractViolations);
  
  // 2. 检查文档-代码一致性
  if (docPath) {
    console.log(`检查文档-代码一致性 (${docPath})...`);
    const docViolations = await checkDocCodeConsistency(docPath, changedProjects);
    allViolations.push(...docViolations);
  }
  
  // 输出结果
  const errors = allViolations.filter(v => v.severity === 'error');
  const warnings = allViolations.filter(v => v.severity === 'warning');
  
  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} 个错误:\n`);
    errors.forEach((v, i) => {
      console.error(`  ${i + 1}. [${v.type}] ${v.fromProject} → ${v.toProject}`);
      console.error(`     ${v.message}`);
      if (v.details.interfaceName) {
        console.error(`     接口: ${v.details.interfaceName}`);
      }
      console.error('');
    });
  }
  
  if (warnings.length > 0) {
    console.warn(`\n⚠️  ${warnings.length} 个警告:\n`);
    warnings.forEach((v, i) => {
      console.warn(`  ${i + 1}. [${v.type}] ${v.message}`);
    });
  }
  
  if (allViolations.length === 0) {
    console.log('\n✅ 跨工程一致性检查通过！');
  } else if (errors.length === 0) {
    console.log('\n✅ 检查通过（有警告，但不影响合并）');
  } else {
    console.error(`\n❌ 发现 ${errors.length} 个跨工程一致性问题`);
    console.error('\n修复建议:');
    console.error('  - 接口变更时同步更新所有调用方');
    console.error('  - 破坏性变更需提供迁移方案');
    console.error('  - 确保文档与代码实现一致');
    process.exit(1);
  }
}

main();
