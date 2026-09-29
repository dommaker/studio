# 角色 preset 模板浮出水面（2026-09-23）

> 来源：架构评审「角色域」候选 4（2026-09-23），#633 裁决。
> 状态：**accepted**（#633 已落地，2026-09-23）。

## 背景

服务端 `POST /agent-profiles` 支持 `preset` 字段：`loadRolePreset` 读 `.agents/roles/<preset>.yaml`，把 description/persona/acceptedTypes/skills/tools/constraints 带入新角色（显式传入字段优先；preset 读不到则拒绝创建，防静默丢配置），prompt「## 你的角色」段消费 persona/skills/tools/constraints。但 web 的 `createAgent` 类型不含 preset、UI 从不传——UI 建的角色是空心的（只有名字+描述）；且 `update()` 不接受 persona/acceptedTypes，创建后即成死字段。

第一性定性（#633 评审分析）：

- **yaml 里真正不可替代的资产是 persona 及其治理身份**（`.agents/roles/` 为治理内容，变更须人闸 + Governance-Approved trailer）。skills 已有 RoleSkillsModal（#462）这条 UI 通道；acceptedTypes 不参与路由（#337 契约），仅用于 skill 排序与递归子 WU 的 type 推导；yaml 的 templates/capabilities 字段无人消费（`loadRolePreset` 不读）；tools/constraints 只作 prompt 文本，无机制强制。
- **preset yaml 是 E1 飞轮 role-preset 提案的落点**：generator 在「某角色失败 ≥5 次且失败率 ≥30%」时提议改该角色 persona，applier 的 `applyRolePreset` 落笔写 yaml。删除 preset = 拆掉飞轮的角色人格改进维度。
- **快照断裂（已知限制）**：`loadRolePreset` 仅在 create 时读一次，profile 落盘后不再重读——飞轮改进 yaml 后，存量角色吃不到改进，只有之后创建的角色受益。

## 决策

1. **A 路：preset 模板浮出水面**。创建角色表单（#630 的 RoleFormModal，create 模式）加「从模板开始」入口，可选 preset（pm/developer/reviewer 等），提交时传 `preset` 字段；可选模板清单由服务端只读端点提供，不硬编码进前端。
2. **PATCH 开放 persona/acceptedTypes**，编辑模式可改，创建后不再是死字段。
3. **死字段不浮出**：templates/capabilities 不进 UI、不进模板清单端点；tools/constraints 维持 prompt 文本消费的现状，不新增机制强制。
4. **快照断裂记为已知限制**，本票不修：飞轮对 yaml 的 persona 改进只影响之后创建的角色。存量角色同步（prompt 组装时重读正本，或 evolution 落点改写 profile）列为 follow-up 候选，另行开票裁决。

## 否决的备选（勿再提）

- **B 路（删除 preset 装载路径与三份 yaml）**：等于拆掉 E1 飞轮的角色人格改进维度，且须同步退役 evolution 的 role-preset 生成规则与 applier case——与 harness 1.10.0 约束文本层退役导致提案无落点（被迫加落笔前拒绝）是同款伤疤，不主动再造。人格配置退回手填/curl，新角色空心出生。
- **模板清单前端硬编码**：yaml 是治理正本、会随飞轮演化，前端写死清单必然漂移。

## 落点清单

- api：角色 preset 清单只读端点（返回 preset 名 + description 摘要）+ 测试；`AgentProfileService.update` 接 persona/acceptedTypes + 测试。
- web：`createAgent`/`updateAgent` 客户端类型补 preset/persona/acceptedTypes；RoleFormModal create 模式「从模板开始」入口 + 编辑模式 persona/acceptedTypes 字段 + 测试。
- 依赖：#630（RoleFormModal 正本）落地后开工。
