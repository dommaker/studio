/**
 * p2c-public-surface — P2-c 第 2 步「立界」codemod
 *
 * 1) 从实际跨模块 import（生产代码，含静态/动态/require/typeof-import）反推每个模块的公共面
 * 2) 生成 modules/X/index.ts barrel（纯再导出）
 * 3) 把模块外消费方的深路径 import 改写为模块根 index.js
 *
 * 白名单（不改写、lint 豁免）：测试文件、route-registry.ts。
 *
 * 用法：
 *   node scripts/p2c-public-surface.mjs --check   # 干跑：打印公共面/冲突/改写计划
 *   node scripts/p2c-public-surface.mjs --apply   # 落盘
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = 'apps/api/src';
const MODULES_ROOT = path.join(SRC_ROOT, 'modules');
const WHITELIST_FILES = new Set(['route-registry.ts']);

// ---------- 工具 ----------

export function isWhitelisted(relFile) {
  return (
    relFile.includes('__tests__') ||
    /\.(test|spec)\.tsx?$/.test(relFile) ||
    WHITELIST_FILES.has(path.basename(relFile))
  );
}

function collectFiles(root) {
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

function stripComments(content) {
  // 等长替换（改写 offset 依赖原文件坐标，长度必须不变）
  return content
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/(^|[^:'"])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * 扫描文件内全部引用 specifier 的位置：
 * 静态 import/export-from（含多行）、动态 import()、typeof import()、require()。
 * 返回 [{ kind: 'static'|'dynamic'|'require', spec, start, end, stmtStart, stmtEnd, statement }]
 * start/end 是 specifier 字符串（不含引号）的区间；stmt 区间是整个语句/调用。
 */
export function scanSpecifiers(content) {
  const src = stripComments(content);
  const out = [];
  let m;
  const staticRe = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+(['"])([^'"]+)\1/g;
  while ((m = staticRe.exec(src))) {
    const specStart = m.index + m[0].lastIndexOf(m[2]);
    out.push({ kind: 'static', spec: m[2], start: specStart, end: specStart + m[2].length, stmtStart: m.index, stmtEnd: m.index + m[0].length, statement: m[0] });
  }
  const dynRe = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = dynRe.exec(src))) {
    // 排除静态 import 已覆盖的（staticRe 不含括号形态，无交集）
    const specStart = m.index + m[0].indexOf(m[2]);
    out.push({ kind: 'dynamic', spec: m[2], start: specStart, end: specStart + m[2].length, stmtStart: m.index, stmtEnd: m.index + m[0].length, statement: m[0] });
  }
  const reqRe = /(?<![\w.])require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = reqRe.exec(src))) {
    const specStart = m.index + m[0].indexOf(m[2]);
    out.push({ kind: 'require', spec: m[2], start: specStart, end: specStart + m[2].length, stmtStart: m.index, stmtEnd: m.index + m[0].length, statement: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 解析静态 import/export-from 语句的绑定 */
export function parseBindings(statement) {
  const typeOnly = /^\s*(?:import|export)\s+type\b/.test(statement);
  const isExport = /^\s*export\b/.test(statement);
  const head = statement.slice(0, statement.lastIndexOf(' from ')).replace(/^\s*(?:import|export)\s+(?:type\s+)?/, '').trim();
  const r = { typeOnly, isExport, defaultName: null, namespaceName: null, named: [] };
  if (head.startsWith('{') || head.startsWith('type {')) {
    r.named = parseNamedClause(head.replace(/^type\s+/, ''));
    return r;
  }
  if (head.startsWith('*')) {
    r.namespaceName = (head.match(/\*\s+as\s+(\w+)/) || [])[1] || '*';
    return r;
  }
  // default 开头，可能跟 , { ... } 或 , * as ns
  const commaIdx = head.indexOf(',');
  if (commaIdx === -1) { r.defaultName = head.trim(); return r; }
  r.defaultName = head.slice(0, commaIdx).trim();
  const rest = head.slice(commaIdx + 1).trim();
  if (rest.startsWith('{')) r.named = parseNamedClause(rest);
  else if (rest.startsWith('*')) r.namespaceName = (rest.match(/\*\s+as\s+(\w+)/) || [])[1] || '*';
  return r;
}

function parseNamedClause(clause) {
  const inner = clause.replace(/^\{/, '').replace(/\}\s*$/, '');
  const named = [];
  for (const part of inner.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const isType = p.startsWith('type ');
    const bare = isType ? p.slice(5).trim() : p;
    const asM = bare.match(/^(\w+)\s+as\s+(\w+)$/);
    if (asM) named.push({ imported: asM[1], local: asM[2], isType });
    else {
      // 解构重命名 `{ a: b }`（动态 import/require 解构形态）
      const colonM = bare.match(/^(\w+)\s*:\s*(\w+)$/);
      if (colonM) named.push({ imported: colonM[1], local: colonM[2], isType });
      else named.push({ imported: bare, local: bare, isType });
    }
  }
  return named;
}

/** 解析动态 import / require 的消费名（解构 or .then 形参） */
export function parseDynamicNames(content, occ) {
  const before = content.slice(Math.max(0, occ.stmtStart - 120), occ.stmtStart);
  const after = content.slice(occ.stmtEnd, occ.stmtEnd + 120);
  const names = [];
  // 注：括号组限定 [^{}]*——回看窗口里可能混着 try/对象字面量的花括号， lazy 匹配会从最早的 { 开始吃到无关内容
  const backM = before.match(/\{([^{}]*)\}\s*=\s*(?:await\s*)?$/);
  if (backM) names.push(...parseNamedClause(`{${backM[1]}}`));
  const thenM = after.match(/^\.then\(\s*\(?\s*\{([^{}]*)\}\s*\)?/);
  if (thenM) names.push(...parseNamedClause(`{${thenM[1]}}`));
  const arrowM = after.match(/^\.then\(\s*(\w+)\s*=>\s*\1\.(\w+)/);
  if (arrowM) names.push({ imported: arrowM[2], local: arrowM[2], isType: false });
  return names;
}

// ---------- 核心：公共面计划 ----------

/**
 * 解析 specifier：若指向 modules/<mod>/<deep>（deep ≠ index），返回 { mod, deepPath }，否则 null。
 * consumerRel：消费方相对 SRC_ROOT 的路径（posix）。
 */
export function resolveDeepTarget(consumerRel, spec) {
  if (!spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(consumerRel), spec));
  if (!resolved.startsWith('modules/')) return null;
  const rest = resolved.slice('modules/'.length);
  const mod = rest.split('/')[0];
  const deep = rest.slice(mod.length + 1);
  if (!deep || /^index\.(ts|js|tsx)$/.test(deep)) return null;
  return { mod, deepPath: deep.replace(/\.js$/, '.ts') };
}

export function indexSpecifier(consumerRel, mod) {
  let rel = path.posix.relative(path.posix.dirname(consumerRel), `modules/${mod}/index.js`);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/**
 * 构建公共面计划。
 * 返回 { surface: Map<mod, Map<exportName, {source, kind}>>, conflicts: [], rewrites: Map<relFile, edit[]> }
 * kind: 'named' | 'default' | 'type'
 */
export function planPublicSurface(srcRoot = SRC_ROOT) {
  const files = collectFiles(srcRoot);
  const surface = new Map();
  const conflicts = [];
  const rewrites = new Map();

  // 再导出链判定：source 文件内 `export { name } from './other.js'` → 该文件只是中转，非定义处
  const isReExporter = (mod, source, exportName) => {
    const file = path.join(MODULES_ROOT, mod, source.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
    if (!fs.existsSync(file)) return false;
    const content = stripComments(fs.readFileSync(file, 'utf8'));
    const re = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from`);
    return re.test(content);
  };

  const addToSurface = (mod, exportName, source, kind, consumer) => {
    if (!surface.has(mod)) surface.set(mod, new Map());
    const s = surface.get(mod);
    const existing = s.get(exportName);
    // type + named 同名（class 同时当类型/值用）→ 归并为 named
    if (existing) {
      if (existing.source === source && (existing.kind === kind || (existing.kind !== 'default' && kind !== 'default'))) {
        if (existing.kind !== kind) existing.kind = 'named';
        return;
      }
      // 再导出链消歧：同名符号经定义文件 + 中转文件两条路径可达 → 归并到定义文件
      const aRe = isReExporter(mod, existing.source, exportName);
      const bRe = isReExporter(mod, source, exportName);
      if (aRe !== bRe && existing.kind !== 'default' && kind !== 'default') {
        if (aRe) s.set(exportName, { source, kind }); // 新来的是定义处，替换
        return;
      }
      conflicts.push({ mod, exportName, a: existing, b: { source, kind }, consumer });
      return;
    }
    s.set(exportName, { source, kind });
  };

  // 第一遍：surface（default 需先统计 local 名频次定 canonical 名）
  const defaultNameVotes = new Map(); // mod|source -> Map<localName, count>
  const occs = []; // 暂存全部消费事件
  for (const file of files) {
    const relFile = path.relative(srcRoot, file).split(path.sep).join('/');
    if (isWhitelisted(relFile)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const occ of scanSpecifiers(content)) {
      const target = resolveDeepTarget(relFile, occ.spec);
      if (!target) continue;
      const consumerMod = relFile.startsWith('modules/') ? relFile.split('/')[1] : null;
      if (consumerMod === target.mod) continue; // 模块内部深引用，不动
      occs.push({ relFile, content, occ, target });
      if (occ.kind === 'static') {
        const b = parseBindings(occ.statement);
        if (b.defaultName) {
          const key = `${target.mod}|${target.deepPath}`;
          if (!defaultNameVotes.has(key)) defaultNameVotes.set(key, new Map());
          const v = defaultNameVotes.get(key);
          v.set(b.defaultName, (v.get(b.defaultName) || 0) + 1);
        }
      }
    }
  }
  const canonicalDefault = (mod, deepPath) => {
    const v = defaultNameVotes.get(`${mod}|${deepPath}`);
    if (!v) return null;
    return [...v.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  // 第二遍：登记 surface + 生成改写
  for (const { relFile, content, occ, target } of occs) {
    const sourceRel = './' + target.deepPath.replace(/\.ts$/, '.js');
    if (!rewrites.has(relFile)) rewrites.set(relFile, []);
    const edits = rewrites.get(relFile);
    const newSpec = indexSpecifier(relFile, target.mod);

    if (occ.kind === 'static') {
      const b = parseBindings(occ.statement);
      const isType = n => n.isType || (b.typeOnly && !b.isExport);
      for (const n of b.named) addToSurface(target.mod, n.imported, sourceRel, isType(n) ? 'type' : 'named', relFile);
      if (b.namespaceName) {
        // 命名空间 import 指向 index 即可（index 是其超集），仅换 specifier
        edits.push({ start: occ.start, end: occ.end, text: newSpec });
        continue;
      }
      if (b.defaultName) {
        const canon = canonicalDefault(target.mod, target.deepPath);
        addToSurface(target.mod, canon, sourceRel, 'default', relFile);
        // 结构性改写：default → named（可能带 as）
        const namedPart = canon === b.defaultName ? canon : `${canon} as ${b.defaultName}`;
        const namedRest = b.named.length ? `{ ${b.named.map(n => (n.isType ? 'type ' : '') + (n.imported === n.local ? n.imported : `${n.imported} as ${n.local}`)).join(', ')} }` : '';
        const clause = namedRest ? `{ ${namedPart}, ${b.named.map(n => (n.isType ? 'type ' : '') + (n.imported === n.local ? n.imported : `${n.imported} as ${n.local}`)).join(', ')} }` : `{ ${namedPart} }`;
        const kw = occ.statement.match(/^\s*(?:import|export)\s+(?:type\s+)?/)[0];
        edits.push({ start: occ.stmtStart, end: occ.stmtEnd, text: `${kw}${clause} from '${newSpec}'` });
        continue;
      }
      // 纯 named / type-only：仅换 specifier
      edits.push({ start: occ.start, end: occ.end, text: newSpec });
    } else {
      // dynamic / require / typeof-import：仅换 specifier；解构名登记进 surface
      const names = parseDynamicNames(content, occ);
      for (const n of names) addToSurface(target.mod, n.imported, sourceRel, n.isType ? 'type' : 'named', relFile);
      edits.push({ start: occ.start, end: occ.end, text: newSpec });
    }
  }
  return { surface, conflicts, rewrites };
}

/** 生成 barrel 文件内容 */
export function renderIndex(mod, surfaceEntries) {
  const bySource = new Map();
  for (const [name, e] of [...surfaceEntries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push({ name, kind: e.kind });
  }
  const lines = [
    '/**',
    ` * ${mod} 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）`,
    ' *',
    ' * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。',
    ' * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。',
    ' */',
  ];
  for (const [source, entries] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const values = entries.filter(e => e.kind !== 'type');
    const types = entries.filter(e => e.kind === 'type');
    if (values.length) {
      lines.push(`export { ${values.map(e => (e.kind === 'default' ? `default as ${e.name}` : e.name)).join(', ')} } from '${source}';`);
    }
    if (types.length) lines.push(`export type { ${types.map(e => e.name).join(', ')} } from '${source}';`);
  }
  return lines.join('\n') + '\n';
}

/** 应用改写（同文件内 edit 从后往前替换） */
export function applyRewrites(rewrites, srcRoot = SRC_ROOT) {
  let fileCount = 0, editCount = 0;
  for (const [relFile, edits] of rewrites) {
    const file = path.join(srcRoot, relFile);
    let content = fs.readFileSync(file, 'utf8');
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      content = content.slice(0, e.start) + e.text + content.slice(e.end);
      editCount++;
    }
    fs.writeFileSync(file, content);
    fileCount++;
  }
  return { fileCount, editCount };
}

// ---------- CLI ----------

/** 校验 surface：每个名字必须能在来源文件中找到对应 export（防解析错位产生幽灵导出） */
export function verifySurface(surface, modulesRoot = MODULES_ROOT) {
  const problems = [];
  for (const [mod, s] of surface) {
    for (const [name, e] of s) {
      const file = path.join(modulesRoot, mod, e.source.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
      if (!fs.existsSync(file)) { problems.push(`${mod}: 来源文件不存在 ${e.source}（${name}）`); continue; }
      const content = stripComments(fs.readFileSync(file, 'utf8'));
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const direct = new RegExp(`export\\s+(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${esc}\\b`).test(content)
        || new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${esc}\\b[^}]*\\}`).test(content)
        || (e.kind === 'default' && /export\s+default\b/.test(content));
      if (!direct) problems.push(`${mod}: "${name}" 在 ${e.source} 中找不到 export（kind=${e.kind}）`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const { surface, conflicts, rewrites } = planPublicSurface();

  if (conflicts.length) {
    console.error('公共面冲突（需人工裁决）：');
    for (const c of conflicts) console.error(`  ${c.mod}: "${c.exportName}" 来自 ${c.a.source}(${c.a.kind}) 与 ${c.b.source}(${c.b.kind})，消费方 ${c.consumer}`);
    process.exit(1);
  }

  const problems = verifySurface(surface);
  if (problems.length) {
    console.error('公共面校验失败（幽灵导出/来源缺失）：');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  let exportTotal = 0;
  for (const [mod, s] of [...surface.entries()].sort()) {
    exportTotal += s.size;
    console.log(`${mod}: ${s.size} exports`);
  }
  console.log(`\nmodules with surface: ${surface.size}, total exports: ${exportTotal}`);
  console.log(`rewrite files: ${rewrites.size}, edits: ${[...rewrites.values()].reduce((n, e) => n + e.length, 0)}`);

  if (apply) {
    // 全部 36 模块都落 index.ts：无跨模块消费的模块写占位 barrel（公共面为空，新增消费时补导出）
    const allMods = fs.readdirSync(MODULES_ROOT).filter(d => fs.statSync(path.join(MODULES_ROOT, d)).isDirectory());
    for (const mod of allMods) {
      const s = surface.get(mod) ?? new Map();
      fs.writeFileSync(path.join(MODULES_ROOT, mod, 'index.ts'), renderIndex(mod, s));
    }
    const r = applyRewrites(rewrites);
    console.log(`applied: ${r.fileCount} files, ${r.editCount} edits; index.ts written: ${allMods.length}（其中有公共面 ${surface.size}）`);
  }
}
