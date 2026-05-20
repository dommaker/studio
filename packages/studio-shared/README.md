# @agent-studio/shared

Studio 共享工具和 CLI 框架。

## 安装

```bash
pnpm install @agent-studio/shared
```

## 功能

### CLI 共享能力

- **参数解析** (`parser.ts`): 支持 `-c --company --format=json`
- **输出格式化** (`formatter.ts`): table/json/csv 三种格式
- **配置加载** (`config.ts`): 加载 `.studio/config.yaml`
- **命令注册** (`command.ts`): 统一命令注册框架

## 使用示例

```typescript
import { parseArgs, formatOutput } from '@agent-studio/shared/cli';

// 参数解析
const args = parseArgs(['balance', '--company=1', '--format=json']);
console.log(args.command); // 'balance'
console.log(args.options.company); // '1'

// 输出格式化
const data = [{ id: 1, name: 'Alice' }];
console.log(formatOutput(data, { format: 'table' }));
```

## 开发

```bash
# 运行测试
pnpm test

# 构建
pnpm build
```