/**
 * Contract Test Validator — Layer 1-3 质量检查
 *
 * Layer 1: AC coverage check — 每个 acGroup 的 contractTests 是否覆盖所有 ACs
 * Layer 2: TypeScript syntax validation — 测试代码是否有语法错误
 * Layer 3: Import path validation — 测试中的 import 路径是否指向存在的文件
 *
 * 所有函数为纯函数，便于单元测试。
 * 监控日志: CT-1 (Validation), CT-2 (AC Coverage)
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';

// ========================================
// Types
// ========================================

export interface AcGroupInfo {
  id: string;
  acs: string[];
  files: string[];
}

export interface ContractTestInfo {
  file: string;
  content: string;
}

export interface Layer1Result {
  layer: 1;
  pass: boolean;
  acGroupId: string;
  totalAcs: number;
  coveredAcs: number;
  coverageRate: number;
  uncoveredAcs: string[];
  hasContractTests: boolean;
  skipReason?: string;
}

export interface Layer2Result {
  layer: 2;
  pass: boolean;
  acGroupId: string;
  testFile: string;
  syntaxErrors: Array<{ line: number; message: string }>;
}

export interface Layer3Result {
  layer: 3;
  pass: boolean;
  acGroupId: string;
  testFile: string;
  importPaths: Array<{
    path: string;
    resolved: boolean;
    reason?: string;
  }>;
}

export interface ValidationReport {
  layer1: Layer1Result[];
  layer2: Layer2Result[];
  layer3: Layer3Result[];
  overallPass: boolean;
}

// ========================================
// Layer 1: AC Coverage Check
// ========================================

/**
 * 检查 contractTests 是否覆盖 acGroup 的所有 ACs。
 *
 * 启发式策略：
 * 1. 检查 acGroup 是否有 contractTests（或 skipReason）
 * 2. 检查测试文件中 test/it 块数量 >= AC 数量
 * 3. 检查测试文件是否提及 acGroup id 或 AC 关键词
 */
export function checkAcCoverage(
  acGroup: AcGroupInfo,
  contractTests: ContractTestInfo[] | undefined,
  skipReason: string | undefined,
): Layer1Result {
  const totalAcs = acGroup.acs.length;

  // Case 1: 有 skipReason → 跳过检查，视为 pass
  if (!contractTests || contractTests.length === 0) {
    if (skipReason && skipReason.trim().length > 0) {
      const result: Layer1Result = {
        layer: 1,
        pass: true,
        acGroupId: acGroup.id,
        totalAcs,
        coveredAcs: 0,
        coverageRate: 0,
        uncoveredAcs: acGroup.acs,
        hasContractTests: false,
        skipReason,
      };
      return result;
    }

    // 无 contractTests 且无 skipReason → fail
    const result: Layer1Result = {
      layer: 1,
      pass: false,
      acGroupId: acGroup.id,
      totalAcs,
      coveredAcs: 0,
      coverageRate: 0,
      uncoveredAcs: acGroup.acs,
      hasContractTests: false,
    };
    return result;
  }

  // Case 2: 有 contractTests → 检查覆盖率
  const allTestContent = contractTests.map(t => t.content).join('\n');

  // 启发式 1: 计算 test/it 块数量
  const testBlockCount = countTestBlocks(allTestContent);

  // 启发式 2: 检查是否提及 acGroup id
  const mentionsAcGroupId = allTestContent.includes(acGroup.id);

  // 启发式 3: 检查是否提及 AC 关键词（提取 AC 中的关键词）
  const acKeywords = extractKeywords(acGroup.acs);
  const mentionedKeywords = acKeywords.filter(kw =>
    allTestContent.toLowerCase().includes(kw.toLowerCase()),
  );
  const keywordCoverage = acKeywords.length > 0 ? mentionedKeywords.length / acKeywords.length : 0;

  // 综合评估: 测试块数量 >= AC 数量，或有关键词覆盖
  const testBlockSufficient = testBlockCount >= totalAcs;
  const coverageHeuristic = Math.max(
    testBlockSufficient ? 1 : testBlockCount / totalAcs,
    keywordCoverage,
    mentionsAcGroupId ? 0.8 : 0,
  );

  const coveredAcs = Math.round(totalAcs * Math.min(coverageHeuristic, 1));
  const uncoveredAcs = acGroup.acs.slice(coveredAcs);

  const result: Layer1Result = {
    layer: 1,
    pass: coverageHeuristic >= 0.6, // 60% 阈值
    acGroupId: acGroup.id,
    totalAcs,
    coveredAcs,
    coverageRate: coverageHeuristic,
    uncoveredAcs,
    hasContractTests: true,
  };

  return result;
}

/**
 * 统计测试文件中 test/it 块的数量
 */
export function countTestBlocks(content: string): number {
  const patterns = [
    /\btest\s*\(/g,
    /\bit\s*\(/g,
    /\btest\.each\s*\(/g,
    /\bit\.each\s*\(/g,
    /\bdescribe\s*\(/g,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = content.match(pattern);
    count += matches ? matches.length : 0;
  }

  // describe 块不计入（只计 test/it）
  const describeMatches = content.match(/\bdescribe\s*\(/g);
  if (describeMatches) {
    count -= describeMatches.length;
  }

  return count;
}

/**
 * 从 AC 数组中提取关键词（去停用词）
 */
export function extractKeywords(acs: string[]): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this',
    'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  ]);

  const keywords = new Set<string>();
  for (const ac of acs) {
    const words = ac.toLowerCase().split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-z0-9]/g, '');
      if (cleaned.length > 2 && !stopWords.has(cleaned)) {
        keywords.add(cleaned);
      }
    }
  }

  return Array.from(keywords);
}

// ========================================
// Layer 2: TypeScript Syntax Validation
// ========================================

/**
 * 检查测试代码的 TypeScript 语法是否正确。
 */
export function validateTypeScriptSyntax(
  acGroupId: string,
  testFile: string,
  content: string,
): Layer2Result {
  const sourceFile = ts.createSourceFile(
    testFile,
    content,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  const syntaxErrors: Array<{ line: number; message: string }> = [];

  // 遍历 AST 节点收集语法错误
  function visit(node: ts.Node): void {
    if (ts.isExpressionStatement(node)) {
      // 检查是否有无效的表达式
      const expr = node.expression;
      if (ts.isCallExpression(expr)) {
        const callee = expr.expression;
        if (ts.isIdentifier(callee)) {
          const name = callee.text;
          // 检查 test/it/describe 是否缺少回调函数
          if (['test', 'it', 'describe'].includes(name)) {
            if (expr.arguments.length < 2) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              syntaxErrors.push({
                line: line + 1,
                message: `${name}() requires at least 2 arguments (name, callback)`,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // 检查是否有明显的语法错误（通过 transpileModule）
  try {
    const transpileResult = ts.transpileModule(content, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        strict: true,
        noEmit: false,
      },
      reportDiagnostics: true,
    });

    if (transpileResult.diagnostics && transpileResult.diagnostics.length > 0) {
      for (const diag of transpileResult.diagnostics) {
        const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
        let line = 0;
        if (diag.file && diag.start !== undefined) {
          const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
          line = pos.line + 1;
        }
        syntaxErrors.push({ line, message });
      }
    }
  } catch (e) {
    syntaxErrors.push({
      line: 0,
      message: `Transpile error: ${String(e)}`,
    });
  }

  return {
    layer: 2,
    pass: syntaxErrors.length === 0,
    acGroupId,
    testFile,
    syntaxErrors,
  };
}

// ========================================
// Layer 3: Import Path Validation
// ========================================

/**
 * 检查测试代码中的 import 路径是否指向存在的文件。
 *
 * @param worktree — worktree 目录，用于解析相对路径
 */
export function validateImportPaths(
  acGroupId: string,
  testFile: string,
  content: string,
  worktree: string,
): Layer3Result {
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  const importPaths: Array<{
    path: string;
    resolved: boolean;
    reason?: string;
  }> = [];

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // 跳过 node_modules 和 builtin 模块
    if (importPath.startsWith('node:') || !importPath.startsWith('.')) {
      importPaths.push({
        path: importPath,
        resolved: true,
        reason: 'external or builtin module',
      });
      continue;
    }

    // 解析相对路径
    const testFileDir = path.dirname(path.join(worktree, testFile));
    const resolved = resolveImportPath(importPath, testFileDir);

    if (resolved.exists) {
      importPaths.push({
        path: importPath,
        resolved: true,
      });
    } else {
      importPaths.push({
        path: importPath,
        resolved: false,
        reason: resolved.reason,
      });
    }
  }

  return {
    layer: 3,
    pass: importPaths.every(p => p.resolved),
    acGroupId,
    testFile,
    importPaths,
  };
}

/**
 * 解析 import 路径，尝试多种扩展名
 */
function resolveImportPath(
  importPath: string,
  baseDir: string,
): { exists: boolean; reason?: string } {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
  const fullPath = path.resolve(baseDir, importPath);

  // 直接匹配
  if (fs.existsSync(fullPath)) {
    return { exists: true };
  }

  // 尝试加扩展名
  for (const ext of extensions) {
    if (fs.existsSync(fullPath + ext)) {
      return { exists: true };
    }
  }

  // 尝试 index 文件
  for (const ext of extensions) {
    const indexPath = path.join(fullPath, 'index' + ext);
    if (fs.existsSync(indexPath)) {
      return { exists: true };
    }
  }

  return { exists: false, reason: `file not found: ${importPath}` };
}

// ========================================
// Aggregated Validation
// ========================================

/**
 * 执行所有 Layer 检查并生成报告。
 */
export function validateContractTests(
  requirementAcGroups: Array<{ id: string; acs: string[]; files: string[] }>,
  taskAcGroups: Array<{
    id: string;
    contractTests?: Array<{ file: string; content: string }>;
    contractTestsSkipReason?: string;
  }>,
  worktree: string,
): ValidationReport {
  const layer1: Layer1Result[] = [];
  const layer2: Layer2Result[] = [];
  const layer3: Layer3Result[] = [];

  for (const reqAcGroup of requirementAcGroups) {
    const taskAcGroup = taskAcGroups.find(t => t.id === reqAcGroup.id);
    if (!taskAcGroup) continue;

    const acGroupInfo: AcGroupInfo = {
      id: reqAcGroup.id,
      acs: reqAcGroup.acs,
      files: reqAcGroup.files,
    };

    // Layer 1: AC coverage
    const l1 = checkAcCoverage(
      acGroupInfo,
      taskAcGroup.contractTests,
      taskAcGroup.contractTestsSkipReason,
    );
    layer1.push(l1);

    // CT-1 monitoring: Layer 1 result
    logger.info('[ContractTest] Validation', {
      acGroupId: acGroupInfo.id,
      layer: 1,
      pass: l1.pass,
      hasContractTests: l1.hasContractTests,
      skipReason: l1.skipReason || '(none)',
      totalAcs: l1.totalAcs,
      coveredAcs: l1.coveredAcs,
      coverageRate: `${(l1.coverageRate * 100).toFixed(1)}%`,
      uncoveredAcs: l1.uncoveredAcs.slice(0, 5), // 只显示前 5 个
    });

    if (!l1.hasContractTests) continue;

    // Layer 2 + 3: 对每个 test file
    for (const test of taskAcGroup.contractTests || []) {
      const l2 = validateTypeScriptSyntax(acGroupInfo.id, test.file, test.content);
      layer2.push(l2);

      // CT-1 monitoring: Layer 2 result
      logger.info('[ContractTest] Validation', {
        acGroupId: acGroupInfo.id,
        layer: 2,
        pass: l2.pass,
        testFile: test.file,
        syntaxErrorCount: l2.syntaxErrors.length,
      });

      const l3 = validateImportPaths(acGroupInfo.id, test.file, test.content, worktree);
      layer3.push(l3);

      // CT-1 monitoring: Layer 3 result
      logger.info('[ContractTest] Validation', {
        acGroupId: acGroupInfo.id,
        layer: 3,
        pass: l3.pass,
        testFile: test.file,
        importCount: l3.importPaths.length,
        unresolvedCount: l3.importPaths.filter(p => !p.resolved).length,
      });
    }
  }

  // CT-2 monitoring: AC coverage summary
  const totalAcs = layer1.reduce((sum, l) => sum + l.totalAcs, 0);
  const coveredAcs = layer1.reduce((sum, l) => sum + l.coveredAcs, 0);
  const overallCoverageRate = totalAcs > 0 ? coveredAcs / totalAcs : 0;

  logger.info('[ContractTest] AC Coverage', {
    totalAcs,
    coveredAcs,
    coverageRate: `${(overallCoverageRate * 100).toFixed(1)}%`,
    acGroupsWithTests: layer1.filter(l => l.hasContractTests).length,
    acGroupsWithSkip: layer1.filter(l => l.skipReason).length,
    acGroupsWithoutTests: layer1.filter(l => !l.hasContractTests && !l.skipReason).length,
    uncoveredAcs: layer1.flatMap(l => l.uncoveredAcs).slice(0, 10), // 前 10 个
  });

  const overallPass =
    layer1.every(l => l.pass) &&
    layer2.every(l => l.pass) &&
    layer3.every(l => l.pass);

  return {
    layer1,
    layer2,
    layer3,
    overallPass,
  };
}
