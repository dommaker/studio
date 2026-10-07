/**
 * check-module-cycles — 模块级循环依赖 CI 门（#666，docs/plans/2026-10-arch-deepening.md Phase 2）
 *
 * 兑现 target-architecture.md「循环依赖显形，新增环即 CI 红」的承诺。
 * 复用 p2c-dep-analysis.mjs 的模块级 import 图，在 prod 桶边上做两层判定：
 *   1. SCC（强连通分量 size>1）：成员集须与豁免清单精确匹配——新模块入环簇 / 环簇合并即 fail；
 *   2. 互耦对（prod 双向直连）：逐对须豁免——SCC 豁免不掩盖簇内新增直连互耦。
 * 反向同样 fail：豁免有、实际无 = 清单腐化（stale），逼豁免随清零同步回收。
 * 测试桶边不计入（跨模块深 import 白名单口径与 p2c-dep-analysis 报告一致）；
 * type-only import 算结构依赖（与 local/no-deep-module-import 口径一致）。
 *
 * 豁免清单：scripts/module-cycle-exemptions.mjs（逐条带 reason，改动须说明）。
 *
 * 用法：
 *   node scripts/check-module-cycles.mjs          # 有违规 exit 1，否则 exit 0
 *   node scripts/check-module-cycles.mjs --json   # JSON 明细到 stdout（exit 码同上）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModuleGraph, findSCCs } from './p2c-dep-analysis.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const EXEMPTIONS_PATH = path.join(SCRIPT_DIR, 'module-cycle-exemptions.mjs');

/** prod 桶边邻接表：Map<fromMod, Set<toMod>> */
export function prodAdjacency(graph) {
  const adj = new Map();
  for (const [from, mm] of graph.edges) {
    for (const [to, recs] of mm) {
      if (!recs.some(r => r.bucket === 'prod')) continue;
      if (!adj.has(from)) adj.set(from, new Set());
      adj.get(from).add(to);
    }
  }
  return adj;
}

/** 邻接表上的 Tarjan SCC（size>1），成员排序后返回 */
function sccsOf(modules, adj) {
  const edgeView = new Map([...adj.entries()].map(([f, tos]) => [f, new Map([...tos].map(t => [t, []]))]));
  return findSCCs(modules, edgeView);
}

/** prod 双向直连互耦对，返回排序后的 'a<->b' 键列表 */
function mutualPairKeys(adj) {
  const keys = [];
  for (const [a, tos] of adj) {
    for (const b of tos) {
      if (a < b && adj.get(b)?.has(a)) keys.push(`${a}<->${b}`);
    }
  }
  return keys.sort();
}

/**
 * 比对实际环与豁免清单。
 * exemptions: { sccs: [{ modules: string[], reason }], mutualPairs: [{ a, b, reason }] }
 * 返回 { ok, violations: [{ kind, key, reason? }] }，
 * kind: new-scc | stale-scc | new-pair | stale-pair。
 */
export function checkCycles(graph, exemptions) {
  const adj = prodAdjacency(graph);
  const actualSccs = sccsOf(graph.modules, adj).map(m => m.join(','));
  const exemptSccs = (exemptions.sccs ?? []).map(e => [...e.modules].sort().join(','));
  const actualPairs = mutualPairKeys(adj);
  const exemptPairs = (exemptions.mutualPairs ?? []).map(e => [e.a, e.b].sort().join('<->'));

  const violations = [];
  for (const key of actualSccs) {
    if (!exemptSccs.includes(key)) violations.push({ kind: 'new-scc', key });
  }
  for (const key of exemptSccs) {
    if (!actualSccs.includes(key)) violations.push({ kind: 'stale-scc', key });
  }
  for (const key of actualPairs) {
    if (!exemptPairs.includes(key)) violations.push({ kind: 'new-pair', key });
  }
  for (const key of exemptPairs) {
    if (!actualPairs.includes(key)) violations.push({ kind: 'stale-pair', key });
  }
  return { ok: violations.length === 0, violations };
}

const KIND_LABEL = {
  'new-scc': '新增环簇（未豁免的 SCC）',
  'stale-scc': '豁免过期（SCC 已不存在，回收豁免）',
  'new-pair': '新增互耦对（prod 双向直连未豁免）',
  'stale-pair': '豁免过期（互耦对已不存在，回收豁免）',
};

export function formatViolations(violations) {
  return violations
    .map(v => `  [${v.kind}] ${KIND_LABEL[v.kind]}: ${v.key}`)
    .join('\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: exemptions } = await import(EXEMPTIONS_PATH);
  const graph = buildModuleGraph(path.join(REPO_ROOT, 'apps/api/src'));
  const { ok, violations } = checkCycles(graph, exemptions);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok, violations }, null, 2));
  } else if (ok) {
    console.log(`check-module-cycles: OK（modules=${graph.modules.length}，存量环全部命中豁免清单，无新增）`);
  } else {
    console.error(`check-module-cycles: FAIL（${violations.length} 项违规）`);
    console.error(formatViolations(violations));
    console.error('处置：新增环请拆依赖；确属合理架构则在 scripts/module-cycle-exemptions.mjs 补豁免（带原因注释）；stale 项直接删豁免。');
  }
  process.exit(ok ? 0 : 1);
}
