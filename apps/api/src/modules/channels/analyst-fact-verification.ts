/**
 * Analyst Fact Verification — 事实验证层 (D6)
 *
 * 纯代码，无 LLM。验证 Analyst 产出的 architectureContext 声明
 * 是否与实际代码库一致。
 *
 * 两个检查：
 *   1. import 路径是否可解析（文件存在）
 *   2. 函数名是否在声明的文件中存在
 *
 * 不检查的内容（由 RequirementGate Stage 1 覆盖）：
 *   - acGroup.files 文件存在性
 *   - 依赖闭环
 *   - AC 结构质量
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';

export interface FactCheckResult {
  name: string;
  passed: boolean;
  message: string;
}

interface AcGroupForVerification {
  id: string;
  files?: string[];
  architectureContext?: {
    functions?: string[];
    imports?: string[];
    [key: string]: unknown;
  };
}

/**
 * 提取 import 路径中的模块路径
 * 例: `import { foo } from './bar.js'` → `./bar.js`
 *     `import { foo } from '@dommaker/studio-shared'` → `@dommaker/studio-shared`
 */
function extractImportPath(importStatement: string): string | null {
  // Match: from '...' or from "..."
  const fromMatch = importStatement.match(/from\s+['"]([^'"]+)['"]/);
  if (fromMatch) return fromMatch[1];

  // Match: import '...' (side-effect import)
  const sideEffectMatch = importStatement.match(/import\s+['"]([^'"]+)['"]/);
  if (sideEffectMatch) return sideEffectMatch[1];

  // Match: require('...')
  const requireMatch = importStatement.match(/require\(['"]([^'"]+)['"]\)/);
  if (requireMatch) return requireMatch[1];

  return null;
}

/**
 * 解析 import 路径为文件系统路径
 * - 相对路径: 基于 sourceFile 所在目录解析
 * - 包路径 (@dommaker/xxx, lodash): 跳过（不验证 node_modules）
 * - 绝对路径: 直接使用
 */
function resolveImportPath(
  importPath: string,
  sourceFile: string,
  repoDir: string,
): string | null {
  // 包路径 → 跳过
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null; // can't verify node_modules
  }

  const sourceDir = path.dirname(sourceFile);
  const resolved = path.resolve(sourceDir, importPath);

  // Strip existing extension to try alternatives
  const ext = path.extname(resolved);
  const base = ext ? resolved.slice(0, -ext.length) : resolved;

  // 尝试常见扩展名（已有扩展时优先匹配，再试无扩展名）
  const extensions = ext
    ? [ext, '', ...['.ts', '.js'].filter(e => e !== ext)]
    : ['', '.ts', '.js', '.tsx', '.jsx', '.mts', '.mjs'];
  const indexSuffixes = ['/index.ts', '/index.js'];
  for (const e of extensions) {
    const candidate = base + e;
    if (fs.existsSync(candidate)) return candidate;
  }
  // Also try index files for directory imports
  for (const suffix of indexSuffixes) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * 从函数签名中提取函数名
 * 支持格式：
 *   - `functionName(params): type`
 *   - `function functionName(params)`
 *   - `async function functionName(params)`
 *   - `const functionName = (params) =>`
 *   - `export function functionName(params)`
 *   - `class.method(params)`
 */
function extractFunctionName(signature: string): string | null {
  // Remove leading export/default/async/declare
  const cleaned = signature
    .replace(/^(export\s+(default\s+)?)?/, '')
    .replace(/^(async\s+)?/, '')
    .replace(/^(declare\s+)?/, '')
    .trim();

  // function name(...)
  const funcMatch = cleaned.match(/^function\s+(\w+)/);
  if (funcMatch) return funcMatch[1];

  // const/let/var name = ...
  const constMatch = cleaned.match(/^(?:const|let|var)\s+(\w+)/);
  if (constMatch) return constMatch[1];

  // name(...) — direct function signature
  const directMatch = cleaned.match(/^(\w+)\s*\(/);
  if (directMatch) return directMatch[1];

  // class.method(...)
  const methodMatch = cleaned.match(/^(\w+\.\w+)\s*\(/);
  if (methodMatch) return methodMatch[1].split('.')[1];

  // Getter/setter: get name() / set name()
  const accessorMatch = cleaned.match(/^(?:get|set)\s+(\w+)/);
  if (accessorMatch) return accessorMatch[1];

  return null;
}

/**
 * 检查函数名是否在文件中存在
 * 简单 grep: 查找 `functionName` 或 `functionName:` 或 `functionName(`
 */
function checkFunctionExists(functionName: string, filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Check for:
    //   function functionName
    //   functionName: (  (object method shorthand)
    //   functionName = (  (const assignment)
    //   .functionName(  (method call/definition)
    //   "functionName"  (string reference — weak but acceptable)
    const patterns = [
      new RegExp(`\\bfunction\\s+${escapeRegex(functionName)}\\b`),
      new RegExp(`\\b${escapeRegex(functionName)}\\s*[:=(]`),
      new RegExp(`\\.${escapeRegex(functionName)}\\s*\\(`),
      new RegExp(`\\b${escapeRegex(functionName)}\\s*\\(`),
    ];
    return patterns.some(p => p.test(content));
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析文件在 monorepo 中的实际路径
 * Analyst 可能写相对路径（如 src/modules/foo.ts）或包相对路径
 */
function resolveFilePath(filePath: string, repoDir: string): string | null {
  // Absolute
  if (path.isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }

  // Try repoDir first, then common subdirectories
  const tryDirs = [repoDir];
  for (const sub of ['apps/api', 'apps/web', 'packages/studio-shared', 'packages/studio-agent', 'packages/studio-skill', 'packages/studio-prisma']) {
    const candidate = path.join(repoDir, sub);
    if (fs.existsSync(candidate)) tryDirs.push(candidate);
  }

  for (const base of tryDirs) {
    const fullPath = path.join(base, filePath);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return null;
}

/**
 * 验证 Analyst 产出的 architectureContext 事实声明
 *
 * @param groups - acGroups 数组（完整格式，含 architectureContext）
 * @param repoDir - 仓库根目录
 * @returns 检查结果列表（空 = 全部通过）
 */
export function verifyAnalystFacts(
  groups: AcGroupForVerification[],
  repoDir: string,
): FactCheckResult[] {
  const results: FactCheckResult[] = [];

  for (const group of groups) {
    const ctx = group.architectureContext;
    if (!ctx) continue; // architectureContext 是可选的

    // Check 1: import 路径验证
    if (Array.isArray(ctx.imports)) {
      for (const importStmt of ctx.imports) {
        const importPath = extractImportPath(importStmt);
        if (!importPath) {
          results.push({
            name: 'import-parse',
            passed: false,
            message: `组 "${group.id}" 的 import 语句无法解析路径: "${importStmt}"`,
          });
          continue;
        }

        // 包路径跳过
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
          continue;
        }

        // 需要知道源文件位置才能解析相对路径
        // 如果 group.files 有值，用第一个文件作为参考点
        const sourceFile = group.files?.[0];
        if (!sourceFile) continue;

        const resolvedSource = resolveFilePath(sourceFile, repoDir);
        if (!resolvedSource) continue; // source file not found, RequirementGate handles this

        const resolvedImport = resolveImportPath(importPath, resolvedSource, repoDir);
        if (!resolvedImport) {
          results.push({
            name: 'import-not-found',
            passed: false,
            message: `组 "${group.id}" 声明的 import "${importPath}" 无法解析（文件不存在）`,
          });
        }
      }
    }

    // Check 2: 函数存在性验证
    if (Array.isArray(ctx.functions) && group.files?.length) {
      for (const funcSig of ctx.functions) {
        const funcName = extractFunctionName(funcSig);
        if (!funcName) {
          results.push({
            name: 'function-parse',
            passed: false,
            message: `组 "${group.id}" 的函数签名无法解析: "${funcSig}"`,
          });
          continue;
        }

        // 在 group.files 中查找函数
        let found = false;
        for (const filePath of group.files) {
          const resolved = resolveFilePath(filePath, repoDir);
          if (resolved && checkFunctionExists(funcName, resolved)) {
            found = true;
            break;
          }
        }

        if (!found) {
          results.push({
            name: 'function-not-found',
            passed: false,
            message: `组 "${group.id}" 声明的函数 "${funcName}" 在关联文件中未找到`,
          });
        }
      }
    }
  }

  if (results.length === 0) {
    results.push({ name: 'fact-check-summary', passed: true, message: '所有事实验证通过' });
  }

  return results;
}
