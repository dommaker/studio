// ExecutionFlow — #396 WU 详情页「执行过程」重设计（spec §5.3）：stat 摘要行 + 纵向 step 链。
//   - stat 摘要行：状态徽章 / 进度（第 N 步 · 上限 M）/ 累计 token（--fs-stat mono）；最近进展一行；失败红色警示行；
//   - 纵向 step 链：步骤号圆节点 + 贯穿竖线；thinking 弱显折叠（details）；tool 调用成行（mono 工具名 + 摘要）；
//     失败步红节点 + 红 tag + 错误详情。
// 不复用 ExecutionSteps 的 hairline 表格形态（其继续服务频道抽屉/列表行内展开）；
// 数据路径同 ExecutionSteps：REST 回放打底 + workunit.execution.step SSE 负载直更 + 重连 refetch，
// 合并/最近进展/token 缩写走 utils/executionSteps 共享纯函数。
// 取舍：本组件不接 Layer-B 步内流式 chunk（该粒度留在频道抽屉 ExecutionSteps），stat 进度行覆盖「第 N 步」语义。
import { useEffect, useRef, useState } from 'react';
import {
  workunitApi,
  parseExecutionStepEvents,
  type ExecutionStepEvent,
  type WorkUnit,
} from '../../api/workunit';
import { deriveDisplayState, WU_STATUS_COLORS, WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { useWebSocketContext } from '../../api/websocketHooks';
import { formatShortTime } from '../../utils/datetime';
import { parseWuMeta } from '../../utils/wuMeta';
import { formatStepTokens, lastProgressEntry, mergeStepEvents } from '../../utils/executionSteps';

// 步数预算：与 ExecutionSteps / agent-loop 同值（展示用）
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;

interface GlanceMeta {
  stepCount?: number;
  progressLog?: unknown;
}

/** 单步：号节点 + 标题行 + 失败详情 + 折叠思考 + 工具行 + 正文/skills */
function FlowStep({ s }: { s: ExecutionStepEvent }) {
  const failed = s.status === 'failed';
  return (
    <div className={`wu-flow-step${failed ? ' wu-flow-failed' : ''}`}>
      <span className="wu-flow-num">{s.step}</span>
      <div className="wu-flow-body">
        <div className="wu-flow-head">
          <span className="wu-flow-action">{s.action ?? '执行'}</span>
          {failed && <span className="wu-flow-failtag">失败</span>}
          <span className="wu-flow-meta">
            {formatShortTime(s.at)}
            {s.usage ? ` · ${formatStepTokens(s.usage.inputTokens + s.usage.outputTokens)} tok` : ''}
          </span>
        </div>
        {failed && (s.errorDetail || s.errorType) && (
          <div className="wu-flow-err">
            {s.errorType ? `${s.errorType}：` : ''}{s.errorDetail ?? ''}
          </div>
        )}
        {s.thinking.length > 0 && (
          <details className="wu-flow-thinking">
            <summary>思考 ×{s.thinking.length}</summary>
            <div className="wu-flow-thinking-body">
              {s.thinking.map((t, i) => <div key={i}>{t}</div>)}
            </div>
          </details>
        )}
        {s.toolCalls.map((c, i) => (
          <div key={i} className="wu-flow-tool" title={c.summary}>
            <span className={`wu-flow-tool-dot${failed ? ' wu-flow-tool-dot-fail' : ''}`} />
            <span className="wu-flow-tool-name">{c.tool}</span>
            <span className="wu-flow-tool-sum">{c.summary}</span>
          </div>
        ))}
        {s.skills.length > 0 && (
          <div className="wu-flow-skills">skills：{s.skills.join(', ')}</div>
        )}
        {s.text && <div className="wu-flow-text">{s.text}</div>}
      </div>
    </div>
  );
}

export function ExecutionFlow({ workUnitId, wu }: { workUnitId: string; wu: WorkUnit }) {
  const [steps, setSteps] = useState<ExecutionStepEvent[] | null>(null);
  // SSE 负载直更（同 ExecutionSteps #318 模式）：步结束事件负载就地 append；重连一次性 refetch
  const { onEvent, onReconnect } = useWebSocketContext();
  const [refreshTick, setRefreshTick] = useState(0);
  // 首拉（steps===null）期间到达的步事件暂存，首拉落位时并入
  const pendingRef = useRef<ExecutionStepEvent[]>([]);

  // 渲染期按 workUnitId 重置（同 ExecutionSteps 模式）：事件刷新静默进行，旧列表留到新数据到达
  const [prevWorkUnitId, setPrevWorkUnitId] = useState(workUnitId);
  if (prevWorkUnitId !== workUnitId) {
    setPrevWorkUnitId(workUnitId);
    setSteps(null);
  }
  // ref 不碰渲染期（react-hooks/globals）：暂存槽随 workUnitId 切换在 effect 清空
  useEffect(() => { pendingRef.current = []; }, [workUnitId]);

  useEffect(() => onEvent((msg) => {
    if (msg.event_type !== 'workunit.execution.step') return;
    const [ev] = parseExecutionStepEvents([{ payload: msg.data }], workUnitId);
    if (!ev) return;
    setSteps(prev => {
      if (prev === null) { pendingRef.current.push(ev); return prev; }
      return mergeStepEvents(prev, [ev]);
    });
  }), [onEvent, workUnitId]);

  useEffect(() => onReconnect(() => setRefreshTick(t => t + 1)), [onReconnect]);

  useEffect(() => {
    let alive = true;
    workunitApi.listExecutionStepEvents(workUnitId)
      .then(r => {
        if (!alive) return;
        const loaded = parseExecutionStepEvents(r.data.events || [], workUnitId);
        setSteps(mergeStepEvents(loaded, pendingRef.current));
        pendingRef.current = [];
      })
      .catch(() => { if (alive) setSteps([]); });
    return () => { alive = false; };
  }, [workUnitId, refreshTick]);

  const shown = steps ?? [];
  const meta = parseWuMeta<GlanceMeta>(wu.metadata);
  const currentStepNo = Math.max(
    typeof meta.stepCount === 'number' ? meta.stepCount : 0,
    shown.reduce((m, s) => Math.max(m, s.step), 0),
  );
  const stepLimit = wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT;
  const progress = lastProgressEntry(meta.progressLog);
  const failedStep = [...shown].reverse().find(s => s.status === 'failed');
  const totalTokens = shown.reduce((sum, s) => sum + (s.usage ? s.usage.inputTokens + s.usage.outputTokens : 0), 0);
  // F6 铁律：展示状态一律过 deriveDisplayState，不自行解释 metadata
  const column = deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;

  return (
    <div>
      <div className="wu-exec-stats">
        <div className="wu-exec-stat">
          <span className="wu-exec-stat-k">状态</span>
          <span className={`text-xs px-2 py-0.5 rounded wu-exec-badge ${WU_STATUS_COLORS[column] || 'u-surface-2 u-text-3'}`}>
            {WU_STATUS_LABELS[column] ?? column}
          </span>
        </div>
        <div className="wu-exec-stat">
          <span className="wu-exec-stat-k">进度</span>
          <span className="wu-exec-stat-v">
            第 {currentStepNo} 步 <span className="wu-exec-dim">/ 上限 {stepLimit}</span>
          </span>
        </div>
        <div className="wu-exec-stat">
          <span className="wu-exec-stat-k">累计 token</span>
          <span className="wu-exec-stat-num">{steps === null ? '—' : formatStepTokens(totalTokens)}</span>
        </div>
      </div>
      <div className="wu-exec-note">
        <span className="wu-exec-note-k">最近进展</span>
        {progress
          ? `${typeof progress.step === 'number' ? `第 ${progress.step} 步：` : ''}${progress.summary}`
          : '—'}
      </div>
      {failedStep && (
        <div className="wu-exec-fail">
          ✗ 第 {failedStep.step} 步失败：{failedStep.errorDetail || failedStep.errorType || '执行失败'}
        </div>
      )}

      {steps === null && <div className="wu-exec-note">加载中…</div>}
      {steps !== null && shown.length === 0 && (
        <div className="wu-exec-note">暂无执行过程记录（仅记录本能力上线后的执行步）</div>
      )}
      {shown.length > 0 && (
        <div className="wu-flow">
          {shown.map(s => <FlowStep key={`${s.executionId}-${s.step}`} s={s} />)}
        </div>
      )}
    </div>
  );
}
