// ExecutionSteps — WU 过程可视化：执行步事件流（思考/工具调用/skill 注入/用量），SSE 步级刷新。
// 频道只留里程碑，过程明细在这里；完整 transcript（会话原文）见 WU 详情页 TranscriptViewer（#174）。
// Layer B：执行中的步内实时 chunk（SSE-only 不落盘）；REST 步级卡片落位（同 step）后实时区自动让位。
// 消费方：WorkUnitDrawer（频道页右抽屉）、WorkUnitDetailPage（详情页）、WorkUnitListPage（/workunits 行内展开）
// #182（决策 #61 速览档）：传 wu 时置顶「当前状态速览」节——状态 / 第 N 步·上限 M / 最近进展 / 失败原因 / 累计 token；
// 抽屉与详情页都传 wu，两端复用同一组件避免渲染逻辑漂移；ListPage 不传则不渲染速览。
import { useEffect, useState } from 'react';
import {
  workunitApi,
  parseExecutionStepEvents,
  formatExecutionStreamChunkText,
  type ExecutionStepEvent,
  type WorkUnit,
} from '../../api/workunit';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { useWorkUnitEvents } from '../../hooks/useWorkUnitEvents';
import { useWorkUnitStreamEvents } from '../../hooks/useWorkUnitStreamEvents';
import {
  deriveLiveToolRows,
  derivePersistedToolRows,
  type ToolRow,
  type ToolRowState,
} from './execution-rows';

// #240: 工具行四态 → 状态点/可读标签（运行中 pulse 黄点 / 成功绿 / 失败红 / 已中断灰）
const TOOL_STATE_DOT: Record<ToolRowState, string> = {
  running: 'mc-dot-busy',
  ok: 'mc-dot-online',
  error: 'mc-dot-error',
  stopped: 'mc-dot-offline',
};
const TOOL_STATE_LABEL: Record<ToolRowState, string> = {
  running: '运行中',
  ok: '成功',
  error: '失败',
  stopped: '已中断',
};

/** #240: 折叠单行工具卡——整行点击展开/收起；长输出在内部滚动容器，不撑爆消息流 */
function ToolRowView({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const stateLabel = TOOL_STATE_LABEL[row.state];
  return (
    <div className="mc-toolrow-wrap">
      <button type="button" className="mc-toolrow" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className={`mc-dot ${TOOL_STATE_DOT[row.state]}`} role="img" aria-label={stateLabel} title={stateLabel} />
        <span className="mc-toolrow-label">{row.tool}{row.summary ? ` ${row.summary}` : ''}</span>
        <span className="mc-toolrow-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mc-toolrow-output">{row.output || row.summary || '（无输出记录）'}</div>
      )}
    </div>
  );
}

// 步数预算：与 apps/api/src/modules/agents/loop/agent-loop.ts 的 STEP_LIMIT/REVIEW_STEP_LIMIT 同值——
// 超限处置仍走服务端既有「强制提交审查」路径，这里只做展示与 ≥80% 提示（决策 #61 §5）
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;
const BUDGET_HINT_RATIO = 0.8;

// 状态文案与 WorkUnitDrawer 同口径（大白话，不用行话）
const WU_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

/** WU metadata JSON 解析（只消费速览需要的字段，其余透传；坏 JSON → 空对象） */
interface GlanceMeta {
  stepCount?: number;
  /** #95 成功步环形簿记：[{step, action, summary, at}]，取最后一条当「最近进展」 */
  progressLog?: unknown;
}

function parseGlanceMeta(metadata: string | null): GlanceMeta {
  try { return JSON.parse(metadata || '{}'); } catch { return {}; }
}

/** progressLog 最后一条带 summary 的条目（畸形条目跳过） */
function lastProgressEntry(log: unknown): { step?: number; summary: string } | null {
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] as { step?: unknown; summary?: unknown } | null;
    if (e && typeof e.summary === 'string' && e.summary) {
      return { step: typeof e.step === 'number' ? e.step : undefined, summary: e.summary };
    }
  }
  return null;
}

export function ExecutionSteps({ workUnitId, wu }: { workUnitId: string; wu?: WorkUnit }) {
  const [steps, setSteps] = useState<ExecutionStepEvent[] | null>(null);
  // WU 事件（SSE）：执行步落盘/状态变化时重拉（认领/审查/完成/执行过程即时可见）
  const [eventTick, setEventTick] = useState(0);
  useWorkUnitEvents(() => setEventTick(t => t + 1));
  // Layer B 步内流式：执行中的实时 chunk（内存态，步级 REST 卡片落位后自动让位）
  const liveChunks = useWorkUnitStreamEvents(workUnitId);

  // 渲染期按 workUnitId 重置（替代原 effect 内同步重置）：SSE eventTick 重拉不再清空 steps，
  // 消除每次事件都闪"加载中…"的闪烁——事件刷新静默进行，旧列表留到新数据到达
  const [prevWorkUnitId, setPrevWorkUnitId] = useState(workUnitId);
  if (prevWorkUnitId !== workUnitId) {
    setPrevWorkUnitId(workUnitId);
    setSteps(null);
  }

  useEffect(() => {
    let alive = true;
    workunitApi.listExecutionStepEvents(workUnitId)
      .then(r => { if (alive) setSteps(parseExecutionStepEvents(r.data.events || [], workUnitId)); })
      .catch(() => { if (alive) setSteps([]); });
    return () => { alive = false; };
  }, [workUnitId, eventTick]);

  return (
    <>
      {/* #182（决策 #61）「当前状态速览」置顶节：传 wu 才渲染（抽屉/详情页），五要素全部取现有字段 + #172 失败步事件 */}
      {wu && (() => {
        const meta = parseGlanceMeta(wu.metadata);
        const maxEventStep = (steps ?? []).reduce((m, s) => Math.max(m, s.step), 0);
        const maxLiveStep = liveChunks.reduce((m, c) => Math.max(m, c.step), 0);
        const currentStepNo = Math.max(typeof meta.stepCount === 'number' ? meta.stepCount : 0, maxEventStep, maxLiveStep);
        const stepLimit = wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT;
        const progress = lastProgressEntry(meta.progressLog);
        const failedStep = steps ? [...steps].reverse().find(s => s.status === 'failed') : undefined;
        const totalTokens = (steps ?? []).reduce(
          (sum, s) => sum + (s.usage ? s.usage.inputTokens + s.usage.outputTokens : 0), 0,
        );
        // F6 铁律：展示状态一律过 deriveDisplayState，不自行解释 metadata
        const column = deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;
        return (
          <>
            <div className="mc-block-label">当前状态</div>
            <div className="mc-kv">
              <span className="mc-kv-k">状态</span>
              <span className="mc-kv-v">{WU_STATUS_LABELS[column] ?? column}</span>
            </div>
            <div className="mc-kv">
              <span className="mc-kv-k">进度</span>
              <span className="mc-kv-v">第 {currentStepNo} 步 / 上限 {stepLimit} 步</span>
            </div>
            <div className="mc-kv">
              <span className="mc-kv-k">最近进展</span>
              <span className="mc-kv-v">
                {progress ? `${typeof progress.step === 'number' ? `第 ${progress.step} 步：` : ''}${progress.summary}` : '—'}
              </span>
            </div>
            {failedStep && (
              <div className="mc-kv">
                <span className="mc-kv-k">失败原因</span>
                <span className="mc-kv-v">{failedStep.errorDetail || failedStep.errorType || '执行失败'}</span>
              </div>
            )}
            <div className="mc-kv">
              <span className="mc-kv-k">累计 token</span>
              <span className="mc-kv-v">{steps === null ? '—' : formatTokens(totalTokens)}</span>
            </div>
            {currentStepNo / stepLimit >= BUDGET_HINT_RATIO && (
              <div className="mc-drawer-note">已接近步数上限：再超限将自动转人工审查</div>
            )}
          </>
        );
      })()}
      <div className="mc-block-label">执行过程</div>
      {(() => {
        const maxPersistedStep = (steps ?? []).reduce((m, s) => Math.max(m, s.step), 0);
        const live = liveChunks.filter(c => c.step > maxPersistedStep);
        if (live.length === 0) return null;
        const currentStep = live[live.length - 1].step;
        // 步结束信号 = result chunk（「本回合结束」）；结束后未配对工具 → stopped（#240 中断合成）
        const stepEnded = live.some(c => c.kind === 'result');
        // 工具行四态由纯函数推导（execution-rows.ts）；此处按 chunk 到达序穿插渲染
        const toolRowQueue = [...deriveLiveToolRows(live, stepEnded)];
        return (
          <div style={{ marginBottom: 8 }}>
            {/* 执行级状态条（#240）：常驻整个执行期，步切换只更新文案不卸载（不闪烁） */}
            <div className="mc-exec-statusbar">
              <span className="mc-status mc-status-running"><span className="mc-dot" />实时</span>
              <span>第 {currentStep} 步进行中</span>
            </div>
            {live.map((c, i) => {
              // 工具调用 → 折叠单行卡；tool-result/step-start 不独立渲染（前者配对进行，后者只作步边界）
              if (c.kind === 'tool') {
                const row = toolRowQueue.shift();
                return row ? <ToolRowView key={row.key} row={row} /> : null;
              }
              if (c.kind === 'tool-result' || c.kind === 'step-start') return null;
              // chunk→文案映射唯一出处：api/workunit.ts formatExecutionStreamChunkText
              const text = formatExecutionStreamChunkText(c, { maxTextLength: false, maxSummaryLength: false });
              if (text === null) return null;
              // #240: thinking 独立成行，与正文/工具调用分开
              return c.kind === 'thinking' ? (
                <div key={i} className="mc-exec-thinking">{text}</div>
              ) : (
                <div key={i} className="mc-drawer-note" style={{ whiteSpace: 'pre-wrap' }}>
                  {text}
                </div>
              );
            })}
          </div>
        );
      })()}
      {steps === null && <div className="mc-drawer-note">加载中…</div>}
      {steps !== null && steps.length === 0 && liveChunks.length === 0 && (
        <div className="mc-drawer-note">暂无执行过程记录（仅记录本能力上线后的执行步）</div>
      )}
      {steps !== null && steps.length > 0 && steps.map(s => (
        <div key={`${s.executionId}-${s.step}`} style={{ marginBottom: 8 }}>
          <div className="mc-kv">
            <span className="mc-kv-k">#{s.step}{s.action ? ` · ${s.action}` : ''}{s.status === 'failed' ? ' · ✗ 失败' : ''}</span>
            <span className="mc-kv-v">
              {formatTime(s.at)}
              {s.usage ? ` · ${formatTokens(s.usage.inputTokens + s.usage.outputTokens)} tok` : ''}
            </span>
          </div>
          {s.thinking.map((t, i) => (
            <div key={`t${i}`} className="mc-exec-thinking">
              思考：{t}
            </div>
          ))}
          {derivePersistedToolRows(s).map(row => (
            <ToolRowView key={row.key} row={row} />
          ))}
          {s.skills.length > 0 && (
            <div className="mc-drawer-note">skills：{s.skills.join(', ')}</div>
          )}
        </div>
      ))}
    </>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
