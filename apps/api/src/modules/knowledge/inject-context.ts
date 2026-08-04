/**
 * inject-context — injectContext 的注入闸门与 2K 预算 helpers
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：R3 提案闸门
 * （draft/archived/deprecated 不注入）、来源凭证检查、注入 token 预算与
 * 优先级排序、E2「何时查知识库」检索指引、prompt 文本 stripFormat。
 * knowledge-service.ts 以 re-export 保持
 * KNOWLEDGE_QUERY_GUIDANCE / INJECT_TOKEN_BUDGET 导出面不变。
 */

// ── R3 提案闸门 ──

/**
 * R3 提案闸门：draft/archived/deprecated 不参与注入。
 * proposal（LLM 提取产物，maturity=draft）须经人工审核 promote 后才可注入。
 * 无 maturity 字段的条目（doc 来源 rule/preference/snapshot，恒为 approved 语义）不受限。
 */
const NON_INJECTABLE_MATURITIES: ReadonlySet<string> = new Set(['draft', 'archived', 'deprecated']);

function isInjectableMaturity(maturity: unknown): boolean {
  return typeof maturity !== 'string' || !NON_INJECTABLE_MATURITIES.has(maturity);
}

/** ②（wireups）：生产条目来源凭证字段是 sourceReferences（复数数组），length>0 才算有凭证。 */
function hasSourceReferences(entry: any): boolean {
  return Array.isArray(entry?.sourceReferences) && entry.sourceReferences.length > 0;
}

/** ③（wireups）：注入 token 预算（vision D6「注入 ≤2K tokens」红线执行点） */
export const INJECT_TOKEN_BUDGET = 2_000;

/**
 * ③（wireups）：注入优先级 = 成熟度权重 × 10000 + 引用计数。
 * 成熟度高的先注入；同成熟度按 referencedBy 计数（被引用越多越有价值）。
 */
function injectPriority(entry: any): number {
  const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 2, draft: 1 };
  const w = maturityWeight[entry?.maturity] ?? 0;
  const refs = Array.isArray(entry?.referencedBy) ? entry.referencedBy.length : 0;
  return w * 10_000 + refs;
}

/**
 * E2 检索主动性（断点 G）：知识上下文注入时附带的「何时查知识库」指引。
 * signal 档只注入索引，agent 需要知道何时、如何主动检索全文。
 * 入口 = worktree `.claude/settings.json` 里注册的 local-rag MCP server
 * （studio-agent worktree-resolver propagateHarnessConfig 写入；agent CLI 以
 * worktree 为 cwd 启动，自动加载该配置），工具名 `mcp__local-rag__query_documents`。
 * 体量 ~3 行（约 80 tokens），计入 2K 注入红线内的固定小额开销。
 */
export const KNOWLEDGE_QUERY_GUIDANCE = [
  '## 何时查知识库',
  '- 遇到不熟悉的报错、同一问题反复失败、涉及用户偏好、或大改/重构之前：先查知识库再动手。',
  '- 查询入口：MCP 工具 `mcp__local-rag__query_documents`（local-rag server），query 传关键词或问题描述。',
  '- 有现成经验就复用，不要重复踩坑；查不到再自行解决。',
].join('\n');

function stripFormat(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .trim();
}

export { isInjectableMaturity, hasSourceReferences, injectPriority, stripFormat };
