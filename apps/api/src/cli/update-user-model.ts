/**
 * studio update-user-model — 用户模型持续演化引擎
 * （自 harness src/cli/commands/update-user-model.ts 迁入，ADR-0019）
 *
 * 不依赖固定规则快照。每天从最新数据中提取增量信号，
 * 对比昨天状态，输出变化，更新模型。
 *
 * 数据源:
 *   ~/.claude/projects/-root--claude/*.jsonl  (对话)
 *   /tmp/claude-knowledge-hooks.log            (行为信号)
 *   studio/.harness/knowledge/                 (知识新鲜度)
 *   ~/.claude/projects/-root-projects/memory/  (规则库)
 *
 * 模型状态: $HARNESS_UUM_STATE_FILE，默认 ~/.claude/user-model-state.json
 * 画像输出: $HARNESS_UUM_PROFILE_FILE，默认 ~/.claude/projects/-root-projects/memory/user_profile.md
 */

import chalk from './colors.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readTranscriptSessions,
  type TranscriptFilter,
  extractCorrectionMatches,
  cleanCorrectionConcept,
  jaccardChinese,
} from './session-mining/index.js';
import { log, processIO, type CommandIO, type CommandResult } from './command-contract.js';

export interface UpdateUserModelOptions {
  days?: number;    // 只处理最近 N 天（自然日，含今天）的会话；缺省不过滤（向后兼容）
  json?: boolean;
  dryRun?: boolean;  // don't update state, just show what would change
}

interface ModelState {
  lastUpdated: string;
  sessionsProcessed: string[];       // session IDs already counted
  patterns: Record<string, {         // pattern → running stats
    firstSeen: string;
    occurrences: number;
    sessions: string[];
    trend: 'rising' | 'stable' | 'falling' | 'new' | 'gone';
    lastSeen: string;
  }>;
  lensWeights: Record<string, number>;  // lens → activation count → normalized weight
  principleWeights: Record<string, number>;
  evolutionLog: Array<{ date: string; change: string }>;
}

// 路径集中解析：默认值保持原行为，env 可覆盖（多工作区/测试隔离）。
// 运行时解析而非模块加载期常量，保证 env 设置后生效。
export interface UserModelPaths {
  stateFile: string;
  profileFile: string;
}

export function resolveUserModelPaths(env: NodeJS.ProcessEnv = process.env): UserModelPaths {
  const home = os.homedir();
  return {
    stateFile: env.HARNESS_UUM_STATE_FILE
      || path.join(home, '.claude', 'user-model-state.json'),
    profileFile: env.HARNESS_UUM_PROFILE_FILE
      || path.join(home, '.claude', 'projects', '-root-projects', 'memory', 'user_profile.md'),
  };
}

export async function updateUserModel(options: UpdateUserModelOptions, io: CommandIO = processIO): Promise<CommandResult> {
  const transcriptDir = process.env.CLAUDE_TRANSCRIPTS_DIR
    || path.join(os.homedir(), '.claude', 'projects', '-root--claude');

  // 1. Load previous state
  const paths = resolveUserModelPaths();
  const state = loadState(paths);

  // 2. Scan new data
  const newSessions = findNewSessions(transcriptDir, state.sessionsProcessed, options.days);
  if (newSessions.length === 0) {
    log(io, chalk.gray('No new sessions to process'));
    return { kind: 'skip', reason: '没有新会话可处理' };
  }

  // 3. Extract signals from new data
  const signals = extractSignals(newSessions);

  // 4. Build concept clusters (semantic dedup)
  const mergedConcepts = buildMergedConcepts(signals);

  // 5. Diff against previous state → find changes
  const changes = diffState(state, mergedConcepts, signals);

  // 6. Update state
  if (!options.dryRun) {
    for (const sid of newSessions.map(s => s.id)) {
      if (!state.sessionsProcessed.includes(sid)) {
        state.sessionsProcessed.push(sid);
      }
    }
    applySignals(state, signals, mergedConcepts);
    state.lastUpdated = new Date().toISOString();

    if (state.sessionsProcessed.length > 200) {
      state.sessionsProcessed = state.sessionsProcessed.slice(-200);
    }

    saveState(state, paths);
    updateProfile(state, paths);
  }

  // 6. Output
  if (options.json) {
    log(io, JSON.stringify({ newSessions: newSessions.length, changes }, null, 2));
    return { kind: 'ok' };
  }

  log(io, chalk.blue(`📊 Processed ${newSessions.length} new sessions\n`));
  printChanges(changes, signals, io);
  return { kind: 'ok' };
}

// ── State I/O ──

function loadState(paths: UserModelPaths): ModelState {
  try {
    if (fs.existsSync(paths.stateFile)) {
      return JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
    }
  } catch {}
  return {
    lastUpdated: new Date(0).toISOString(),
    sessionsProcessed: [],
    patterns: {},
    lensWeights: {},
    principleWeights: {},
    evolutionLog: [],
  };
}

function saveState(state: ModelState, paths: UserModelPaths): void {
  try {
    const dir = path.dirname(paths.stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch {}
}

// ── Session scanning ──

interface SimpleSession {
  id: string;
  date: string;
  userText: string;       // all user messages joined
  assistantText: string;  // all assistant messages joined
  toolCalls: string[];     // tool names used
}

function findNewSessions(dir: string, processed: string[], days?: number): SimpleSession[] {
  // 过滤下推 seam：excludeIds 走文件名、since 走 stat，未命中不 parse
  const filter: TranscriptFilter = { excludeIds: processed };

  // 「最近 N 天」：自然日窗口（含今天）。days<=0 视为不过滤，与缺省一致。
  // date 是 mtime 的 UTC 日，date >= cutoff ⟺ mtimeMs >= cutoff 日 UTC 零点
  if (days !== undefined && days > 0) {
    const cutoff = new Date(Date.now() - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    filter.since = Date.parse(cutoff);
  }

  const sessions = readTranscriptSessions(dir, filter);

  sessions.sort((a, b) => a.date.localeCompare(b.date));

  return sessions.map(s => ({
    id: s.id,
    date: s.date,
    userText: s.turns.filter(t => t.role === 'user').map(t => t.content).join('\n'),
    assistantText: s.turns.filter(t => t.role === 'assistant').map(t => t.content).join('\n'),
    toolCalls: s.toolCalls,
  }));
}

// ── Signal extraction ──

interface SessionSignals {
  sessionId: string;
  date: string;
  correctionPhrases: string[];        // "你又..." etc.
  concepts: Record<string, number>;   // N-gram → frequency
  toolPatterns: Record<string, number>; // tool → count
  sessionDuration: number;            // estimated from turn count
  turnCount: number;
  deepAnalysis: boolean;              // EnterPlanMode or Agent(Explore)
  knowledgeCaptured: boolean;         // Write to knowledge-docs
}

function extractCorrectionConcepts(userText: string): string[] {
  const concepts: string[] = [];
  for (const sentence of extractCorrectionMatches(userText)) {
    const cleaned = cleanCorrectionConcept(sentence);
    if (cleaned.length >= 4 && cleaned.length <= 60) concepts.push(cleaned);
  }
  return [...new Set(concepts)];
}

// ── Semantic clustering ──

function clusterConcepts(
  agg: Record<string, { count: number; sessions: string[] }>
): Record<string, { count: number; sessions: string[] }> {
  const entries = Object.entries(agg).filter(([k]) => k.length >= 4);
  if (entries.length <= 1) return agg;

  const merged: Record<string, { count: number; sessions: string[] }> = {};
  const used = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const [concept, data] = entries[i];
    let clusterName = concept;
    let clusterCount = data.count;
    const clusterSessions = new Set(data.sessions);
    used.add(i);

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const [other, otherData] = entries[j];
      const sim = jaccardChinese(concept, other);
      if (sim > 0.5) {
        clusterCount += otherData.count;
        for (const s of otherData.sessions) clusterSessions.add(s);
        // Use the shorter name as cluster label
        if (other.length < clusterName.length) clusterName = other;
        used.add(j);
      }
    }

    merged[clusterName] = { count: clusterCount, sessions: [...clusterSessions] };
  }

  return merged;
}

function extractSignals(sessions: SimpleSession[]): SessionSignals[] {
  return sessions.map(s => {
    const correctionPhrases = extractCorrectionConcepts(s.userText);

    // Concept extraction (Chinese char N-grams, etc.)
    const concepts: Record<string, number> = {};
    const cleanText = s.userText
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\{[^{}]*\}/g, '')
      .replace(/[{}[\]"':,\\]+/g, ' ');
    let cnSeq = '';
    for (const char of cleanText) {
      if (/[\u4e00-\u9fff]/.test(char)) {
        cnSeq += char;
      } else {
        if (cnSeq.length >= 4) concepts[cnSeq] = (concepts[cnSeq] || 0) + 1;
        cnSeq = '';
      }
    }
    if (cnSeq.length >= 4) concepts[cnSeq] = (concepts[cnSeq] || 0) + 1;

    // Tool patterns
    const toolPatterns: Record<string, number> = {};
    for (const t of s.toolCalls) {
      toolPatterns[t] = (toolPatterns[t] || 0) + 1;
    }

    return {
      sessionId: s.id,
      date: s.date,
      correctionPhrases,
      concepts,
      toolPatterns,
      sessionDuration: s.userText.length + s.assistantText.length, // proxy
      turnCount: (s.userText.match(/\n/g) || []).length,
      deepAnalysis: s.toolCalls.includes('EnterPlanMode') || s.toolCalls.includes('Agent'),
      knowledgeCaptured: s.toolCalls.includes('Write') && (
        s.assistantText.includes('.harness/knowledge-docs/') ||
        s.assistantText.includes('.harness/knowledge/')
      ),
    };
  });
}

// ── Concept aggregation ──

type ConceptMap = Record<string, { count: number; sessions: string[] }>;

function buildMergedConcepts(signals: SessionSignals[]): ConceptMap {
  const agg: ConceptMap = {};
  for (const sig of signals) {
    for (const [concept, count] of Object.entries(sig.concepts)) {
      if (!agg[concept]) agg[concept] = { count: 0, sessions: [] };
      agg[concept].count += count;
      if (!agg[concept].sessions.includes(sig.sessionId)) {
        agg[concept].sessions.push(sig.sessionId);
      }
    }
    for (const phrase of sig.correctionPhrases) {
      if (phrase.length < 4) continue;
      if (!agg[phrase]) agg[phrase] = { count: 0, sessions: [] };
      agg[phrase].count += 3;
      if (!agg[phrase].sessions.includes(sig.sessionId)) {
        agg[phrase].sessions.push(sig.sessionId);
      }
    }
  }
  return clusterConcepts(agg);
}

// ── Diff & Apply ──

interface Change {
  type: 'new_pattern' | 'rising' | 'falling' | 'gone' | 'lens_shift';
  key: string;
  detail: string;
}

function diffState(state: ModelState, mergedConcepts: ConceptMap, signals: SessionSignals[]): Change[] {
  const changes: Change[] = [];

  // Detect new/rising/falling/gone concepts (from merged clusters)
  for (const [concept, agg] of Object.entries(mergedConcepts)) {
    const existing = state.patterns[concept];
    if (!existing) {
      if (agg.sessions.length >= 2) {
        changes.push({ type: 'new_pattern', key: concept, detail: `Appeared in ${agg.sessions.length} sessions` });
      }
    } else if (existing.trend === 'gone' || existing.trend === 'falling') {
      changes.push({ type: 'rising', key: concept, detail: `Re-emerged after being ${existing.trend}` });
    }
  }

  // Detect lens weight shifts (from correction patterns)
  const totalCorrections = signals.reduce((sum, s) => sum + s.correctionPhrases.length, 0);
  if (totalCorrections >= 3) {
    changes.push({ type: 'lens_shift', key: 'completeness',
      detail: `${totalCorrections} corrections in these sessions — completeness lens may need weight increase` });
  }

  return changes;
}

function applySignals(state: ModelState, signals: SessionSignals[], mergedConcepts: ConceptMap): void {
  const now = new Date().toISOString().slice(0, 10);

  // Update patterns from merged concept clusters
  // occurrences 唯一来源：mergedConcepts 聚合值（含 correction phrase 的 ×3 加权，
  // 见 buildMergedConcepts）。不再叠加 per-session 原始 count —— 那是双计 bug。
  for (const [concept, agg] of Object.entries(mergedConcepts)) {
    if (!state.patterns[concept]) {
      state.patterns[concept] = {
        firstSeen: now, occurrences: 0, sessions: [], trend: 'new', lastSeen: now,
      };
    }
    const p = state.patterns[concept];
    p.occurrences += agg.count;
    for (const sid of agg.sessions) {
      if (!p.sessions.includes(sid)) p.sessions.push(sid);
    }
    p.lastSeen = now;
    p.trend = p.occurrences >= 5 ? 'stable' : 'rising';
  }

  // Update lens weights from correction signals
  for (const sig of signals) {
    if (sig.correctionPhrases.length > 0) {
      state.lensWeights.completeness = (state.lensWeights.completeness || 0) + 1;
      state.lensWeights.automation = (state.lensWeights.automation || 0) + (sig.correctionPhrases.length > 2 ? 1 : 0);
    }
    if (sig.deepAnalysis) {
      state.lensWeights.first_principles = (state.lensWeights.first_principles || 0) + 1;
    }
  }

  // Detect falling/stable shifts
  for (const [, p] of Object.entries(state.patterns)) {
    if (p.trend === 'stable' && p.lastSeen < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) {
      p.trend = 'falling';
    }
  }
}

// ── Profile update ──

function updateProfile(state: ModelState, paths: UserModelPaths): void {
  try {
    let content = fs.readFileSync(paths.profileFile, 'utf-8');

    // Replace Derived Rules section
    const derivedStart = '## Derived Rules';
    const derivedEnd = '\n## Evolution';
    const derivedIdx = content.indexOf(derivedStart);

    const activePatterns = Object.entries(state.patterns)
      .filter(([, p]) => (p.trend === 'rising' || p.trend === 'stable') && p.sessions.length >= 2)
      .sort(([, a], [, b]) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const derivedContent = [
      '## Derived Rules (auto-generated by update-user-model)',
      `Last scan: ${state.lastUpdated}. ${state.sessionsProcessed.length} sessions analyzed.`,
      '',
      '| Pattern | Trend | Occurrences | Sessions |',
      '|---------|-------|-------------|----------|',
      ...activePatterns.map(([k, p]) =>
        `| ${k} | ${p.trend} | ${p.occurrences} | ${p.sessions.length} |`),
      '',
    ].join('\n');

    if (derivedIdx >= 0) {
      content = content.slice(0, derivedIdx) + derivedContent + '\n' + content.slice(content.indexOf(derivedEnd, derivedIdx));
    } else {
      // No derived section yet — append before Evolution
      const evIdx = content.indexOf('## Evolution');
      if (evIdx >= 0) {
        content = content.slice(0, evIdx) + derivedContent + '\n' + content.slice(evIdx);
      } else {
        content += '\n' + derivedContent;
      }
    }

    fs.writeFileSync(paths.profileFile, content, 'utf-8');
  } catch (e) {
    // Profile file might not exist yet — skip
  }
}

// ── Output ──

function printChanges(changes: Change[], signals: SessionSignals[], io: CommandIO): void {
  if (changes.length === 0) {
    log(io, chalk.green('No significant changes detected'));
    return;
  }

  const byType = {
    new_pattern: changes.filter(c => c.type === 'new_pattern'),
    rising: changes.filter(c => c.type === 'rising'),
    lens_shift: changes.filter(c => c.type === 'lens_shift'),
  };

  if (byType.new_pattern.length > 0) {
    log(io, chalk.yellow(`🌱 New patterns: ${byType.new_pattern.length}`));
    for (const c of byType.new_pattern.slice(0, 5)) {
      log(io, chalk.gray(`   ${c.key}: ${c.detail}`));
    }
    log(io);
  }

  if (byType.rising.length > 0) {
    log(io, chalk.green(`📈 Re-emerging: ${byType.rising.length}`));
    for (const c of byType.rising.slice(0, 5)) {
      log(io, chalk.gray(`   ${c.key}: ${c.detail}`));
    }
    log(io);
  }

  if (byType.lens_shift.length > 0) {
    log(io, chalk.cyan(`🎯 Lens shifts:`));
    for (const c of byType.lens_shift) {
      log(io, chalk.gray(`   ${c.key}: ${c.detail}`));
    }
    log(io);
  }

  log(io, chalk.bold(`Total signals processed:`));
  log(io, `  Sessions: ${signals.length}`);
  log(io, `  Correction phrases: ${signals.reduce((s, sig) => s + sig.correctionPhrases.length, 0)}`);
  log(io, `  Concepts extracted: ${signals.reduce((s, sig) => s + Object.keys(sig.concepts).length, 0)}`);
}
