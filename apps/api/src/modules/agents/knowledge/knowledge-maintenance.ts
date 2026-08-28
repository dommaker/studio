/**
 * Knowledge Agent — 语料分析（每日维护）子模块
 *
 * 从 knowledge-curator.service.ts 拆分（提取/冷启动/分析分离，零行为变更）。
 * LLM-Powered Daily Maintenance (F1) 的 4 个质量操作，由门面 runDailyMaintenance 聚合调用：
 *   - semanticDedup         F1a 语义去重（同 type 分批送 LLM，archive 重复并合并 sourceReferences）
 *   - assessQuality         F1b 内容质量评估（低质量 archive，proven 不动）
 *   - validateFreshness     F1c 过期验证（近 7 天 git 变更 → 匹配条目 → 标 draft 重分析）
 *   - resolveContradictions F1d 矛盾审查（按 tag 分组检测，保留高 maturity）
 */

import { logger } from '@dommaker/studio-shared';
import { getSystemExecutor } from '../system-executor.js';
import { sharedStore } from '../../knowledge/knowledge-singletons.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * F1a: 语义去重 — 用 LLM 判断内容相似的知识条目，合并重复
 *
 * 流程：取所有 active 条目 → 按 type 分组 → 每批 10 条送 LLM → 合并建议
 */
export async function semanticDedup(): Promise<number> {
  const entries = sharedStore.list({ excludeArchived: true });
  if (entries.length < 2) return 0;

  let merged = 0;
  // Group by type for more accurate comparison
  const byType = new Map<string, typeof entries>();
  for (const e of entries) {
    const group = byType.get(e.type) || [];
    group.push(e);
    byType.set(e.type, group);
  }

  for (const [type, typeEntries] of byType) {
    if (typeEntries.length < 2) continue;

    // Process in batches of 10
    for (let i = 0; i < typeEntries.length; i += 10) {
      const batch = typeEntries.slice(i, i + 10);
      if (batch.length < 2) continue;

      const entryList = batch.map((e, idx) =>
        `[${idx}] id=${e.id} title="${e.title}" content="${e.content.slice(0, 150)}..."`,
      ).join('\n');

      const prompt = `以下是一批同类型(type=${type})的知识条目。请判断哪些在语义上是重复的（描述同一个问题或决策），即使标题不同。

${entryList}

输出 JSON 格式：
{
  "duplicates": [
    { "keep": "保留的条目id", "merge": ["要合并的条目id"], "reason": "为什么是重复的" }
  ]
}

如果没有重复，返回 {"duplicates": []}。最多返回 5 组。`;

      try {
        const result = await getSystemExecutor().runJson<{ duplicates: Array<{ keep: string; merge: string[]; reason: string }> }>(
          prompt,
          { systemPrompt: '你是知识库去重专家。判断哪些知识条目在语义上是重复的。只合并真正重复的，不要合并相关但不同的条目。', eventSource: 'knowledge-maintenance' },
        );

        if (!result.duplicates?.length) continue;

        for (const dup of result.duplicates) {
          const keepEntry = sharedStore.get(dup.keep);
          if (!keepEntry) continue;

          for (const mergeId of dup.merge) {
            const mergeEntry = sharedStore.get(mergeId);
            if (!mergeEntry) continue;

            // Merge: archive the duplicate, keep the better one
            sharedStore.update(mergeId, { maturity: 'archived' });
            // Transfer sourceReferences from archived to kept entry
            const refs = [...(keepEntry.sourceReferences || []), ...(mergeEntry.sourceReferences || [])];
            const seen = new Set<string>();
            const deduped = refs.filter(r => {
              const key = `${r.workflow}:${r.timestamp}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).slice(-20);
            sharedStore.update(dup.keep, { sourceReferences: deduped });
            merged++;

            logger.info('[KnowledgeCurator] Semantic dedup merged', {
              keep: dup.keep,
              archived: mergeId,
              reason: dup.reason,
            });
          }
        }
      } catch (err) {
        logger.warn('[KnowledgeCurator] Semantic dedup batch failed', { type, error: String(err) });
      }
    }
  }

  return merged;
}

/**
 * F1b: 内容质量评估 — 用 LLM 评估每条知识是否值得保留
 *
 * 流程：取所有 active 条目 → 每批 10 条送 LLM → 低质量的 archive
 */
export async function assessQuality(): Promise<number> {
  const entries = sharedStore.list({ excludeArchived: true });
  if (entries.length === 0) return 0;

  let archived = 0;

  // Process in batches of 10
  for (let i = 0; i < entries.length; i += 10) {
    const batch = entries.slice(i, i + 10);

    const entryList = batch.map((e, idx) =>
      `[${idx}] id=${e.id} type=${e.type} title="${e.title}" content="${e.content.slice(0, 200)}"`,
    ).join('\n');

    const prompt = `请评估以下知识条目的质量。对每条判断是否值得保留。

评估标准：
1. 内容是否具体可操作（不是泛泛而谈）
2. 是否有根因分析（不只是描述现象）
3. 是否对未来的开发有参考价值
4. 是否是显而易见的事实（不需要记录）

${entryList}

输出 JSON 格式：
{
  "assessments": [
    { "id": "条目id", "keep": true/false, "reason": "保留/删除的理由", "score": 1-10 }
  ]
}

只标记 keep=false 的为低质量。`;

    try {
      const result = await getSystemExecutor().runJson<{ assessments: Array<{ id: string; keep: boolean; reason: string; score: number }> }>(
        prompt,
        { systemPrompt: '你是知识质量评估专家。严格评估每条知识的价值。只删除真正无价值的条目，有疑问的保留。', eventSource: 'knowledge-maintenance' },
      );

      if (!result.assessments?.length) continue;

      for (const assessment of result.assessments) {
        if (assessment.keep) continue;

        const entry = sharedStore.get(assessment.id);
        if (!entry || entry.maturity === 'proven') continue; // Don't archive proven entries

        sharedStore.update(assessment.id, { maturity: 'archived' });
        archived++;

        logger.info('[KnowledgeCurator] Quality assessment archived', {
          id: assessment.id,
          title: entry.title,
          reason: assessment.reason,
          score: assessment.score,
        });
      }
    } catch (err) {
      logger.warn('[KnowledgeCurator] Quality assessment batch failed', { error: String(err) });
    }
  }

  return archived;
}

/**
 * F1c: 过期验证 — 用 LLM 判断知识内容是否因代码变更而过期
 *
 * 流程：取最近 7 天有 git 变更的文件 → 匹配关联的知识条目 → LLM 判断是否过期
 */
export async function validateFreshness(): Promise<number> {
  let updated = 0;

  try {
    // Get recent git changes (last 7 days)
    const projectRoot = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
    const { stdout: recentChanges } = await execAsync(
      'git log --since="7 days ago" --name-only --pretty=format: 2>/dev/null | sort -u | head -50',
      { cwd: projectRoot, timeout: 15_000 },
    );
    const changedFiles = recentChanges.trim().split('\n').filter(Boolean);
    if (changedFiles.length === 0) return 0;

    // Find entries that reference these files (by tags or content)
    const entries = sharedStore.list({ excludeArchived: true });
    const potentiallyStale = entries.filter(e => {
      const text = `${e.title} ${e.content} ${(e.tags || []).join(' ')}`.toLowerCase();
      return changedFiles.some(f => text.includes(f.toLowerCase()) || text.includes(path.basename(f, path.extname(f)).toLowerCase()));
    });

    if (potentiallyStale.length === 0) return 0;

    // Process in batches of 5
    for (let i = 0; i < potentiallyStale.length; i += 5) {
      const batch = potentiallyStale.slice(i, i + 5);

      const context = batch.map((e, idx) =>
        `[${idx}] id=${e.id} title="${e.title}" content="${e.content.slice(0, 200)}"`,
      ).join('\n');

      const prompt = `以下知识条目关联的代码文件在最近 7 天内有变更。请判断这些知识是否仍然正确。

最近变更的文件：
${changedFiles.slice(0, 20).join('\n')}

知识条目：
${context}

输出 JSON 格式：
{
  "results": [
    { "id": "条目id", "stillValid": true/false, "reason": "判断理由" }
  ]
}

如果知识描述的内容已被代码变更覆盖或修正，标记为 stillValid=false。`;

      try {
        const result = await getSystemExecutor().runJson<{ results: Array<{ id: string; stillValid: boolean; reason: string }> }>(
          prompt,
          { systemPrompt: '你是代码-知识一致性检查专家。判断知识条目描述的内容是否与最新代码一致。如果不确定，标记为 stillValid=true。', eventSource: 'knowledge-maintenance' },
        );

        if (!result.results?.length) continue;

        for (const r of result.results) {
          if (r.stillValid) continue;

          // Mark as draft for re-analysis
          sharedStore.update(r.id, { maturity: 'draft' });
          updated++;

          logger.info('[KnowledgeCurator] Freshness validation marked stale', {
            id: r.id,
            reason: r.reason,
          });
        }
      } catch (err) {
        logger.warn('[KnowledgeCurator] Freshness validation batch failed', { error: String(err) });
      }
    }
  } catch (err) {
    logger.warn('[KnowledgeCurator] Freshness validation failed', { error: String(err) });
  }

  return updated;
}

/**
 * F1d: 矛盾审查 — 用 LLM 检测同主题不同结论的知识条目
 *
 * 流程：按 tag 分组 → 同组内送 LLM → 检测矛盾 → 解决（保留更可靠的，标记另一个）
 */
export async function resolveContradictions(): Promise<number> {
  let resolved = 0;
  const entries = sharedStore.list({ excludeArchived: true });

  // Group by shared tags (at least 2 common tags)
  const tagGroups = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.tags || entry.tags.length === 0) continue;
    for (const tag of entry.tags) {
      const group = tagGroups.get(tag) || [];
      group.push(entry);
      tagGroups.set(tag, group);
    }
  }

  // Only check groups with 2+ entries
  for (const [tag, group] of tagGroups) {
    if (group.length < 2) continue;

    // Deduplicate by id within group
    const unique = [...new Map(group.map(e => [e.id, e])).values()];
    if (unique.length < 2) continue;

    const entryList = unique.map((e, idx) =>
      `[${idx}] id=${e.id} maturity=${e.maturity} title="${e.title}" content="${e.content.slice(0, 200)}"`,
    ).join('\n');

    const prompt = `以下知识条目都与标签 "${tag}" 相关。请检查它们之间是否存在矛盾（对同一问题给出相反的建议或结论）。

${entryList}

输出 JSON 格式：
{
  "contradictions": [
    {
      "entries": ["矛盾的条目id列表"],
      "description": "矛盾的具体描述",
      "resolution": "建议如何解决（保留哪个、修改哪个）"
    }
  ]
}

如果没有矛盾，返回 {"contradictions": []}。相关但不矛盾的条目不算。`;

    try {
      const result = await getSystemExecutor().runJson<{ contradictions: Array<{ entries: string[]; description: string; resolution: string }> }>(
        prompt,
        { systemPrompt: '你是知识一致性检查专家。只报告真正的矛盾（对同一问题给出相反建议），不要报告互补或不同角度的知识。', eventSource: 'knowledge-maintenance' },
      );

      if (!result.contradictions?.length) continue;

      for (const contradiction of result.contradictions) {
        // Keep the highest maturity entry, mark others as needing review
        const conflictEntries = contradiction.entries
          .map(id => sharedStore.get(id))
          .filter(Boolean) as typeof entries;

        if (conflictEntries.length < 2) continue;

        // Sort by maturity (proven > verified > draft)
        const maturityRank = { proven: 3, verified: 2, draft: 1, archived: 0 };
        conflictEntries.sort((a, b) => (maturityRank[b.maturity] || 0) - (maturityRank[a.maturity] || 0));

        // Mark lower-maturity entries as draft for re-analysis
        for (let j = 1; j < conflictEntries.length; j++) {
          sharedStore.update(conflictEntries[j].id, { maturity: 'draft' });
          resolved++;
        }

        logger.info('[KnowledgeCurator] Contradiction detected', {
          tag,
          entries: contradiction.entries,
          description: contradiction.description,
          resolution: contradiction.resolution,
        });
      }
    } catch (err) {
      logger.warn('[KnowledgeCurator] Contradiction check failed', { tag, error: String(err) });
    }
  }

  return resolved;
}
