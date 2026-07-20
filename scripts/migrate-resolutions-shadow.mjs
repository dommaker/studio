#!/usr/bin/env node
/**
 * migrate-resolutions-shadow.mjs — R3 影子库合并（一次性迁移脚本）
 *
 * 影子库 ~/.studio/data/resolutions/*.json（triage 经 knowledgeService.createResolution
 * 写入，UI 不读）合并进 resolutionService 主存储 ~/.studio/knowledge/resolution-*.md。
 *
 * 去重判据：title + 内容 hash（sha256(`${title}\n${fix}`) 前 16 位，
 * 与 resolution.service.ts 的 resolutionContentHash 同口径）。主存储已有同 hash
 * 条目 → 跳过；同一批影子库内部同 hash → 只合第一条。
 *
 * 默认 dry-run（只读，打印合并报告）；--apply 才写盘。
 * 写盘仅新增 resolution-*.md（主存储格式与 writeResolution 一致），不删影子库源文件
 * （合并幂等——重跑全部判重跳过；源文件确认无误后可手动归档）。
 *
 * 注意：本脚本不同步 harness FileKnowledgeStore 的 index.json——解法库 UI/检索口径
 * （resolution.service scanResolutions）直接读目录，合并后立即可见。
 *
 * 用法：
 *   node scripts/migrate-resolutions-shadow.mjs          # dry-run
 *   node scripts/migrate-resolutions-shadow.mjs --apply  # 执行合并
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const SHADOW_DIR = path.join(os.homedir(), '.studio', 'data', 'resolutions');
const KNOWLEDGE_DIR = path.join(os.homedir(), '.studio', 'knowledge');

function contentHash(title, fix) {
  return crypto.createHash('sha256').update(`${title}\n${fix}`).digest('hex').slice(0, 16);
}

/** 与 resolution.service.ts resolutionFromDoc 同口径：从 body 提取 fix */
function extractFix(body) {
  const m = body.match(/## Solution\n\n([\s\S]*)$/);
  return m ? m[1].trim() : body.replace(/^# .*\n/, '').trim();
}

/** 读取主存储全部 resolution 的 title+fix hash 集合 */
function scanMainStoreHashes() {
  const hashes = new Set();
  let files = [];
  try {
    files = fs.readdirSync(KNOWLEDGE_DIR);
  } catch {
    return hashes;
  }
  for (const f of files) {
    if (!f.startsWith('resolution-') || !f.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf-8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!m) continue;
      const title = (m[1].match(/^title:\s*"?([^"\n]*)"?$/m) || [])[1] || '';
      hashes.add(contentHash(title, extractFix(m[2].trim())));
    } catch { /* skip unreadable */ }
  }
  return hashes;
}

/** 序列化为 writeResolution 落盘格式（FileStore.serializeFrontmatter 同构） */
function serializeResolution(r) {
  const lines = [
    '---',
    'type: "resolution"',
    `pattern: "${r.pattern}"`,
    `errorClass: "${r.errorClass}"`,
    `layer: "${r.layer}"`,
    `title: "${r.title}"`,
    `maturity: "${r.status || 'pending'}"`,
    `verifyCount: ${r.verifyCount || 0}`,
  ];
  if (Array.isArray(r.tags) && r.tags.length > 0) {
    lines.push(`tags: [${r.tags.map(t => `"${t}"`).join(', ')}]`);
  }
  lines.push(`createdAt: "${r.createdAt}"`, `updatedAt: "${r.updatedAt}"`, '---');
  return `${lines.join('\n')}\n\n# ${r.title}\n\n## Solution\n\n${r.fix}`;
}

function main() {
  console.log(`# R3 影子库合并报告（${APPLY ? 'APPLY' : 'DRY-RUN'}）`);
  console.log(`影子库: ${SHADOW_DIR}`);
  console.log(`主存储: ${KNOWLEDGE_DIR}\n`);

  let shadowFiles = [];
  try {
    shadowFiles = fs.readdirSync(SHADOW_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    console.log('影子库目录不存在或不可读，无合并项。');
    return;
  }

  const mainHashes = scanMainStoreHashes();
  const batchHashes = new Set();
  const plan = [];

  for (const f of shadowFiles) {
    const filePath = path.join(SHADOW_DIR, f);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      plan.push({ file: f, action: 'ERROR', reason: `JSON 解析失败: ${err.message}` });
      continue;
    }

    // 影子库 tags 是 JSON 编码字符串（历史写入形状），归一化为数组
    let tags = entry.tags;
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch { tags = []; }
    }
    if (!Array.isArray(tags)) tags = [];

    const normalized = {
      id: entry.id || f.replace(/\.json$/, ''),
      pattern: entry.pattern || '',
      errorClass: entry.errorClass || '',
      layer: entry.layer || 'L3_tool_behavior',
      title: entry.title || '',
      fix: entry.fix || '',
      status: entry.status || 'pending',
      verifyCount: Number(entry.verifyCount) || 0,
      tags,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };

    const hash = contentHash(normalized.title, normalized.fix);
    if (mainHashes.has(hash)) {
      plan.push({ file: f, id: normalized.id, title: normalized.title, action: 'SKIP', reason: '主存储已存在同 title+内容 hash 条目' });
    } else if (batchHashes.has(hash)) {
      plan.push({ file: f, id: normalized.id, title: normalized.title, action: 'SKIP', reason: '本批次内重复（同 hash 已计划合并）' });
    } else {
      const target = `resolution-${normalized.id}.md`;
      if (fs.existsSync(path.join(KNOWLEDGE_DIR, target))) {
        plan.push({ file: f, id: normalized.id, title: normalized.title, action: 'SKIP', reason: `主存储已存在同名文件 ${target}` });
      } else {
        batchHashes.add(hash);
        plan.push({ file: f, id: normalized.id, title: normalized.title, action: 'MERGE', target, entry: normalized });
      }
    }
  }

  for (const p of plan) {
    if (p.action === 'MERGE') {
      console.log(`[${p.action}] ${p.file} → ${p.target}`);
      console.log(`  title: ${p.title} | status: ${p.entry.status} | tags: [${p.entry.tags.join(', ')}]`);
    } else {
      console.log(`[${p.action}] ${p.file}${p.title ? ` (${p.title})` : ''} — ${p.reason}`);
    }
  }

  const merges = plan.filter(p => p.action === 'MERGE');
  const skips = plan.filter(p => p.action === 'SKIP');
  const errors = plan.filter(p => p.action === 'ERROR');
  console.log(`\n合计: ${plan.length} 个影子文件 → 合并 ${merges.length}，跳过 ${skips.length}，错误 ${errors.length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN：未写盘。确认后加 --apply 执行。');
    return;
  }

  for (const p of merges) {
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, p.target), serializeResolution(p.entry), 'utf-8');
    console.log(`已写入 ${p.target}`);
  }
  console.log(`\n合并完成：写入 ${merges.length} 条。影子库源文件保留在 ${SHADOW_DIR}（重跑本脚本会全部判重跳过，确认后可手动归档）。`);
}

main();
