# Studio 工程级语言

跨模块共享的术语与约定。模块级上下文见各 `apps/api/src/modules/*/CONTEXT.md`。

## Language

**大文件**:
超过 600 行软上限、触发「是否该拆分」审查的源码文件。审查看职责内聚度，不强制动刀——天然内聚的逻辑允许留在 600–800 行。拆分验收以单一职责为准，行数只是触发器。
_Avoid_: 超大文件、巨型文件、god file

## 大文件治理

**拆分模式**: 整块原样抽出 + 原文件门面 re-export（导出面不变）+ 测试零改动；验收后按需对重模块定向回填直接单测，不要求每个抽出的轻模块/类型文件配同名测试。

**TDD 门禁豁免**: `.git/hooks/pre-commit` 的 TDD 段要求新增源文件配同名测试。纯移动拆分 commit 用 `PURE_MOVE=1 git commit ...` 豁免——仅跳过 TDD 段，credential 扫描 / plan 覆盖 / tsc-gate 仍执行。适用条件：整块抽出、门面 re-export、测试零改动，且 commit body 注明拆分来源文件。含任何新逻辑的代码不得使用（2026-08-04 立法；此前 8 个拆分 commit 以 HARNESS_NO_CHECK=1 临时覆盖落地，先例见 `0aca188b..edbddcdc`）。
