#!/usr/bin/env node
/**
 * cleanup-knowledge-duplicates.mjs — R5 seed 污染清洗 + decision tag 回填（一次性脚本）
 *
 * 背景（全部已查证）：
 * - ensureSeedResolutions 去重失效（旧判据依赖 _index.md 可见性），生产
 *   ~/.studio/knowledge 下 730 条 resolution = 2 条 seed × 365 次启动重复；
 * - harness FileKnowledgeStore 索引（index.json）与 _index.md 均含/缺对应条目；
 * - 4 条 type='decision' 条目 tags 缺 'decision'（decisionChainExtractor.query
 *   按 tags:['decision'] 过滤 → 查不到）。
 *
 * 内容：
 * a) resolution 去重：按 title+内容 hash 分组（与 resolution.service.ts
 *    resolutionContentHash 同口径），每组保留 1 条（优先 canonical，再最早 createdAt），
 *    其余删除；同步从 index.json 移除被删条目，并重建 _index.md。
 * b) decision tag 回填：type='decision' 且 tags 缺 'decision' 的条目，按 β 轨道约定
 *    回填 ['decision', <category 或 'process'>]（既有 tags 保留，幂等）；
 *    index.json 与 decision-*.md frontmatter 同步更新。
 *
 * 默认 dry-run（只读，打印计划）；--apply 才执行。
 *
 * 用法：
 *   node scripts/cleanup-knowledge-duplicates.mjs          # dry-run
 *   node scripts/cleanup-knowledge-duplicates.mjs --apply  # 执行清洗
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const KNOWLEDGE_DIR = path.join(os.homedir(), '.studio', 'knowledge');
const STORE_INDEX = path.join(KNOWLEDGE_DIR, 'index.json');
const DOC_INDEX = path.join(KNOWLEDGE_DIR, '_index.md');

function contentHash(title, fix) {
  return crypto.createHash('sha256').update(`${title}\n${fix}`).digest('hex').slice(0, 16);
}

/** 与 resolution.service.ts resolutionFromDoc 同口径：从 body 提取 fix */
function extractFix(body) {
  const m = body.match(/## Solution\n\n([\s\S]*)$/);
  return m ? m[1].trim() : body.replace(/^# .*\n/, '').trim();
}

/**
 * 宽容的 frontmatter 解析（只取顶层标量与 list 字段）。
 * 兼容两种落盘风格：FileStore（key: "v" / tags: ["a", "b"]）与
 * js-yaml（key: v / tags:\n  - a）。嵌套块（sourceReferences 等）原样跳过。
 */
function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  let curKey = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const [, key, rawVal] = kv;
      if (rawVal === '') {
        meta[key] = [];
        curKey = key;
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        meta[key] = rawVal.slice(1, -1).split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        curKey = null;
      } else {
        meta[key] = rawVal.replace(/^["']|["']$/g, '');
        curKey = null;
      }
      continue;
    }
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && curKey) {
      if (!Array.isArray(meta[curKey])) meta[curKey] = [];
      meta[curKey].push(item[1].trim().replace(/^["']|["']$/g, ''));
    } else if (!/^\s/.test(line)) {
      curKey = null;
    }
  }
  return { meta, body: m[2] };
}

// ─── a) resolution 去重计划 ───

function planResolutionDedup() {
  const files = fs.readdirSync(KNOWLEDGE_DIR)
    .filter(f => f.startsWith('resolution-') && f.endsWith('.md')).sort();
  const groups = new Map(); // hash → [{file, id, title, maturity, createdAt}]
  const unparsable = [];
  for (const f of files) {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf-8'));
    if (!parsed) { unparsable.push(f); continue; }
    const { meta, body } = parsed;
    const title = meta.title || '';
    const hash = contentHash(title, extractFix(body.trim()));
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push({
      file: f,
      id: f.replace(/\.md$/, ''),
      title,
      maturity: meta.maturity || 'pending',
      createdAt: meta.createdAt || '',
    });
  }

  const keep = [];
  const remove = [];
  for (const members of groups.values()) {
    members.sort((a, b) => {
      // 保留优先级：canonical 优先 → 最早 createdAt → id 字典序（确定性）
      if ((a.maturity === 'canonical') !== (b.maturity === 'canonical')) {
        return a.maturity === 'canonical' ? -1 : 1;
      }
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    keep.push(members[0]);
    remove.push(...members.slice(1));
  }
  return { total: files.length, groups, keep, remove, unparsable };
}

// ─── b) decision tag 回填计划 ───

function planDecisionBackfill(storeIndex) {
  const plan = [];
  const decisionEntries = storeIndex.filter(e => e && e.type === 'decision');
  for (const entry of decisionEntries) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (tags.includes('decision')) continue;
    const category = entry.category || 'process'; // β 轨道约定：['decision', <category 或 'process'>]
    const newTags = [...tags];
    for (const t of ['decision', category]) {
      if (!newTags.includes(t)) newTags.push(t);
    }
    plan.push({ id: entry.id, title: entry.title || '', category, oldTags: tags, newTags });
  }
  return plan;
}

/** 在 .md frontmatter 的 tags 块回填标签（yaml list / inline 两种风格），返回新内容或 null（无需改） */
function backfillMdTags(content, addTags) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const tagsIdx = lines.findIndex(l => /^tags:/.test(l));
  if (tagsIdx === -1) return null;

  const inline = lines[tagsIdx].match(/^tags:\s*\[(.*)\]\s*$/);
  if (inline) {
    const tags = inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const toAdd = addTags.filter(t => !tags.includes(t));
    if (toAdd.length === 0) return null;
    lines[tagsIdx] = `tags: [${[...tags, ...toAdd].map(t => `"${t}"`).join(', ')}]`;
    return `---\n${lines.join('\n')}\n---\n\n${m[2].replace(/^\n+/, '')}`;
  }

  // yaml list 风格：tags: 行之后连续的 "  - item" 行
  if (!/^tags:\s*$/.test(lines[tagsIdx])) return null;
  const existing = [];
  let insertAt = tagsIdx + 1;
  while (insertAt < lines.length && /^\s+-\s+(.+)$/.test(lines[insertAt])) {
    existing.push(lines[insertAt].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    insertAt++;
  }
  const toAdd = addTags.filter(t => !existing.includes(t));
  if (toAdd.length === 0) return null;
  lines.splice(insertAt, 0, ...toAdd.map(t => `  - ${t}`));
  return `---\n${lines.join('\n')}\n---\n\n${m[2].replace(/^\n+/, '')}`;
}

/** 从剩余 .md 重建 _index.md（沿用现行格式：filename|id|type|title|maturity|tags） */
function rebuildDocIndex(deletedFiles) {
  const files = fs.readdirSync(KNOWLEDGE_DIR)
    .filter(f => f.endsWith('.md') && f !== '_index.md' && !deletedFiles.has(f)).sort();
  const lines = [];
  for (const f of files) {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf-8'));
    if (!parsed) continue;
    const { meta } = parsed;
    const tags = Array.isArray(meta.tags) ? meta.tags.join(';') : (meta.tags || '');
    lines.push(`${f}|${meta.id || ''}|${meta.type || ''}|${meta.title || ''}|${meta.maturity || ''}|${tags}`);
  }
  const header = [
    '# Directory Index',
    `# Auto-generated (cleanup-knowledge-duplicates.mjs ${new Date().toISOString().slice(0, 10)})`,
    `# Total: ${lines.length} entries`,
    '#',
    '# filename|id|type|title|maturity|tags',
  ];
  fs.writeFileSync(DOC_INDEX, `${header.join('\n')}\n${lines.join('\n')}\n`, 'utf-8');
  return lines.length;
}

function main() {
  console.log(`# R5 知识库清洗报告（${APPLY ? 'APPLY' : 'DRY-RUN'}）`);
  console.log(`目录: ${KNOWLEDGE_DIR}\n`);

  const storeIndex = JSON.parse(fs.readFileSync(STORE_INDEX, 'utf-8'));

  // ── a) resolution 去重 ──
  const dedup = planResolutionDedup();
  console.log(`## a) resolution 去重`);
  console.log(`扫描 resolution-*.md: ${dedup.total} 条，按 title+内容 hash 分组 ${dedup.groups.size} 组`);
  for (const [hash, members] of dedup.groups) {
    console.log(`  组 ${hash}: ${members.length} 条 —「${members[0].title}」`);
  }
  console.log(`\n保留 ${dedup.keep.length} 条：`);
  for (const k of dedup.keep) {
    console.log(`  KEEP ${k.file} (${k.maturity}, ${k.createdAt})`);
  }
  console.log(`删除 ${dedup.remove.length} 条重复（dry-run 仅列出前 5 条）：`);
  for (const r of dedup.remove.slice(0, 5)) {
    console.log(`  DEL  ${r.file}`);
  }
  if (dedup.remove.length > 5) console.log(`  ... 以及其余 ${dedup.remove.length - 5} 条`);
  if (dedup.unparsable.length > 0) {
    console.log(`⚠️ 无法解析（不处理）: ${dedup.unparsable.length} 条: ${dedup.unparsable.join(', ')}`);
  }
  const removeIds = new Set(dedup.remove.map(r => r.id));
  const indexRemovals = storeIndex.filter(e => e && removeIds.has(e.id));
  console.log(`index.json 同步移除: ${indexRemovals.length} 条（总条目 ${storeIndex.length} → ${storeIndex.length - indexRemovals.length}）`);

  // ── b) decision tag 回填 ──
  const backfill = planDecisionBackfill(storeIndex);
  console.log(`\n## b) decision tag 回填（约定 ['decision', <category 或 'process'>]）`);
  if (backfill.length === 0) {
    console.log('无需回填：所有 type=decision 条目已含 decision tag。');
  }
  for (const b of backfill) {
    console.log(`  BACKFILL ${b.id} —「${(b.title || '').slice(0, 40)}」`);
    console.log(`    tags: [${b.oldTags.join(', ')}] → [${b.newTags.join(', ')}]`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN：未写盘。确认后加 --apply 执行。');
    return;
  }

  // ── 执行 ──
  console.log('\n## 执行');
  // 1. 删除重复 resolution 文件
  const deletedFiles = new Set();
  for (const r of dedup.remove) {
    fs.unlinkSync(path.join(KNOWLEDGE_DIR, r.file));
    deletedFiles.add(r.file);
  }
  console.log(`已删除 ${deletedFiles.size} 个重复 resolution 文件`);

  // 2. index.json：移除被删 resolution + 回填 decision tags
  const backfillById = new Map(backfill.map(b => [b.id, b.newTags]));
  const newIndex = storeIndex
    .filter(e => e && !removeIds.has(e.id))
    .map(e => backfillById.has(e.id) ? { ...e, tags: backfillById.get(e.id) } : e);
  fs.writeFileSync(STORE_INDEX, `${JSON.stringify(newIndex, null, 2)}\n`, 'utf-8');
  console.log(`index.json 已更新：移除 ${indexRemovals.length} 条，回填 ${backfill.length} 条 decision tags`);

  // 3. decision-*.md frontmatter 回填（按 frontmatter id 与 index 条目对应）
  let mdUpdated = 0;
  for (const b of backfill) {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.startsWith('decision-') && f.endsWith('.md'));
    for (const f of files) {
      const filePath = path.join(KNOWLEDGE_DIR, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);
      if (!parsed || parsed.meta.id !== b.id) continue;
      const updated = backfillMdTags(content, ['decision', b.category]);
      if (updated) {
        fs.writeFileSync(filePath, updated, 'utf-8');
        mdUpdated++;
        console.log(`  已回填 ${f} (${b.id})`);
      }
    }
  }
  console.log(`decision .md 回填 ${mdUpdated} 个文件`);

  // 4. 重建 _index.md（保持与磁盘一致，消除 index inconsistency 报警）
  const indexed = rebuildDocIndex(deletedFiles);
  console.log(`_index.md 已重建：${indexed} 条`);
  console.log('\n清洗完成。');
}

main();
