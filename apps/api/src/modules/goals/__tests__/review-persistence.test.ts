/**
 * Review Persistence — 验证审查结果持久化 + catch 安全默认值
 *
 * 1. goal-review.ts 在 reviewParallel 后写入 prisma.pipelineReview.create
 * 2. goal-review.ts 写入 review.completed StudioEvent
 * 3. review-agent.service.ts outer catch 返回 approved:false（非 true）
 * 4. review.completed event type 字符串存在于 goal-review.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const GOAL_REVIEW_PATH = path.resolve(__dirname, '../goal-review.ts');
const REVIEW_AGENT_PATH = path.resolve(__dirname, '../../agents/review-agent.service.ts');

const goalReviewSrc = fs.readFileSync(GOAL_REVIEW_PATH, 'utf-8');
const reviewAgentSrc = fs.readFileSync(REVIEW_AGENT_PATH, 'utf-8');

describe('review persistence', () => {
  it('goal-review.ts calls prisma.pipelineReview.upsert after reviewParallel', () => {
    // reviewParallel 调用存在
    expect(goalReviewSrc).toContain('reviewParallel');
    // PipelineReview 持久化存在（upsert 支持多 cycle 覆盖）
    expect(goalReviewSrc).toContain('prisma.pipelineReview.upsert');
    // 写入关键字段
    expect(goalReviewSrc).toContain('overallApproved');
    expect(goalReviewSrc).toContain('issuesJson');
  });

  it('goal-review.ts emits review.completed StudioEvent', () => {
    expect(goalReviewSrc).toContain('prisma.studioEvent.create');
    // event type = review.completed
    expect(goalReviewSrc).toMatch(/type:\s*['"]review\.completed['"]/);
    // source 标识
    expect(goalReviewSrc).toMatch(/source:\s*['"]goal-review['"]/);
  });

  it('review-agent.service.ts outer catch returns approved:false (not true)', () => {
    // 提取 outer catch 块（L338 附近）
    const catchIdx = reviewAgentSrc.indexOf("} catch (error) {");
    expect(catchIdx).toBeGreaterThan(-1);

    // 取 catch 块后 500 字符
    const catchBlock = reviewAgentSrc.slice(catchIdx, catchIdx + 600);

    // 必须包含 approved: false
    expect(catchBlock).toContain('approved: false');
    // 不应包含 approved: true（排除误判：auto-approve 不在 catch 块内）
    expect(catchBlock).not.toContain('approved: true');
    // severity 应为 error
    expect(catchBlock).toContain("severity: 'error'");
    // message 应包含"阻断"
    expect(catchBlock).toMatch(/阻断/);
  });

  it('review.completed event type string exists in goal-review.ts', () => {
    // studioEvent.create 的 payload 里 type 字段
    const matches = goalReviewSrc.match(/['"]review\.completed['"]/g);
    // 至少两处：tracePipeline eventType + studioEvent type
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});
