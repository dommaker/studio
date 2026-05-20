/**
 * Spec Markdown 解析器
 *
 * 从 Spec 文件中提取结构化内容，供 agent 上下文加载使用。
 * 提取自 SpecValidatorService，可独立复用。
 *
 * 用法：
 * ```typescript
 * import { parseSpecMarkdown, loadSpecFile } from '@dommaker/studio-shared';
 *
 * // 从文件加载
 * const spec = await loadSpecFile('/path/to/spec.md');
 *
 * // 从内容解析
 * const spec = parseSpecMarkdown(content, 'spec-id');
 * ```
 */

import { readFileSync, existsSync } from 'fs';

// Spec 内容类型（解析后）
export interface SpecContent {
  metadata: {
    id: string;
    title?: string;
    status?: 'draft' | 'in_progress' | 'completed' | 'deprecated';
    created?: string;
    updated?: string;
  };
  architecture?: {
    dependencies?: string[];
    data_models?: string[];
  };
  api?: {
    endpoints?: ApiEndpoint[];
    schemas?: Record<string, SchemaDefinition>;
  };
  acceptance_criteria?: AcceptanceCriterion[];
}

// API Endpoint 定义
export interface ApiEndpoint {
  path: string;
  method: string;
  request?: string;
  response?: string;
}

// Schema 定义
export interface SchemaDefinition {
  type: string;
  properties?: Record<string, unknown>;
}

// Acceptance Criterion
export interface AcceptanceCriterion {
  id: string;
  description: string;
  test?: string;
  passes?: boolean;
}

/**
 * 加载 Spec 文件
 */
export function loadSpecFile(specPath: string): SpecContent {
  if (!existsSync(specPath)) {
    throw new Error(`Spec 文件不存在: ${specPath}`);
  }

  const content = readFileSync(specPath, 'utf-8');
  return parseSpecMarkdown(content, specPath);
}

/**
 * 解析 Markdown 格式的 Spec 文件
 */
export function parseSpecMarkdown(content: string, filePathOrId: string): SpecContent {
  const lines = content.split('\n');

  // 解析元数据
  const metadata = parseMetadata(lines, filePathOrId);

  // 解析 API endpoints
  const endpoints = parseApiEndpoints(lines);

  // 解析验收条件
  const acceptanceCriteria = parseAcceptanceCriteria(lines);

  // 解析架构依赖
  const architecture = parseArchitecture(lines);

  const spec: SpecContent = { metadata };
  if (endpoints.length > 0) spec.api = { endpoints };
  if (acceptanceCriteria.length > 0) spec.acceptance_criteria = acceptanceCriteria;
  if (architecture.dependencies?.length || architecture.data_models?.length) {
    spec.architecture = architecture;
  }

  return spec;
}

/**
 * 解析元数据
 */
function parseMetadata(lines: string[], filePath: string): SpecContent['metadata'] {
  // 从标题提取 ID: # DD-006: ...
  const titleLine = lines.find(l => l.startsWith('# '));
  const titleMatch = titleLine?.match(/^#\s+(\S+):\s*(.+)/);
  const id = titleMatch?.[1] ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'unknown';
  const title = titleMatch?.[2]?.trim();

  // 从元数据行提取状态
  const statusLine = lines.find(l => l.includes('**状态**'));
  let status: SpecContent['metadata']['status'];
  if (statusLine) {
    if (statusLine.includes('已实现') || statusLine.includes('已完成')) status = 'completed';
    else if (statusLine.includes('进行中')) status = 'in_progress';
    else if (statusLine.includes('废弃') || statusLine.includes('已弃用')) status = 'deprecated';
    else status = 'draft';
  }

  // 提取创建时间
  const createdLine = lines.find(l => l.includes('**创建时间**'));
  const createdMatch = createdLine?.match(/\*\*创建时间\*\*:\s*(.+)/);
  const created = createdMatch?.[1]?.trim();

  return { id, title, status, created };
}

/**
 * 解析 API endpoints
 */
function parseApiEndpoints(lines: string[]): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  // 找到 API 设计段落中的表格
  let inApiSection = false;
  for (const line of lines) {
    if (line.match(/^##\s+.*API/i) || line.match(/^##\s+.*端点/i)) {
      inApiSection = true;
      continue;
    }
    if (inApiSection && line.match(/^##\s/)) break; // 下一段落

    if (inApiSection) {
      // 匹配表格行: | `/path` | METHOD | 说明 |
      const tableMatch = line.match(/^\|\s*`([^`]+)`\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|/i);
      if (tableMatch) {
        endpoints.push({
          path: tableMatch[1],
          method: tableMatch[2].toUpperCase(),
        });
      }
    }
  }

  return endpoints;
}

/**
 * 解析验收条件
 */
function parseAcceptanceCriteria(lines: string[]): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];

  let inAcSection = false;
  for (const line of lines) {
    if (line.match(/^##\s+.*验收/i) || line.match(/^##\s+.*AC/i)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && line.match(/^##\s/)) break;

    if (inAcSection) {
      // 匹配: | **AC-001** | 说明 | 测试场景 |
      const acMatch = line.match(/^\|\s*\*\*(AC-\d+)\*\*\s*\|\s*([^|]+)/);
      if (acMatch) {
        criteria.push({
          id: acMatch[1],
          description: acMatch[2].trim(),
        });
      }
    }
  }

  return criteria;
}

/**
 * 解析架构依赖和数据模型
 */
function parseArchitecture(lines: string[]): NonNullable<SpecContent['architecture']> {
  const dependencies: string[] = [];
  const dataModels: string[] = [];

  let inDataSection = false;
  for (const line of lines) {
    // 数据模型表: | 字段 | 类型 | ... |
    if (line.match(/^##\s+.*数据模型/i) || line.match(/^##\s+.*新增字段/i)) {
      inDataSection = true;
      continue;
    }
    if (inDataSection && line.match(/^##\s/)) break;

    if (inDataSection) {
      const fieldMatch = line.match(/^\|\s*(\w+)\s*\|/);
      if (fieldMatch && !line.match(/^\|\s*字段/) && !line.match(/^\|\s*---/)) {
        dataModels.push(fieldMatch[1]);
      }
    }
  }

  return { dependencies, data_models: dataModels };
}