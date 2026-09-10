# 截图 diff 报告

- 比对：`d-fresh` vs `d-final`
- 生成时间：2026-09-10T04:30:08.976Z
- 总计：26 张 —— clean 0 / minor 8 / major 18 / missing 0

| 页面 | 宽度 | 差异率 | 像素数 | 状态 |
|------|------|--------|--------|------|
| agent-detail | 1440 | 0.85% | 10974 | minor |
| agents | 1440 | 0.81% | 10439 | minor |
| audit-logs | 1440 | 2.26% | 29279 | major |
| audit-logs-empty | 1440 | 1.12% | 14454 | major |
| audit-logs-modal-log-detail | 1440 | 0.06% | 745 | minor |
| audit-logs-select-open | 1440 | 2.30% | 29821 | major |
| channel-detail | 1440 | 5.09% | 66026 | major |
| channels | 1440 | 3.52% | 45636 | major |
| knowledge | 1440 | 3.21% | 41601 | major |
| library | 1440 | 0.53% | 6852 | minor |
| library-doc | 1440 | 4.82% | 62456 | major |
| monitoring | 1440 | 1.78% | 23015 | major |
| notfound | 1440 | 0.37% | 4823 | minor |
| pmo | 1440 | 1.22% | 15786 | major |
| pmo-project | 1440 | 2.80% | 36325 | major |
| settings | 1440 | 2.40% | 31101 | major |
| settings-modal-studio-role-setup | 1440 | 0.19% | 2423 | minor |
| settings-more-open | 1440 | 2.66% | 34441 | major |
| settings-toast | 1440 | 2.22% | 28761 | major |
| workspace | 1440 | 1.03% | 13301 | major |
| workspace-modal-create-role | 1440 | 0.02% | 245 | minor |
| workunit-detail | 1440 | 1.71% | 22134 | major |
| workunit-detail-modal-reject | 1440 | 0.23% | 3030 | minor |
| workunits | 1440 | 3.92% | 50770 | major |
| workunits-long-scope | 1440 | 4.29% | 55574 | major |
| workunits-modal-reject | 1440 | 1.07% | 13819 | major |

## 归因（人工核对，2026-09-10）

本次比对 = 批次 D（docs/plans/2026-09-ui-interaction-polish.md）全量视觉/交互变更的基线重置，**全部差异为预期变更，无回归**：

- **全页共性差异**（背景/标题/卡片）：D-1.1 背景档上抬（elevated/tertiary/hover/active）+ 卡片顶部内高光 + D-1.3 page-title 升 20px + D-1.2 侧边栏 active 态重设计（accent 左边线）+ 顶栏品牌双色调/conn-chip/图标钮
- **channel-detail（5.09%）**：D-1.5 系统播报 CRITICAL 严重度 chip + agent 文档流左边线；另有 SSE 消息流动态内容位移（既有不可消除 diff，README 已载）
- **workunits（3.92%）/ workunits-long-scope（4.29%）**：D-1.6 StatChip 激活 accent 底线 + 待人工行 warning 提权 + D-2 项4 新增搜索框；行内容位移属动态数据
- **settings-toast（2.22%）/ settings-more-open（2.66%）**：D-2 toast util 新增行动按钮能力 + MoreDropdown 新增「搜索 ⌘K」入口项
- **pmo（1.22%）**：D-2 项5 新增「需求」tab + D-3 空态引导主按钮
- **各 modal 态（0.02–0.23%）**：仅 D-1.1 背景档/卡片高光的全局影响，交互态结构未变
- **minor 8 张**：均 <1%，全局背景 token 微移的正常抖动

验收凭据：试点页人闸已过（`.studio/visual/d1-pilot/` 截图会话内确认）；本报告掩码已逐张过目，无敏感信息（dev 走查数据）。

## 差异页对比图

### agent-detail-1440.png（0.85%）

![agent-detail-1440](agent-detail-1440.diff.png)

### agents-1440.png（0.81%）

![agents-1440](agents-1440.diff.png)

### audit-logs-1440.png（2.26%）

![audit-logs-1440](audit-logs-1440.diff.png)

### audit-logs-empty-1440.png（1.12%）

![audit-logs-empty-1440](audit-logs-empty-1440.diff.png)

### audit-logs-modal-log-detail-1440.png（0.06%）

![audit-logs-modal-log-detail-1440](audit-logs-modal-log-detail-1440.diff.png)

### audit-logs-select-open-1440.png（2.30%）

![audit-logs-select-open-1440](audit-logs-select-open-1440.diff.png)

### channel-detail-1440.png（5.09%）

![channel-detail-1440](channel-detail-1440.diff.png)

### channels-1440.png（3.52%）

![channels-1440](channels-1440.diff.png)

### knowledge-1440.png（3.21%）

![knowledge-1440](knowledge-1440.diff.png)

### library-1440.png（0.53%）

![library-1440](library-1440.diff.png)

### library-doc-1440.png（4.82%）

![library-doc-1440](library-doc-1440.diff.png)

### monitoring-1440.png（1.78%）

![monitoring-1440](monitoring-1440.diff.png)

### notfound-1440.png（0.37%）

![notfound-1440](notfound-1440.diff.png)

### pmo-1440.png（1.22%）

![pmo-1440](pmo-1440.diff.png)

### pmo-project-1440.png（2.80%）

![pmo-project-1440](pmo-project-1440.diff.png)

### settings-1440.png（2.40%）

![settings-1440](settings-1440.diff.png)

### settings-modal-studio-role-setup-1440.png（0.19%）

![settings-modal-studio-role-setup-1440](settings-modal-studio-role-setup-1440.diff.png)

### settings-more-open-1440.png（2.66%）

![settings-more-open-1440](settings-more-open-1440.diff.png)

### settings-toast-1440.png（2.22%）

![settings-toast-1440](settings-toast-1440.diff.png)

### workspace-1440.png（1.03%）

![workspace-1440](workspace-1440.diff.png)

### workspace-modal-create-role-1440.png（0.02%）

![workspace-modal-create-role-1440](workspace-modal-create-role-1440.diff.png)

### workunit-detail-1440.png（1.71%）

![workunit-detail-1440](workunit-detail-1440.diff.png)

### workunit-detail-modal-reject-1440.png（0.23%）

![workunit-detail-modal-reject-1440](workunit-detail-modal-reject-1440.diff.png)

### workunits-1440.png（3.92%）

![workunits-1440](workunits-1440.diff.png)

### workunits-long-scope-1440.png（4.29%）

![workunits-long-scope-1440](workunits-long-scope-1440.diff.png)

### workunits-modal-reject-1440.png（1.07%）

![workunits-modal-reject-1440](workunits-modal-reject-1440.diff.png)
