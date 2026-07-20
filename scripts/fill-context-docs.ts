#!/usr/bin/env tsx
/**
 * fill-context-docs.ts — CONTEXT.md LLM 填充器
 *
 * harness sync-docs 只生成 CONTEXT.md 空骨架（占位小节 + session-summary-agent
 * 后续插入的 ⚠️ / STALE_SINCE 过期标记）。本脚本用 LLM 按目录源码填充内容，
 * 是 studio 侧的知识消费者（harness 保持零-LLM 原语）。
 *
 * 行为：
 *   - 遍历 apps//packages 下所有 CONTEXT.md（排除 node_modules/dist/__tests__）
 *   - 四个受管小节：职责 / 核心导出 / 依赖关系 / 注意事项
 *     · 占位小节（空 / 纯 <!-- --> 注释 / harness 默认问题行）→ LLM 生成填充
 *     · 人工写过内容的小节 → 原样保留，永不覆盖
 *     · 其余小节（修复历史 等）→ 原样保留
 *   - 清除 ⚠️ 过期警告行与 <!-- STALE_SINCE --> 标记（session-summary-agent 会按新提交重新打标）
 *   - 成本可控：
 *     · 增量：填充记录（.harness/context-fill-state.json）记载 filledAt，
 *       仅当目录源码 git 最后提交晚于 filledAt 才重填（CONTEXT.md 自身提交除外）
 *     · 输入截断：每文件只取头部行，整目录封顶 maxChars
 *   - 默认 dry-run：只打印计划 + 估算 token，不写文件、不调 LLM
 *
 * 运行：
 *   npx tsx scripts/fill-context-docs.ts                    # dry-run 全仓
 *   npx tsx scripts/fill-context-docs.ts --fill <dir>       # 填充单个目录（如 apps/api/src/modules/skills）
 *   npx tsx scripts/fill-context-docs.ts --all              # 填充所有需要处理的目录
 *   npx tsx scripts/fill-context-docs.ts --all --force      # 忽略增量记录强制重填（仍保留人工小节）
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ─── 常量 ───

export const MANAGED_SECTIONS = ['职责', '核心导出', '依赖关系', '注意事项'] as const;

/** harness createContextMd 模板里的默认占位行 */
const HARNESS_PLACEHOLDER_LINES = new Set([
  '本目录的核心职责是？',
  '本目录对外暴露的主要模块/函数：',
  '本目录依赖哪些其他模块，谁依赖本目录？',
  '开发时需要注意的约束或约定：',
]);

const STALE_MARKER_RE = /<!--\s*STALE_SINCE:[^>]*-->/;
const STALE_WARN_RE = /⚠️\s*以下文件已变更，本节可能过期/;
/** 骨架模板遗留的 HTML 注释（混在人工内容里时也算垃圾行） */
const TEMPLATE_COMMENT_RE = /^\s*<!--\s*(本目录的核心职责是什么|本目录对外暴露的主要模块\/函数|本目录依赖哪些其他模块，谁依赖本目录|开发时需要注意的约束或约定)\s*-->\s*$/;

const DEFAULT_STATE_PATH = path.join('.harness', 'context-fill-state.json');

/** 源码摘要预算：控制单次 LLM 输入规模 */
export const DIGEST_LIMITS = {
  perFileLines: 80,
  maxChars: 20_000,
} as const;

// ─── 类型 ───

export interface ContextAnalysis {
  /** 含 ⚠️ 警告行或 STALE_SINCE 标记 */
  hasStaleMarkers: boolean;
  /** 占位的受管小节名 */
  placeholders: string[];
  /** 有人工内容的受管小节名 */
  humanManaged: string[];
  /** 缺失的受管小节名 */
  missingManaged: string[];
}

export interface FillRecord {
  filledAt: string; // ISO
  sourceCommit: string;
  /** 由本工具填充的小节（source-changed/force 时只重生成这些） */
  toolSections: string[];
}

export type FillState = Record<string, FillRecord>;

export type Action = 'skip' | 'strip' | 'fill';

export interface Decision {
  action: Action;
  reasons: string[];
  /** 需要 LLM 生成的小节 */
  sectionsToFill: string[];
}

export interface GeneratedSections {
  [section: string]: string;
}

export interface DirPlan {
  dir: string; // 相对 repoRoot 的目录
  contextPath: string; // 相对 repoRoot
  decision: Decision;
  estTokens: number; // fill 时的输入估算（digest + prompt 开销）
}

export interface RunSummary {
  plans: DirPlan[];
  filled: string[];
  stripped: string[];
  skipped: string[];
  errors: Array<{ dir: string; error: string }>;
  llmCalls: number;
  tokens: { prompt: number; completion: number };
  dryRun: boolean;
}

export interface RunDeps {
  /** LLM 生成（单测注入 mock）；缺省走 modelGateway */
  generate?: (system: string, user: string) => Promise<GeneratedSections>;
  /** 目录源码 git 最后提交时间（秒级 unix ts；无提交返回 null） */
  gitLastCommitTs?: (dir: string) => number | null;
  /** 当前时间（单测可固定） */
  now?: () => Date;
}

export interface RunOptions {
  repoRoot: string;
  /** 指定目录（相对路径）；'all' 表示全量 */
  target: 'all' | string;
  force?: boolean;
  dryRun: boolean;
  statePath?: string; // 绝对路径
}

// ─── 纯函数：解析 / 判定 / 合并 ───

/** 按 `## ` 标题切分文档，保留原文以便无损重组 */
export function splitSections(content: string): { header: string; sections: Array<{ name: string; body: string }> } {
  const lines = content.split('\n');
  const headerLines: string[] = [];
  const sections: Array<{ name: string; bodyLines: string[] }> = [];
  let current: { name: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = { name: m[1], bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  return {
    header: headerLines.join('\n'),
    sections: sections.map(s => ({ name: s.name, body: s.bodyLines.join('\n') })),
  };
}

function assembleSections(header: string, sections: Array<{ name: string; body: string }>): string {
  let out = header.replace(/\n+$/, '');
  for (const s of sections) {
    out += `\n\n## ${s.name}\n${s.body.replace(/\n+$/, '')}\n`;
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

/** 删除 ⚠️ 过期警告行、STALE_SINCE 标记行与模板占位注释行 */
export function stripStaleMarkers(content: string): string {
  const lines = content.split('\n');
  const kept = lines.filter(l => !STALE_MARKER_RE.test(l) && !STALE_WARN_RE.test(l) && !TEMPLATE_COMMENT_RE.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 小节体是否为模板占位（空 / 纯 HTML 注释 / harness 默认问题行） */
export function isPlaceholderBody(body: string): boolean {
  const meaningful = body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !STALE_MARKER_RE.test(l) && !STALE_WARN_RE.test(l));
  if (meaningful.length === 0) return true;
  return meaningful.every(l => /^<!--.*-->$/.test(l) || HARNESS_PLACEHOLDER_LINES.has(l));
}

export function analyzeContext(content: string): ContextAnalysis {
  const { sections } = splitSections(content);
  const byName = new Map(sections.map(s => [s.name, s.body]));
  const placeholders: string[] = [];
  const humanManaged: string[] = [];
  const missingManaged: string[] = [];

  for (const name of MANAGED_SECTIONS) {
    const body = byName.get(name);
    if (body === undefined) {
      missingManaged.push(name);
    } else if (isPlaceholderBody(body)) {
      placeholders.push(name);
    } else {
      humanManaged.push(name);
    }
  }

  return {
    hasStaleMarkers: STALE_MARKER_RE.test(content) || STALE_WARN_RE.test(content),
    placeholders,
    humanManaged,
    missingManaged,
  };
}

/**
 * 决策：skip / strip（仅清标记）/ fill（LLM 填充）。
 * sourceChanged：目录源码最后提交晚于填充记录 filledAt。
 */
export function decide(
  analysis: ContextAnalysis,
  record: FillRecord | undefined,
  sourceChanged: boolean,
  force: boolean,
): Decision {
  const reasons: string[] = [];
  if (analysis.hasStaleMarkers) reasons.push('stale-markers');
  if (analysis.placeholders.length > 0) reasons.push(`placeholder:${analysis.placeholders.join(',')}`);
  // 无填充记录时 sourceChanged 无意义（人工文档不因源码变更重填）
  if (sourceChanged && record) reasons.push('source-changed');
  if (force) reasons.push('force');
  if (reasons.length === 0) return { action: 'skip', reasons, sectionsToFill: [] };

  const toFill = new Set<string>(analysis.placeholders);
  if (sourceChanged || force) {
    for (const s of record?.toolSections ?? []) toFill.add(s);
  }
  const sectionsToFill = [...toFill];
  return { action: sectionsToFill.length > 0 ? 'fill' : 'strip', reasons, sectionsToFill };
}

/**
 * 合并：清除标记 + 用生成内容替换指定小节体。
 * 未指定的受管小节（人工内容）与非受管小节（修复历史 等）原样保留。
 * 生成内容里残留的占位 HTML 注释行一并剔除（受管小节不应含模板注释）。
 */
export function mergeGenerated(original: string, generated: GeneratedSections, sectionsToFill: string[]): string {
  const cleaned = stripStaleMarkers(original);
  const { header, sections } = splitSections(cleaned);
  for (const s of sections) {
    if (!sectionsToFill.includes(s.name)) continue;
    const gen = generated[s.name]
      ?.split('\n')
      .filter(l => !/^\s*<!--.*-->\s*$/.test(l))
      .join('\n')
      .trim();
    if (gen) s.body = `\n${gen}\n`;
  }
  return assembleSections(header, sections);
}

// ─── 源码摘要（限规模） ───

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);

export function collectSourceDigest(
  dirAbs: string,
  dirRel: string,
  limits: { perFileLines: number; maxChars: number } = DIGEST_LIMITS,
): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts') && !e.name.includes('.test.') && !e.name.includes('.spec.')) {
        files.push(full);
      }
    }
  };
  walk(dirAbs);
  files.sort();

  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const allLines = content.split('\n');
    const head = allLines.slice(0, limits.perFileLines).join('\n');
    const rel = path.relative(dirAbs, f);
    const chunk = `### ${rel}（${allLines.length} 行）\n${head}\n`;
    if (total + chunk.length > limits.maxChars) {
      const remaining = limits.maxChars - total;
      if (remaining > 0) parts.push(chunk.slice(0, remaining));
      truncated = true;
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }
  if (parts.length === 0 && !truncated) return `（目录 ${dirRel} 无可读源码文件）`;
  return parts.join('\n') + (truncated ? `\n（……已截断，共 ${files.length} 个源文件，仅展示前一部分）` : '');
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── 下游引用静态分析（确定性，不走 LLM） ───

export interface ImportIndex {
  /** 源文件绝对路径 → 原始 import specifier 列表 */
  byFile: Map<string, string[]>;
  /** workspace 包名 → 包根绝对路径（packages/*） */
  pkgRoots: Map<string, string>;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/g;

/** 构建全仓 import 索引（apps/ + packages/，跳过 node_modules/dist/__tests__） */
export function buildImportIndex(repoRoot: string): ImportIndex {
  const byFile = new Map<string, string[]>();
  const pkgRoots = new Map<string, string>();

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const specs: string[] = [];
        for (const m of content.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2] ?? m[3];
          if (spec) specs.push(spec);
        }
        if (specs.length > 0) byFile.set(full, specs);
      }
    }
  };

  for (const top of ['apps', 'packages']) {
    const abs = path.join(repoRoot, top);
    if (fs.existsSync(abs)) walk(abs);
  }

  // workspace 包名映射（@dommaker/studio-shared → packages/studio-shared）
  const pkgsDir = path.join(repoRoot, 'packages');
  try {
    for (const name of fs.readdirSync(pkgsDir)) {
      const pkgJson = path.join(pkgsDir, name, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')) as { name?: string };
        if (pkg.name) pkgRoots.set(pkg.name, path.join(pkgsDir, name));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return { byFile, pkgRoots };
}

/** 列出 repo 内 import 了 dirRel 的源文件（repo 相对路径，排序，封顶 30 条） */
export function collectDownstream(index: ImportIndex, repoRoot: string, dirRel: string): string[] {
  const dirAbs = path.join(repoRoot, dirRel);
  const hits: string[] = [];

  for (const [file, specs] of index.byFile) {
    // 自身目录内的互相引用不算下游
    if (file.startsWith(dirAbs + path.sep)) continue;

    let hit = false;
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        // 相对 import：解析后判断是否落入目标目录
        const resolved = path.resolve(path.dirname(file), spec).replace(/\.(js|jsx|ts|tsx|d\.ts)$/, '').replace(/\/index$/, '');
        if (resolved === dirAbs || resolved.startsWith(dirAbs + path.sep)) {
          hit = true;
          break;
        }
      } else {
        // 包名 import：命中 workspace 包（目标目录是该包根或其子目录，如 src/）
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const pkgRoot = index.pkgRoots.get(pkgName);
        if (pkgRoot && (dirAbs === pkgRoot || dirAbs.startsWith(pkgRoot + path.sep))) {
          hit = true;
          break;
        }
      }
    }
    if (hit) hits.push(path.relative(repoRoot, file));
  }

  return hits.sort().slice(0, 30);
}

// ─── Prompt ───

export function buildPrompts(dirRel: string, digest: string, existing: string, sectionsToFill: string[], downstream: string[] = []): { system: string; user: string } {
  const system = `你是代码库文档专家。根据目录源码，为 CONTEXT.md 生成指定小节的内容。

规则：
- 全程中文，简洁准确，严格基于所给源码与下游引用列表，禁止编造不存在的文件、导出或依赖
- 输出 JSON 对象，键为小节名，值为该小节的 markdown 内容；只输出要求的小节
- 内容中不要包含 "## " 标题行本身
- 「核心导出」用 markdown 表格（| 导出 | 文件 | 说明 |）；「职责」2-4 句；「依赖关系」分行列上游（本目录依赖谁）与下游（谁依赖本目录）；「注意事项」用 - 列表列开发约定/约束
- 「依赖关系」的下游必须以下方给出的下游引用列表为准（按模块归并描述），列表为空才写"暂无"
- 不要输出 ⚠️ 过期警告、STALE_SINCE 标记、修复历史`;

  const user = `目录: ${dirRel}
待填充小节: ${sectionsToFill.join('、')}

下游引用（repo 内 import 本目录的源文件，静态分析得出，可信）:
${downstream.length > 0 ? downstream.map(d => `- ${d}`).join('\n') : '（无）'}

现有 CONTEXT.md（仅供对齐风格，其中 <!-- --> 为占位符）:
\`\`\`markdown
${existing.slice(0, 3000)}
\`\`\`

目录源码摘要（文件头部，含 import 与导出信息）:
${digest}`;

  return { system, user };
}

// ─── 发现 / git / 状态 ───

/** 发现 apps/ 与 packages/ 下所有 CONTEXT.md（跳过 node_modules/dist/__tests__） */
export function findContextFiles(repoRoot: string): string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, 'CONTEXT.md'))) {
        result.push(path.relative(repoRoot, full));
      }
      walk(full);
    }
  };
  for (const top of ['apps', 'packages']) {
    const abs = path.join(repoRoot, top);
    if (fs.existsSync(abs)) walk(abs);
  }
  return result.sort();
}

/** 目录源码的 git 最后提交时间（秒）；排除 CONTEXT.md 自身的提交 */
export function gitDirLastCommitTs(repoRoot: string, dir: string): number | null {
  try {
    const out = execSync(
      `git log -1 --format=%ct -- "${dir}" ":(exclude)${dir}/CONTEXT.md" ":(exclude)${dir}/**/CONTEXT.md"`,
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return out ? parseInt(out, 10) : null;
  } catch {
    return null;
  }
}

function gitDirLastCommitShort(repoRoot: string, dir: string): string {
  try {
    return execSync(`git log -1 --format=%h -- "${dir}"`, { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function loadState(statePath: string): FillState {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as FillState;
  } catch {
    return {};
  }
}

export function saveState(statePath: string, state: FillState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ─── LLM（延迟初始化；单测注入 mock 不经过这里） ───

interface LlmBackend {
  generate: (system: string, user: string) => Promise<GeneratedSections>;
  usageSince: (ts: number) => { calls: number; prompt: number; completion: number };
}

async function createLlmBackend(): Promise<LlmBackend> {
  const shared = await import('@dommaker/studio-shared');
  const { modelGateway, getProviderApiKey } = shared;

  // 与 apps/api 启动一致的 provider 初始化：env provider + ~/.studio/llm-configs.json
  modelGateway.loadFromEnv();
  const configsPath = path.join(process.env.HOME || '~', '.studio', 'llm-configs.json');
  try {
    const configs = JSON.parse(fs.readFileSync(configsPath, 'utf-8')) as Array<Record<string, any>>;
    for (const c of configs) {
      if (!c.isActive || (c.scope !== 'studio' && c.scope !== 'orchestrator')) continue;
      const apiKey = getProviderApiKey(c.provider);
      if (!apiKey) continue;
      const envBase = process.env[`${String(c.provider).toUpperCase()}_BASE_URL`];
      modelGateway.addProvider({
        name: `${c.scope}:${c.provider}`,
        baseUrl: c.baseUrl || envBase || '',
        apiKey,
        model: c.model || '',
        priority: c.scope === 'orchestrator' ? 0 : 1,
        ...(c.provider === 'anthropic' ? { protocol: 'anthropic' as const } : {}),
      });
    }
  } catch {
    // 无 llm-configs.json 时仅用 env provider
  }

  if (!modelGateway.isAvailable()) {
    throw new Error('modelGateway 无可用 provider（检查 ~/.studio/llm-configs.json 与 API key 环境变量）');
  }

  const generate = async (system: string, user: string): Promise<GeneratedSections> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await modelGateway.promptJson<GeneratedSections>(user, system);
      } catch (err) {
        lastErr = err;
        // 瞬时 token/网络错误：退避重试
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  const usageSince = (ts: number) => {
    const recent = modelGateway.getRecentUsage(500).filter(u => u.timestamp >= ts);
    return {
      calls: recent.length,
      prompt: recent.reduce((s, u) => s + u.promptTokens, 0),
      completion: recent.reduce((s, u) => s + u.completionTokens, 0),
    };
  };

  return { generate, usageSince };
}

// ─── 主流程 ───

export async function runFill(options: RunOptions, deps: RunDeps = {}): Promise<RunSummary> {
  const { repoRoot, target, force = false, dryRun } = options;
  const statePath = options.statePath ?? path.join(repoRoot, DEFAULT_STATE_PATH);
  const gitTs = deps.gitLastCommitTs ?? ((dir: string) => gitDirLastCommitTs(repoRoot, dir));
  const now = deps.now ?? (() => new Date());

  const discovered = findContextFiles(repoRoot);
  const dirs = target === 'all'
    ? discovered
    : discovered.filter(d => d === target || d.replace(/\/CONTEXT\.md$/, '') === target);
  if (dirs.length === 0) {
    throw new Error(`未找到目标目录的 CONTEXT.md: ${target}（可用: ${discovered.length} 个，例: ${discovered[0]}）`);
  }

  const state = loadState(statePath);
  const summary: RunSummary = {
    plans: [], filled: [], stripped: [], skipped: [], errors: [],
    llmCalls: 0, tokens: { prompt: 0, completion: 0 }, dryRun,
  };

  // 下游引用静态分析索引（仅在存在 fill 计划时构建，控制 dry-run 开销）
  let importIndex: ImportIndex | null = null;
  const getIndex = (): ImportIndex => {
    if (!importIndex) importIndex = buildImportIndex(repoRoot);
    return importIndex;
  };

  // 先出计划（含 dry-run 的 token 估算）
  for (const dir of dirs) {
    const ctxPath = path.join(dir, 'CONTEXT.md');
    const content = fs.readFileSync(path.join(repoRoot, ctxPath), 'utf-8');
    const analysis = analyzeContext(content);
    const record = state[dir];
    const srcTs = gitTs(dir);
    const sourceChanged = record !== undefined && srcTs !== null && srcTs * 1000 > Date.parse(record.filledAt);
    const decision = decide(analysis, record, sourceChanged, force);

    let estTokens = 0;
    if (decision.action === 'fill') {
      const digest = collectSourceDigest(path.join(repoRoot, dir), dir);
      const downstream = collectDownstream(getIndex(), repoRoot, dir);
      const { system, user } = buildPrompts(dir, digest, content, decision.sectionsToFill, downstream);
      estTokens = estimateTokens(system + user) + 600; // + 输出预算
    }
    summary.plans.push({ dir, contextPath: ctxPath, decision, estTokens });
  }

  if (dryRun) return summary;

  // 执行
  const startedAt = Date.now();
  let backend: LlmBackend | null = null;
  const stateUpdates: FillState = {};

  for (const plan of summary.plans) {
    const { dir, contextPath, decision } = plan;
    if (decision.action === 'skip') {
      summary.skipped.push(dir);
      continue;
    }
    const absCtx = path.join(repoRoot, contextPath);
    const original = fs.readFileSync(absCtx, 'utf-8');

    try {
      if (decision.action === 'strip') {
        const stripped = stripStaleMarkers(original);
        if (stripped !== original) {
          fs.writeFileSync(absCtx, stripped, 'utf-8');
          summary.stripped.push(dir);
        } else {
          summary.skipped.push(dir);
        }
        continue;
      }

      // fill
      if (!backend) {
        backend = deps.generate
          ? { generate: deps.generate, usageSince: () => ({ calls: 0, prompt: 0, completion: 0 }) }
          : await createLlmBackend();
      }
      const digest = collectSourceDigest(path.join(repoRoot, dir), dir);
      const downstream = collectDownstream(getIndex(), repoRoot, dir);
      const { system, user } = buildPrompts(dir, digest, original, decision.sectionsToFill, downstream);
      const generated = await backend.generate(system, user);
      const merged = mergeGenerated(original, generated, decision.sectionsToFill);
      fs.writeFileSync(absCtx, merged, 'utf-8');
      summary.filled.push(dir);
      stateUpdates[dir] = {
        filledAt: now().toISOString(),
        sourceCommit: gitDirLastCommitShort(repoRoot, dir),
        toolSections: decision.sectionsToFill,
      };
    } catch (err) {
      summary.errors.push({ dir, error: String(err) });
    }
  }

  if (Object.keys(stateUpdates).length > 0) {
    saveState(statePath, { ...state, ...stateUpdates });
  }

  if (backend && !deps.generate) {
    const usage = backend.usageSince(startedAt);
    summary.llmCalls = usage.calls;
    summary.tokens = { prompt: usage.prompt, completion: usage.completion };
  } else {
    summary.llmCalls = summary.filled.length;
  }

  return summary;
}

/** dry-run 输出格式化 */
export function formatPlan(summary: RunSummary): string {
  const lines: string[] = [];
  const fills = summary.plans.filter(p => p.decision.action === 'fill');
  const strips = summary.plans.filter(p => p.decision.action === 'strip');
  const skips = summary.plans.filter(p => p.decision.action === 'skip');

  for (const p of fills) {
    lines.push(`[fill ] ${p.dir} — ${p.decision.reasons.join(' + ')}；小节: ${p.decision.sectionsToFill.join(',')}；估 ~${p.estTokens} tok`);
  }
  for (const p of strips) {
    lines.push(`[strip] ${p.dir} — 仅清除过期标记`);
  }
  for (const p of skips) {
    lines.push(`[skip ] ${p.dir} — 已是最新`);
  }

  lines.push('');
  lines.push(`合计: fill ${fills.length} / strip ${strips.length} / skip ${skips.length}；LLM 调用 ${fills.length} 次；估算输入+输出 ~${fills.reduce((s, p) => s + p.estTokens, 0)} tok`);
  if (summary.dryRun) lines.push('（dry-run：未写文件、未调用 LLM。用 --fill <dir> 或 --all 实际执行）');
  return lines.join('\n');
}

// ─── CLI ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const all = args.includes('--all');
  const fillIdx = args.indexOf('--fill');
  const fillDir = fillIdx >= 0 ? args[fillIdx + 1]?.replace(/\/CONTEXT\.md$/, '').replace(/\/$/, '') : undefined;

  if (all && fillDir) {
    console.error('--all 与 --fill 互斥');
    process.exit(1);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dryRun = !all && !fillDir;
  const target: 'all' | string = all || dryRun ? 'all' : (fillDir as string);

  const summary = await runFill({ repoRoot, target, force, dryRun }, {});

  if (dryRun) {
    console.log(formatPlan(summary));
    return;
  }

  for (const d of summary.filled) console.log(`[filled ] ${d}`);
  for (const d of summary.stripped) console.log(`[stripped] ${d}`);
  for (const e of summary.errors) console.error(`[error  ] ${e.dir}: ${e.error}`);
  console.log(`\n完成: filled ${summary.filled.length} / stripped ${summary.stripped.length} / skipped ${summary.skipped.length} / errors ${summary.errors.length}`);
  console.log(`LLM 调用 ${summary.llmCalls} 次；token: prompt ${summary.tokens.prompt} + completion ${summary.tokens.completion}`);
  if (summary.errors.length > 0) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('[fill-context-docs] failed:', err);
    process.exit(1);
  });
}
