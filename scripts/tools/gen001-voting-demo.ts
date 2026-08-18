/**
 * GEN-001 评审投票模拟
 * 
 * 模拟参与者投票，展示会议如何自动结束
 */

import { loadReviewRules, calculateVerdict } from '../src/core/review-rules-loader';

console.log('🗳️  GEN-001 评审投票模拟\n');
console.log('='.repeat(60));

// 模拟参与者投票
const votes = [
  { user: 'architect-1', role: 'architect', name: '架构师 A', response: 'approve', comment: '四层架构设计合理，Monorepo 方案可行' },
  { user: 'tech-lead-1', role: 'tech_lead', name: 'Tech Lead', response: 'approve', comment: '职责边界清晰，支持实施' },
  { user: 'product-owner-1', role: 'product_owner', name: 'Product Owner', response: 'approve', comment: '产品视角无问题' },
  { user: 'architect-2', role: 'architect', name: '架构师 B', response: 'abstain', comment: '无异议' },
];

console.log('\n📊 投票记录');
console.log('-'.repeat(60));
votes.forEach((v, i) => {
  const icon = v.response === 'approve' ? '✅' : v.response === 'reject' ? '❌' : '➖';
  console.log(`${i + 1}. ${icon} ${v.name} (${v.role})`);
  console.log(`   投票: ${v.response}`);
  console.log(`   意见: ${v.comment}`);
  console.log('');
});

// 使用规则计算结果
const rules = loadReviewRules();
const voteData = votes.map(v => ({ role: v.role, response: v.response as 'approve' | 'reject' | 'abstain' }));
const verdict = calculateVerdict(rules, voteData);

console.log('\n📈 统计结果');
console.log('-'.repeat(60));
console.log(`总参与者: ${votes.length}`);
console.log(`Approve: ${votes.filter(v => v.response === 'approve').length}`);
console.log(`Reject: ${votes.filter(v => v.response === 'reject').length}`);
console.log(`Abstain: ${votes.filter(v => v.response === 'abstain').length}`);

console.log('\n🔍 规则检查');
console.log('-'.repeat(60));

// 检查各项规则
const approveCount = votes.filter(v => v.response === 'approve').length;
const totalVotes = votes.length;
const architectApproved = votes.some(v => v.role === 'architect' && v.response === 'approve');
const architectRejected = votes.some(v => v.role === 'architect' && v.response === 'reject');

console.log(`✓ 2/3 多数检查: ${approveCount}/${totalVotes} = ${(approveCount/totalVotes*100).toFixed(0)}% ${approveCount >= Math.ceil(totalVotes*2/3) ? '通过' : '未通过'}`);
console.log(`✓ 最少批准人数: ${approveCount} >= ${rules.approval.min_approvers} ${approveCount >= rules.approval.min_approvers ? '通过' : '未通过'}`);
console.log(`✓ 架构师批准: ${architectApproved ? '有 ✅' : '无 ❌'}`);
console.log(`✓ 架构师否决: ${architectRejected ? '已否决 ⚠️' : '未使用'}`);

console.log('\n' + '='.repeat(60));
console.log(`📋 评审结果: ${verdict.status === 'approved' ? '✅ 通过' : '❌ 未通过'}`);
console.log('='.repeat(60));

if (verdict.status === 'approved') {
  console.log('\n✅ 会议通过！');
  console.log('\n自动执行下一步:');
  console.log('  1. SpecReview 状态更新为 approved');
  console.log('  2. 生成实现任务:');
  console.log('     - [ ] GEN-001-C1: 确认四层架构模型');
  console.log('     - [ ] GEN-001-C2: 创建 Monorepo');
  console.log('     - [ ] GEN-001-C3: 明确 harness 边界');
  console.log('     - [ ] GEN-001-C4: 明确 studio 职责');
  console.log('     - [ ] GEN-001-C5: 定义接口契约');
  console.log('  3. 通知相关人员开始开发');
  console.log('  4. 代码需带 @spec GEN-001 注释');
  console.log('\n开发完成后:');
  console.log('  - 运行 npx harness spec 检查');
  console.log('  - 提交 PR');
  console.log('  - CI 自动验证');
} else {
  console.log('\n❌ 会议未通过');
  console.log('\n原因:', verdict.reason);
  console.log('\n下一步:');
  console.log('  - 根据意见修改 Spec');
  console.log('  - 重新提交评审');
}

console.log('\n' + '='.repeat(60));
console.log('完整的 Spec 驱动开发流程演示完成！');
console.log('='.repeat(60));
