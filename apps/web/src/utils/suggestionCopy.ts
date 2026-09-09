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
  // #445：无人认领补救动作片（action 形态）——工单一直没人接手；
  // 说清点了会发生什么（一次确认后认领到你名下 + 频道发认领说明）
  'claim-wu': p => ({
    label: `认领工单：《${p.wuTitle}》`,
    hint: '这张工单一直没有人接手；点击确认后会把它认领给你，并在频道里发一条认领说明',
  }),
  // #446：prompt 形态——阻塞诊断片。指令本体在后端 text 字段（点击预填进输入框，
  // 可编辑后发送，走既有消息路由）；hint 带阻塞原因上下文 + 说清点击后果
  'diagnose-blocked': p => ({
    label: `诊断阻塞：《${p.wuTitle}》`,
    hint: `这张工单被阻塞了${p.blockReason ? `（${p.blockReason}）` : ''}；点击会把诊断指令预填到输入框，可修改后再发送`,
  }),
  // #446：prompt 形态——前置门禁窗口的可选介入（评审未派发）。标注「可选」：
  // 不点自动化照常推进；点了可让审查员先把验收标准转写成审查清单
  'transcribe-review-checklist': p => ({
    label: `可选：转写审查清单：《${p.wuTitle}》`,
    hint: '自动审查开始前，可以先让审查员把验收标准转写成审查清单；点击会把这句话预填到输入框，可修改后再发送',
  }),
  // #465：首用引导——空转频道（无当前工单）且无成员时的只读提示（status 形态）；
  // 引导去顶栏 ⋯ 菜单加成员（与 ChannelMemberManager 入口口径一致）
  'channel-no-members': () => ({
    label: '本频道还没有成员',
    hint: '角色加入频道后才能在这里接收任务；点顶栏 ⋯ 菜单里的「成员」添加',
  }),
};

/** 渲染建议文案；未知模板 → null（调用方跳过该片） */
export function renderSuggestionCopy(s: ChannelSuggestion): RenderedSuggestionCopy | null {
  const template = TEMPLATES[s.id];
  return template ? template(s.params) : null;
}
