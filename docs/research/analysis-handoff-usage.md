# analysis-handoff 链路使用现状根因（issue #165）

> 研究票：issue #165（dommaker/studio）。调研日期 2026-08-15。
> 问题：analysis WU → in_review → 人工「通过」→ done → spawnTasks 自动派工 这条链路为什么只走通过一次？
> 数据源：`~/.studio/data/workunits/index.json`（116 个 analysis WU 快照，metadata 为 JSON 字符串需二次解析）与
> `~/.studio/data/workunits/events.jsonl`（8128 行事件，最后事件 2026-08-09T09:05:56Z）。全程只读。
> 代码口径：`apps/api/src/modules/pmo/analysis-handoff.ts`、`apps/api/src/modules/agents/loop/agent-loop.ts`（master `9d564798`）。
> 注：events.jsonl 无 `status_changed`/`reviewPassed` 事件类型；状态轨迹由 `updated`/`completed`/`closed` 事件的
> `data.status` 重建。人工「通过」（reviewPassed）落盘形态 = `completed` 事件（status=done）。

## TL;DR

链路闲置的根因类别是 **「无人点确认」**，且是结构性的：功能 2026-07-30 才上线，此前 47 个到达 in_review 的
analysis WU 全部在 07-27 被一次性批量清理关闭（cleanupNote: `review-report-chain-broken`）；上线后仅 4 个
analysis WU 到达 in_review，其中 3 个是 trigger 自动巡检 WU、`channelId=null`——`postConfirmGuidance` 因无
频道直接 return（analysis-handoff.ts:59），确认提示从未投递给任何人。唯一一次确认发生在功能上线当天
（b0c30939，进 in_review 后 17 秒即被点「通过」），链路各环节（TASK 落档 → 确认 → 哨兵 → 派生）账实相符，
代码本身未见故障证据。

## Q1：116 个 analysis WU 的 status 分布（index.json 终态）

| status | 数量 |
|--------|------|
| closed | 106 |
| in_review | 7 |
| done | 1 |
| unassigned | 2 |

触发来源分布：knowledge-quality-audit 28、zero-consumption-audit 26、daily-health-check 26、
session-knowledge-extraction 24、doc-semantic-review 5、knowledge-synthesis 4、manual/unknown 3。
即 ~93% 是 trigger 自动巡检类 WU，非 PMO 需求分析。

## Q2：到达过 in_review 的 analysis WU 数量（events.jsonl 轨迹重建）

**51 个**到达过 in_review。首次到达时间的日分布：

| 日期 | 数量 | 备注 |
|------|------|------|
| 2026-07-18 ~ 07-27 | 43 | 功能上线前；07-27 被批量清理 |
| 2026-07-29 | 4 | 功能上线前 |
| 2026-07-30 | 1 | = b0c30939，唯一走通者 |
| 2026-07-31 / 08-01 / 08-02 | 各 1 | 至今仍挂 in_review |

analysis-handoff 首个 commit 为 2026-07-30（`280a7329`/`c1c6a2d4`）。即 **47/51 的 in_review 发生在功能
存在之前**，彼时根本没有「通过 → 自动派工」链路可走。

## Q3：到达 done 的数量；其中带 metadata.analysisTasks 的数量

- 到达 done 的 analysis WU：**1 个**（b0c30939，2026-07-30T01:08:14Z）。
- 带 `analysisTasks` 的：**1 个**（同一个 b0c30939，1 条任务）。哨兵 `analysisTasksSpawnedAt`
  同日落档（2026-07-30T01:08:14.974Z），账实相符。
- 全量事件流中 `analysisTasks` 字样只出现在 b0c30939 的 4 条事件里，无任何其他 WU 曾写入又丢失的痕迹。

TASK 落档条件（agent-loop.ts:985-989）：`type==='analysis' && action==='complete'` 时解析输出中的
`TASK:` 行，有才写。功能上线后到达 in_review 的 4 个 WU 中 1 个有 TASK 行——样本太小，且 trigger 巡检类
WU 的 scope 本就不含 TASK 拆分约定（agent 无输出动机），**没有证据表明解析器失效**。

## Q4：人工确认（reviewPassed / done 迁移）发生次数与时间分布

**恰好 1 次**：b0c30939，2026-07-30T01:07:57Z 进 in_review → 01:08:14Z `completed`(done)，间隔 17 秒。
events.jsonl 全文无 `reviewPassed` 字样；index 中无任何 analysis WU 带 reviewPassed 类 metadata。
其余 50 个到达过 in_review 的 WU：43 个走向 closed（其中 42 个是 2026-07-27 批量清理，cleanupNote
`stale in_review cleanup 2026-07-27 (B2, backup at /root/.studio-backup-20260727-p0)` /
`review-report-chain-broken`），7 个至今仍挂 in_review（最后一个是 08-02 进入，此后无新 analysis 进审）。

## Q5：根因类别判断

**主因 = 无人点确认（人工闸门从未被例行使用）**，由三个结构性因素叠加造成，按贡献排序：

1. **功能上线太晚，历史存量被清理而非确认**（解释 43/51）：handoff 链路 2026-07-30 才上线；此前到达
   in_review 的 47 个 WU 中 42 个在 07-27 被一次性运维清理关闭（彼时评审链已断，
   `review-report-chain-broken`），从未有过「点通过」的机会窗口。
2. **确认提示无法投递**（解释上线后 3/4 未确认）：上线后到达 in_review 的 4 个 WU 中 3 个
   `channelId=null`（trigger 自动巡检 WU），`postConfirmGuidance` 首行 `if (!wu.channelId) return`
   直接放弃——频道里从未出现确认入口提示，只能指望有人在 WorkUnit 列表 UI 主动翻到一个巡检 WU 点「通过」。
   唯一走通的 b0c30939 恰恰是带频道、有人在场的 PMO-11 走查 WU。
3. **TASK 行未落档不是主因**：唯一被确认的 WU 恰好带 TASK 行且全链路走通；上线后样本仅 4 个，
   无解析器失效证据。但需注意：即使确认发生，trigger 巡检类 WU 大概率无 TASK 行，确认后也只会走
   「提示可手动拆任务」分支，不产生派工——链路的「自动派工」价值对占 93% 的巡检流量本就不适用。

次要背景：41 个 analysis WU 的轨迹终止于 `active>blocked`（执行期失败/卡死，从未提交审查），其中
多为 07-18~07-26 的早期 trigger WU；另有 16 个停于 active、2 个从未被认领（08-09 新建）。这些是
执行层可靠性问题，与 handoff 链路无关，但进一步压小了能走到确认环节的样本。

### 一句话结论

链路只走通一次，不是代码坏了，而是：**上线前没有机会确认（存量被清理），上线后需要确认的 WU 没人看得到
提示（channelId=null 提示被吞），唯一一次有人在场就 17 秒走通了全流程。**

## 复现方法

```python
import json, collections
idx = json.load(open('/root/.studio/data/workunits/index.json'))
ana = [w for w in idx if w.get('type') == 'analysis']
print(collections.Counter(w['status'] for w in ana))  # Q1
# Q2/Q3/Q4：逐行 json.loads events.jsonl，过滤 wuId in ana，按 data.status 重建轨迹；
# metadata 字段为 JSON 字符串，需二次 json.loads。
```
