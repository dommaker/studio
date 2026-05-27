#!/usr/bin/env node
/**
 * memory-knowledge-sync.js — 开发文档 → Studio 知识引擎自动沉淀
 *
 * 由 Claude CLI PostToolUse(Write) hook 触发。
 * 读取前端标记了 ingest:true 的 markdown 文档，
 * 写入 KnowledgeStore (.harness/knowledge/)。
 *
 * 用法: node memory-knowledge-sync.js <file-path>
 *
 * 环境变量:
 *   KNOWLEDGE_DIR  — KnowledgeStore 目标目录 (默认 .harness/knowledge/)
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(process.cwd(), '.harness', 'knowledge');

// ── YAML frontmatter parser (minimal, no dependency) ──
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const fm = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    fm[key] = val;
  }
  return { frontmatter: fm, body: content.slice(match[0].length).trim() };
}

// ── Write knowledge entry (file-based, compatible with KnowledgeStore format) ──
function writeKnowledgeEntry(entry) {
  const { id, type, title, content, frontmatter } = entry;

  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });

  const filename = `${type}-${id}.md`;
  const filepath = path.join(KNOWLEDGE_DIR, filename);

  // KnowledgeStore-compatible format: YAML frontmatter + markdown body
  const fm = {
    id,
    type,
    title,
    source: frontmatter.source || 'memory-sync',
    maturity: frontmatter.maturity || 'verified',
    confidence: frontmatter.confidence || 0.7,
    published: frontmatter.published !== undefined ? frontmatter.published : true,
    createdAt: frontmatter.createdAt || new Date().toISOString(),
    tags: frontmatter.tags || [],
  };

  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');

  const fileContent = `---\n${yaml}\n---\n\n${content}`;
  fs.writeFileSync(filepath, fileContent, 'utf-8');

  // Update index.json
  const indexPath = path.join(KNOWLEDGE_DIR, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch {}
  const existingIdx = index.findIndex(e => e.id === id);
  if (existingIdx >= 0) {
    index[existingIdx] = { id, type, title, path: filename, updatedAt: new Date().toISOString() };
  } else {
    index.push({ id, type, title, path: filename, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  return filepath;
}

// ── Main ──
function main() {
  const targetFile = process.argv[2] || '';
  if (!targetFile) return;

  // Only process markdown files — gate is frontmatter, not path
  if (!targetFile.endsWith('.md')) return;

  syncFile(targetFile);
}

function syncFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log('[memory-sync] File not found:', filePath);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const maturity = frontmatter.maturity || 'verified';
  // Only skip drafts — verified/canonical always ingested
  // (ingest:true gate removed: maturity already handles quality control)
  if (maturity === 'draft') {
    console.log('[memory-sync] Skipped (maturity=draft):', path.basename(filePath));
    return;
  }

  const fileBase = path.basename(filePath, '.md');
  const entryType = frontmatter.type || 'architecture';
  const entryId = fileBase.replace(/^project_/, '').replace(/^feedback_/, '').replace(/^analysis_/, '').replace(/^issue_/, '');
  const entryTitle = frontmatter.name || fileBase;
  const description = frontmatter.description || '';

  // Build knowledge entry content
  const entryContent = [
    description ? `## 描述\n${description}\n` : '',
    `## 内容\n${body}`,
    '',
    `> 来源: ${filePath}`,
    `> 同步时间: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n\n');

  const entry = {
    id: entryId,
    type: entryType,
    title: entryTitle,
    content: entryContent,
    frontmatter,
  };

  const written = writeKnowledgeEntry(entry);
  console.log(`[memory-sync] Ingested: ${path.basename(filePath)} → ${written}`);
}

main();
