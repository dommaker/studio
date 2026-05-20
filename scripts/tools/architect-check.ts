#!/usr/bin/env node
/**
 * 架构约束检查脚本
 * 
 * 用法:
 *   node scripts/architect-check.ts [options]
 * 
 * 选项:
 *   --diff <base>     检查 git diff
 *   --files <list>    检查指定文件
 *   --pr <number>     检查 PR
 *   --fix             尝试自动修复
 */

import { runArchitectureCheck, ArchitectureContext } from '@dommaker/harness';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.join(process.cwd(), '.architect', 'rules.yml');

async function getChangedFiles(base?: string): Promise<string[]> {
  try {
    const cmd = base 
      ? `git diff --name-only ${base}...HEAD`
      : 'git diff --name-only HEAD~1';
    
    const output = execSync(cmd, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(f => f);
  } catch {
    return [];
  }
}

async function getGitDiff(base?: string): Promise<string> {
  try {
    const cmd = base
      ? `git diff ${base}...HEAD`
      : 'git diff HEAD~1';
    
    return execSync(cmd, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const diffIndex = args.indexOf('--diff');
  const filesIndex = args.indexOf('--files');
  
  // 检查配置文件是否存在
  if (!existsSync(CONFIG_PATH)) {
    console.error(`❌ 配置文件不存在: ${CONFIG_PATH}`);
    process.exit(1);
  }

  // 获取变更文件
  let files: string[] = [];
  let diff = '';
  
  if (diffIndex !== -1) {
    const base = args[diffIndex + 1] || 'main';
    files = await getChangedFiles(base);
    diff = await getGitDiff(base);
  } else if (filesIndex !== -1) {
    files = args[filesIndex + 1]?.split(',') || [];
  } else {
    // 默认检查当前变更
    files = await getChangedFiles();
    diff = await getGitDiff();
  }

  if (files.length === 0) {
    console.log('✅ 没有文件变更，跳过检查');
    process.exit(0);
  }

  console.log(`🔍 检查 ${files.length} 个文件的架构约束...\n`);

  // 构建上下文
  const context: ArchitectureContext = {
    files,
    diff,
  };

  // 运行检查
  try {
    const result = await runArchitectureCheck(CONFIG_PATH, context);

    // 输出结果
    const errors = result.violations.filter(v => v.severity === 'error');
    const warnings = result.violations.filter(v => v.severity === 'warning');

    if (errors.length > 0) {
      console.error(`\n❌ ${errors.length} 个错误:\n`);
      errors.forEach((v, i) => {
        console.error(`  ${i + 1}. [${v.ruleId}]`);
        console.error(`     ${v.message}`);
        if (v.files) {
          console.error(`     文件: ${v.files.join(', ')}`);
        }
        console.error('');
      });
    }

    if (warnings.length > 0) {
      console.warn(`\n⚠️  ${warnings.length} 个警告:\n`);
      warnings.forEach((v, i) => {
        console.warn(`  ${i + 1}. [${v.ruleId}]`);
        console.warn(`     ${v.message}`);
        console.warn('');
      });
    }

    if (result.passed) {
      console.log('✅ 架构检查通过！');
      if (warnings.length > 0) {
        console.log('   (有警告，但不影响合并)');
      }
      process.exit(0);
    } else {
      console.error('\n❌ 架构检查失败，请修复上述错误后再提交。');
      console.error('\n参考文档: docs/architecture/agent-system-architecture.md');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 检查过程出错:', error);
    process.exit(1);
  }
}

main();
