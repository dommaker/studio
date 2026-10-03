/**
 * p2c-dep-analysis — apps/api/src/modules 模块级依赖分析（P2-c 第 1 步「显形」）
 *
 * 产出：
 *   - 模块级 import 图（from -> to -> 明细：跨模块 import 语句清单）
 *   - 互耦对（A->B 且 B->A）
 *   - 强连通分量（Tarjan SCC，size>1 即环簇）
 *   - 简单环枚举（长度 <= maxCycleLen，带上限防爆炸）
 *   - 深 import 清单（生产代码 / 测试 / 模块外基础设施 分桶）
 *
 * 用法：
 *   node scripts/p2c-dep-analysis.mjs                # 摘要到 stdout
 *   node scripts/p2c-dep-analysis.mjs --json         # JSON 到 stdout
 *   node scripts/p2c-dep-analysis.mjs --out <path>   # 写 Markdown 报告
 */
import fs from 'node:fs';
import path from 'node:path';

const MODULES_ROOT = 'apps/api/src/modules';
const SRC_ROOT = 'apps/api/src';

/** 递归收集 .ts/.tsx 文件 */
export function collectSourceFiles(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  })(root);
  return out.sort();
}

/**
 * 解析一个源文件的全部 import 来源 specifier（静态 import / export-from / 动态 import()）。
 * 多行 import 语句先归一化处理。返回 [{ spec, dynamic, names, typeOnly, line }]。
 */
export function parseImports(content) {
  const results = [];
  // 去掉注释，避免误匹配（块注释/行注释内的 import 样例）
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const staticRe = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  const seen = new Set();
  while ((m = staticRe.exec(stripped))) {
    const stmt = m[0];
    results.push({
      spec: m[1],
      dynamic: false,
      typeOnly: /^\s*(?:import|export)\s+type\b/.test(stmt),
      names: stmt.startsWith('import') || stmt.startsWith('export') ? stmt.slice(0, stmt.indexOf(' from ')).trim() : '',
      index: m.index,
    });
    seen.add(m.index);
  }
  while ((m = sideEffectRe.exec(stripped))) {
    if ([...seen].some(i => Math.abs(i - m.index) < 3)) continue;
    results.push({ spec: m[1], dynamic: false, typeOnly: false, names: '(side-effect)', index: m.index });
  }
  while ((m = dynamicRe.exec(stripped))) {
    results.push({ spec: m[1], dynamic: true, typeOnly: false, names: '(dynamic)', index: m.index });
  }
  return results;
}

function isTestFile(relPath) {
  return relPath.includes('__tests__') || /\.(test|spec)\.tsx?$/.test(relPath);
}

/**
 * 构建模块级 import 图。
 * 返回 {
 *   modules: string[],
 *   edges: Map<fromMod, Map<toMod, Array<{fromFile, spec, toPath, dynamic, typeOnly, bucket}>>>,
 *   outsideDeep: Array<{fromFile, spec, toMod, toPath, bucket}>,  // 模块外基础设施深 import
 * }
 * bucket: 'prod' | 'test'
 */
export function buildModuleGraph(srcRoot = SRC_ROOT) {
  const modulesRoot = path.join(srcRoot, 'modules');
  const modules = fs.readdirSync(modulesRoot).filter(d => fs.statSync(path.join(modulesRoot, d)).isDirectory()).sort();
  const moduleSet = new Set(modules);
  const edges = new Map();
  const outsideDeep = [];
  const files = collectSourceFiles(srcRoot);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(srcRoot, file).split(path.sep).join('/');
    const bucket = isTestFile(relFile) ? 'test' : 'prod';
    const inModules = relFile.startsWith('modules/');
    const fromMod = inModules ? relFile.split('/')[1] : null;

    for (const imp of parseImports(content)) {
      if (!imp.spec.startsWith('.')) continue;
      const resolved = path.normalize(path.join(path.dirname(file), imp.spec));
      const rel = path.relative(modulesRoot, resolved).split(path.sep).join('/');
      if (rel.startsWith('..')) continue;
      const toMod = rel.split('/')[0];
      if (!moduleSet.has(toMod)) continue;
      if (inModules && toMod === fromMod) continue;
      const record = { fromFile: relFile, spec: imp.spec, toPath: `modules/${rel}`, dynamic: imp.dynamic, typeOnly: imp.typeOnly, bucket };
      if (inModules) {
        if (!edges.has(fromMod)) edges.set(fromMod, new Map());
        const mm = edges.get(fromMod);
        if (!mm.has(toMod)) mm.set(toMod, []);
        mm.get(toMod).push(record);
      } else {
        outsideDeep.push({ ...record, toMod });
      }
    }
  }
  return { modules, edges, outsideDeep };
}

/** 互耦对：A->B 且 B->A（prod bucket 计边） */
export function findMutualPairs(edges) {
  const pairs = [];
  const keys = [...edges.keys()].sort();
  for (const a of keys) {
    for (const [b, recs] of edges.get(a)) {
      if (a < b && edges.get(b)?.has(a)) {
        pairs.push({ a, b, ab: recs.filter(r => r.bucket === 'prod').length, ba: edges.get(b).get(a).filter(r => r.bucket === 'prod').length });
      }
    }
  }
  return pairs;
}

/** Tarjan SCC，返回 size>1 的分量列表（prod+test 边都算，环是结构事实） */
export function findSCCs(modules, edges) {
  const adj = new Map(modules.map(m => [m, [...(edges.get(m)?.keys() ?? [])]]));
  let idx = 0;
  const indices = {}, low = {}, stack = [], onStack = new Set(), sccs = [];
  function sc(v) {
    indices[v] = low[v] = idx++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (indices[w] === undefined) { sc(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack.has(w)) low[v] = Math.min(low[v], indices[w]);
    }
    if (low[v] === indices[v]) {
      const s = []; let w;
      do { w = stack.pop(); onStack.delete(w); s.push(w); } while (w !== v);
      if (s.length > 1) sccs.push(s.sort());
    }
  }
  for (const v of modules) if (indices[v] === undefined) sc(v);
  return sccs;
}

/** 简单环枚举（DFS，长度 2..maxLen，按起点字典序去重，cap 防爆炸） */
export function findSimpleCycles(modules, edges, { maxLen = 4, cap = 500 } = {}) {
  const adj = new Map(modules.map(m => [m, [...(edges.get(m)?.keys() ?? [])].sort()]));
  const cycles = [];
  const seen = new Set();
  for (const start of modules) {
    if (cycles.length >= cap) break;
    const dfs = (node, pathSoFar) => {
      if (cycles.length >= cap) return;
      for (const next of adj.get(node) ?? []) {
        if (next === start && pathSoFar.length >= 2) {
          const cyc = [...pathSoFar];
          // 规范化：以最小节点开头表示同一环
          const minIdx = cyc.indexOf([...cyc].sort()[0]);
          const norm = [...cyc.slice(minIdx), ...cyc.slice(0, minIdx)].join('->');
          if (!seen.has(norm)) { seen.add(norm); cycles.push(cyc); }
        } else if (!pathSoFar.includes(next) && pathSoFar.length < maxLen && next > start) {
          dfs(next, [...pathSoFar, next]);
        }
      }
    };
    dfs(start, [start]);
  }
  return cycles;
}

/** 汇总统计（供报告与测试断言） */
export function summarize(graph) {
  const { modules, edges, outsideDeep } = graph;
  let prodEdges = 0, testEdges = 0;
  const byTarget = {}, bySource = {};
  for (const [f, mm] of edges) {
    for (const [t, recs] of mm) {
      for (const r of recs) {
        if (r.bucket === 'prod') {
          prodEdges++;
          byTarget[t] = (byTarget[t] || 0) + 1;
          bySource[f] = (bySource[f] || 0) + 1;
        } else testEdges++;
      }
    }
  }
  return {
    moduleCount: modules.length,
    prodCrossModuleImports: prodEdges,
    testCrossModuleImports: testEdges,
    outsideDeepImports: outsideDeep.length,
    byTarget, bySource,
    mutualPairs: findMutualPairs(edges),
    sccs: findSCCs(modules, edges),
  };
}

/** 生成 Markdown 报告 */
export function renderReport(graph, { maxCycleLen = 4 } = {}) {
  const s = summarize(graph);
  const cycles = findSimpleCycles(graph.modules, graph.edges, { maxLen: maxCycleLen });
  const L = [];
  L.push('# P2-c 模块依赖显形报告', '');
  L.push(`> 生成：node scripts/p2c-dep-analysis.mjs --out（${new Date().toISOString().slice(0, 10)}）`, '');
  L.push('## 总量', '');
  L.push(`- 模块数：${s.moduleCount}`);
  L.push(`- 生产代码跨模块深 import 语句：${s.prodCrossModuleImports}`);
  L.push(`- 测试代码跨模块深 import 语句：${s.testCrossModuleImports}（白名单，不计边界违规）`);
  L.push(`- 模块外基础设施深 import：${s.outsideDeepImports}（route-registry / app / bootstrap / core 等）`);
  L.push(`- 互耦对：${s.mutualPairs.length} 组`);
  L.push(`- 强连通分量（size>1）：${s.sccs.length} 个`);
  L.push(`- 简单环（长度≤${maxCycleLen}）：${cycles.length} 条`, '');
  L.push('## 互耦对（prod 边数）', '');
  L.push('| A | B | A→B | B→A |', '|---|---|---|---|');
  for (const p of s.mutualPairs) L.push(`| ${p.a} | ${p.b} | ${p.ab} | ${p.ba} |`);
  L.push('', '## 强连通分量', '');
  for (const scc of s.sccs) L.push(`- [${scc.join(', ')}]（${scc.length} 节点）`);
  L.push('', '## 简单环清单', '');
  for (const c of cycles) L.push(`- ${[...c, c[0]].join(' → ')}`);
  L.push('', '## 跨模块 import 目标分布（prod）', '');
  L.push('| 目标模块 | 被深 import 次数 |', '|---|---|');
  for (const [m, c] of Object.entries(s.byTarget).sort((a, b) => b[1] - a[1])) L.push(`| ${m} | ${c} |`);
  L.push('', '## 深 import 明细（prod，模块间）', '');
  const det = [];
  for (const [f, mm] of [...graph.edges.entries()].sort()) {
    for (const [t, recs] of [...mm.entries()].sort()) {
      for (const r of recs.filter(r => r.bucket === 'prod')) {
        det.push(`- \`${r.fromFile}\` → \`${r.toPath}\`${r.dynamic ? '（dynamic）' : ''}${r.typeOnly ? '（type-only）' : ''}`);
      }
    }
  }
  L.push(...det);
  L.push('', '## 模块外基础设施深 import 明细', '');
  for (const r of graph.outsideDeep.filter(r => r.bucket === 'prod').sort((a, b) => a.fromFile.localeCompare(b.fromFile))) {
    L.push(`- \`${r.fromFile}\` → \`${r.toPath}\`${r.dynamic ? '（dynamic）' : ''}`);
  }
  return L.join('\n') + '\n';
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const graph = buildModuleGraph();
  if (args.includes('--json')) {
    const s = summarize(graph);
    console.log(JSON.stringify(s, null, 2));
  } else {
    const s = summarize(graph);
    console.log(`modules=${s.moduleCount} prodDeepImports=${s.prodCrossModuleImports} outsideDeep=${s.outsideDeepImports} mutualPairs=${s.mutualPairs.length} sccs=${s.sccs.map(x => x.length).join('/')}`);
    const outIdx = args.indexOf('--out');
    if (outIdx !== -1 && args[outIdx + 1]) {
      fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true });
      fs.writeFileSync(args[outIdx + 1], renderReport(graph));
      console.log(`report written: ${args[outIdx + 1]}`);
    }
  }
}
