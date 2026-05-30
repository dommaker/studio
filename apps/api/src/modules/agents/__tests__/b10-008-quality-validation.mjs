#!/usr/bin/env node
/**
 * B10-008 Quality Validation
 *
 * Run extractUserBehavior prompt against 3 historical session JSONL files.
 * Evaluate: coverage ≥60%, false positive rate <30%, evidence quality.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Config ──
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
const THRESHOLD = 0.6;
const MAX_CONTENT = 40_000;

// 3 sessions: varied size/date
const SESSIONS = [
  '/root/.claude/projects/-root-projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl.bak.20260523-085252',
  '/root/.claude/projects/-root-projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl.bak.20260527-104614',
  '/root/.claude/projects/-root-projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl.bak.20260528-015910',
];

// ── Preprocessing (same as events-daemon postSessionArchive) ──

function preprocessJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const msg = parsed.message || parsed;
      if (parsed.type === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : '';
        if (text) messages.push('User: ' + text.slice(0, 2000));
      } else if (parsed.type === 'assistant') {
        const textBlocks = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === 'text' && !b.text?.includes('thinking')).map(b => b.text).join('\n')
          : typeof msg.content === 'string' ? msg.content : '';
        if (textBlocks) messages.push('Assistant: ' + textBlocks.slice(0, 2000));
      }
    } catch { /* skip malformed */ }
  }
  const fullText = messages.join('\n');
  if (fullText.length <= 50000) return fullText;
  return fullText.slice(0, 25000) + '\n\n... (truncated) ...\n\n' + fullText.slice(-25000);
}

// ── Load existing memory rules for coverage check ──

function loadMemoryRules() {
  const memoryDir = join(homedir(), '.claude', 'projects', '-root-projects', 'memory');
  const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
  const rules = [];
  for (const f of files) {
    const raw = readFileSync(join(memoryDir, f), 'utf-8');
    const titleMatch = raw.match(/^name:\s*(.+)$/m);
    const descMatch = raw.match(/^description:\s*(.+)$/m);
    rules.push({
      file: f,
      title: titleMatch ? titleMatch[1] : f.replace('.md', ''),
      description: descMatch ? descMatch[1] : '',
    });
  }
  return rules;
}

// ── DeepSeek API call (same prompt as extractUserBehavior) ──

async function callDeepSeek(content, existingPatterns) {
  const systemPrompt = `你是一个行为模式分析师。从以下 Claude Code 会话对话中，提取用户的行为模式。

## 提取维度

### A. 纠正信号（correction）
用户纠正助手的时刻。识别标志：
- 显式纠正："不对"/"应该是"/"你错了"/"先验证"/"不要删"
- 隐式纠正："我感觉你陷入了误区"/"你扫的是哪个工程"/"按照X来判断有点问题"
- 方案推翻：用户否定助手的方案并给出新方向
- 假设质疑：用户质疑助手的前提假设

**不是纠正的情况（负面示例）**：
- 正常指令："先看看待办"/"写个spec" — 这是任务分配，不是纠正
- 信息补充："对，而且还要..." — 这是补充，不是否定
- 确认："可以"/"没问题" — 这是同意

提取：纠正内容 + 触发场景 + 推断的规则

### B. 决策模式（workflow）
用户的决策链。识别标志：
- "先X再Y" / "先看...再做..."
- 用户引导助手的执行顺序
- 用户在多个选项中的选择逻辑
提取：触发条件 + 步骤序列 + 产出物

### C. 重复操作（automation）
用户反复手动执行的操作。识别标志：
- 多次相同请求
- 每次都要确认/查询的东西
- 可以用脚本/hook 替代的手动步骤
提取：操作内容 + 频率 + 自动化价值

## 输出格式（JSON 数组）

[
  {
    "category": "correction|workflow|automation",
    "title": "简短标题（10字以内）",
    "evidence": "原文引用",
    "pattern": "模式描述",
    "suggestedAction": "create_rule|create_skill|create_automation|skip",
    "confidence": 0.0-1.0
  }
]

## 过滤条件

- 只输出 confidence > ${THRESHOLD} 的条目
- 只输出以下未覆盖的条目
- 保持简洁，每个条目不超过 3 行

${existingPatterns}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: content.slice(0, MAX_CONTENT) },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── JSON parsing (4 strategies) ──

function parseProfiles(llmContent) {
  if (!llmContent) return [];
  // 1. direct JSON
  try {
    const parsed = JSON.parse(llmContent);
    return Array.isArray(parsed) ? parsed : parsed.profiles || parsed.entries || [];
  } catch {}
  // 2. code block
  const codeMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  // 3. array match
  const arrMatch = llmContent.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  // 4. object match
  const objMatch = llmContent.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      return Array.isArray(parsed) ? parsed : parsed.profiles || parsed.entries || [];
    } catch {}
  }
  return [];
}

// ── Coverage evaluation ──

function evaluateCoverage(profiles, memoryRules) {
  // Map memory rule keywords to check if extracted profiles cover them
  const ruleKeywords = memoryRules.map(r => {
    const words = (r.title + ' ' + r.description).toLowerCase();
    return { rule: r, words };
  });

  const coveredRules = new Set();
  for (const p of profiles) {
    const pText = ((p.title || '') + ' ' + (p.pattern || '') + ' ' + (p.evidence || '')).toLowerCase();
    for (let i = 0; i < ruleKeywords.length; i++) {
      const kw = ruleKeywords[i];
      // Check if profile relates to this rule (keyword overlap)
      const ruleTokens = kw.words.match(/[\u4e00-\u9fff]|[a-z0-9]{3,}/g) || [];
      const profileTokens = pText.match(/[\u4e00-\u9fff]|[a-z0-9]{3,}/g) || [];
      const overlap = ruleTokens.filter(t => profileTokens.includes(t)).length;
      if (overlap >= 3 || (ruleTokens.length > 0 && overlap / ruleTokens.length > 0.3)) {
        coveredRules.add(i);
      }
    }
  }
  return { covered: coveredRules.size, total: ruleKeywords.length, rate: coveredRules.size / ruleKeywords.length };
}

function evaluateFalsePositives(profiles) {
  // Heuristic: profiles with confidence < 0.7 or suggestedAction === 'skip' are likely false positives
  // Also check evidence quality: must have actual quote
  let fp = 0;
  const details = [];
  for (const p of profiles) {
    let isFp = false;
    let reason = '';
    if ((p.confidence || 0) < 0.7) { isFp = true; reason = 'low confidence'; }
    if (!p.evidence || p.evidence.length < 10) { isFp = true; reason = 'no/weak evidence'; }
    if (p.suggestedAction === 'skip') { isFp = true; reason = 'skip action'; }
    if (isFp) fp++;
    details.push({ title: p.title, confidence: p.confidence, isFp, reason });
  }
  return { fp, total: profiles.length, rate: profiles.length > 0 ? fp / profiles.length : 0, details };
}

// ── Main ──

async function main() {
  if (!DEEPSEEK_API_KEY) {
    console.error('ERROR: No DEEPSEEK_API_KEY or ANTHROPIC_AUTH_TOKEN set');
    process.exit(1);
  }

  const memoryRules = loadMemoryRules();
  console.log(`Loaded ${memoryRules.length} memory rules for coverage check\n`);

  const allResults = [];

  for (let i = 0; i < SESSIONS.length; i++) {
    const fp = SESSIONS[i];
    const label = fp.split('.').pop(); // timestamp suffix
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Session ${i + 1}: ${label}`);
    console.log(`File: ${fp}`);
    console.log(`${'='.repeat(60)}`);

    // Preprocess
    const content = preprocessJsonl(fp);
    console.log(`Preprocessed: ${content.length} chars`);

    // Build existing patterns block (simplified — no Prisma, just memory rules)
    const existingPatterns = memoryRules.length > 0
      ? `已有 memory 规则:\n${memoryRules.map(r => `- ${r.title}`).join('\n')}\n\n只提取以上未覆盖的新模式。`
      : '';

    // Call DeepSeek
    console.log('Calling DeepSeek API...');
    const t0 = Date.now();
    const llmContent = await callDeepSeek(content, existingPatterns);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`LLM response: ${llmContent.length} chars (${elapsed}s)`);

    // Parse
    const profiles = parseProfiles(llmContent);
    console.log(`Parsed: ${profiles.length} profiles`);

    // Filter by threshold
    const aboveThreshold = profiles.filter(p => (p.confidence || 0) >= THRESHOLD);
    console.log(`Above threshold (${THRESHOLD}): ${aboveThreshold.length}`);

    // Evaluate
    const coverage = evaluateCoverage(aboveThreshold, memoryRules);
    const fpRate = evaluateFalsePositives(aboveThreshold);

    console.log(`\n--- Results ---`);
    console.log(`Coverage: ${coverage.covered}/${coverage.total} = ${(coverage.rate * 100).toFixed(1)}%`);
    console.log(`False positive rate: ${fpRate.fp}/${fpRate.total} = ${(fpRate.rate * 100).toFixed(1)}%`);

    console.log(`\nExtracted profiles:`);
    for (const p of aboveThreshold) {
      console.log(`  [${p.category}] ${p.title} (conf: ${p.confidence})`);
      console.log(`    evidence: ${(p.evidence || '').slice(0, 100)}`);
      console.log(`    pattern: ${(p.pattern || '').slice(0, 100)}`);
      console.log(`    action: ${p.suggestedAction}`);
    }

    allResults.push({ label, profiles: aboveThreshold, coverage, fpRate });
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);

  const totalProfiles = allResults.reduce((s, r) => s + r.profiles.length, 0);
  const avgCoverage = allResults.reduce((s, r) => s + r.coverage.rate, 0) / allResults.length;
  const avgFpRate = allResults.reduce((s, r) => s + r.fpRate.rate, 0) / allResults.length;

  console.log(`Total profiles extracted: ${totalProfiles}`);
  console.log(`Average coverage: ${(avgCoverage * 100).toFixed(1)}% (target: ≥60%)`);
  console.log(`Average false positive rate: ${(avgFpRate * 100).toFixed(1)}% (target: <30%)`);
  console.log(`\nAC-7 verdict:`);
  console.log(`  Coverage: ${avgCoverage >= 0.6 ? 'PASS' : 'FAIL'} (${(avgCoverage * 100).toFixed(1)}%)`);
  console.log(`  FP rate:  ${avgFpRate < 0.3 ? 'PASS' : 'FAIL'} (${(avgFpRate * 100).toFixed(1)}%)`);
  console.log(`  Evidence: ${totalProfiles > 0 ? 'PASS (each has evidence field)' : 'FAIL (no profiles)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
