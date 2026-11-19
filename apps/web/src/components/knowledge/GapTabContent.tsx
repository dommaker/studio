// 拆分来源：pages/KnowledgePage.tsx「── Gap Type Tabs ──」内容区整块 + renderGapItem
//（六类缺口形状各异——卡片自行解读字段，仅 id 用于列表 key；纯 JSX 平移）
import { SkeletonCard } from '../ui';
import {
  PreferenceCard, BusinessRuleCard, EnvSnapshotCard,
  DecisionChainCard, InteractionPatternCard, ResolutionCard,
} from './GapCards';
import { UnifiedEntryContent } from './UnifiedEntryContent';
import type {
  PreferenceGap, BusinessRuleGap, EnvSnapshotGap,
  DecisionChainGap, InteractionGap, ResolutionGap,
} from './GapCards';

/** 六类知识缺口 tab（页面 tab 栏与 ActiveTab 联合类型同源） */
export type GapTab = 'preference' | 'business_rule' | 'environment' | 'decision_chain' | 'interaction' | 'resolution';

/** Gap tab 条目：六类缺口形状各异（卡片自行解读字段），仅 id 用于列表 key */
export type GapItem = { id?: string } & Record<string, unknown>;

export interface GapTabContentProps {
  loading: boolean;
  /** tab 拉取失败：错误条已由页头统一渲染，此处落 null（与批次 F-1 页面行为一致） */
  error: string | null;
  activeTab: GapTab;
  /** 当前 tab 中文标签（空态文案「暂无X数据」用） */
  tabLabel: string;
  items: GapItem[];
}

/** Gap tab 内容区：骨架 / 空态 / 条目卡列表（卡片按 activeTab 分派） */
export function GapTabContent({ loading, error, activeTab, tabLabel, items }: GapTabContentProps) {
  // ── Gap type detail rendering ──
  const renderGapItem = (item: GapItem) => {
    switch (activeTab) {
      case 'preference':
        return <PreferenceCard item={item as PreferenceGap} />;
      case 'business_rule':
        return <BusinessRuleCard item={item as BusinessRuleGap} />;
      case 'environment':
        return <EnvSnapshotCard item={item as EnvSnapshotGap} />;
      case 'decision_chain':
        return <DecisionChainCard item={item as DecisionChainGap} />;
      case 'interaction':
        return <InteractionPatternCard item={item as InteractionGap} />;
      case 'resolution':
        return <ResolutionCard item={item as ResolutionGap} />;
      default:
        // 六类 GapTab 全覆盖后此分支不可达；兜底同样消化呈现，不裸 JSON.stringify
        return <UnifiedEntryContent content={JSON.stringify(item)} />;
    }
  };

  return (
    <div>
      {loading ? (
        // 批次 F-3：加载态骨架卡片行（批次 E-2 ui/Skeleton 正本）
        <div className="space-y-3">
          <SkeletonCard height={88} />
          <SkeletonCard height={88} />
          <SkeletonCard height={88} />
        </div>
      ) : error ? null : items.length === 0 ? (
        <div className="empty-state">
          暂无{tabLabel}数据。系统会自动从 Agent 执行/交互中积累。
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={item.id || i}>{renderGapItem(item)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
