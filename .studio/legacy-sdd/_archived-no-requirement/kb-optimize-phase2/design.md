# Phase 2 知识库存量分类迁移 — 设计 Spec

日期：2026-07-01
源 issue：studio/docs/issues/2026-07-01-knowledge-base-optimization.md Phase 2
依赖：Phase 1 完成（commit 4da9043..9f84026）

## 第一性分析

知识库 64 工作条目（排除 166 测试污染 + 1 空数据）的实际分类：

| 类别 | 数量 | 问题 |
|------|------|------|
| ✅ 正常知识（有 frontmatter） | 27 | 无 |
| ⚠️ 无 frontmatter | 13+4=17 | grep 不可发现 |
| ⚠️ type 不匹配 | 3 | architecture- 前缀但 type=guideline |
| ⚠️ Skill 形态 | 7 | 在 knowledge/skills/ 应在 ~/.studio/skills/ |
| 🗑️ 测试污染 | 166 | resolutions/ 测试产出 |
| 🗑️ 空数据 | 1 | archive/process-PRO-006.md |

原始 issue Phase 2 分类（2.1-2.6）与实际存量不符：
- 2.5（骨架型）已在 B12 完成
- 2.3（数据型）Phase 1 已切断+B12 已归档
- 2.2/2.4/2.6 描述与实际不匹配

## 决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | resolutions/ 166 条直接删除 | 测试产出，从来不是合法知识 |
| D2 | 3 条 architecture- 前缀 type=guideline → 重命名文件 | 文件名与 type 保持一致 |
| D3 | arch-patterns/ 4 条留 knowledge/ 补 frontmatter | Agent 可搜索的知识 |
| D4 | 7 条旧 Skill 转换格式迁移到 ~/.studio/skills/ | Pipeline 格式→目录格式 |

## AC 定义

### AC-1: resolutions/ 清理
- 触发：166 条 `resolutions/resolution-*.md`
- 预期：全部删除，目录移除
- 验证：`ls ~/.studio/knowledge/resolutions/` 报错不存在

### AC-2: 空数据清理
- 触发：archive/process-PRO-006.md
- 预期：删除
- 验证：文件不存在

### AC-3: Skill 迁移（7 条）
- 触发：knowledge/skills/*.md
- 预期：每个转为目录格式 `~/.studio/skills/{name}/SKILL.md`
- 冲突处理：knowledge-extraction 新版已存在 → 归档旧版
- 验证：`ls ~/.studio/skills/forensic-review/SKILL.md` 等 6 个存在

### AC-4: type 不匹配修正（3 条）
- 触发：architecture-complete_the_pattern/memory_frontmatter/verify_before_move
- 预期：重命名为 guideline-*.md
- 验证：`ls ~/.studio/knowledge/guideline-*.md` 含 3 条新名，旧名不存在

### AC-5: 无 frontmatter 条目补全（17 条）
- 触发：13 条根目录 + 4 条 arch-patterns/
- 预期：每条有 YAML frontmatter（type/tags/maturity）
- 验证：`grep -L "^---" <files>` 无结果

### AC-6: index.json 重建
- 触发：上述所有变更完成后
- 预期：`harness knowledge index` 成功，条目数与预期一致
- 验证：index.json 条目数正确

## 执行顺序

1. AC-1 + AC-2（删除，无风险）
2. AC-4（重命名 3 条）
3. AC-3（Skill 迁移 7 条，最复杂）
4. AC-5（补 frontmatter 17 条）
5. AC-6（index 重建 + 验证）
