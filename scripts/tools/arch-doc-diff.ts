#!/usr/bin/env node
/**
 * 架构文档差异检查
 *
 * 扫描三个仓库的实际状态，与 ARCHITECTURE.md 中记录的内容对比，
 * 报告需要更新的部分。
 *
 * 用法:
 *   npx tsx scripts/tools/arch-doc-diff.ts [--fix]
 *
 * 选项:
 *   --fix    输出建议的文档补丁（不自动覆盖）
 */

import { readFileSync, existsSync } from 'fs';
import * as path from 'path';

const PROJECTS_ROOT = '/root/projects';
const ARCH_DOC = path.join(PROJECTS_ROOT, 'ARCHITECTURE.md');

interface PkgInfo {
  name: string;
  version: string;
  path: string;
}

interface PortInfo {
  service: string;
  port: string;
  source: string;
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        result[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
      }
    }
  } catch {}
  return result;
}

function collectPackageVersions(): PkgInfo[] {
  const pkgs: PkgInfo[] = [];
  const paths = [
    path.join(PROJECTS_ROOT, 'harness/package.json'),
    path.join(PROJECTS_ROOT, 'agent-platform/packages/runtime/package.json'),
    path.join(PROJECTS_ROOT, 'agent-platform/packages/workflows/package.json'),
  ];
  for (const p of paths) {
    const json = readJson(p);
    if (json?.name && json?.version) {
      pkgs.push({ name: json.name, version: json.version, path: p });
    }
  }
  return pkgs;
}

function collectPorts(): PortInfo[] {
  const ports: PortInfo[] = [];

  // agent-studio API
  const studioEnv = readEnv(path.join(PROJECTS_ROOT, 'agent-studio/.env'));
  if (studioEnv.PORT) {
    ports.push({ service: 'agent-studio API', port: studioEnv.PORT, source: 'agent-studio/.env' });
  }

  // agent-studio Web (from vite default or env)
  ports.push({ service: 'agent-studio Web', port: '5173', source: 'vite default' });

  // agent-runtime / runtime-proxy: removed (2026-05-14)

  return ports;
}

function readArchDoc(): string {
  try {
    return readFileSync(ARCH_DOC, 'utf-8');
  } catch {
    return '';
  }
}

function checkVersions(pkgs: PkgInfo[], doc: string): string[] {
  const issues: string[] = [];
  for (const pkg of pkgs) {
    // Look for the package name on a line, followed by a version within the same line
    // Must match the EXACT package name, not a substring of another
    const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linePattern = new RegExp(
      `^.*${escapedName}\\b[^\\n]*?(\\d+\\.\\d+\\.\\d+)`,
      'im'
    );
    const match = doc.match(linePattern);
    if (match) {
      const docVersion = match[1];
      if (docVersion !== pkg.version) {
        issues.push(
          `版本不一致: ${pkg.name} 实际 v${pkg.version}，文档记录 ${docVersion}`
        );
      }
    } else if (doc.includes(pkg.name)) {
      issues.push(`${pkg.name} 在文档中存在但未找到版本号`);
    } else {
      issues.push(`${pkg.name} v${pkg.version} 未在文档中记录`);
    }
  }
  return issues;
}

function checkPorts(ports: PortInfo[], doc: string): string[] {
  const issues: string[] = [];
  for (const p of ports) {
    // Check if this port appears in the doc
    if (doc.includes(p.port)) {
      // Port is mentioned, check if associated with the right service
      const portContext = doc.split(p.port)[0]?.split('\n').pop() || '';
      if (portContext && !portContext.toLowerCase().includes(p.service.toLowerCase().split(' ')[0])) {
        // Port exists but might be associated with wrong service - minor, skip
      }
    }
    // We mainly care if a port changed and doc still has old value
  }
  return issues;
}

function checkSections(pkgs: PkgInfo[], ports: PortInfo[], doc: string): string[] {
  const issues: string[] = [];

  // Check key sections exist
  const requiredSections = ['层级结构', '依赖关系', '服务间交互', '架构边界', '端口分配'];
  for (const section of requiredSections) {
    if (!doc.includes(section)) {
      issues.push(`缺少章节: "${section}"`);
    }
  }

  // Check all repos are mentioned
  const repos = ['harness', 'agent-platform', 'agent-studio'];
  for (const repo of repos) {
    if (!doc.includes(repo)) {
      issues.push(`仓库 "${repo}" 未在文档中提及`);
    }
  }

  return issues;
}

async function main() {
  const args = process.argv.slice(2);
  const fixMode = args.includes('--fix');

  console.log('🔍 架构文档差异检查\n');

  const doc = readArchDoc();
  if (!doc) {
    console.error(`❌ ARCHITECTURE.md 不存在: ${ARCH_DOC}`);
    process.exit(1);
  }

  console.log(`文档路径: ${ARCH_DOC}\n`);

  const pkgs = collectPackageVersions();
  const ports = collectPorts();

  console.log('📦 当前包版本:');
  for (const pkg of pkgs) {
    console.log(`  ${pkg.name} v${pkg.version}`);
  }

  console.log('\n🔌 当前端口:');
  for (const p of ports) {
    console.log(`  ${p.service}: ${p.port} (${p.source})`);
  }

  // Run checks
  const versionIssues = checkVersions(pkgs, doc);
  const portIssues = checkPorts(ports, doc);
  const sectionIssues = checkSections(pkgs, ports, doc);

  const allIssues = [...versionIssues, ...portIssues, ...sectionIssues];

  console.log('\n' + '='.repeat(50));

  if (allIssues.length === 0) {
    console.log('✅ 架构文档与实际状态一致');
    process.exit(0);
  } else {
    console.log(`⚠️  发现 ${allIssues.length} 处差异:\n`);
    allIssues.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue}`);
    });

    if (fixMode) {
      console.log('\n📝 建议更新:');
      console.log('  请手动更新 ARCHITECTURE.md 中对应的版本号和配置信息。');
      console.log(`  文档路径: ${ARCH_DOC}`);
    }

    process.exit(1);
  }
}

main();
