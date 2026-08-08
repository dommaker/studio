// ExecutionSteps — WU 过程可视化：执行步事件流（思考/工具调用/skill 注入/用量），SSE 步级刷新。
// 频道只留里程碑，过程明细在这里；完整 transcript 见 agent HOME 的 claude projects 文件。
// Layer B：执行中的步内实时 chunk（SSE-only 不落盘）；REST 步级卡片落位（同 step）后实时区自动让位。
// 消费方：WorkUnitDrawer（频道页右抽屉）、WorkUnitListPage（/workunits 行内展开）
import { useEffect, useState } from 'react';
import {
  workunitApi,
  parseExecutionStepEvents,
  formatExecutionStreamChunkText,
  type ExecutionStepEvent,
} from '../../api/workunit';
import { useWorkUnitEvents } from '../../hooks/useWorkUnitEvents';
import { useWorkUnitStreamEvents } from '../../hooks/useWorkUnitStreamEvents';

export function ExecutionSteps({ workUnitId }: { workUnitId: string }) {
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
      <div className="mc-block-label">执行过程</div>
      {(() => {
        const maxPersistedStep = (steps ?? []).reduce((m, s) => Math.max(m, s.step), 0);
        const live = liveChunks.filter(c => c.step > maxPersistedStep);
        if (live.length === 0) return null;
        const currentStep = live[live.length - 1].step;
        return (
          <div style={{ marginBottom: 8 }}>
            <div className="mc-kv">
              <span className="mc-kv-k">
                <span className="mc-status mc-status-running"><span className="mc-dot" />实时</span>
              </span>
              <span className="mc-kv-v">第 {currentStep} 步进行中</span>
            </div>
            {live.map((c, i) => {
              // chunk→文案映射唯一出处：api/workunit.ts formatExecutionStreamChunkText（step-start → null 不渲染）
              const text = formatExecutionStreamChunkText(c, { maxTextLength: false, maxSummaryLength: false });
              if (text === null) return null;
              return c.kind === 'tool' ? (
                <div key={i} className="mc-drawer-note" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {text}
                </div>
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
            <span className="mc-kv-k">#{s.step}{s.action ? ` · ${s.action}` : ''}</span>
            <span className="mc-kv-v">
              {formatTime(s.at)}
              {s.usage ? ` · ${formatTokens(s.usage.inputTokens + s.usage.outputTokens)} tok` : ''}
            </span>
          </div>
          {s.thinking.map((t, i) => (
            <div key={`t${i}`} className="mc-drawer-note" style={{ whiteSpace: 'pre-wrap' }}>
              思考：{t}
            </div>
          ))}
          {s.toolCalls.map((c, i) => (
            <div key={`c${i}`} className="mc-drawer-note" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {c.tool}{c.summary ? `  ${c.summary}` : ''}
            </div>
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
