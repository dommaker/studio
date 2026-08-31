// EvidenceLedger — F6 证据台账三级共享组件（WorkUnitDrawer 抽屉变体 / WorkUnitDetailPage 卡片变体）
// 共享口径：层标签（正本 utils/evidence.EVIDENCE_LAYER_LABELS，白话不上 L1/L2/L3 编号，#385 词表）、
// 证据行格式 `{kind} · {by 前 8 位} · {时间}`、存量空态文案、l2.summary 评审结论行；
// variant 只承载真实差异：外层标记（mc-kv vs card）与 verdict 呈现（✓/✗ 前缀 vs 通过/拒绝徽章）
import type { AttestationEntry, WuAttestations } from '@dommaker/studio-shared/web';
import { formatShortTime } from '../../utils/datetime';
import { EVIDENCE_LAYER_LABELS } from '../../utils/evidence';

const LEVELS = ['l1', 'l2', 'l3'] as const;

/** 存量任务（证据模型未介入）空态文案，两变体一致 */
const LEGACY_EMPTY_COPY = '存量任务，证据模型未介入（按存储状态展示）';

interface Props {
  /** parseAttestations(wu.metadata) 的结果；undefined = 存量 legacy WU */
  attestations: WuAttestations | undefined;
  variant: 'drawer' | 'card';
}

/** 证据行共用部分：`{kind} · {by 前 8 位} · {时间}`（verdict 呈现由 variant 决定） */
function formatEntryLine(entry: AttestationEntry): string {
  return `${entry.kind} · ${entry.by.slice(0, 8)} · ${formatShortTime(entry.at)}`;
}

export function EvidenceLedger({ attestations, variant }: Props) {
  if (variant === 'drawer') {
    return (
      <>
        <div className="mc-block-label">证据台账</div>
        {attestations === undefined && (
          <div className="mc-drawer-note">{LEGACY_EMPTY_COPY}</div>
        )}
        {attestations !== undefined && LEVELS.map(level => {
          const entry = attestations[level];
          return (
            <div className="mc-kv" key={level}>
              <span className="mc-kv-k">{EVIDENCE_LAYER_LABELS[level]}</span>
              <span className="mc-kv-v">
                {entry
                  ? `${entry.verdict === 'approved' ? '✓' : '✗'} ${formatEntryLine(entry)}`
                  : '—'}
              </span>
            </div>
          );
        })}
        {attestations?.l2?.summary && (
          <div className="mc-drawer-note">评审结论：{attestations.l2.summary}</div>
        )}
      </>
    );
  }

  return (
    <div className="card mt-4 p-3">
      <div className="text-xs font-medium u-text-2 mb-2">证据台账</div>
      {attestations === undefined ? (
        <div className="text-xs u-text-3">{LEGACY_EMPTY_COPY}</div>
      ) : (
        <div className="space-y-1.5">
          {LEVELS.map(level => {
            const entry = attestations[level];
            return (
              <div className="flex items-center gap-2 text-xs" key={level}>
                <span className="u-text-2 w-24 flex-shrink-0">{EVIDENCE_LAYER_LABELS[level]}</span>
                {entry ? (
                  <>
                    <span className={`px-2 py-0.5 rounded ${entry.verdict === 'approved' ? 'u-ok-dim u-ok' : 'u-err-dim u-err'}`}>
                      {entry.verdict === 'approved' ? '✓ 通过' : '✗ 拒绝'}
                    </span>
                    <span className="u-text-3">{formatEntryLine(entry)}</span>
                  </>
                ) : (
                  <span className="u-text-3">—</span>
                )}
              </div>
            );
          })}
          {attestations.l2?.summary && (
            <div className="text-xs u-text-3">评审结论：{attestations.l2.summary}</div>
          )}
        </div>
      )}
    </div>
  );
}
