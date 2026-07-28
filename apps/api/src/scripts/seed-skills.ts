/**
 * Seed 4 built-in Skills into FileStore (D6).
 *
 * Usage: npx tsx apps/api/src/scripts/seed-skills.ts
 */

import { FileStore } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const fileStore = new FileStore();
const SKILLS_DIR = path.join(os.homedir(), '.studio', 'data', 'skills');

const BUILTIN_SKILLS = [
  {
    name: 'tdd-workflow',
    description: '测试驱动开发工作流：写失败测试→最小实现→通过→重构→循环',
    trigger: 'goal_start',
    agentTypes: JSON.stringify(['executor']),
    prompt: `## TDD 工作流

严格按以下流程工作：

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过 → 运行确认通过
4. 重构优化
5. 重复 1-4 直到所有 AC 满足
6. 运行 npm test + type check + lint
7. 更新 .progress.json
8. 全部 AC 覆盖 + 全部测试通过 → 设置 .progress.json allComplete: true`,
  },
  {
    name: 'multi-stance-review',
    description: '多立场代码审查：质疑者/架构师/执行者/实用主义者轮流审查',
    trigger: 'review',
    agentTypes: JSON.stringify(['reviewer']),
    prompt: `## 审查流程

你要用 4 个立场轮流审查代码，每个立场关注不同的维度：

1. **质疑者 (skeptic)**: 寻找逻辑错误、边界条件遗漏、安全隐患
2. **架构师 (architect)**: 检查架构一致性、模块耦合、接口设计
3. **执行者 (executor)**: 评估代码可维护性、可读性、测试覆盖
4. **实用主义者 (pragmatist)**: 检查是否过度设计、是否有更简单方案

对每个立场：
- 检查 git diff 中的变更
- 运行 npm test 确认通过
- 逐条验证 AC
- 补充边界测试

审查结论：
- 全部通过 → overallApproved: true
- 有问题 → 列出具体问题和建议修改方案`,
  },
  {
    name: 'forensic-review',
    description: '第5立场审查：检测 fallback/hack/workaround/临时方案等技术债模式',
    trigger: 'review',
    agentTypes: JSON.stringify(['reviewer']),
    prompt: `## 第5立场：法证审查 (Forensic)

在前4立场之后，用法证视角审查代码变更，专注检测：

1. **Fallback 模式**: try/catch 吞异常、|| 默认值掩盖错误、silent fail
2. **Hack/Workaround**: 注释含 HACK/FIXME/WORKAROUND/临时、硬编码魔数绕过逻辑
3. **降级伪装**: 用简单实现替代设计意图（如 curl 替代 e2e 测试、skip 替代修复）
4. **门禁绕过**: --no-verify、skip-ci、降阈值让 CI 通过、删测试让构建绿
5. **僵尸代码**: 被注释但未删除的代码块、unused import/variable 保留"以防万一"

对每个发现：
- 指出位置（文件:行号）
- 判断严重程度：critical（必须修）/ warning（建议修）/ info（记录）
- 提供正确修复方案

如果发现 critical 级别的 hack：overallApproved 必须为 false。`,
  },
  {
    name: 'integration-merge',
    description: '集成验证：合并分支→typecheck→test→冲突分析',
    trigger: 'integration',
    agentTypes: JSON.stringify(['executor']),
    prompt: `## 集成验证

你是集成验证者。合并所有并行 sub-agent 的工作并验证。

步骤：
1. 合并所有 task/* 分支
2. 运行 tsc --noEmit 检查类型
3. 运行 npm test 确认全部通过
4. 如果有冲突：分析根因，指出哪个 sub-agent 需要修改
5. 全部通过后设置 allComplete: true`,
  },
];

async function seedSkills() {
  console.log('Seeding built-in Skills...');

  await fs.promises.mkdir(SKILLS_DIR, { recursive: true });

  for (const skill of BUILTIN_SKILLS) {
    const fileName = `${skill.name}.json`;
    const filePath = path.join(SKILLS_DIR, fileName);
    const now = new Date().toISOString();

    let existing: any = null;
    try { existing = await fileStore.readJson<any>(filePath); } catch { /* new file */ }

    const record = {
      ...(existing || {}),
      companyId: 'system',
      name: skill.name,
      description: skill.description,
      source: 'builtin',
      status: 'published',
      trigger: skill.trigger,
      agentTypes: skill.agentTypes,
      prompt: skill.prompt,
      isBuiltin: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await fileStore.writeJson(filePath, record);
    console.log(`  ✓ ${skill.name}`);
  }

  // Count builtin skills
  let count = 0;
  try {
    const entries = await fs.promises.readdir(SKILLS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const s = await fileStore.readJson<any>(path.join(SKILLS_DIR, e.name));
      if (s && s.isBuiltin) count++;
    }
  } catch { /* no skills dir */ }
  console.log(`\nDone. ${count} built-in skills in FileStore.`);
}

seedSkills().catch(console.error);
