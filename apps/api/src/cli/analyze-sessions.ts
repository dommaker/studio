/**
 * studio analyze-sessions — 对话模式发现引擎
 * （自 harness src/cli/commands/analyze-sessions.ts 迁入，ADR-0019）
 *
 * 扫描 transcript 文件，不预设关键词，挖掘：
 *   1. 纠正信号（用户反复指出的问题）
 *   2. 高频 N-gram（跨会话重复出现的概念）
 *   3. 规则缺口（高频模式未被现有 memory 覆盖）
 *
 * 输出候选规则建议，供用户审核后写入 memory。
 */

import chalk from './colors.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readTranscriptSessions,
  type MinedSession,
  extractCorrectionMatches,
  cleanCorrectionConcept,
  tokenize,
  stripCodeBlocks,
  jaccardSimilarity,
  isPunctuation,
  isCodeNoise,
  hasSemanticContent,
  STOP_WORDS,
} from './session-mining/index.js';
import { log, processIO, type CommandIO, type CommandResult } from './command-contract.js';

export interface AnalyzeSessionsOptions {
  days?: number;
  projectPath?: string;
  json?: boolean;
}

interface Correction {
  sentence: string;
  sessionId: string;
  timestamp: string;
}

interface PatternCandidate {
  pattern: string;           // 被纠正/重复的概念
  frequency: number;          // 跨会话出现次数
  sessions: string[];         // 出现的会话 ID
  source: 'correction' | 'ngram';  // 来源
  confidence: number;         // 0-1
  suggestedRule: string;      // 建议的规则名
}

// ── Main ──

export async function analyzeSessions(options: AnalyzeSessionsOptions, io: CommandIO = processIO): Promise<CommandResult> {
  const transcriptDir = process.env.CLAUDE_TRANSCRIPTS_DIR
    || path.join(os.homedir(), '.claude', 'projects', '-root--claude');
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
  const days = options.days || 7;

  if (!fs.existsSync(transcriptDir)) {
    log(io, chalk.yellow('No transcripts directory found'));
    return { kind: 'skip', reason: `会话记录目录不存在: ${transcriptDir}` };
  }

  // 1. Scan transcripts（since 下推 seam：stat 级过滤，窗口外不 parse；倒序）
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions = readTranscriptSessions(transcriptDir, { since: cutoff })
    .sort((a, b) => b.date.localeCompare(a.date));

  if (sessions.length === 0) {
    log(io, chalk.yellow(`No sessions found in the last ${days} days`));
    return { kind: 'skip', reason: `最近 ${days} 天没有会话` };
  }

  // 2. Extract corrections + N-grams
  const corrections = extractCorrections(sessions);
  const ngrams = extractNGrams(sessions, { minLen: 4, maxLen: 24, minFreq: 2 });

  // 3. Load existing memory rules for gap detection
  const existingRules = loadExistingRules(memoryDir);

  // 4. Generate candidates
  const candidates = generateCandidates(corrections, ngrams, existingRules);

  // 5. Output
  if (options.json) {
    log(io, JSON.stringify({ sessions: sessions.length, corrections: corrections.length, candidates }, null, 2));
    return { kind: 'ok' };
  }

  log(io, chalk.blue(`🔍 Analyzing ${sessions.length} sessions (last ${days} days)...\n`));

  printCorrectionSummary(corrections, io);
  printCandidates(candidates, io);
  return { kind: 'ok' };
}

// ── Correction Extraction ──

function extractCorrections(sessions: MinedSession[]): Correction[] {
  const corrections: Correction[] = [];

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.role !== 'user') continue;
      const text = stripCodeBlocks(turn.content);

      for (const sentence of extractCorrectionMatches(text)) {
        if (sentence.length > 3 && sentence.length < 200) {
          corrections.push({
            sentence,
            sessionId: session.id,
            timestamp: session.date,
          });
        }
      }
    }
  }

  return corrections;
}

// ── N-gram Mining ──

interface NGramOptions {
  minLen: number;
  maxLen: number;
  minFreq: number;
}

interface NGramResult {
  phrase: string;
  frequency: number;
  sessions: string[];
}

function extractNGrams(sessions: MinedSession[], opts: NGramOptions): NGramResult[] {
  const phraseMap = new Map<string, { count: number; sessions: Set<string> }>();

  for (const session of sessions) {
    const userTexts = session.turns
      .filter(t => t.role === 'user' && !t.content.startsWith('{') && !t.content.startsWith('[') && t.content.length > 10)
      .map(t => stripCodeBlocks(t.content));

    const combined = userTexts.join(' ');

    // Extract meaningful word sequences (Chinese chars + meaningful words)
    const words = tokenize(combined);

    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = words.slice(i, i + n).join('');
        const clean = phrase.replace(/[，。！？、；：""''（）\s]/g, '');

        if (clean.length < opts.minLen || clean.length > opts.maxLen) continue;
        if (/^\d+$/.test(clean)) continue;
        if (STOP_WORDS.has(clean)) continue;
        if (isPunctuation(clean)) continue;

        const existing = phraseMap.get(clean) || { count: 0, sessions: new Set() };
        existing.count++;
        existing.sessions.add(session.id);
        phraseMap.set(clean, existing);
      }
    }
  }

  // Filter by minimum frequency and sort
  return Array.from(phraseMap.entries())
    .filter(([, v]) => v.count >= opts.minFreq && v.sessions.size >= 2)
    .map(([phrase, v]) => ({ phrase, frequency: v.count, sessions: Array.from(v.sessions) }))
    .filter(r => !isCodeNoise(r.phrase) && hasSemanticContent(r.phrase))
    .sort((a, b) => b.frequency - a.frequency || b.sessions.length - a.sessions.length);
}

// ── Existing Rules ──

function isInExistingRules(concept: string, existingRules: Set<string>): boolean {
  const lower = concept.toLowerCase();
  if (existingRules.has(lower)) return true;
  // Partial match: concept appears in any rule name
  for (const rule of existingRules) {
    if (rule.includes(lower) || lower.includes(rule)) return true;
  }
  return false;
}

function loadExistingRules(memoryDir: string): Set<string> {
  const concepts = new Set<string>();
  try {
    if (!fs.existsSync(memoryDir)) return concepts;
    for (const file of fs.readdirSync(memoryDir)) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
      // Extract key concepts from rule titles
      const titleMatch = content.match(/#\s+(.+)/);
      if (titleMatch) {
        const words = tokenize(titleMatch[1]);
        for (const w of words) {
          if (w.length >= 4) concepts.add(w.toLowerCase());
        }
      }
    }
  } catch {}
  return concepts;
}

// ── Candidate Generation ──

function generateCandidates(
  corrections: Correction[],
  ngrams: NGramResult[],
  existingRules: Set<string>,
): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];

  // From corrections: cluster similar sentences
  const correctionClusters = clusterCorrections(corrections);
  for (const cluster of correctionClusters) {
    // Must appear at least 3 times total
    if (cluster.sentences.length < 3) continue;
    const concept = extractConcept(cluster.sentences);
    if (isInExistingRules(concept, existingRules)) continue;

    candidates.push({
      pattern: concept,
      frequency: cluster.sentences.length,
      sessions: cluster.sessions,
      source: 'correction',
      confidence: Math.min(1, cluster.sentences.length / 10),
      suggestedRule: `feedback_auto_${concept.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '_').slice(0, 40)}.md`,
    });
  }

  // From N-grams: high-frequency concepts not in corrections
  const correctionConcepts = new Set(correctionClusters.map(c => extractConcept(c.sentences).toLowerCase()));
  for (const ng of ngrams) {
    const concept = ng.phrase;
    if (correctionConcepts.has(concept.toLowerCase())) continue; // already covered
    if (isInExistingRules(concept, existingRules)) continue;
    if (ng.frequency < 2) continue;
    const crossSessionStrength = ng.sessions.length >= 2;
    const highFreqSingle = ng.sessions.length === 1 && ng.frequency >= 4;
    if (!crossSessionStrength && !highFreqSingle) continue;

    candidates.push({
      pattern: concept,
      frequency: ng.frequency,
      sessions: ng.sessions,
      source: 'ngram',
      confidence: Math.min(1, ng.frequency / 10),
      suggestedRule: `feedback_recurring_${concept.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '_').slice(0, 40)}.md`,
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

interface CorrectionCluster {
  sentences: string[];
  sessions: string[];
}

function clusterCorrections(corrections: Correction[]): CorrectionCluster[] {
  const clusters: CorrectionCluster[] = [];
  const used = new Set<number>();

  for (let i = 0; i < corrections.length; i++) {
    if (used.has(i)) continue;
    const cluster: CorrectionCluster = {
      sentences: [corrections[i].sentence],
      sessions: [corrections[i].sessionId],
    };
    used.add(i);

    for (let j = i + 1; j < corrections.length; j++) {
      if (used.has(j)) continue;
      const similarity = jaccardSimilarity(corrections[i].sentence, corrections[j].sentence);
      if (similarity > 0.3) {
        cluster.sentences.push(corrections[j].sentence);
        if (!cluster.sessions.includes(corrections[j].sessionId)) {
          cluster.sessions.push(corrections[j].sessionId);
        }
        used.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function extractConcept(sentences: string[]): string {
  // Take the longest sentence and extract the noun phrase after the correction marker
  const longest = sentences.reduce((a, b) => a.length > b.length ? a : b, '');
  const cleaned = cleanCorrectionConcept(longest);
  return cleaned.slice(0, 60) || longest.slice(0, 60);
}

// ── Output ──

function printCorrectionSummary(corrections: Correction[], io: CommandIO): void {
  if (corrections.length === 0) {
    log(io, chalk.green('No correction patterns found'));
    return;
  }

  log(io, chalk.yellow(`📢 ${corrections.length} correction signals detected\n`));
}

function printCandidates(candidates: PatternCandidate[], io: CommandIO): void {
  if (candidates.length === 0) {
    log(io, chalk.green('✅ No new pattern candidates — all recurring concepts already have rules\n'));
    return;
  }

  log(io, chalk.bold('🔔 Pattern Candidates (suggested rules)\n'));

  const topK = candidates.slice(0, 10);
  for (const c of topK) {
    const icon = c.source === 'correction' ? '🔴' : '🟡';
    const confBar = '█'.repeat(Math.round(c.confidence * 10)) + '░'.repeat(10 - Math.round(c.confidence * 10));
    log(io, chalk.bold(`${icon} ${c.pattern}`));
    log(io, chalk.gray(`   Source: ${c.source} | Freq: ${c.frequency} | Sessions: ${c.sessions.length} | Confidence: ${confBar}`));
    log(io, chalk.cyan(`   → Rule: ${c.suggestedRule}`));
    log(io);
  }

  if (candidates.length > 10) {
    log(io, chalk.gray(`... and ${candidates.length - 10} more candidates. Run with --json for full list.`));
  }
}
