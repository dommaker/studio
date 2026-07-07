---
status: done
version: "1.0"
---

# 频道系统重构 — 设计文档

## 文件映射表

### 删除文件

| 文件路径 | AC | 原因 |
|---------|-----|------|
| `apps/api/src/modules/channels/conversation-handler.ts` | AC-A2 | conversation 模式删除 |
| `apps/api/src/modules/channels/conversation-converter.ts` | AC-A2 | 依赖 conversation 模式 |
| `apps/api/src/modules/channels/analyst-trigger.service.ts` | AC-A3 | @Analyst 硬编码删除 |
| `apps/api/src/modules/channels/analyst-prompt.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-executor.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-prescan.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-scout.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-synthesizer.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-knowledge.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/analyst-fact-verification.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/contract-test-validator.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/contract-test-red-check.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/acgroup-tier.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/multi-repo-split.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/sdd-verification.ts` | AC-A3 | 仅 analyst-trigger 消费 |
| `apps/api/src/modules/channels/__tests__/conversation-handler.test.ts` | AC-A2 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/conversation-handler-integration.test.ts` | AC-A2 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/channel-conversation-schema.test.ts` | AC-A2 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/conversation-converter.test.ts` | AC-A2 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-fact-verification.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-revision.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-prescan.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-scout.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-synthesizer.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-executor-sanitize.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-executor-output-path.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/analyst-output-validation.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/contract-test-validator.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/contract-test-red-check.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/acgroup-tier.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/multi-repo-split.test.ts` | AC-A3 | 测试目标删除 |
| `apps/api/src/modules/channels/__tests__/sdd-verification.test.ts` | AC-A3 | 测试目标删除 |

### 修改文件

| 文件路径 | AC | 改动类型 | 改动内容 |
|---------|-----|---------|---------|
| `packages/studio-prisma/prisma/schema.prisma` | AC-A1 | Schema | 删除 Channel.mode/agentName/sessionId |
| `apps/api/src/modules/channels/channel.routes.ts` | AC-A4,A5,B1-B4 | 重写 | 删旧路由(POST /convert + POST /actions 整个) + 新消息分发逻辑 |
| `apps/api/src/modules/discord/command-runner.ts` | AC-A4 | 修改 | analystTrigger → WorkUnitService.create |
| `apps/api/src/modules/channels/channel-message.service.ts` | AC-B2 | 无改动 | 已支持 workUnitId 参数 |
| `apps/web/src/components/channel/ChannelInput.tsx` | AC-C1,C2 | 修改 | Agent 列表改 API + 回复模式 |
| `apps/web/src/components/channel/ChannelMessageItem.tsx` | AC-C2,C3 | 修改 | 回复按钮 + 引用渲染 |
| `apps/web/src/pages/ChannelDetailPage.tsx` | AC-C2 | 修改 | 回复状态管理 + replyToId 传递 |
| `apps/web/src/hooks/useChannelEvents.ts` | AC-C2 | 修改 | sendMessage 签名改为 `(content, replyToId?)` + 透传给 channelApi |
| `apps/web/src/api/channel.ts` | AC-C1 | 修改 | 新增 listAgents() 方法（调 `GET /agent-profiles?status=active`） |

### 附带清理

| 文件路径 | 清理内容 | 原因 |
|---------|---------|------|
| `apps/api/src/modules/knowledge/knowledge-sync.service.ts` | 删除 ScopeConfig.files 中 `analyst-trigger.service.ts` glob 引用（L28, L48） | 非代码依赖，但引用已删除文件路径 |

### 新增文件

| 文件路径 | AC | 用途 |
|---------|-----|------|
| 无 | — | 本次无新增文件 |

## 接口定义

### 后端：@mention 检测

```typescript
// channel.routes.ts 内部函数

/**
 * 检测消息中的 @mention
 * @returns AgentProfile name，无 @mention 返回 null
 */
function detectMention(content: string): string | null {
  const match = content.match(/@([\w-]+)/);
  return match ? match[1] : null;
}
```

### 后端：消息处理路由分发（重写 POST /:id/messages）

```typescript
// channel.routes.ts L301-394 重写

router.post('/:id/messages', async (req, res) => {
  const { content, replyToId } = req.body;
  // ... 现有验证 ...

  const channelId = req.params.id;
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return res.status(404).json({ ... });

  // 优先级 1：Thread 回复（replyToId 存在）
  if (replyToId) {
    const originalMsg = await prisma.channelMessage.findUnique({
      where: { id: replyToId },
    });
    const workUnitId = originalMsg?.workUnitId ?? null;
    const message = await channelMessageService.createHumanMessage(
      channelId, trimmedContent, replyToId, workUnitId ?? undefined,
    );
    return res.status(201).json({ success: true, data: message });
  }

  // 优先级 2：@mention → WorkUnit
  const mentionName = detectMention(trimmedContent);
  if (mentionName) {
    const agent = await prisma.agentProfile.findFirst({
      where: { name: mentionName, status: 'active' },
    });
    const scope = trimmedContent.replace(/@[\w-]+\s*/, '');
    const workUnit = await workUnitService.create({
      scope,
      channelId,
      type: 'task',
      status: 'unassigned',
      metadata: { mentionName, matched: !!agent, creationMode: 'mention' },
    });
    const message = await channelMessageService.createHumanMessage(
      channelId, trimmedContent, undefined, workUnit.id,
    );
    return res.status(201).json({ success: true, data: { ...message, workUnitId: workUnit.id } });
  }

  // 优先级 3：纯存储
  const message = await channelMessageService.createHumanMessage(channelId, trimmedContent);
  return res.status(201).json({ success: true, data: message });
});
```

### 后端：WorkUnitService import

```typescript
// channel.routes.ts 新增 import
import { WorkUnitService } from '../workunit/workunit.service.js';
const workUnitService = new WorkUnitService(prisma);
```

### 后端：Discord command-runner 适配

```typescript
// discord/command-runner.ts 修改
// 删除: const { analystTriggerService } = await import(...)
// 新增:
import { WorkUnitService } from '../workunit/workunit.service.js';
const workUnitService = new WorkUnitService(prisma);

// 替换 analystTriggerService.trigger() 为:
await workUnitService.create({
  scope: content,
  channelId: rndChannel.id,
  type: 'task',
  metadata: { creationMode: 'discord' },
});
```

### 前端：Agent 列表 API

```typescript
// api/channel.ts 或 api/index.ts 新增
// 复用现有 agents API，不新增端点

// api/agents.ts (或现有文件)
interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

// GET /api/v1/agent-profiles?status=active（注意路径是 agent-profiles 非 agents/profiles）
// 已在 agent-profile.routes.ts 中定义，支持 status 查询参数
```

### 前端：ChannelInput 回复模式

```typescript
// components/channel/ChannelInput.tsx

interface ChannelInputProps {
  onSend: (content: string, replyToId?: string) => void;
  sending: boolean;
  replyTo?: ChannelMessage | null;  // 新增
  onCancelReply?: () => void;       // 新增
}

// 回复模式 UI：
// ┌─────────────────────────┐
// │ ↩ 回复 @Analyst: xxx... │  ← 引用预览，可点击取消
// │                         │
// │ 输入消息...              │  ← textarea
// └─────────────────────────┘
```

### 前端：ChannelMessageItem 回复按钮

```typescript
// components/channel/ChannelMessageItem.tsx

interface ChannelMessageItemProps {
  message: ChannelMessage;
  onAction: (messageId: string, action: string) => void;
  onReply?: (message: ChannelMessage) => void;  // 新增
}

// hover 时显示回复按钮
// 点击 → onReply(message) → 父组件设置 replyTo 状态

// 引用渲染（replyToId 存在时）：
// ┌─────────────────────────┐
// │ > 原消息作者: 原消息摘要  │  ← 引用块
// │                         │
// │ 当前消息内容              │
// └─────────────────────────┘
```

### 前端：ChannelDetailPage 回复状态

```typescript
// pages/ChannelDetailPage.tsx

const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);

const handleSend = (content: string, replyToId?: string) => {
  sendMessage(content, replyToId);
  setReplyTo(null);  // 发送后清除回复状态
};

// JSX:
// {replyTo && <ReplyPreview message={replyTo} onCancel={() => setReplyTo(null)} />}
// <ChannelInput onSend={handleSend} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
```

## 代码依赖图

```
channel.routes.ts (重写)
  ├─→ channel-message.service.ts (无改动)
  ├─→ workunit.service.ts (新增 import)
  └─→ prisma (AgentProfile 查询)

discord/command-runner.ts (修改)
  └─→ workunit.service.ts (新增 import，替代 analyst-trigger)

ChannelDetailPage.tsx (修改)
  ├─→ ChannelMessageItem.tsx (新增 onReply prop)
  ├─→ ChannelInput.tsx (新增 replyTo prop)
  └─→ useChannelEvents.ts (无改动)

ChannelInput.tsx (修改)
  ├─→ agentProfiles API (替代硬编码列表)
  └─→ replyTo state (新增)

ChannelMessageItem.tsx (修改)
  ├─→ onReply callback (新增)
  └─→ 引用渲染 (新增)
```

## 依赖分析（执行顺序）

```
Phase 1（后端，可并行）：
  Step 1a: schema.prisma 删除字段 → prisma db push
  Step 1b: 删除 32 个文件（conversation + analyst 链 + 测试）
  Step 1b2: 清理 knowledge-sync.service.ts 字符串引用
  Step 1c: channel.routes.ts 重写（依赖 1a + 1b）— 含删除 POST /actions 和 POST /convert 路由
  Step 1d: discord/command-runner.ts 修改（依赖 1b）
  Step 1e: 编写新测试（mention-workunit / thread-reply / thread-mention / message-routing）

Phase 2（前端，依赖 Phase 1 完成）：
  Step 2a: ChannelInput.tsx 回复模式 + Agent autocomplete（API 改 /agent-profiles）
  Step 2b: ChannelMessageItem.tsx 回复按钮 + 引用渲染
  Step 2c: ChannelDetailPage.tsx 回复状态管理
  Step 2d: useChannelEvents.ts sendMessage 透传 replyToId
  （2a-2d 可并行开发）

Phase 3（验证）：
  Step 3a: tsc --noEmit
  Step 3b: npm test
  Step 3c: 线上部署
```
