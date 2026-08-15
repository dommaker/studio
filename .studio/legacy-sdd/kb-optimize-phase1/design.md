---
status: "done"
version: "1.0"
---

# Phase 1 知识库源头修复 — 设计

## 文件映射表

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-A.1 | `studio/apps/api/src/modules/knowledge/knowledge-service.ts` | 改写 | `recordTrend()` → 写 data/ |
| AC-A.2 | `studio/apps/api/src/modules/knowledge/knowledge-service.ts` | 改写 | `recordAnalystAccuracy()` → 写 data/ |
| AC-A.3 | `studio/apps/api/src/modules/agents/monitor-agent.service.ts` | 改写 | `precipitateRouting()` → 导入 writeTrendData 写 data/ |
| AC-A.4 | `studio/apps/api/src/modules/knowledge/signal-aggregator.ts` | 改写 | `upsertTrend()` → 导入 writeTrendData 写 data/（移除 sharedIngest 依赖） |
| AC-A.5 | `studio/apps/api/src/modules/knowledge/knowledge-bus.service.ts` | 注释 | 加 @deprecated |
| AC-B.1 | `studio/apps/api/src/modules/knowledge/knowledge-service.ts` | 新增 | `validateKnowledgeForm()` 函数 |
| AC-B.2 | `~/.studio/skills/knowledge-extraction/SKILL.md` | 改写 | 质量门加形态判断 |
| AC-B.3 | `studio/apps/api/src/modules/agents/knowledge-agent.service.ts` | 改写 | `safeIngest()` 集成门禁 |
| AC-C.1a | `/root/.zshrc` | 改写 | cstnew 函数：JSONL.bak 移到 data/sessions/ |
| AC-C.1b | `/root/transport/events-daemon.js` | 改写 | session:archive 移动文件而非 POST |
| AC-C.2 | `studio/apps/api/src/modules/agents/default-triggers.ts` | 新增 | session-knowledge-extraction trigger |

## 共享工具模块

| 模块 | 路径 | 用途 |
|------|------|------|
| DATA_DIR 常量 | `knowledge-service.ts` 或新文件 | `~/.studio/data/trends/` 路径 |
| writeTrendData() | `knowledge-service.ts` 新增 | mkdirSync + writeFileSync 工具函数 |
| validateKnowledgeForm() | `knowledge-service.ts` 新增 | 形态门禁函数 |

---

## 接口定义

### writeTrendData() — 数据层写入工具

```typescript
// knowledge-service.ts 新增（export，供 monitor-agent/signal-aggregator 复用）

const DATA_TRENDS_DIR = path.join(os.homedir(), '.studio', 'data', 'trends');

/**
 * 写入趋势数据到 data/trends/ 目录。
 * 替代原 recordTrend 写入 knowledge/ 的行为。
 * 被 knowledgeService.recordTrend/recordAnalystAccuracy、
 * monitorAgent.precipitateRouting、signalAggregator.upsertTrend 共用。
 */
export function writeTrendData(filename: string, content: string): void {
  fs.mkdirSync(DATA_TRENDS_DIR, { recursive: true });
  const filePath = path.join(DATA_TRENDS_DIR, filename);
  // 同日期追加：检查文件是否存在
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, existing + '\n\n---\n\n' + content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}
```

### validateKnowledgeForm() — 形态门禁

```typescript
// knowledge-service.ts 新增

export interface FormValidationResult {
  valid: boolean;
  form: 'knowledge' | 'data' | 'skill' | 'rule';
  reason?: string;
}

/**
 * 判断条目是否属于知识形态。
 * 代码层判断，不调 LLM。遵循 no_model_for_deterministic。
 */
function validateKnowledgeForm(entry: {
  type: string;
  content: string;
  tags: string[];
}): FormValidationResult {
  // 空内容
  if (!entry.content || entry.content.trim().length < 20) {
    return { valid: false, form: 'data', reason: 'content too short' };
  }

  // 数据形态检测：含具体数值/百分比/日期
  const dataPatterns = [
    /\d+%/,                          // 百分比
    /\d{4}-\d{2}-\d{2}/,            // ISO 日期
    /premium:\s*\d+/,               // 路由统计格式
    /analyst_accuracy/,              // accuracy 标签
  ];
  if (entry.type === 'process' && dataPatterns.some(p => p.test(entry.content))) {
    return { valid: false, form: 'data', reason: 'contains statistical data' };
  }
  if (entry.tags.includes('trend') || entry.tags.includes('analyst_accuracy')) {
    return { valid: false, form: 'data', reason: 'data-type tag' };
  }

  // Skill 形态检测：多步骤流程
  const skillPatterns = [
    /step\s*\d/i,
    /步骤\s*\d/,
    /^\d+\.\s+.+\n\d+\.\s+.+\n\d+\./m, // 3+ numbered items
  ];
  if (skillPatterns.some(p => p.test(entry.content)) && entry.content.length > 500) {
    return { valid: false, form: 'skill', reason: 'multi-step process detected' };
  }

  // 规则形态检测：短指令式
  const rulePatterns = [/^禁止/, /^必须/, /^不得/, /^禁止/];
  if (rulePatterns.some(p => p.test(entry.content.trim())) && entry.content.length < 100) {
    return { valid: false, form: 'rule', reason: 'short imperative directive' };
  }

  // 默认：知识形态
  return { valid: true, form: 'knowledge' };
}
```

### recordTrend() 改写

```typescript
// knowledge-service.ts 改写

async recordTrend(entry: TrendEntry): Promise<void> {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const content = `## ${entry.title}\n\n${entry.content}\n\nmetric: ${entry.metric}`;
    writeTrendData(`${dateStr}.md`, content);
    logger.debug('[KnowledgeService] recordTrend → data/', { metric: entry.metric });
  } catch (e) {
    logger.warn('[KnowledgeService] recordTrend failed', { error: String(e) });
  }
}
```

### recordAnalystAccuracy() 改写

```typescript
// knowledge-service.ts 改写

async recordAnalystAccuracy(data: AnalystAccuracyInput): Promise<void> {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const missedFiles = data.predictedFiles.filter(f => !data.actualFiles.includes(f));
    const extraFiles = data.actualFiles.filter(f => !data.predictedFiles.includes(f));
    const missedDeps = data.predictedDeps.filter(d => !data.actualDeps.includes(d));

    const content = [
      `## AnalystAccuracy: ${data.goalTitle.slice(0, 80)}`,
      ``,
      `- AC匹配率: ${Math.round(data.acMatchRate * 100)}%`,
      `- 预测文件: [${data.predictedFiles.join(', ')}]`,
      `- 实际文件: [${data.actualFiles.join(', ')}]`,
      missedFiles.length > 0 ? `- 漏预测: [${missedFiles.join(', ')}]` : '',
      extraFiles.length > 0 ? `- 多预测: [${extraFiles.join(', ')}]` : '',
      missedDeps.length > 0 ? `- 漏依赖: [${missedDeps.join(', ')}]` : '',
    ].filter(Boolean).join('\n');

    writeTrendData(`${dateStr}.md`, content);
    logger.debug('[KnowledgeService] recordAnalystAccuracy → data/');
  } catch (e) {
    logger.warn('[KnowledgeService] recordAnalystAccuracy failed', { error: String(e) });
  }
}
```

### precipitateRouting() 改写

```typescript
// monitor-agent.service.ts 改写 precipitateRouting()
// 新增 import: import { writeTrendData } from '../knowledge/knowledge-service.js';

private async precipitateRouting(): Promise<boolean> {
  try {
    const routingFile = path.join(os.homedir(), '.studio', '.harness', 'routing.jsonl');
    if (!fs.existsSync(routingFile)) return true;

    const raw = fs.readFileSync(routingFile, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 10) return true;

    const stats = { premium: 0, standard: 0, degraded: 0, total: 0 };
    const recent = lines.slice(-100);
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        stats.total++;
        if (entry.tier === 'premium') stats.premium++;
        else if (entry.tier === 'standard') stats.standard++;
        if (entry.degraded) stats.degraded++;
      } catch { /* skip */ }
    }

    if (stats.total < 5) return true;

    const dateStr = new Date().toISOString().split('T')[0];
    const content = [
      `## [沉淀] 路由分布 ${dateStr}`,
      ``,
      `- premium: ${stats.premium} (${Math.round(stats.premium / stats.total * 100)}%)`,
      `- standard: ${stats.standard} (${Math.round(stats.standard / stats.total * 100)}%)`,
      `- 降级: ${stats.degraded} (${Math.round(stats.degraded / stats.total * 100)}%)`,
      `- metric: routing_distribution`,
    ].join('\n');

    // 复用共享 writeTrendData，不内联 mkdir+write
    writeTrendData(`${dateStr}.md`, content);

    logger.info('[MonitorAgent] Precipitate routing → data/', { total: stats.total });
    return true;
  } catch (e) {
    logger.warn('[MonitorAgent] Precipitate routing failed', { error: String(e) });
    return false;
  }
}
```

### signal-aggregator upsertTrend() 改写

```typescript
// signal-aggregator.ts 改写 upsertTrend()
// 移除 import: sharedIngest (不再写 knowledge/)
// 新增 import: import { writeTrendData } from './knowledge-service.js';

private upsertTrend(trend: TrendSummary): boolean {
  const dateStr = new Date().toISOString().split('T')[0];
  const content = [
    `## ${trend.tag} 趋势 (${trend.count} 条/${trend.windowDays}天)`,
    ``,
    ...trend.sampleTitles.map(t => `- ${t}`),
  ].join('\n');

  // 复用共享 writeTrendData（内含同日期追加逻辑）
  // 同 tag 更新需额外处理：先读现有文件，替换对应 section
  const dataDir = path.join(os.homedir(), '.studio', 'data', 'trends');
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, `${dateStr}.md`);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    const tagPattern = new RegExp(`## ${trend.tag} 趋势[\\s\\S]*?(?=## |$)`);
    if (tagPattern.test(existing)) {
      fs.writeFileSync(filePath, existing.replace(tagPattern, content + '\n'), 'utf-8');
    } else {
      writeTrendData(`${dateStr}.md`, content);
    }
  } else {
    writeTrendData(`${dateStr}.md`, content);
  }

  logger.debug('[SignalAggregator] Trend → data/', { tag: trend.tag });
  return true;
}
```

### safeIngest() 门禁集成

```typescript
// knowledge-agent.service.ts 改写 safeIngest()

private safeIngest(
  partial: Partial<{ type: string; title: string; content: string; tags: string[]; projects: string[] }>,
  options: { source: string; layer: StorageLayer; maturity?: MaturityLevel; tags?: string[]; projects?: string[] },
): boolean {
  // 新增：形态门禁检查
  const formResult = validateKnowledgeForm({
    type: partial.type || 'guideline',
    content: partial.content || '',
    tags: [...(partial.tags || []), ...(options.tags || [])],
  });

  if (!formResult.valid) {
    logger.info('[KnowledgeAgent] Form gate rejected', {
      form: formResult.form,
      reason: formResult.reason,
      title: partial.title?.slice(0, 50),
    });

    if (formResult.form === 'data') {
      // 数据写入 data/ 目录
      const dateStr = new Date().toISOString().split('T')[0];
      const dataDir = path.join(os.homedir(), '.studio', 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, `${dateStr}-extracted.md`),
        `## ${partial.title}\n\n${partial.content}\n\nsource: ${options.source}\n`,
        'utf-8',
      );
    }
    // form='skill'/'rule' → 只记日志，不写入
    return false;
  }

  // 原有逻辑继续...
  // (现有的 safeIngest 实现)
}
```

### events-daemon.js session:archive 改写

```javascript
// ~/transport/events-daemon.js 改写 postSessionArchive()

async function postSessionArchive(evt) {
  const sessionFilePath = evt.sessionFile || evt.message || '';
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) return;

  // 改：移动文件到 data/sessions/ 而非 POST extract-text
  const dataDir = path.join(os.homedir(), '.studio', 'data', 'sessions');
  fs.mkdirSync(dataDir, { recursive: true });

  const basename = path.basename(sessionFilePath);
  const destPath = path.join(dataDir, basename);

  // 避免覆盖
  let finalDest = destPath;
  if (fs.existsSync(finalDest)) {
    const ext = path.extname(basename);
    const name = path.basename(basename, ext);
    finalDest = path.join(dataDir, `${name}-${Date.now()}${ext}`);
  }

  fs.copyFileSync(sessionFilePath, finalDest);
  logger.info(`session:archive → data/sessions/${path.basename(finalDest)}`);

  // 保留 KE-003 行为蒸馏（如果原来有的话）
  // fire-and-forget POST /api/knowledge/extract-behavior 可以保留
}
```

### cstnew 函数改写

```bash
# ~/.zshrc 改写 cstnew() 中 session:archive 部分

cstnew() {
    local sf="$HOME/.claude/projects/-root-projects/${_CS_ID}.jsonl"
    if tmux has-session -t claude 2>/dev/null; then
        tmux kill-session -t claude 2>/dev/null
    fi
    if [ -f "$sf" ]; then
        # 改：直接移到 data/sessions/
        local _data_dir="$HOME/.studio/data/sessions"
        mkdir -p "$_data_dir"
        local _dest="$_data_dir/${_CS_ID}-$(date +%Y%m%d-%H%M%S).jsonl"
        mv "$sf" "$_dest"
        echo "\033[33mSession saved: ${_dest##*/}\033[0m"
        # 不再调 cst-emit.sh session:archive
    fi
    bash /root/projects/studio/scripts/preflight.sh 2>&1 | sed 's/^/  /'
    echo "\033[32mStarting fresh session (old context cleared)...\033[0m"
    cst
}
```

### default-triggers.ts 新增 trigger

```typescript
// default-triggers.ts 新增

{
  id: 'session-knowledge-extraction',
  condition: {
    type: 'SCHEDULE',
    cron: '17 4 * * *',  // 每日 04:17
  },
  action: {
    type: 'CREATE',
    payload: {
      type: 'analysis',
      scope: '从 data/sessions/ 最近 7 天的 session 数据中聚合提取知识。先检查 data/sessions/ 目录是否有文件，无则跳过。有则读取 7 天内文件，跨 session 提取模式，通过 validateKnowledgeForm() 门禁后写入 knowledge/。',
      metadata: {
        source: 'data/sessions/',
        days: 7,
      },
    },
  },
}
```

---

## 代码依赖图

```
knowledge-bus.service.ts (sharedStore/sharedIngest singletons)
  ↑ 导入
  ├── knowledge-service.ts (knowledgeService 实例 + writeTrendData + validateKnowledgeForm)
  │     ├── recordTrend()           → 调用 writeTrendData()
  │     ├── recordAnalystAccuracy() → 调用 writeTrendData()
  │     ├── validateKnowledgeForm() → 新增（形态门禁）
  │     └── writeTrendData()        → 新增（export，共享数据写入）
  │
  ├── signal-aggregator.ts (signalAggregator 实例)
  │     └── upsertTrend()    → 导入 writeTrendData（移除 sharedIngest 依赖）
  │
  └── knowledge-agent.service.ts
        ├── safeIngest()      → 导入 validateKnowledgeForm 集成门禁
        └── extract* 方法     → 通过 safeIngest 间接使用门禁

monitor-agent.service.ts
  ├── 已有 import: knowledgeService from knowledge-service
  └── precipitateRouting()   → 导入 writeTrendData（移除 knowledgeService.recordTrend 调用）

default-triggers.ts
  └── session-knowledge-extraction → 新增 trigger

~/.zshrc (cstnew)            → 改写：mv 到 data/sessions/
~/transport/events-daemon.js  → 改写：移动文件而非 POST
```

## 依赖分析（执行顺序）

```
独立（可并行）:
  AC-A.5 (knowledgeBus @deprecated)     — 纯注释
  AC-B.2 (extraction skill 文档)        — 独立文件
  AC-C.2 (SCHEDULE trigger)             — 独立文件

有依赖（需串行）:
  AC-B.1 (validateKnowledgeForm)        — 先写
    ↓ 被 AC-B.3 (safeIngest) 使用
  AC-A.1/A.2 (recordTrend/Accuracy)     — 依赖 writeTrendData()（不调门禁，直接写 data/）
  AC-A.3 (precipitateRouting)           — 独立写 data/，不依赖 writeTrendData
  AC-A.4 (signal-aggregator)            — 独立写 data/
  AC-C.1 (cstnew + daemon)              — 独立，shell + JS

推荐执行顺序:
  1. AC-A.5 (@deprecated)               — 1 分钟
  2. AC-B.1 (validateKnowledgeForm)     — 核心函数
  3. AC-A.1 + AC-A.2 (recordTrend/Accuracy) — 可并行
  4. AC-A.3 + AC-A.4 (precipitate/signal)   — 可并行
  5. AC-B.3 (safeIngest 门禁集成)
  6. AC-B.2 (extraction skill 文档)
  7. AC-C.1 + AC-C.2 (cstnew + trigger) — 可并行
```

## 模块边界

| 边界 | 说明 |
|------|------|
| knowledge-bus.service.ts | 只加 @deprecated 注释，不改逻辑 |
| knowledgeService 的 recordPattern/recordIncident | 不改（这些是真正的知识写入） |
| extractDecision | 不改（走 knowledgeBus） |
| Phase 2 存量迁移 | 不做 |
