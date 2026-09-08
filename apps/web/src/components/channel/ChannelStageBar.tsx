// ChannelStageBar — #440 Phase 2：频道详情页顶部的工单阶段条。
// 铁律：阶段语义 = deriveDisplayState 展示列（与 WU 详情页同一口径），不发明第二套阶段模型；
// 渲染复用 #396 StationStepper + buildLifecycle 纯函数（attestations 从列表 WU metadata 解析，
// 「待验收」站时间戳口径沿用 wuLifecycle 注释 §5.6.2）。无当前 WU → 不占位。
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { buildLifecycle } from '../../utils/wuLifecycle';
import { parseWuMeta } from '../../utils/wuMeta';
import { StationStepper } from '../workunit/StationStepper';
// stepper 样式类（wu-stepper-bar/wu-bstep/wu-st-*）定义在 wu-detail.css，顶层作用域可直接复用
import '../../styles/wu-detail.css';

export function ChannelStageBar({ wu }: { wu: WorkUnit | null }) {
  if (!wu) return null;
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });
  const { stations } = buildLifecycle(wu, derived, parseWuMeta(wu.metadata), parseAttestations(wu.metadata));
  return (
    <div className="mc-stagebar" aria-label="工单阶段">
      <StationStepper stations={stations} />
    </div>
  );
}
