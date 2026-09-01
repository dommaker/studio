// 引导文案模板注册表（#443 / spec #441）：后端建议端点只回结构化数据
// { id, kind, params }，文案全部由本注册表的模板渲染——说人话、带工单上下文、
// 无内部术语（快照测试锁定输出，禁用词表见 suggestionCopy.test.ts）。
// fail-closed：未知模板 id → null（后端给了前端不认识的建议时不渲染、不编造）。
import type { ChannelSuggestion } from '../api/channel';

export interface RenderedSuggestionCopy {
  /** 片上主文案（一行，说清当前状况/动作） */
  label: string;
  /** 说明小字（可选语义 / 点了会发生什么 / 无需操作的安心说明） */
  hint?: string;
}

type CopyTemplate = (params: Record<string, string>) => RenderedSuggestionCopy;

const TEMPLATES: Record<string, CopyTemplate> = {
  // 自动化在途的只读状态说明（status 形态）：呈现状况 + 安心等待，无操作引导
  'auto-review-in-flight': p => ({
    label: `等待自动评审：《${p.wuTitle}》`,
    hint: '系统正在自动审查这张工单，无需操作；有结果后这里会更新',
  }),
  // #444：断链补救动作片（action 形态）——自动审查该开始没开始；
  // 说清点了会发生什么（一次确认后创建审查工单，交给频道成员审查）
  'redispatch-review': p => ({
    label: `补派评审：《${p.wuTitle}》`,
    hint: '这张工单的自动审查迟迟没有开始；点击确认后会立即创建审查工单，交给频道里的成员审查',
  }),
};

/** 渲染建议文案；未知模板 → null（调用方跳过该片） */
export function renderSuggestionCopy(s: ChannelSuggestion): RenderedSuggestionCopy | null {
  const template = TEMPLATES[s.id];
  return template ? template(s.params) : null;
}
