---
status: "done"
version: 1
---

# Design: PMO → Channel → Agent 流程串联

## 文件映射表

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-1 | `apps/api/src/modules/triggers/trigger.types.ts` | 修改 | 扩展 TriggerCondition 联合类型 |
| AC-2 | `apps/api/src/modules/triggers/trigger-scheduler.ts` | 修改 | 注入 EventBus，EVENT 订阅/取消 |
| AC-2 | `apps/api/src/modules/triggers/trigger-registry.ts` | 修改 | 单例工厂 `getTriggerScheduler()` 增加 eventBus 参数 |
| AC-2 | `apps/api/src/modules/triggers/__tests__/trigger-scheduler.test.ts` | 修改 | EVENT 条件测试 + 构造函数更新 |
| AC-3 | `apps/api/src/modules/agents/agent-loop.ts` | 修改 | 注册 EVENT trigger + observe handler |
| AC-3 | `apps/api/src/modules/agents/agent-loop.test.ts` | 修改 | EVENT trigger 测试 |
| AC-4 | `apps/api/src/modules/workunit/workunit.service.ts` | 修改 | create() 加 eventBus.publish |
| AC-4 | `apps/api/src/modules/workunit/__tests__/workunit-api.test.ts` | 修改 | 事件发布测试（workunit.service.test.ts 是占位符） |
| AC-5 | `apps/api/src/modules/pmo/routes.ts` | 修改 | 新增 publish 路由 |
| AC-5 | `apps/api/src/modules/pmo/project.service.ts` | 修改 | 新增 publish() 方法 |
| AC-5 | `apps/api/src/modules/pmo/__tests__/publish.test.ts` | 新增 | publish 流程测试 |
| AC-6 | `apps/web/src/pages/PMOPage.tsx` | 修改 | 发布按钮 + Channel 选择（列表页，与 status badge 同行） |
| AC-7 | `apps/api/src/modules/mcp/tools.ts` | 修改 | 新增 createWorkUnit tool |
| AC-7 | `apps/api/src/modules/mcp/__tests__/create-workunit.test.ts` | 新增 | createWorkUnit 测试（mcp 无 __tests__ 目录） |
| AC-8 | `~/.claude/projects/-root-projects/memory/standard_sdd_format.md` | 修改 | 加 pmoNumber 字段 |
| AC-8 | `~/.claude/skills/task-planner/task-planner.md` | 修改 | Skill 写 SDD 时支持 pmoNumber |
| AC-9 | `harness/src/sdd/index-generator.ts` | 新增 | SDD 索引生成器类 |
| AC-9 | `harness/src/sdd/index-generator.test.ts` | 新增 | 索引生成器测试 |
| AC-9 | `harness/src/commands/sdd.ts` | 新增 | `harness sdd index` CLI 命令 |
| AC-10 | `apps/api/src/modules/pmo/routes.ts` | 修改 | 新增 sdd 查询路由 |
| AC-10 | `apps/api/src/modules/pmo/__tests__/sdd-query.test.ts` | 新增 | SDD 查询测试 |

## 接口定义

### AC-1: TriggerCondition 类型

```typescript
// trigger.types.ts
export type TriggerCondition =
  | { type: 'SCHEDULE'; cron: string }
  | { type: 'EVENT'; event: string; filter?: Record<string, unknown> };
```

### AC-2: TriggerScheduler 构造函数

```typescript
// trigger-scheduler.ts
import { StudioEventBus } from '@dommaker/studio-shared';

interface TriggerSchedulerDeps {
  store: TriggerStore;
  eventBus?: StudioEventBus;  // 可选，向后兼容
}

class TriggerScheduler {
  private subscriptions: Map<string, () => void> = new Map(); // triggerId → unsubscribe

  constructor(deps: TriggerSchedulerDeps);

  registerTrigger(trigger: TriggerConfig): void;
  // EVENT 条件: eventBus.subscribe → 存 unsubscribe 到 subscriptions map

  deregisterTrigger(triggerId: string): void;
  // 调用 subscriptions.get(triggerId)() 取消订阅

  dispose(): void;
  // 清理所有 subscriptions
}
```

**trigger-registry.ts 工厂更新**:

```typescript
// trigger-registry.ts — 现有单例工厂需传入 eventBus
import { eventBus } from '@dommaker/studio-shared';

export function getTriggerScheduler(
  store?: import('./trigger-store.js').TriggerStore,
): TriggerScheduler {
  if (!_instance) {
    _instance = new TriggerScheduler({ store: store ?? null, eventBus });
  }
  return _instance;
}
```

注意：使用全局 eventBus 单例（符合"EventBus 只用全局单例"约束），不通过调用方传入。
现有 `apps/api/src/index.ts:187` 和 `trigger.routes.ts:9` 调用 `getTriggerScheduler()` 无需改动。

**事件处理逻辑**:

```typescript
private handleEvent(trigger: TriggerConfig, payload: unknown): void {
  if (!trigger.enabled) return;

  // filter 匹配
  if (trigger.condition.type === 'EVENT' && trigger.condition.filter) {
    if (!this.matchFilter(payload, trigger.condition.filter)) return;
  }

  this.executeTrigger(trigger, payload);
}

private matchFilter(payload: unknown, filter: Record<string, unknown>): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  for (const [key, value] of Object.entries(filter)) {
    if ((payload as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}
```

### AC-3: AgentLoop 改造

```typescript
// agent-loop.ts
class AgentLoop {
  constructor(
    role: AgentProfile,
    workUnitService: WorkUnitService,
    triggerScheduler: TriggerScheduler,  // 新增
  );

  async start(): Promise<void> {
    // 现有逻辑（创建 RuntimeInstance）

    // 注册 EVENT trigger
    this.triggerScheduler.registerTrigger({
      id: `agent-${this.role.id}-workunit-created`,
      name: `Agent ${this.role.name} discover workunit`,
      condition: { type: 'EVENT', event: 'workunit.created' },
      action: { type: 'EXECUTE', target: `agent-loop-${this.role.id}-observe` },
      enabled: true,
      scope: 'agent',
    });

    // 注册 EXECUTE handler
    this.triggerScheduler.registerExecuteHandler(
      `agent-loop-${this.role.id}-observe`,
      () => this.observe()
    );

    // 保留 SCHEDULE 轮询兜底
    this.triggerScheduler.registerTrigger({
      id: `agent-${this.role.id}-poll-fallback`,
      name: `Agent ${this.role.name} poll fallback`,
      condition: { type: 'SCHEDULE', cron: '*/1 * * * *' },  // 每 min
      action: { type: 'EXECUTE', target: `agent-loop-${this.role.id}-observe` },
      enabled: true,
      scope: 'agent',
    });
  }

  async stop(): Promise<void> {
    this.triggerScheduler.deregisterTrigger(`agent-${this.role.id}-workunit-created`);
    this.triggerScheduler.deregisterTrigger(`agent-${this.role.id}-poll-fallback`);
    this.triggerScheduler.unregisterExecuteHandler(`agent-loop-${this.role.id}-observe`);
  }
}
```

### AC-4: WorkUnitService 改造

```typescript
// workunit.service.ts
import { eventBus } from '@dommaker/studio-shared';

class WorkUnitService {
  async create(input: CreateWorkUnitInput): Promise<WorkUnit> {
    const workunit = await this.prisma.workUnit.create({
      data: { ...input, metadata: input.metadata ? JSON.stringify(input.metadata) : undefined },
    });

    // 新增：发布事件
    try {
      eventBus.publish('workunit.created', { workunit });
    } catch (err) {
      console.error('[WorkUnitService] Failed to publish workunit.created:', err);
    }

    return workunit;
  }
}
```

### AC-5: PMO Publish

```typescript
// project.service.ts
interface PublishProjectInput {
  projectId: string;
  channelId: string;
}

interface PublishProjectResult {
  message: ChannelMessage;
  workUnit: WorkUnit;
  project: Project;
}

// project.service.ts 新增方法
async publish(input: PublishProjectInput): Promise<PublishProjectResult> {
  const project = await this.getProject(input.projectId);
  if (!project) throw new Error('Project not found');
  if (project.status !== 'pending') throw new Error('Project must be pending to publish');

  // 1. 创建 ChannelMessage
  const message = await channelMessageService.createHumanMessage(
    input.channelId,
    `📋 ${project.pmoNumber}: ${project.title}\n\n${project.requirement || ''}`,
  );
  // 更新 meta 含 pmoId
  await channelMessageService.updateMessageMeta(message.id, { pmoId: project.id });

  // 2. 创建分析 WorkUnit
  const workUnit = await workUnitService.create({
    type: 'analysis',
    scope: `分析需求 ${project.pmoNumber}: ${project.title}\n\n${project.requirement || ''}`,
    channelId: input.channelId,
    metadata: { pmold: project.id, pmoNumber: project.pmoNumber },
  });

  // 3. 更新 PMO 状态
  const updatedProject = await this.updateStatus(input.projectId, 'active');

  return { message, workUnit, project: updatedProject };
}
```

```typescript
// routes.ts 新增路由
router.post('/project/:id/publish', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });

  const result = await projectService.publish({
    projectId: req.params.id,
    channelId,
  });
  res.json(result);
});
```

### AC-7: MCP createWorkUnit

```typescript
// tools.ts
const createWorkUnit: MCPTool = {
  name: 'createWorkUnit',
  description: '创建 WorkUnit（工作单元）。Agent 用于拆分下游任务。',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['task', 'analysis', 'monitor', 'discussion'],
        description: 'WorkUnit 类型',
      },
      scope: { type: 'string', description: '工作范围描述' },
      channelId: { type: 'string', description: '关联 Channel ID（可选）' },
      parentId: { type: 'string', description: '父 WorkUnit ID（可选）' },
      metadata: { type: 'object', description: '元数据（pmold 等）' },
    },
    required: ['type', 'scope'],
  },
  handler: async (input) => {
    const workunit = await workUnitService.create({
      type: input.type,
      scope: input.scope,
      channelId: input.channelId,
      parentId: input.parentId,
      metadata: input.metadata,
      status: 'unassigned',
    });
    return {
      workUnitId: workunit.id,
      type: workunit.type,
      scope: workunit.scope,
      status: workunit.status,
    };
  },
};
```

注意：与现有 tool 直接 prisma 不同，这里 import WorkUnitService 复用验证逻辑。需要在 tools.ts 顶部新增 workUnitService 实例化。

### AC-9: SDD 索引生成器

```typescript
// harness/src/sdd/index-generator.ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const INDEX_FILENAME = '_index.md';
const SDD_DIR = 'docs/sdd';

interface SDDIndexEntry {
  slug: string;
  pmoNumber: string;
  status: string;
  title: string;
  tags: string;
}

export class SDDIndexGenerator {
  constructor(private baseDir: string) {}

  regenerate(): { count: number; entries: SDDIndexEntry[] } {
    const entries: SDDIndexEntry[] = [];
    const sddDir = path.join(this.baseDir, SDD_DIR);

    if (!fs.existsSync(sddDir)) {
      throw new Error(`SDD directory not found: ${sddDir}`);
    }

    // 扫描子目录
    const dirs = fs.readdirSync(sddDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const reqPath = path.join(sddDir, dir, 'requirement.md');
      if (!fs.existsSync(reqPath)) continue;

      const content = fs.readFileSync(reqPath, 'utf-8');
      const frontmatter = this.parseFrontmatter(content);

      // 跳过 stale
      if (frontmatter.status === 'stale') continue;

      entries.push({
        slug: frontmatter.slug || dir,
        pmoNumber: frontmatter.pmoNumber || '',
        status: frontmatter.status || 'unknown',
        title: frontmatter.title || dir,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.join(',') : '',
      });
    }

    // 按 slug 排序
    entries.sort((a, b) => a.slug.localeCompare(b.slug));

    // 写入索引文件
    const indexPath = path.join(sddDir, INDEX_FILENAME);
    const header = [
      `# SDD Index`,
      `# Auto-generated — run \`harness sdd index\` to rebuild`,
      `# Total: ${entries.length} entries`,
      `#`,
      `# Usage:`,
      `#   grep "<pmoNumber>" docs/sdd/_index.md`,
      `#   Then Read the matching SDD directory for full content.`,
      `#`,
      `# slug|pmoNumber|status|title|tags`,
    ].join('\n');

    const lines = entries.map(e =>
      `${e.slug}|${e.pmoNumber}|${e.status}|${this.sanitize(e.title)}|${e.tags}`
    );

    fs.writeFileSync(indexPath, header + '\n' + lines.join('\n') + '\n');

    return { count: entries.length, entries };
  }

  private parseFrontmatter(content: string): Record<string, string | string[]> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    return yaml.load(match[1]) as Record<string, string | string[]> || {};
  }

  private sanitize(s: string): string {
    return s.replace(/\n/g, ' ').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  }
}
```

### AC-10: SDD 查询

```typescript
// routes.ts 新增
router.get('/project/:id/sdd', async (req, res) => {
  const project = await projectService.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const indexPath = path.join(process.cwd(), 'docs/sdd/_index.md');
  if (!fs.existsSync(indexPath)) {
    return res.json({ sddEntries: [] });
  }

  const content = fs.readFileSync(indexPath, 'utf-8');
  const entries = content
    .split('\n')
    .filter(line => line.includes(project.pmoNumber) && !line.startsWith('#'))
    .map(line => {
      const [slug, pmoNumber, status, title, tags] = line.split('|');
      return { slug, pmoNumber, status, title, tags };
    });

  res.json({ sddEntries: entries });
});
```

## 代码依赖图

```
trigger.types.ts (AC-1)
    ↑
trigger-scheduler.ts (AC-2) ← event-bus.ts (已有)
    ↑
agent-loop.ts (AC-3)

workunit.service.ts (AC-4) ← event-bus.ts (已有)
    ↑
agent-loop.ts (AC-3) — 消费 workunit.created 事件
    ↑
project.service.ts (AC-5) — publish() 调用 workunit.service.create()
    ↑
routes.ts (AC-5, AC-10)
    ↑
PMOPage.tsx (AC-6) — 前端调用 publish API

tools.ts (AC-7) — import workUnitService

index-generator.ts (AC-9) — 独立，无依赖
    ↑
routes.ts (AC-10) — 读索引文件
```

## 并行/串行分析

```
Batch 1（独立，可并行）:
  - AC-1: trigger.types.ts（类型定义）
  - AC-4: workunit.service.ts（事件发布）
  - AC-9: index-generator.ts（新模块）

Batch 2（依赖 Batch 1）:
  - AC-2: trigger-scheduler.ts（依赖 AC-1 类型 + event-bus）

Batch 3（依赖 Batch 2）:
  - AC-3: agent-loop.ts（依赖 AC-2 triggerScheduler 改造）
  - AC-7: tools.ts createWorkUnit（依赖 AC-4 workunit.service 事件）

Batch 4（依赖 Batch 3）:
  - AC-5: PMO publish API（依赖 AC-4 create 事件 + channel message service）
  - AC-8: SDD frontmatter 标准更新（文档+Skill，独立）

Batch 5（依赖 Batch 4）:
  - AC-6: PMO UI（依赖 AC-5 publish API）
  - AC-10: SDD 查询 API（依赖 AC-9 索引生成器产出索引文件）
```

## 模块边界约束

1. **EventBus 只用全局单例** — `import { eventBus } from '@dommaker/studio-shared'`，不新建实例
2. **MCP tool 通过 Service 而非直接 Prisma** — createWorkUnit 需走 WorkUnitService 复用验证
3. **SDD 索引只读 requirement.md** — 不索引 design.md/task.md
4. **PMO publish 使用现有 channelMessageService** — createHumanMessage + updateMessageMeta 两步
5. **PMO 编号格式** — 使用代码现有格式 `PM-NNN`（如 PM-001），不用 `PMO-NNN`
